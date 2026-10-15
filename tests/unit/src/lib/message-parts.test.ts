import { describe, expect, it } from "vitest";
import { compareParts, groupCompactTurnParts, groupTurnParts, selectResponseParts, shouldHideUnfinishedTool, upsertPart } from "../../../../src/lib/message-parts";
import type { TextPart, UnifiedMessage, UnifiedPart } from "../../../../src/types/unified";

const textPart = (id: string, order?: number, phase?: TextPart["phase"]): TextPart => ({
  id, messageId: "reply", sessionId: "session", type: "text", text: id, order, phase,
});

describe("compareParts", () => {
  it("keeps native chronology when item IDs sort in the opposite order", () => {
    const parts = [textPart("a-final", 3), textPart("z-progress", 0), textPart("m-partial", 2)];
    const lateReasoning: UnifiedPart = {
      id: "zz-reasoning", messageId: "reply", sessionId: "session", type: "reasoning", text: "Checking", order: 1,
    };

    expect([...parts, lateReasoning].sort(compareParts).map((part) => part.id))
      .toEqual(["z-progress", "zz-reasoning", "m-partial", "a-final"]);
  });

  it("retains legacy ID sorting and deterministically orders mixed metadata", () => {
    const parts = [textPart("legacy-z"), textPart("native-b", 0), textPart("legacy-a"), textPart("native-a", 0)];

    expect(parts.sort(compareParts).map((part) => part.id))
      .toEqual(["native-a", "native-b", "legacy-a", "legacy-z"]);
  });
});

describe("upsertPart", () => {
  it("produces the same native order for incremental, batched and restored parts", () => {
    const progress = textPart("z-progress", 0, "commentary");
    const partial = textPart("m-partial", 1, "partial");
    const final = textPart("a-final", 2, "final");
    const updates = [final, progress, partial, { ...progress, text: "Updated progress" }];
    const streamed: UnifiedPart[] = [];
    for (const part of updates) upsertPart(streamed, part);
    const restored = [final, partial, updates[3]].sort(compareParts);

    expect(streamed).toEqual(restored);
    expect(streamed.map((part) => part.id)).toEqual(["z-progress", "m-partial", "a-final"]);
  });

  it("updates by identity when a snapshot supplies or corrects order", () => {
    const parts: UnifiedPart[] = [textPart("a"), textPart("b"), textPart("c")];
    upsertPart(parts, textPart("c", 0));
    upsertPart(parts, textPart("a", 2));
    upsertPart(parts, textPart("b", 1));
    expect(parts.map((part) => part.id)).toEqual(["c", "b", "a"]);

    upsertPart(parts, textPart("c", 3));
    expect(parts.map((part) => part.id)).toEqual(["b", "a", "c"]);
    expect(new Set(parts.map((part) => part.id)).size).toBe(3);
  });

  it("preserves legacy insertion and replacement without explicit order", () => {
    const parts: UnifiedPart[] = [textPart("part-1"), textPart("part-3")];
    upsertPart(parts, textPart("part-2"));
    upsertPart(parts, { ...textPart("part-2"), text: "Complete text" });

    expect(parts.map((part) => part.id)).toEqual(["part-1", "part-2", "part-3"]);
    expect(parts[1]).toMatchObject({ text: "Complete text" });
  });
});

describe("selectResponseParts", () => {
  it("keeps every partial and final response in order without promoting commentary", () => {
    const parts = [
      textPart("progress", 0, "commentary"),
      textPart("partial", 1, "partial"),
      textPart("first-final", 2, "final"),
      textPart("more-progress", 3, "commentary"),
      textPart("second-final", 4, "final"),
    ];

    expect(selectResponseParts(parts).map((part) => part.id)).toEqual(["partial", "first-final", "second-final"]);
  });

  it("leaves commentary-only turns in the activity stream", () => {
    expect(selectResponseParts([textPart("Checking the repository", 0, "commentary")])).toEqual([]);
  });

  it("preserves the last visible text response for engines without phases", () => {
    const parts = [
      textPart("old-progress"),
      textPart("legacy-answer"),
      { ...textPart("synthetic-answer"), synthetic: true },
      { ...textPart("empty-answer"), text: "" },
    ];

    expect(selectResponseParts(parts).map((part) => part.id)).toEqual(["legacy-answer"]);
  });

  it("does not let a newly started empty final item hide an existing answer", () => {
    const first = textPart("first-final", 0, "final");
    const next = { ...textPart("next-final", 1, "final"), text: "" };
    expect(selectResponseParts([first, next])).toEqual([first]);
    expect(selectResponseParts([first, { ...next, text: "The next result" }]).map((part) => part.id))
      .toEqual(["first-final", "next-final"]);
  });
});

