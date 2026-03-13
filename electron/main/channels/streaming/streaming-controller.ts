// ============================================================================
// StreamingController — Generic streaming orchestrator for channel adapters
// Manages streaming session lifecycle with capability-driven degradation.
//
// Degradation strategy based on ChannelCapabilities:
//
// supportsMessageUpdate = true  → "streaming mode"
//   Send "thinking..." placeholder, update it with content as it arrives,
//   finalize with final reply. On segment boundary: finalize current message
//   with plain text, create new streaming message.
//
// supportsMessageUpdate = false → "batch mode"
//   Silently accumulate text, no intermediate updates visible.
//   On segment boundary: flush accumulated text as a plain text message,
//   start accumulating the new segment.
//   The adapter is responsible for not sending a placeholder message
//   (check controller.isBatchMode).
//
// Both modes handle multi-segment replies: intermediate segments are always
// delivered as plain text; only the final segment uses rich content (if
// supported) via finalize → sendFinalReply.
//
// supportsRichContent = false   → renderer returns type "text"
//   Final reply sent as plain text, no rich content.
//
// supportsMessageDelete = false → no delete-and-replace
//   When finalizing with rich content, update existing message to a
//   completion notice instead of deleting it.
// ============================================================================

import type { UnifiedPart, UnifiedMessage } from "../../../../src/types/unified";
import type { ChannelCapabilities } from "../channel-adapter";
import type { MessageTransport } from "./message-transport";
import type { MessageRenderer } from "./message-renderer";
import type { StreamingSession, StreamingConfig } from "./streaming-types";
import { channelLog } from "../../services/logger";

/**
 * Generic streaming controller for channel adapters.
 *
 * The adapter owns routing (which streaming session to update) and
 * session tracking. The controller manages the streaming state machine
 * for individual sessions, adapting behavior based on platform capabilities.
 */
export class StreamingController {
  constructor(
    private transport: MessageTransport,
    private renderer: MessageRenderer,
    private config: StreamingConfig,
    private capabilities: ChannelCapabilities,
  ) {}

  // =========================================================================
  // Part Application
  // =========================================================================

