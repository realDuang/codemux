import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { openVerifiedCodexRollout } from "./rollout-reader";

const MAX_ROLLOUT_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_THREADS = 8;
const MAX_CACHED_ROLLOUT_BYTES = 8 * 1024 * 1024;

interface ReplayEntry {
  id?: string;
  aliases?: string[];
  anchor?: string;
  tool?: Record<string, unknown>;
}

interface ReplayIndex {
  signature: string;
  turns: Map<string, ReplayEntry[]>;
}

/** Restore public tool records dropped by app-server's custom-tool history decoder. */
export class CodexRolloutHistory {
  private readonly cache = new Map<string, ReplayIndex>();

  constructor(private readonly codexHome?: string) {}

  async enrich(threadId: string, thread: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (thread.id !== threadId || !Array.isArray(thread.turns) || thread.turns.length === 0) return thread;
    const opened = await openVerifiedCodexRollout(threadId, thread, this.codexHome);
    if (!opened) return thread;
    try {
      const stat = await opened.file.stat();
      if (stat.size > MAX_ROLLOUT_BYTES) return thread;
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      let index = this.cache.get(threadId);
      if (index?.signature !== signature) {
        const stream = opened.file.createReadStream({ start: 0, end: Math.max(0, stat.size - 1), autoClose: false });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try { index = { signature, turns: await readPublicToolIndex(lines) }; }
        finally { lines.close(); stream.destroy(); }
        this.cache.delete(threadId);
        if (stat.size <= MAX_CACHED_ROLLOUT_BYTES) this.cache.set(threadId, index);
        while (this.cache.size > MAX_CACHED_THREADS) this.cache.delete(this.cache.keys().next().value!);
      }
      let changed = false;
      const turns = thread.turns.map(value => {
        const turn = record(value);
        const replay = typeof turn.id === "string" ? index.turns.get(turn.id) : undefined;
        if (!replay || !Array.isArray(turn.items)) return value;
        const items = reconcileTools(turn.items, replay, turn.status === "inProgress");
        if (items === turn.items) return value;
        changed = true;
        return { ...turn, items };
      });
      return changed ? { ...thread, turns } : thread;
    } catch {
      // Native snapshots remain usable when an optional replay record is partial.
      return thread;
    } finally {
      await opened.file.close();
    }
  }
}

async function readPublicToolIndex(lines: AsyncIterable<string>): Promise<Map<string, ReplayEntry[]>> {
  const turns = new Map<string, ReplayEntry[]>();
  const calls = new Map<string, ReplayEntry>();
  let activeTurn: string | undefined;
  for await (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    const payload = record(entry.payload);
    if (entry.type === "event_msg" && payload.type === "task_started" && typeof payload.turn_id === "string") activeTurn = payload.turn_id;
    if (entry.type === "turn_context" && typeof payload.turn_id === "string") activeTurn = payload.turn_id;
    if (entry.type !== "response_item") continue;
    const metadata = record(payload.internal_chat_message_metadata_passthrough);
    const turnId = typeof metadata.turn_id === "string" ? metadata.turn_id : activeTurn;
    if (!turnId) continue;
    const list = turns.get(turnId) ?? [];
    turns.set(turnId, list);
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const anchor = messageAnchor(payload.role, payload.content);
      if (anchor) list.push({ id: string(payload.id), anchor });
      continue;
    }
    const callId = string(payload.call_id);
    if (!callId) continue;
    const callKey = `${turnId}:${callId}`;
    if ((payload.type === "custom_tool_call" || payload.type === "function_call") && typeof payload.name === "string") {
      const tool: Record<string, unknown> = {
        id: callId, type: "functionCallOutput", name: payload.name,
        arguments: payload.type === "custom_tool_call" ? payload.input : parseArguments(payload.arguments),
        status: "inProgress",
      };
      const existing = calls.get(callKey);
      if (existing) existing.tool = tool;
      else {
        const replay = { id: callId, aliases: [string(payload.id)].filter((id): id is string => Boolean(id)), tool };
        list.push(replay);
        calls.set(callKey, replay);
      }
    } else if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
      const call = calls.get(callKey);
      if (call?.tool) {
        // The call's `completed` status only completes its arguments. Execution
        // is complete when the output paired by the native call ID is persisted.
        call.tool = { ...call.tool, status: "completed", output: publicOutput(payload.output) };
        if (typeof payload.id === "string") call.aliases?.push(payload.id);
      }
    }
  }
  return turns;
}