describe("groupTurnParts", () => {
  const message: UnifiedMessage = {
    id: "reply", sessionId: "session", role: "assistant", time: { created: 1 }, parts: [],
  };
  const tool: UnifiedPart = {
    id: "tool", messageId: "reply", sessionId: "session", type: "tool", order: 1,
    callId: "call", normalizedTool: "shell", originalTool: "shell", title: "Run checks",
    state: { status: "completed", input: { command: "test" }, output: "Passed", time: { start: 1, end: 2 } },
  };
  const segmentsFor = (parts: UnifiedPart[]) => groupTurnParts(parts.map((part, index) => ({ message, part, index })));

  it("keeps a partial response before intervening tools and the final response after them", () => {
    const segments = segmentsFor([textPart("partial", 0, "partial"), tool, textPart("final", 2, "final")]);

    expect(segments.map(({ kind, items }) => [kind, items.map(({ part }) => part.id)]))
      .toEqual([["response", ["partial"]], ["activity", ["tool"]], ["response", ["final"]]]);
    expect(segments.flatMap(({ items }) => items.map(({ part }) => part.id))).toEqual(["partial", "tool", "final"]);
  });

  it("groups consecutive responses without absorbing commentary or losing message ownership", () => {
    const laterMessage = { ...message, id: "reply-2" };
    const partial = textPart("partial", 0, "partial");
    const final = { ...textPart("final", 1, "final"), messageId: laterMessage.id };
    const commentary = { ...textPart("commentary", 2, "commentary"), messageId: laterMessage.id };
    const segments = groupTurnParts([
      { message, part: partial, index: 0 },
      { message: laterMessage, part: final, index: 0 },
      { message: laterMessage, part: commentary, index: 1 },
    ]);

    expect(segments.map(({ kind, items }) => [kind, items.map(({ part }) => part.id)]))
      .toEqual([["response", ["partial", "final"]], ["activity", ["commentary"]]]);
    expect(segments[0].items[1]).toEqual({ message: laterMessage, part: final, index: 0 });
  });

  it("keeps unphased engines' final text after their activity as before", () => {
    const segments = segmentsFor([textPart("legacy-progress"), textPart("legacy-answer"), tool]);
    expect(segments.map(({ kind, items }) => [kind, items.map(({ part }) => part.id)]))
      .toEqual([["activity", ["legacy-progress", "tool"]], ["response", ["legacy-answer"]]]);
  });
});

describe("shouldHideUnfinishedTool", () => {
  const message: UnifiedMessage = {
    id: "earlier-reply", sessionId: "session", role: "assistant", time: { created: 1 }, parts: [],
  };

  it.each(["pending", "running"] as const)("retains a %s tool owned by an unfinished earlier message", (status) => {
    const tool: UnifiedPart = {
      id: "tool", messageId: message.id, sessionId: "session", type: "tool",
      callId: "call", normalizedTool: "shell", originalTool: "shell", title: "Run checks",
      state: { status, input: { command: "test" }, time: { start: 1 } },
    };

    expect(shouldHideUnfinishedTool(tool, false, message)).toBe(false);
    expect(shouldHideUnfinishedTool(tool, false, { ...message, time: { created: 1, completed: 2 } })).toBe(true);
    expect(shouldHideUnfinishedTool(tool, true, { ...message, time: { created: 1, completed: 2 } })).toBe(false);
    expect(shouldHideUnfinishedTool(tool, false)).toBe(true);
    expect(shouldHideUnfinishedTool(tool, false, { ...message, id: "different-reply" })).toBe(true);
  });
});


describe("groupCompactTurnParts", () => {
  const message: UnifiedMessage = { id: "native-reply", sessionId: "session", role: "assistant", time: { created: 1 }, parts: [] };
  const sources = (parts: UnifiedPart[]) => parts.map((part, index) => ({ message, part, index }));
  const tool = (id: string, normalizedTool: "shell" | "read" | "task" = "shell"): UnifiedPart => ({
    id, messageId: message.id, sessionId: "session", type: "tool", callId: id, normalizedTool, originalTool: normalizedTool,
    title: id, kind: "other", state: { status: "completed", input: {}, output: id, time: { start: 1, end: 2, duration: 1 } },
  });

  it("keeps commentary visible and uses every assistant message as an activity boundary", () => {
    const parts = [textPart("purpose-one", 0, "commentary"), tool("read", "read"), tool("command"),
      textPart("purpose-two", 3, "commentary"), tool("next-command"), textPart("answer", 5, "final")];
    const grouped = groupCompactTurnParts(sources(parts));
    expect(grouped.map(item => item.kind)).toEqual(["message", "activity", "message", "activity", "message"]);
    expect(grouped.filter(item => item.kind === "activity").map(item => item.items.map(source => source.part.id)))
      .toEqual([["read", "command"], ["next-command"]]);
    expect(grouped.flatMap(item => item.kind === "activity" ? item.items : [item.item]).map(item => item.part)).toEqual(parts);
  });

  it("does not split a tool run at ordinary reasoning and preserves explicit standalone boundaries", () => {
    const reasoning: UnifiedPart = { id: "thought", messageId: message.id, sessionId: "session", type: "reasoning", text: "Visible summary" };
    const notice: UnifiedPart = { id: "notice", messageId: message.id, sessionId: "session", type: "system-notice", noticeType: "info", text: "Notice" };
    const result = groupCompactTurnParts(sources([tool("a"), reasoning, tool("b"), notice, tool("c"), tool("agent", "task"), tool("d")]));
    expect(result.map(item => item.kind)).toEqual(["activity", "standalone", "activity", "standalone", "activity"]);
    expect(result[0]).toMatchObject({ kind: "activity", items: [{ part: { id: "a" } }, { part: { id: "thought" } }, { part: { id: "b" } }] });
    expect(groupCompactTurnParts(sources([reasoning]))[0]).toMatchObject({ kind: "standalone", item: { part: { id: "thought" } } });
  });

  it("keeps group identity stable as later tools arrive and leaves legacy grouping unchanged", () => {
    const first = sources([textPart("progress", 0, "commentary"), tool("a")]);
    const later = [...first, ...sources([tool("b")])];
    expect(groupCompactTurnParts(first)[1].id).toBe(groupCompactTurnParts(later)[1].id);
    expect(groupTurnParts(first).map(item => item.kind)).toEqual(["activity"]);
    const legacy = sources([textPart("old-progress"), tool("read", "read"), textPart("old-answer")]);
    expect(groupTurnParts(legacy).map(item => item.kind)).toEqual(["activity", "response"]);
  });
});