  /**
   * Apply a part update to a streaming session.
   * Handles text accumulation, segment transitions, and tool counting.
   *
   * In batch mode (no message update support), text is accumulated
   * silently without any platform API calls.
   */
  applyPart(session: StreamingSession, part: UnifiedPart): void {
    switch (part.type) {
      case "text":
        if (
          session.currentTextPartId &&
          session.currentTextPartId !== part.id &&
          session.textBuffer
        ) {
          // New text segment detected
          if (this.capabilities.supportsMessageUpdate) {
            // Streaming mode: finalize current message, create new streaming message
            void this.transitionToNewSegment(session, part);
          } else {
            // Batch mode: flush current buffer as plain text, start new segment
            void this.flushSegmentAsText(session, part);
          }
        } else {
          // Same segment or first segment
          session.currentTextPartId = part.id;
          session.textBuffer = part.text || "";
          if (this.capabilities.supportsMessageUpdate) {
            this.scheduleThrottledUpdate(session);
          }
          // In batch mode: just accumulate, no API call
        }
        break;
      case "tool":
        if (part.normalizedTool) {
          const count = session.toolCounts.get(part.normalizedTool) ?? 0;
          session.toolCounts.set(part.normalizedTool, count + 1);
        }
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // Multi-Segment Transitions
  // =========================================================================

  /**
   * Flush the current text buffer as a plain text message and start
   * accumulating the new segment. Used in batch mode (no message update)
   * when a segment boundary is detected.
   *
   * Intermediate segments are always plain text; only the final segment
   * (handled by finalize → sendFinalReply) uses rich content.
   */
  private async flushSegmentAsText(
    session: StreamingSession,
    newPart: UnifiedPart & { type: "text" },
  ): Promise<void> {
    // Send current buffer as a plain text message (intermediate segment)
    const truncated = this.renderer.truncate(session.textBuffer);
    await this.transport.sendText(session.chatId, truncated);

    // Reset for new segment
    session.textBuffer = newPart.text || "";
    session.currentTextPartId = newPart.id;
  }

  /**
   * Transition to a new text segment in streaming mode: finalize current
   * platform message with plain text, create a new streaming message for
   * the incoming segment.
   * Only called when supportsMessageUpdate is true.
   */
  private async transitionToNewSegment(
    session: StreamingSession,
    newPart: UnifiedPart & { type: "text" },
  ): Promise<void> {
    // 1. Finalize current message (clear timer, patch with final text)
    if (session.patchTimer) {
      clearTimeout(session.patchTimer);
      session.patchTimer = null;
    }
    if (session.platformMessageId && session.textBuffer) {
      const truncated = this.renderer.truncate(session.textBuffer);
      await this.transport.updateText(session.platformMessageId, truncated);
    }

    // 2. Reset for new segment
    session.textBuffer = newPart.text || "";
    session.currentTextPartId = newPart.id;
    session.platformMessageId = ""; // prevent patches during message creation
    session.lastPatchTime = Date.now();

    // 3. Create new platform message for the new segment
    const streamingText = this.renderer.renderStreamingUpdate(session.textBuffer);
    const newMsgId = await this.transport.sendText(session.chatId, streamingText);

    if (newMsgId) {
      session.platformMessageId = newMsgId;
      if (session.completed) {
        // Race: message completed while creating new message — finalize now
        await this.sendFinalReply(session);
      } else {
        this.scheduleThrottledUpdate(session);
      }
    } else {
      channelLog.error("Failed to create new segment message");
    }
  }

  // =========================================================================
  // Finalization
  // =========================================================================

  /**
   * Finalize a streaming session when the assistant message completes.
   * Sends the final formatted reply and marks the session as completed.
   *
   * @returns true if the session was finalized
   */
  finalize(session: StreamingSession, message: UnifiedMessage): boolean {
    if (message.role !== "assistant") return false;
    if (!message.time?.completed) return false;

    session.completed = true;
    if (session.patchTimer) {
      clearTimeout(session.patchTimer);
      session.patchTimer = null;
    }

    if (message.error) {
      if (this.capabilities.supportsMessageUpdate && session.platformMessageId) {
        this.transport.updateText(
          session.platformMessageId,
          `⚠️ Error: ${message.error}`,
        );
      } else {
        // Batch mode or no placeholder: send error as new message
        this.transport.sendText(
          session.chatId,
          `⚠️ Error: ${message.error}`,
        );
      }
      return true;
    }

    void this.sendFinalReply(session);
    return true;
  }

  /**
   * Send the final reply for a completed streaming session.
   * Adapts delivery strategy based on platform capabilities.
   */
  private async sendFinalReply(session: StreamingSession): Promise<void> {
    const toolSummary = this.formatToolSummary(session.toolCounts);
    const content = session.textBuffer || "（无文本回复）";

    const rendered = this.renderer.renderFinalReply(content, toolSummary);

    if (rendered.type === "rich" && this.capabilities.supportsRichContent) {
      // Rich content: send new rich message
      const newId = await this.transport.sendRichContent(session.chatId, rendered.content);
      if (newId && session.platformMessageId) {
        if (this.capabilities.supportsMessageDelete) {
          // Delete old streaming text message
          await this.transport.deleteMessage(session.platformMessageId);
        } else if (this.capabilities.supportsMessageUpdate) {
          // Can't delete, but can update — replace with completion notice
          await this.transport.updateText(session.platformMessageId, "✅");
        }
        // Can't delete or update — old message stays (acceptable degradation)
      }
    } else if (this.capabilities.supportsMessageUpdate && session.platformMessageId) {
      // Text-only or no rich support: update existing message in place
      await this.transport.updateText(session.platformMessageId, rendered.content);
    } else {
      // Batch mode: send final reply as a new message
      await this.transport.sendText(session.chatId, rendered.content);
    }
  }

  // =========================================================================
  // Throttled Update (streaming mode only)
  // =========================================================================

  /**
   * Schedule a throttled update to the platform message.
   * Only called when supportsMessageUpdate is true.
   */
  private scheduleThrottledUpdate(session: StreamingSession): void {
    if (session.patchTimer || session.completed || !session.platformMessageId) return;

    const elapsed = Date.now() - session.lastPatchTime;
    const delay = Math.max(0, this.config.throttleMs - elapsed);

    session.patchTimer = setTimeout(() => {
      session.patchTimer = null;
      if (!session.completed) {
        session.lastPatchTime = Date.now();
        const text = this.renderer.renderStreamingUpdate(session.textBuffer);
        const truncated = this.renderer.truncate(text);
        this.transport.updateText(session.platformMessageId, truncated);
      }
    }, delay);
  }

  // =========================================================================
  // Query
  // =========================================================================

  /** Whether this controller operates in batch mode (no streaming updates) */
  get isBatchMode(): boolean {
    return !this.capabilities.supportsMessageUpdate;
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  /** Clean up a single streaming session (clear timer) */
  cleanupSession(session: StreamingSession): void {
    if (session.patchTimer) {
      clearTimeout(session.patchTimer);
      session.patchTimer = null;
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Format tool counts into a summary string */
  private formatToolSummary(toolCounts: Map<string, number>): string {
    if (toolCounts.size === 0) return "";

    const total = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);
    const details = Array.from(toolCounts.entries())
      .map(([name, count]) => `${name.charAt(0).toUpperCase() + name.slice(1)}(${count})`)
      .join(", ");

    return `\n\n---\n执行了 ${total} 个操作：${details}`;
  }
}
