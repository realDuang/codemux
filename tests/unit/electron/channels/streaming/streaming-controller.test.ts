import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelCapabilities } from "../../../../../electron/main/channels/channel-adapter";
import type { MessageTransport } from "../../../../../electron/main/channels/streaming/message-transport";
import type { MessageRenderer, RenderedMessage } from "../../../../../electron/main/channels/streaming/message-renderer";
import type { StreamingSession, StreamingConfig } from "../../../../../electron/main/channels/streaming/streaming-types";
import type { UnifiedPart, UnifiedMessage } from "../../../../../src/types/unified";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const { mockScopedLogger } = vi.hoisted(() => ({
  mockScopedLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  channelLog: mockScopedLogger,
}));

import { StreamingController } from "../../../../../electron/main/channels/streaming/streaming-controller";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTransport(): MessageTransport {
  return {
    sendText: vi.fn<MessageTransport["sendText"]>().mockResolvedValue("msg-new"),
    updateText: vi.fn<MessageTransport["updateText"]>().mockResolvedValue(undefined),
    deleteMessage: vi.fn<MessageTransport["deleteMessage"]>().mockResolvedValue(undefined),
    sendRichContent: vi.fn<MessageTransport["sendRichContent"]>().mockResolvedValue("rich-new"),
  };
}

function createMockRenderer(): MessageRenderer {
  return {
    renderStreamingUpdate: vi.fn<MessageRenderer["renderStreamingUpdate"]>((text) => `[streaming] ${text}`),
    renderFinalReply: vi.fn<MessageRenderer["renderFinalReply"]>((content, toolSummary, _title) => ({
      type: "rich" as const,
      content: `[final] ${content}${toolSummary ?? ""}`,
    })),
    truncate: vi.fn<MessageRenderer["truncate"]>((text) => text),
  };
}

function streamingCapabilities(overrides?: Partial<ChannelCapabilities>): ChannelCapabilities {
  return {
    supportsMessageUpdate: true,
    supportsMessageDelete: true,
    supportsRichContent: true,
    maxMessageBytes: 30000,
    ...overrides,
  };
}

function batchCapabilities(overrides?: Partial<ChannelCapabilities>): ChannelCapabilities {
  return {
    supportsMessageUpdate: false,
    supportsMessageDelete: false,
    supportsRichContent: false,
    maxMessageBytes: 30000,
    ...overrides,
  };
}

const defaultConfig: StreamingConfig = { throttleMs: 1000 };

function createSession(overrides?: Partial<StreamingSession>): StreamingSession {
  return {
    platformMessageId: "plat-msg-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    chatId: "chat-1",
    textBuffer: "",
    lastPatchTime: 0,
    patchTimer: null,
    completed: false,
    finalReplySent: false,
    toolCounts: new Map(),
    ...overrides,
  };
}

function textPart(id: string, text: string): UnifiedPart & { type: "text" } {
  return { type: "text", id, messageId: "m1", sessionId: "s1", text };
}

function toolPart(id: string, normalizedTool: string): UnifiedPart & { type: "tool" } {
  return {
    type: "tool",
    id,
    messageId: "m1",
    sessionId: "s1",
    normalizedTool,
    callId: `call-${id}`,
    originalTool: normalizedTool,
    title: normalizedTool,
    kind: "other",
    state: "running",
    input: {},
  } as any;
}