function reconcileTools(items: unknown[], replay: ReplayEntry[], live: boolean): unknown[] {
  const sourceIds = new Set(items.flatMap(value => {
    const item = record(value);
    return [string(item.id), string(item.callId), string(item.call_id)].filter(Boolean);
  }));
  const sourceIndexes = indexSourceAnchors(items);
  const positions = replay.map(entry => {
    const byId = entry.id ? sourceIndexes.get(`id:${entry.id}`) : undefined;
    return byId != null && byId >= 0 ? byId : entry.anchor ? sourceIndexes.get(`text:${entry.anchor}`) : undefined;
  });
  const following: Array<number | undefined> = [];
  const hasFollowingAnchor: boolean[] = [];
  let nextPosition: number | undefined;
  let laterAnchor = false;
  for (let index = replay.length - 1; index >= 0; index -= 1) {
    following[index] = nextPosition;
    hasFollowingAnchor[index] = laterAnchor;
    if (positions[index] != null && positions[index]! >= 0) nextPosition = positions[index];
    laterAnchor ||= Boolean(replay[index].anchor);
  }
  const buckets = new Map<number, Record<string, unknown>[]>();
  let previousPosition: number | undefined;
  for (const [position, entry] of replay.entries()) {
    const before = previousPosition;
    if (positions[position] != null && positions[position]! >= 0) previousPosition = positions[position];
    if (!entry.tool || sourceIds.has(entry.id) || entry.aliases?.some(id => sourceIds.has(id))) continue;
    const next = following[position];
    if (next == null && !live && hasFollowingAnchor[position]) continue;
    const insertion = next ?? (before == null ? undefined : before + 1);
    // A changed/replaced native turn without a surviving public anchor must not
    // resurrect old tools merely because its turn ID was retained.
    if (insertion == null) continue;
    const bucket = buckets.get(insertion) ?? [];
    bucket.push(entry.tool!);
    buckets.set(insertion, bucket);
  }
  if (buckets.size === 0) return items;
  return items.flatMap((item, index) => [...(buckets.get(index) ?? []), item]).concat(buckets.get(items.length) ?? []);
}

function indexSourceAnchors(items: unknown[]): Map<string, number> {
  const indexes = new Map<string, number>();
  const add = (key: string, index: number) => indexes.set(key, indexes.has(key) ? -1 : index);
  items.forEach((value, index) => {
    const item = record(value);
    if (typeof item.id === "string") add(`id:${item.id}`, index);
    const anchor = item.type === "agentMessage" ? messageAnchor("assistant", [{ text: item.text }])
      : item.type === "userMessage" ? messageAnchor("user", item.content) : undefined;
    if (anchor) add(`text:${anchor}`, index);
  });
  return indexes;
}

function messageAnchor(role: unknown, content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content.map(block => string(record(block).text) ?? "").join("\n");
  return text ? createHash("sha256").update(JSON.stringify([role, text])).digest("hex") : undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

function publicOutput(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return [];
  return value.flatMap((value): Record<string, unknown>[] => {
    const block = record(value);
    if (["input_text", "output_text", "text"].includes(String(block.type)) && typeof block.text === "string") {
      return [{ type: "input_text", text: block.text }];
    }
    if (block.type === "input_image" && typeof block.image_url === "string") return [{ type: "input_image", image_url: block.image_url }];
    return [];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
