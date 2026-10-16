import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import {
  isExpanded,
  consumeQueuedPreview,
  messageStore,
  invalidateMessageSteps,
  replaceFetchedMessageSteps,
  replaceMessageParts,
  replaceMessageProjection,
  setExpanded,
  setMessageStore,
  toggleExpanded,
} from "../../../../src/stores/message";
import type { ReasoningPart, TextPart, ToolPart, UnifiedMessage } from "../../../../src/types/unified";

const textPart = (id: string, text: string): TextPart => ({
  id, messageId: "reply", sessionId: "shared-session", type: "text", text,
});

describe("consumeQueuedPreview", () => {
  beforeEach(() => {
    setMessageStore("queued", reconcile({}));
    setMessageStore("queued", "session", [
      { id: "client-first", text: "First input", enqueuedAt: 1 },
      { id: "client-second", text: "Second input", enqueuedAt: 2 },
    ]);
  });

  it("removes the acknowledged input when native acceptance completes out of order", () => {
    consumeQueuedPreview("session", "client-second");
    expect(messageStore.queued.session.map((message) => message.id)).toEqual(["client-first"]);
    consumeQueuedPreview("session", "client-first");
    expect(messageStore.queued.session).toEqual([]);
  });

  it("ignores another client's acknowledgment and repeated acceptance events", () => {
    consumeQueuedPreview("session", "other-client");
    expect(messageStore.queued.session).toHaveLength(2);
    consumeQueuedPreview("session", "client-first");
    consumeQueuedPreview("session", "client-first");
    expect(messageStore.queued.session.map((message) => message.id)).toEqual(["client-second"]);
  });

  it("retains FIFO behavior for adapters that do not provide submission correlation", () => {
    consumeQueuedPreview("session");
    expect(messageStore.queued.session.map((message) => message.id)).toEqual(["client-second"]);
    consumeQueuedPreview("missing");
    expect(messageStore.queued.missing).toBeUndefined();
  });
});

describe("replaceMessageProjection", () => {
  const tool = (id: string, output: string): ToolPart => ({
    id, messageId: "reply", sessionId: "shared-session", type: "tool",
    callId: id, originalTool: "read", normalizedTool: "read", title: "Read", kind: "read",
    state: { status: "completed", input: {}, output, time: { start: 1, end: 2, duration: 1 } },
  });
  const projection = (stepCount: number): UnifiedMessage => ({
    id: "reply", sessionId: "shared-session", role: "assistant", time: { created: 1, completed: 2 },
    stepCount, parts: [textPart("answer", "Final answer")],
  });

  beforeEach(() => {
    setMessageStore("part", reconcile({}));
    setMessageStore("stepsLoaded", reconcile({}));
    setMessageStore("stepsVersion", reconcile({}));
  });

  it("keeps loaded steps visible while refreshing a lightweight projection, then replaces the step partition", () => {
    replaceMessageParts("reply", [tool("old", "Original"), tool("removed", "Obsolete")]);
    setMessageStore("stepsLoaded", "reply", true);

    replaceMessageProjection(projection(1));
    expect(messageStore.part.reply.map((part) => part.id)).toEqual(["answer", "old", "removed"]);
    expect(messageStore.stepsLoaded.reply).toBe(false);
    const version = messageStore.stepsVersion.reply;

    expect(replaceFetchedMessageSteps("reply", [tool("old", "Corrected")], version)).toBe("applied");
    expect(messageStore.part.reply).toEqual([textPart("answer", "Final answer"), tool("old", "Corrected")]);
    expect(messageStore.stepsLoaded.reply).toBe(true);
  });

  it("clears removed native steps immediately and rejects an older lazy response", () => {
    replaceMessageParts("reply", [tool("removed", "Old")]);
    replaceMessageProjection(projection(1));
    const oldVersion = messageStore.stepsVersion.reply;

    replaceMessageProjection(projection(0));

    expect(messageStore.part.reply).toEqual([textPart("answer", "Final answer")]);
    expect(messageStore.stepsLoaded.reply).toBe(true);
    expect(replaceFetchedMessageSteps("reply", [tool("removed", "Old")], oldVersion)).toBe("superseded");
    expect(messageStore.part.reply).toEqual([textPart("answer", "Final answer")]);
  });

  it("retries an obsolete lazy response only when a newer projection still needs its steps", () => {
    replaceMessageProjection(projection(1));
    const version = messageStore.stepsVersion.reply;
    replaceMessageProjection(projection(2));

    expect(replaceFetchedMessageSteps("reply", [tool("old", "Stale")], version)).toBe("retry");
    expect(messageStore.stepsLoaded.reply).toBe(false);
    expect(messageStore.part.reply).toEqual([textPart("answer", "Final answer")]);
  });

  it("does not overwrite a newer ordinary-engine step notification with an in-flight lazy response", () => {
    replaceMessageParts("reply", [tool("tool", "Before request")]);
    const version = messageStore.stepsVersion.reply ?? 0;
    replaceMessageParts("reply", [tool("tool", "Live result"), textPart("answer", "Live answer")]);
    invalidateMessageSteps("reply");
    setMessageStore("stepsLoaded", "reply", true);

    expect(replaceFetchedMessageSteps("reply", [tool("tool", "Stale persisted result")], version)).toBe("superseded");
    expect(messageStore.stepsLoaded.reply).toBe(true);
    expect(messageStore.part.reply).toEqual([textPart("answer", "Live answer"), tool("tool", "Live result")]);
    const current = messageStore.stepsVersion.reply;
    expect(replaceFetchedMessageSteps("reply", [tool("tool", "Live result")], current)).toBe("applied");
    expect(messageStore.part.reply).toEqual([textPart("answer", "Live answer"), tool("tool", "Live result")]);
  });
});