function completedAssistantMessage(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "u1",
    sessionId: "s1",
    role: "assistant",
    time: { created: 1000, completed: 2000 },
    parts: [],
    ...overrides,
  } as UnifiedMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StreamingController", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let renderer: ReturnType<typeof createMockRenderer>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    transport = createMockTransport();
    renderer = createMockRenderer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // =========================================================================
  // 1. applyPart - text part handling
  // =========================================================================

  describe("applyPart", () => {
    describe("text parts", () => {
      it("sets currentTextPartId and textBuffer on first text part", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession();

        ctrl.applyPart(session, textPart("part-1", "Hello"));

        expect(session.currentTextPartId).toBe("part-1");
        expect(session.textBuffer).toBe("Hello");
      });

      it("schedules throttled update in streaming mode on first text part", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession();

        ctrl.applyPart(session, textPart("part-1", "Hello"));

        // A timer should have been scheduled
        expect(session.patchTimer).not.toBeNull();
      });

      it("does NOT schedule throttled update in batch mode on first text part", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
        const session = createSession();

        ctrl.applyPart(session, textPart("part-1", "Hello"));

        expect(session.patchTimer).toBeNull();
        expect(transport.updateText).not.toHaveBeenCalled();
      });

      it("updates textBuffer when the same text part id arrives again", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession();

        ctrl.applyPart(session, textPart("part-1", "Hel"));
        ctrl.applyPart(session, textPart("part-1", "Hello World"));

        expect(session.currentTextPartId).toBe("part-1");
        expect(session.textBuffer).toBe("Hello World");
      });

      it("triggers transitionToNewSegment in streaming mode on new text part id", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ currentTextPartId: "part-1", textBuffer: "Old text" });

        ctrl.applyPart(session, textPart("part-2", "New text"));

        // After transition, session state should be updated synchronously
        expect(session.currentTextPartId).toBe("part-2");
        expect(session.textBuffer).toBe("New text");

        // Allow async operations to complete
        await vi.runAllTimersAsync();

        // Old message should be updated with truncated old text
        expect(transport.updateText).toHaveBeenCalledWith("plat-msg-1", "Old text");
        // New streaming message should be created
        expect(transport.sendText).toHaveBeenCalledWith("chat-1", "[streaming] New text");
      });

      it("triggers flushSegmentAsText in batch mode on new text part id", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
        const session = createSession({ currentTextPartId: "part-1", textBuffer: "Old text" });

        ctrl.applyPart(session, textPart("part-2", "New text"));

        expect(session.currentTextPartId).toBe("part-2");
        expect(session.textBuffer).toBe("New text");

        await vi.runAllTimersAsync();

        // Old text should have been sent as a new message
        expect(transport.sendText).toHaveBeenCalledWith("chat-1", "Old text");
        // No updateText calls in batch mode
        expect(transport.updateText).not.toHaveBeenCalled();
      });

      it("does NOT trigger segment transition if textBuffer is empty", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ currentTextPartId: "part-1", textBuffer: "" });

        ctrl.applyPart(session, textPart("part-2", "New text"));

        // Should treat it as "same/first segment" path since textBuffer is empty
        expect(session.currentTextPartId).toBe("part-2");
        expect(session.textBuffer).toBe("New text");
        expect(transport.sendText).not.toHaveBeenCalled();
        expect(transport.updateText).not.toHaveBeenCalled();
      });

      it("handles empty text in the new part gracefully", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession();

        ctrl.applyPart(session, textPart("part-1", ""));

        expect(session.textBuffer).toBe("");
        expect(session.currentTextPartId).toBe("part-1");
      });
    });

    describe("tool parts", () => {
      it("increments tool count for normalizedTool", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession();

        ctrl.applyPart(session, toolPart("t1", "read"));
        ctrl.applyPart(session, toolPart("t2", "read"));
        ctrl.applyPart(session, toolPart("t3", "write"));

        expect(session.toolCounts.get("read")).toBe(2);
        expect(session.toolCounts.get("write")).toBe(1);
      });

      it("does not increment tool count when normalizedTool is falsy", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession();
        const part = { type: "tool" as const, id: "t1", messageId: "m1", sessionId: "s1", normalizedTool: "", callId: "c1", originalTool: "x", title: "x", kind: "other", state: "running", input: {} } as any;

        ctrl.applyPart(session, part);

        expect(session.toolCounts.size).toBe(0);
      });
    });

    describe("other part types", () => {
      it("ignores non-text non-tool parts", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession();
        const part = { type: "reasoning" as const, id: "r1", messageId: "m1", sessionId: "s1", text: "thinking..." } as any;

        ctrl.applyPart(session, part);

        expect(session.textBuffer).toBe("");
        expect(session.toolCounts.size).toBe(0);
        expect(transport.sendText).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // 2. Segment transitions
  // =========================================================================

  describe("segment transitions", () => {
    describe("flushSegmentAsText (batch mode)", () => {
      it("captures old buffer, sends as text, and sets up new segment", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
        const session = createSession({ currentTextPartId: "part-1", textBuffer: "Previous content" });

        ctrl.applyPart(session, textPart("part-2", "Next content"));
        await vi.runAllTimersAsync();

        expect(renderer.truncate).toHaveBeenCalledWith("Previous content");
        expect(transport.sendText).toHaveBeenCalledWith("chat-1", "Previous content");
        expect(session.currentTextPartId).toBe("part-2");
        expect(session.textBuffer).toBe("Next content");
      });
    });

    describe("transitionToNewSegment (streaming mode)", () => {
      it("clears the patchTimer", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ currentTextPartId: "part-1", textBuffer: "Old" });
        session.patchTimer = setTimeout(() => {}, 5000);

        ctrl.applyPart(session, textPart("part-2", "New"));
        await vi.runAllTimersAsync();

        // The old timer should have been cleared (the current one is new or null)
        // and platform operations should proceed normally
        expect(transport.updateText).toHaveBeenCalledWith("plat-msg-1", "Old");
      });

      it("finalizes old message and creates new platform message", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ currentTextPartId: "part-1", textBuffer: "Old text", platformMessageId: "old-msg" });

        ctrl.applyPart(session, textPart("part-2", "New text"));
        await vi.runAllTimersAsync();

        // Finalize old message
        expect(transport.updateText).toHaveBeenCalledWith("old-msg", "Old text");
        // Create new message
        expect(transport.sendText).toHaveBeenCalledWith("chat-1", "[streaming] New text");
        // platformMessageId updated to the new one
        expect(session.platformMessageId).toBe("msg-new");
      });

      it("handles the race where session completes during transition", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({
          currentTextPartId: "part-1",
          textBuffer: "Old",
          platformMessageId: "old-msg",
        });

        // Mark completed before transition completes
        session.completed = true;

        ctrl.applyPart(session, textPart("part-2", "New"));
        // Need the session to stay completed
        session.completed = true;
        await vi.runAllTimersAsync();

        // Since completed is true when new message is created, sendFinalReply should be triggered
        // sendFinalReply calls renderFinalReply
        expect(renderer.renderFinalReply).toHaveBeenCalled();
      });

      it("skips updating previous message when prevMessageId is empty", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({
          currentTextPartId: "part-1",
          textBuffer: "Old",
          platformMessageId: "",
        });

        ctrl.applyPart(session, textPart("part-2", "New"));
        await vi.runAllTimersAsync();

        // updateText should NOT be called for the old (empty) message id.
        // It may be called for the *new* message via scheduleThrottledUpdate,
        // but never with the old empty id.
        expect(transport.updateText).not.toHaveBeenCalledWith("", expect.anything());
        // sendText should be called to create new message
        expect(transport.sendText).toHaveBeenCalledWith("chat-1", "[streaming] New");
      });

      it("sets platformMessageId to empty string during async operations", () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({
          currentTextPartId: "part-1",
          textBuffer: "Old",
          platformMessageId: "old-msg",
        });

        // Block sendText so we can observe the intermediate state
        transport.sendText = vi.fn(() => new Promise(() => {}));
        transport.updateText = vi.fn().mockResolvedValue(undefined);

        ctrl.applyPart(session, textPart("part-2", "New"));

        // platformMessageId is set to "" synchronously before the first await
        // to prevent stale patches from being sent during the async gap
        expect(session.platformMessageId).toBe("");
        expect(session.currentTextPartId).toBe("part-2");
        expect(session.textBuffer).toBe("New");
      });
    });
  });

  // =========================================================================
  // 3. flushAsIntermediateReply
  // =========================================================================

  describe("flushAsIntermediateReply", () => {
    it("is a no-op when textBuffer is empty", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "" });

      await ctrl.flushAsIntermediateReply(session);

      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("is a no-op when session is completed", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Some text", completed: true });

      await ctrl.flushAsIntermediateReply(session);

      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("is a no-op when finalReplySent is true", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Some text", finalReplySent: true });

      await ctrl.flushAsIntermediateReply(session);

      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("clears patchTimer before updating", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Some text" });
      const timerCallback = vi.fn();
      session.patchTimer = setTimeout(timerCallback, 5000);

      await ctrl.flushAsIntermediateReply(session);

      expect(session.patchTimer).toBeNull();
      // Advance timers to check the old timer was truly cleared
      vi.advanceTimersByTime(10000);
      expect(timerCallback).not.toHaveBeenCalled();
    });

    it("updates the platform message in streaming mode", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Current content", platformMessageId: "plat-1" });

      await ctrl.flushAsIntermediateReply(session);

      expect(renderer.renderStreamingUpdate).toHaveBeenCalledWith("Current content");
      expect(renderer.truncate).toHaveBeenCalledWith("[streaming] Current content");
      expect(transport.updateText).toHaveBeenCalledWith("plat-1", "[streaming] Current content");
    });

    it("is a no-op in batch mode (no supportsMessageUpdate)", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
      const session = createSession({ textBuffer: "Some text", platformMessageId: "plat-1" });

      await ctrl.flushAsIntermediateReply(session);

      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("is a no-op when platformMessageId is empty in streaming mode", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Some text", platformMessageId: "" });

      await ctrl.flushAsIntermediateReply(session);

      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("swallows transport errors without throwing", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Some text", platformMessageId: "plat-1" });
      transport.updateText = vi.fn().mockRejectedValue(new Error("Network error"));

      // Should not throw
      await expect(ctrl.flushAsIntermediateReply(session)).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // 4. finalize
  // =========================================================================

  describe("finalize", () => {
    it("returns false for non-assistant messages", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession();
      const msg = completedAssistantMessage({ role: "user" as any });

      expect(ctrl.finalize(session, msg)).toBe(false);
      expect(session.completed).toBe(false);
    });

    it("returns false when message.time.completed is not set", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession();
      const msg = completedAssistantMessage({ time: { created: 1000 } });

      expect(ctrl.finalize(session, msg)).toBe(false);
      expect(session.completed).toBe(false);
    });

    it("sets session.completed to true on valid finalization", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });
      const msg = completedAssistantMessage();

      const result = ctrl.finalize(session, msg);

      expect(result).toBe(true);
      expect(session.completed).toBe(true);
    });

    it("clears patchTimer on finalization", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });
      session.patchTimer = setTimeout(() => {}, 5000);

      ctrl.finalize(session, completedAssistantMessage());

      expect(session.patchTimer).toBeNull();
    });

    describe("error messages", () => {
      it("updates existing message with error in streaming mode", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ platformMessageId: "plat-1" });
        const msg = completedAssistantMessage({ error: "Something went wrong" });

        const result = ctrl.finalize(session, msg);
        await vi.runAllTimersAsync();

        expect(result).toBe(true);
        expect(transport.updateText).toHaveBeenCalledWith("plat-1", expect.stringContaining("Something went wrong"));
      });

      it("sends error as new message in batch mode", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
        const session = createSession();
        const msg = completedAssistantMessage({ error: "Something went wrong" });

        const result = ctrl.finalize(session, msg);
        await vi.runAllTimersAsync();

        expect(result).toBe(true);
        expect(transport.sendText).toHaveBeenCalledWith("chat-1", expect.stringContaining("Something went wrong"));
      });

      it("sends error as new message when no platformMessageId in streaming mode", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ platformMessageId: "" });
        const msg = completedAssistantMessage({ error: "Oops" });

        ctrl.finalize(session, msg);
        await vi.runAllTimersAsync();

        expect(transport.sendText).toHaveBeenCalledWith("chat-1", expect.stringContaining("Oops"));
      });

      it("does not call sendFinalReply when message has error", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ textBuffer: "content", platformMessageId: "plat-1" });
        const msg = completedAssistantMessage({ error: "err" });

        ctrl.finalize(session, msg);
        await vi.runAllTimersAsync();

        expect(renderer.renderFinalReply).not.toHaveBeenCalled();
      });
    });

    describe("successful finalization", () => {
      it("calls sendFinalReply for successful messages", async () => {
        const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
        const session = createSession({ textBuffer: "Final text" });

        ctrl.finalize(session, completedAssistantMessage());
        await vi.runAllTimersAsync();

        expect(renderer.renderFinalReply).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // 5. sendFinalReply (tested via finalize)
  // =========================================================================

  describe("sendFinalReply", () => {
    it("is idempotent - skips when finalReplySent is already true", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Text", finalReplySent: true });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      // renderFinalReply should not be called since finalReplySent is true
      // (finalize calls sendFinalReply which returns early)
      expect(renderer.renderFinalReply).not.toHaveBeenCalled();
    });

    it("sends rich content and deletes old message (supportsDelete)", async () => {
      const caps = streamingCapabilities({ supportsMessageDelete: true, supportsRichContent: true });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ textBuffer: "Content", platformMessageId: "old-msg" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.sendRichContent).toHaveBeenCalledWith("chat-1", expect.stringContaining("[final] Content"));
      expect(transport.deleteMessage).toHaveBeenCalledWith("old-msg");
    });

    it("sends rich content and updates old message to checkmark (supportsUpdate, no delete)", async () => {
      const caps = streamingCapabilities({ supportsMessageDelete: false, supportsRichContent: true });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ textBuffer: "Content", platformMessageId: "old-msg" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.sendRichContent).toHaveBeenCalled();
      expect(transport.updateText).toHaveBeenCalledWith("old-msg", "\u2705");
      expect(transport.deleteMessage).not.toHaveBeenCalled();
    });

    it("does not delete/update old message when sendRichContent returns empty string", async () => {
      const caps = streamingCapabilities({ supportsMessageDelete: true, supportsRichContent: true });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      transport.sendRichContent = vi.fn().mockResolvedValue("");
      const session = createSession({ textBuffer: "Content", platformMessageId: "old-msg" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.deleteMessage).not.toHaveBeenCalled();
      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("does not delete/update when platformMessageId is empty", async () => {
      const caps = streamingCapabilities({ supportsRichContent: true });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ textBuffer: "Content", platformMessageId: "" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.sendRichContent).toHaveBeenCalled();
      expect(transport.deleteMessage).not.toHaveBeenCalled();
    });

    it("updates existing message in text-only mode (supportsUpdate, no rich)", async () => {
      const caps = streamingCapabilities({ supportsRichContent: false });
      renderer.renderFinalReply = vi.fn().mockReturnValue({ type: "text", content: "[text] Final" });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ textBuffer: "Content", platformMessageId: "old-msg" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.updateText).toHaveBeenCalledWith("old-msg", "[text] Final");
      expect(transport.sendText).not.toHaveBeenCalled();
      expect(transport.sendRichContent).not.toHaveBeenCalled();
    });

    it("sends as new text message in batch mode", async () => {
      renderer.renderFinalReply = vi.fn().mockReturnValue({ type: "text", content: "[text] Final" });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
      const session = createSession({ textBuffer: "Content", platformMessageId: "" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.sendText).toHaveBeenCalledWith("chat-1", "[text] Final");
    });

    it("uses fallback text when textBuffer is empty", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(renderer.renderFinalReply).toHaveBeenCalledWith(
        "\uFF08\u65E0\u6587\u672C\u56DE\u590D\uFF09",
        expect.any(String),
        undefined,
      );
    });

    it("passes sessionTitle to renderFinalReply", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Content", sessionTitle: "My Session" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(renderer.renderFinalReply).toHaveBeenCalledWith(
        "Content",
        expect.any(String),
        "My Session",
      );
    });

    it("includes tool summary in the final reply", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Result" });
      session.toolCounts.set("read", 3);
      session.toolCounts.set("write", 1);

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      const toolSummary = (renderer.renderFinalReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(toolSummary).toContain("4");
      expect(toolSummary).toContain("Read(3)");
      expect(toolSummary).toContain("Write(1)");
    });
  });

  // =========================================================================
  // 6. deleteWithRetry (tested via sendFinalReply with rich content)
  // =========================================================================

  describe("deleteWithRetry", () => {
    it("succeeds on first attempt", async () => {
      const caps = streamingCapabilities({ supportsMessageDelete: true, supportsRichContent: true });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ textBuffer: "Text", platformMessageId: "old-msg" });

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.deleteMessage).toHaveBeenCalledTimes(1);
      expect(transport.deleteMessage).toHaveBeenCalledWith("old-msg");
    });

    it("retries with backoff and succeeds on second attempt", async () => {
      const caps = streamingCapabilities({ supportsMessageDelete: true, supportsRichContent: true });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ textBuffer: "Text", platformMessageId: "old-msg" });

      let calls = 0;
      transport.deleteMessage = vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("Transient error");
      });

      ctrl.finalize(session, completedAssistantMessage());

      // First attempt fails immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.deleteMessage).toHaveBeenCalledTimes(1);

      // Wait for backoff (500ms * 1 = 500ms)
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.deleteMessage).toHaveBeenCalledTimes(2);
    });

    it("falls back to updateText after max retries exhausted", async () => {
      const caps = streamingCapabilities({ supportsMessageDelete: true, supportsRichContent: true });
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ textBuffer: "Text", platformMessageId: "old-msg" });

      transport.deleteMessage = vi.fn().mockRejectedValue(new Error("Permanent failure"));

      ctrl.finalize(session, completedAssistantMessage());

      // Run all retries: attempt 1 fails, backoff 500ms, attempt 2 fails, backoff 1000ms, attempt 3 fails
      await vi.advanceTimersByTimeAsync(0); // attempt 1
      await vi.advanceTimersByTimeAsync(500); // backoff 1, attempt 2
      await vi.advanceTimersByTimeAsync(1000); // backoff 2, attempt 3
      await vi.advanceTimersByTimeAsync(0); // let promises settle

      expect(transport.deleteMessage).toHaveBeenCalledTimes(3);
      // Falls back to updating with checkmark
      expect(transport.updateText).toHaveBeenCalledWith("old-msg", "\u2705");
    });
  });

  // =========================================================================
  // 7. formatToolSummary (tested via finalize -> sendFinalReply)
  // =========================================================================

  describe("formatToolSummary", () => {
    it("returns empty string for no tools", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });
      // toolCounts is empty by default

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      const toolSummary = (renderer.renderFinalReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(toolSummary).toBe("");
    });

    it("formats a single tool correctly", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });
      session.toolCounts.set("search", 5);

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      const toolSummary = (renderer.renderFinalReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(toolSummary).toContain("\u6267\u884C\u4E86 5 \u4E2A\u64CD\u4F5C");
      expect(toolSummary).toContain("Search(5)");
    });

    it("formats multiple tools with correct total", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });
      session.toolCounts.set("read", 2);
      session.toolCounts.set("edit", 3);

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      const toolSummary = (renderer.renderFinalReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(toolSummary).toContain("\u6267\u884C\u4E86 5 \u4E2A\u64CD\u4F5C");
      expect(toolSummary).toContain("Read(2)");
      expect(toolSummary).toContain("Edit(3)");
    });

    it("capitalizes tool names", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });
      session.toolCounts.set("bash", 1);

      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      const toolSummary = (renderer.renderFinalReply as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(toolSummary).toContain("Bash(1)");
    });
  });

  // =========================================================================
  // 8. isBatchMode and cleanupSession
  // =========================================================================

  describe("isBatchMode", () => {
    it("returns true when supportsMessageUpdate is false", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
      expect(ctrl.isBatchMode).toBe(true);
    });

    it("returns false when supportsMessageUpdate is true", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      expect(ctrl.isBatchMode).toBe(false);
    });
  });

  describe("cleanupSession", () => {
    it("clears the patchTimer and sets it to null", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const callback = vi.fn();
      const session = createSession();
      session.patchTimer = setTimeout(callback, 5000);

      ctrl.cleanupSession(session);

      expect(session.patchTimer).toBeNull();
      vi.advanceTimersByTime(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("is a no-op when patchTimer is already null", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession();
      session.patchTimer = null;

      // Should not throw
      expect(() => ctrl.cleanupSession(session)).not.toThrow();
      expect(session.patchTimer).toBeNull();
    });
  });

  // =========================================================================
  // 9. scheduleThrottledUpdate
  // =========================================================================

  describe("scheduleThrottledUpdate", () => {
    it("schedules an update when conditions are met", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      expect(session.patchTimer).not.toBeNull();
    });

    it("does not schedule when timer is already active", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ textBuffer: "Hello" });

      ctrl.applyPart(session, textPart("p1", "Hello"));
      const firstTimer = session.patchTimer;

      // Apply same part again - should not replace the timer
      ctrl.applyPart(session, textPart("p1", "Hello World"));
      expect(session.patchTimer).toBe(firstTimer);
    });

    it("does not schedule when session is completed", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ completed: true });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      expect(session.patchTimer).toBeNull();
    });

    it("does not schedule when finalReplySent is true", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ finalReplySent: true });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      expect(session.patchTimer).toBeNull();
    });

    it("does not schedule when platformMessageId is empty", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ platformMessageId: "" });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      expect(session.patchTimer).toBeNull();
    });

    it("fires the update after the throttle delay", () => {
      const ctrl = new StreamingController(transport, renderer, { throttleMs: 2000 }, streamingCapabilities());
      const session = createSession({ lastPatchTime: Date.now() - 500 });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      // Should not have fired yet
      expect(transport.updateText).not.toHaveBeenCalled();

      // Advance by the remaining delay (2000 - 500 = 1500ms)
      vi.advanceTimersByTime(1500);

      expect(transport.updateText).toHaveBeenCalledWith(
        "plat-msg-1",
        "[streaming] Hello",
      );
    });

    it("uses 0 delay when throttleMs has already elapsed", () => {
      const ctrl = new StreamingController(transport, renderer, { throttleMs: 1000 }, streamingCapabilities());
      const session = createSession({ lastPatchTime: Date.now() - 2000 });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      // Timer should fire immediately (delay = 0)
      vi.advanceTimersByTime(0);

      expect(transport.updateText).toHaveBeenCalled();
    });

    it("clears patchTimer after the timer fires", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ lastPatchTime: 0 });

      ctrl.applyPart(session, textPart("p1", "Hello"));
      expect(session.patchTimer).not.toBeNull();

      vi.advanceTimersByTime(defaultConfig.throttleMs);

      expect(session.patchTimer).toBeNull();
    });

    it("does not fire update if session becomes completed before timer fires", () => {
      const ctrl = new StreamingController(transport, renderer, { throttleMs: 2000 }, streamingCapabilities());
      const session = createSession({ lastPatchTime: 0 });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      // Mark completed before timer fires
      session.completed = true;

      vi.advanceTimersByTime(2000);

      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("does not fire update if finalReplySent becomes true before timer fires", () => {
      const ctrl = new StreamingController(transport, renderer, { throttleMs: 2000 }, streamingCapabilities());
      const session = createSession({ lastPatchTime: 0 });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      // Mark finalReplySent before timer fires
      session.finalReplySent = true;

      vi.advanceTimersByTime(2000);

      expect(transport.updateText).not.toHaveBeenCalled();
    });

    it("calls renderer.truncate on the rendered text", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ lastPatchTime: 0 });

      ctrl.applyPart(session, textPart("p1", "Hello"));
      vi.advanceTimersByTime(defaultConfig.throttleMs);

      expect(renderer.renderStreamingUpdate).toHaveBeenCalledWith("Hello");
      expect(renderer.truncate).toHaveBeenCalledWith("[streaming] Hello");
    });

    it("updates lastPatchTime when the timer fires", () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, streamingCapabilities());
      const session = createSession({ lastPatchTime: 0 });

      ctrl.applyPart(session, textPart("p1", "Hello"));

      const beforeFire = Date.now();
      vi.advanceTimersByTime(defaultConfig.throttleMs);

      expect(session.lastPatchTime).toBeGreaterThanOrEqual(beforeFire);
    });
  });

  // =========================================================================
  // Integration-style scenarios
  // =========================================================================

  describe("integration scenarios", () => {
    it("full streaming lifecycle: text -> text -> tool -> finalize", async () => {
      const caps = streamingCapabilities();
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({ lastPatchTime: 0 });

      // First text part
      ctrl.applyPart(session, textPart("p1", "Hello "));
      vi.advanceTimersByTime(defaultConfig.throttleMs);
      expect(transport.updateText).toHaveBeenCalledTimes(1);

      // Same text part updated
      vi.clearAllMocks();
      ctrl.applyPart(session, textPart("p1", "Hello World"));
      vi.advanceTimersByTime(defaultConfig.throttleMs);
      expect(transport.updateText).toHaveBeenCalledTimes(1);

      // Tool part
      ctrl.applyPart(session, toolPart("t1", "search"));
      expect(session.toolCounts.get("search")).toBe(1);

      // Finalize
      vi.clearAllMocks();
      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(session.completed).toBe(true);
      expect(session.finalReplySent).toBe(true);
      expect(renderer.renderFinalReply).toHaveBeenCalled();
    });

    it("full batch lifecycle: text -> segment transition -> finalize", async () => {
      const ctrl = new StreamingController(transport, renderer, defaultConfig, batchCapabilities());
      const session = createSession({ platformMessageId: "" });

      // First text part - no API calls in batch mode
      ctrl.applyPart(session, textPart("p1", "First segment"));
      expect(transport.sendText).not.toHaveBeenCalled();

      // New segment - flushes first segment as text
      ctrl.applyPart(session, textPart("p2", "Second segment"));
      await vi.runAllTimersAsync();
      expect(transport.sendText).toHaveBeenCalledWith("chat-1", "First segment");

      // Finalize
      vi.clearAllMocks();
      renderer.renderFinalReply = vi.fn().mockReturnValue({ type: "text", content: "[final] Second segment" });
      ctrl.finalize(session, completedAssistantMessage());
      await vi.runAllTimersAsync();

      expect(transport.sendText).toHaveBeenCalledWith("chat-1", "[final] Second segment");
    });

    it("multiple segment transitions in streaming mode", async () => {
      const caps = streamingCapabilities();
      const ctrl = new StreamingController(transport, renderer, defaultConfig, caps);
      const session = createSession({
        currentTextPartId: "p1",
        textBuffer: "Segment 1",
        platformMessageId: "msg-1",
        lastPatchTime: 0,
      });

      // Transition to segment 2
      ctrl.applyPart(session, textPart("p2", "Segment 2"));
      await vi.runAllTimersAsync();

      expect(transport.updateText).toHaveBeenCalledWith("msg-1", "Segment 1");
      expect(transport.sendText).toHaveBeenCalledWith("chat-1", "[streaming] Segment 2");
      expect(session.platformMessageId).toBe("msg-new");

      // Transition to segment 3
      vi.clearAllMocks();
      ctrl.applyPart(session, textPart("p3", "Segment 3"));
      await vi.runAllTimersAsync();

      expect(transport.updateText).toHaveBeenCalledWith("msg-new", "Segment 2");
      expect(transport.sendText).toHaveBeenCalledWith("chat-1", "[streaming] Segment 3");
    });
  });
});
