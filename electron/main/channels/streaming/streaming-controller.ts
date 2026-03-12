// ============================================================================
// StreamingController — Generic streaming orchestrator for channel adapters
// Manages streaming session lifecycle: throttled updates, multi-segment
// transitions, and message finalization. Platform-agnostic.
// ============================================================================

import type { UnifiedPart, UnifiedMessage } from "../../../../src/types/unified";
import type { MessageTransport } from "./message-transport";
import type { MessageRenderer } from "./message-renderer";
import type { StreamingSession, StreamingConfig } from "./streaming-types";
import { channelLog } from "../../services/logger";

/**
 * Callback invoked after a streaming session is finalized.
 * The adapter uses this to clean up its own session tracking.
 */
export type FinalizeCallback = (session: StreamingSession) => void;

/**
 * Generic streaming controller for channel adapters.
 *
 * Responsibilities:
 * - Apply incoming part updates (text accumulation, tool counting)
 * - Throttle platform message update API calls
 * - Detect and handle multi-segment text transitions
 * - Finalize streaming sessions when messages complete
 *
 * The adapter owns routing (which streaming session to update) and
 * session tracking. The controller manages the streaming state machine
 * for a single session at a time.
 */
export class StreamingController {
  constructor(
    private transport: MessageTransport,
    private renderer: MessageRenderer,
    private config: StreamingConfig,
  ) {}

  // =========================================================================
  // Part Application
  // =========================================================================

  /**
   * Apply a part update to a streaming session.
   * Handles text accumulation, segment transitions, and tool counting.
   */
  applyPart(session: StreamingSession, part: UnifiedPart): void {
    switch (part.type) {
      case "text":
        if (
          session.currentTextPartId &&
          session.currentTextPartId !== part.id &&
          session.textBuffer
        ) {
          // New text segment detected — transition to a new platform message
          void this.transitionToNewSegment(session, part);
        } else {
          // Same segment or first segment — normal streaming update
          session.currentTextPartId = part.id;
          session.textBuffer = part.text || "";
          this.scheduleThrottledUpdate(session);
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
  // Multi-Segment Transition
  // =========================================================================

  /**
   * Transition to a new text segment: finalize current platform message
   * and create a new one for the incoming segment.
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
   * @returns true if a matching session was found and finalized
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
      this.transport.updateText(
        session.platformMessageId,
        `⚠️ Error: ${message.error}`,
      );
      return true;
    }

    void this.sendFinalReply(session);
    return true;
  }

  /**
   * Send the final reply for a completed streaming session.
   * Uses the renderer to format the content and the transport to deliver it.
   */
  private async sendFinalReply(session: StreamingSession): Promise<void> {
    const toolSummary = this.formatToolSummary(session.toolCounts);
    const content = session.textBuffer || "（无文本回复）";

    const rendered = this.renderer.renderFinalReply(content, toolSummary);

    if (rendered.type === "rich") {
      // Replace streaming text message with rich content
      const newId = await this.transport.sendRichContent(session.chatId, rendered.content);
      if (newId) {
        await this.transport.deleteMessage(session.platformMessageId);
      }
    } else {
      // Update existing message with final text
      await this.transport.updateText(session.platformMessageId, rendered.content);
    }
  }

  // =========================================================================
  // Throttled Update
  // =========================================================================

  /**
   * Schedule a throttled update to the platform message.
   * Ensures we don't exceed the platform's API rate limit.
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
