import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import {
  isExpanded,
  messageStore,
  replaceMessageParts,
  setExpanded,
  setMessageStore,
  toggleExpanded,
} from "../../../../src/stores/message";
import type { ReasoningPart, TextPart } from "../../../../src/types/unified";

const textPart = (id: string, text: string): TextPart => ({
  id, messageId: "reply", sessionId: "shared-session", type: "text", text,
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
