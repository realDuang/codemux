import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { isExpanded, messageStore, replaceMessageParts, setExpanded, setMessageStore, toggleExpanded } from "../../../../src/stores/message";
import type { ReasoningPart, TextPart } from "../../../../src/types/unified";

const textPart = (id: string, text: string): TextPart => ({
  id, messageId: "reply", sessionId: "shared-session", type: "text", text,
});

describe("replaceMessageParts", () => {
  beforeEach(() => setMessageStore("part", reconcile({})));

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

  it("keeps a reasoning card's expansion state while its authoritative text changes", () => {
    const key = "reasoning-text-1";
    setMessageStore("expanded", reconcile({}));
    expect(isExpanded(key)).toBe(false);
    setExpanded(key, true);
    const part: ReasoningPart = { ...textPart("text-1", "Partial reasoning"), type: "reasoning" };
    replaceMessageParts("reply", [part]);
    replaceMessageParts("reply", [{ ...part, text: "Completed reasoning" }]);
    expect(isExpanded(key)).toBe(true);

    toggleExpanded(key);
    expect(isExpanded(key)).toBe(false);
    expect(messageStore.part.reply).toEqual([{ ...part, text: "Completed reasoning" }]);
  });
});