describe("replaceMessageParts", () => {
  beforeEach(() => {
    setMessageStore("part", reconcile({}));
    setMessageStore("expanded", reconcile({}));
  });

  it("updates the same displayed part from empty through partial to final text", () => {
    for (const text of ["", "Working", "The complete assistant response."]) {
      replaceMessageParts("reply", [textPart("text-1", text)]);
      expect(messageStore.part.reply).toEqual([textPart("text-1", text)]);
    }
  });

  it("removes parts omitted from the next snapshot and supports an empty snapshot", () => {
    replaceMessageParts("reply", [textPart("text-1", "Old text"), textPart("text-2", "Removed text")]);
    replaceMessageParts("reply", [textPart("text-1", "Revised text")]);
    expect(messageStore.part.reply).toEqual([textPart("text-1", "Revised text")]);

    replaceMessageParts("reply", []);
    expect(messageStore.part.reply).toEqual([]);
  });

  it("sorts a copied snapshot without changing other messages or the incoming array", () => {
    const other = { ...textPart("other-text", "Other engine output"), messageId: "other" };
    setMessageStore("part", "other", [other]);
    const incoming = [textPart("text-2", "Second"), textPart("text-1", "First")];

    replaceMessageParts("reply", incoming);

    expect(messageStore.part.reply.map((part) => part.id)).toEqual(["text-1", "text-2"]);
    expect(incoming.map((part) => part.id)).toEqual(["text-2", "text-1"]);
    expect(messageStore.part.other).toEqual([other]);
  });

  it("restores explicit item order and phases from an authoritative snapshot", () => {
    const final: TextPart = { ...textPart("a-final", "The answer"), order: 2, phase: "final" };
    const partial: TextPart = { ...textPart("m-partial", "An initial result"), order: 1, phase: "partial" };
    const commentary: TextPart = { ...textPart("z-progress", "Checking"), order: 0, phase: "commentary" };

    replaceMessageParts("reply", [final, commentary, partial]);

    expect(messageStore.part.reply).toEqual([commentary, partial, final]);
    replaceMessageParts("reply", [{ ...commentary, text: "Checked" }, final]);
    expect(messageStore.part.reply).toEqual([{ ...commentary, text: "Checked" }, final]);
  });

  it("preserves independent disclosure choices when replayed parts disappear and return", () => {
    const first: ReasoningPart = { ...textPart("analysis-1", "Initial analysis"), type: "reasoning" };
    const second: ReasoningPart = { ...textPart("analysis-2", "Initial verification"), type: "reasoning" };
    const firstKey = `reasoning-${first.id}`;
    const secondKey = `reasoning-${second.id}`;
    replaceMessageParts("reply", [first, second]);

    expect(isExpanded(firstKey)).toBe(false);
    expect(isExpanded(secondKey)).toBe(false);
    setExpanded(firstKey, true);
    setExpanded(secondKey, true);
    toggleExpanded(secondKey);

    const replayedFirst: ReasoningPart = { ...first, text: "Completed analysis", completed: true };
    replaceMessageParts("reply", [replayedFirst]);

    expect(messageStore.part.reply).toEqual([replayedFirst]);
    expect(isExpanded(firstKey)).toBe(true);
    expect(isExpanded(secondKey)).toBe(false);
    expect(messageStore.expanded[secondKey]).toBe(false);

    const replayedSecond: ReasoningPart = { ...second, text: "Completed verification", completed: true };
    replaceMessageParts("reply", [replayedSecond, replayedFirst]);

    expect(messageStore.part.reply).toEqual([replayedFirst, replayedSecond]);
    expect(isExpanded(firstKey)).toBe(true);
    expect(isExpanded(secondKey)).toBe(false);
    expect(messageStore.expanded[secondKey]).toBe(false);

    toggleExpanded(firstKey);
    toggleExpanded(secondKey);
    expect(isExpanded(firstKey)).toBe(false);
    expect(isExpanded(secondKey)).toBe(true);
  });
});
