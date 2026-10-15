import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexRolloutHistory } from "../../../../../electron/main/engines/codex/rollout-history";
import { convertThreadToMessages } from "../../../../../electron/main/engines/codex/converters";

const id = "01a13ed7-4a99-7d30-8b50-2d1b2df28866";
const turnId = "01a13ed7-75c9-7723-8684-a64a67515195";
let home: string;
let path: string;

function response(payload: Record<string, unknown>) {
  return { type: "response_item", payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turnId } } };
}

function records(output = true) {
  return [
    { type: "session_meta", payload: { id, cli_version: "0.162.1" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    response({ type: "message", id: "native-user", role: "user", content: [{ type: "input_text", text: "Run bounded test" }] }),
    response({ type: "reasoning", id: "hidden", encrypted_content: "NEVER_VISIBLE", content: [{ text: "PRIVATE_REASONING" }] }),
    response({ type: "custom_tool_call", id: "native-call", call_id: "call-exec", name: "exec", status: "completed", input: 'const result = await tools.exec_command({cmd:"printf OK"}); text(result.output);' }),
    ...(output ? [response({ type: "custom_tool_call_output", call_id: "call-exec", output: [{ type: "input_text", text: "OK" }, { type: "encrypted_content", encrypted_content: "NEVER_VISIBLE" }] })] : []),
    response({ type: "message", id: "native-final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Finished" }] }),
  ];
}

function snapshot(status = "completed") {
  return { id, path, turns: [{ id: turnId, status, items: [
    { type: "userMessage", id: "item-1", content: [{ type: "text", text: "Run bounded test" }] },
    { type: "agentMessage", id: "item-2", phase: "final_answer", text: "Finished" },
  ] }] };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codemux-rollout-history-"));
  path = join(home, "sessions", "2026", "10", "15", `rollout-2026-10-15T17-14-19-${id}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records().map(value => JSON.stringify(value)).join("\n") + "\n");
});

afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("CodexRolloutHistory.enrich", () => {
  it("restores missing custom exec output in native order without hidden reasoning", async () => {
    const source = snapshot();
    const enriched = await new CodexRolloutHistory(home).enrich(id, source);
    const turn = (enriched.turns as typeof source.turns)[0];
    expect(turn.items.map(item => item.id)).toEqual(["item-1", "call-exec", "item-2"]);
    expect(turn.items[1]).toMatchObject({ type: "functionCallOutput", name: "exec", status: "completed", output: [{ type: "input_text", text: "OK" }] });
    expect(source.turns[0].items).toHaveLength(2);
    const messages = convertThreadToMessages("session", { thread: enriched });
    expect(messages.flatMap(message => message.parts).filter(part => part.type === "tool")).toMatchObject([{
      callId: "call-exec", state: { status: "completed", output: "OK", input: { input: 'const result = await tools.exec_command({cmd:"printf OK"}); text(result.output);' } },
    }]);
    expect(JSON.stringify(enriched)).not.toMatch(/NEVER_VISIBLE|PRIVATE_REASONING/);
  });

  it("reconciles a completed output after a live read and after a fresh history load", async () => {
    await writeFile(path, records(false).map(value => JSON.stringify(value)).join("\n") + "\n");
    const reader = new CodexRolloutHistory(home);
    const live = await reader.enrich(id, snapshot("inProgress"));
    expect(JSON.stringify(live)).toContain('"status":"inProgress"');
    await appendFile(path, JSON.stringify(response({ type: "custom_tool_call_output", call_id: "call-exec", output: "Completed after approval" })) + "\n");
    const completed = await reader.enrich(id, snapshot());
    const reloaded = await new CodexRolloutHistory(home).enrich(id, snapshot());
    expect(completed).toEqual(reloaded);
    expect(JSON.stringify(completed)).toContain("Completed after approval");
  });

  it("keeps current source replacements authoritative and never recreates absent turns", async () => {
    const source = snapshot();
    const current = { id: "call-exec", type: "functionCallOutput", text: "Source replacement" };
    source.turns[0].items.splice(1, 0, current);
    const reader = new CodexRolloutHistory(home);
    expect(await reader.enrich(id, source)).toBe(source);
    current.id = "native-call";
    expect(await reader.enrich(id, source)).toBe(source);
    const noTurns = { id, path, turns: [] };
    expect(await reader.enrich(id, noTurns)).toBe(noTurns);
    const replaced = { id, path, turns: [{ id: turnId, status: "completed", items: [{ id: "new", type: "agentMessage", text: "Replaced" }] as Record<string, unknown>[] }] };
    expect(await reader.enrich(id, replaced)).toBe(replaced);
    replaced.turns[0].items.unshift(source.turns[0].items[0]);
    expect(await reader.enrich(id, replaced)).toBe(replaced);
  });

  it("restores function arguments and repeated tool calls with stable IDs once", async () => {
    const entries = records();
    entries.splice(5, 0,
      response({ type: "function_call", call_id: "call-function", name: "read_file", arguments: '{"path":"src/main.ts"}' }),
      response({ type: "function_call_output", call_id: "call-function", output: "file content" }),
    );
    await writeFile(path, entries.map(value => JSON.stringify(value)).join("\n") + "\n");
    const reader = new CodexRolloutHistory(home);
    const result = await reader.enrich(id, snapshot());
    expect((result.turns as Array<{ items: Array<{ id: string }> }>)[0].items.map(item => item.id)).toEqual(["item-1", "call-exec", "call-function", "item-2"]);
    expect(await reader.enrich(id, result)).toBe(result);
    expect(JSON.stringify(result)).toContain('"arguments":{"path":"src/main.ts"}');
  });

  it("rejects foreign metadata and tolerates a partially appended record", async () => {
    const reader = new CodexRolloutHistory(home);
    const source = snapshot();
    expect(await reader.enrich("another-thread", source)).toBe(source);
    await appendFile(path, '{"type":');
    expect(JSON.stringify(await reader.enrich(id, source))).toContain("call-exec");
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "foreign", cli_version: "0.162.1" } }) + "\n");
    expect(await reader.enrich(id, source)).toBe(source);
  });
});
