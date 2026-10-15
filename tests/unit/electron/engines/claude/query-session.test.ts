import { beforeEach, describe, expect, it, vi } from "vitest";

const { sdkQueryMock } = vi.hoisted(() => ({ sdkQueryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdkQueryMock }));

import { createClaudeSession, resumeClaudeSession } from "../../../../../electron/main/engines/claude/query-session";

/**
 * Fake Query: consumes the streaming-input prompt and, for every user message,
 * yields `system:init → assistant → result` like the CLI does for one turn.
 */
function makeFakeQuery(prompt: AsyncIterable<any>) {
  const received: any[] = [];
  async function* gen() {
    for await (const userMsg of prompt) {
      received.push(userMsg);
      yield { type: "system", subtype: "init", session_id: "cc-123" };
      yield { type: "assistant", message: { content: [{ type: "text", text: `echo ${received.length}` }] } };
      yield { type: "result", subtype: "success" };
    }
  }
  const iterator = gen();
  return Object.assign(iterator, { received, close: vi.fn(), interrupt: vi.fn() });
}

describe("query-session (persistent session on query())", () => {
  let fake: ReturnType<typeof makeFakeQuery>;

  beforeEach(() => {
    sdkQueryMock.mockReset();
    sdkQueryMock.mockImplementation(({ prompt }: any) => {
      fake = makeFakeQuery(prompt);
      return fake;
    });
  });

  it("passes the full options object to query() with a streaming prompt", () => {
    const options = { model: "m", includePartialMessages: true, settingSources: ["user"] } as any;
    createClaudeSession(options);
    expect(sdkQueryMock).toHaveBeenCalledTimes(1);
    const arg = sdkQueryMock.mock.calls[0][0];
    expect(arg.options).toBe(options);
    expect(typeof arg.prompt[Symbol.asyncIterator]).toBe("function");
  });

  it("runs multiple turns over one process, each stream() ending at its result", async () => {
    const session = createClaudeSession({ model: "m" } as any);

    await session.send("first");
    const turn1: any[] = [];
    for await (const m of session.stream()) turn1.push(m);
    expect(turn1.map((m) => m.type)).toEqual(["system", "assistant", "result"]);
    expect(session.sessionId).toBe("cc-123");

    await session.send("second");
    const turn2: any[] = [];
    for await (const m of session.stream()) turn2.push(m);
    expect(turn2[1].message.content[0].text).toBe("echo 2");

    expect(sdkQueryMock).toHaveBeenCalledTimes(1);
    expect(fake.received[0]).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    });
  });

  it("forwards SDKUserMessage payloads unchanged (e.g. image blocks)", async () => {
    const session = createClaudeSession({ model: "m" } as any);
    const payload = { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "image" }] } } as any;
    await session.send(payload);
    for await (const _ of session.stream()) { /* drain */ }
    expect(fake.received[0]).toBe(payload);
  });

  it("resume sets options.resume and exposes the id before the first turn", () => {
    const session = resumeClaudeSession("cc-old", { model: "m" } as any);
    expect(sdkQueryMock.mock.calls[0][0].options.resume).toBe("cc-old");
    expect(session.sessionId).toBe("cc-old");
  });

  it("rejects sends after close() and exposes the underlying query", async () => {
    const session = createClaudeSession({ model: "m" } as any);
    expect(session.query).toBe(fake);
    session.close();
    await expect(session.send("late")).rejects.toThrow("closed");
  });
});
