/**
 * Read-only by default. --write asks one built-in question in an explicitly
 * selected test thread; --cancel-question also tests dismissing a second one.
 * Native settings are restored in finally. No retries or implicit interruptions.
 */
import { randomUUID } from "node:crypto";
import { CodexDesktopAdapter } from "../electron/main/engines/codex/desktop-adapter";
import {
  CodexDesktopIpcClient, type DesktopCollaborationMode,
  type DesktopThreadSettingsPatch, type DesktopThreadStream,
} from "../electron/main/engines/codex/desktop-ipc-client";
import {
  DesktopStateReducer, type DesktopConversationSnapshot, type DesktopPendingRequest,
} from "../electron/main/engines/codex/desktop-state";
import type { UnifiedMessage, ToolPart } from "../src/types/unified";

const LIMIT_MS = 180_000;
const RESTORE_RESERVE_MS = 25_000;
interface Options { thread: string; write: boolean; cancelQuestion: boolean }
interface NativeSettings {
  model: string;
  effort: string | null;
  collaborationMode: DesktopCollaborationMode;
  serviceTier: string | null;
}
interface Peer { client: CodexDesktopIpcClient; adapter: CodexDesktopAdapter; state: DesktopStateReducer; invalidStream?: boolean }
interface View { snapshot: DesktopConversationSnapshot; raw: Record<string, unknown>; settings: NativeSettings }
type Pair = [View, View];
type Outcome = { ok: true; message: UnifiedMessage } | { ok: false };
interface Flight { settled: boolean; promise: Promise<Outcome> }
class SmokeError extends Error { constructor(readonly code: string) { super(code); } }
function report(stage: string, fields: Record<string, unknown>) { console.log(JSON.stringify({ stage, ...fields })); }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function text(message: UnifiedMessage): string { return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim(); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new SmokeError(code); }
function idle(pair: Pair): boolean { return pair.every((view) => !view.snapshot.isActive && view.snapshot.pendingRequests.length === 0); }

function optionsFrom(args: string[]): Options | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    report("help", { usage: "bun scripts/codex-desktop-interaction-smoke.ts --thread <UUID> [--write [--cancel-question]]", readOnlyByDefault: true, timeoutSeconds: LIMIT_MS / 1000 });
    return null;
  }
  const options: Options = { thread: "", write: false, cancelQuestion: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    assert(!seen.has(flag), "duplicate-option");
    seen.add(flag);
    if (flag === "--thread") options.thread = args[++i] ?? "";
    else if (flag === "--write") options.write = true;
    else if (flag === "--cancel-question") options.cancelQuestion = true;
    else throw new SmokeError("unknown-option");
  }
  assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.thread), "explicit-thread-uuid-required");
  assert(!options.cancelQuestion || options.write, "write-flag-required");
  return options;
}

function settingsFrom(state: Record<string, unknown>): NativeSettings {
  const settings = record(state.latestThreadSettings);
  const collaborationMode = record(settings.collaborationMode ?? state.latestCollaborationMode);
  const collaborationSettings = record(collaborationMode.settings);
  const model = settings.model ?? state.latestModel ?? collaborationSettings.model;
  const effort = Object.hasOwn(settings, "effort") ? settings.effort
    : Object.hasOwn(state, "latestReasoningEffort") ? state.latestReasoningEffort : collaborationSettings.reasoning_effort ?? null;
  const serviceTier = settings.serviceTier ?? null;
  assert(typeof model === "string" && model.length > 0 && typeof collaborationMode.mode === "string" && typeof collaborationSettings.model === "string"
    && (effort === null || typeof effort === "string") && (serviceTier === null || typeof serviceTier === "string"), "native-settings-not-synchronized");
  return { model, effort, serviceTier, collaborationMode: structuredClone(collaborationMode) as unknown as DesktopCollaborationMode };
}

async function bounded<T>(action: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  assert(!signal?.aborted, "stopped-by-user");
  assert(Date.now() < deadline, "time-limit-reached");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SmokeError("time-limit-reached")), deadline - Date.now());
      onAbort = () => reject(new SmokeError("stopped-by-user"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([action(), interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function questionTool(part: ToolPart): boolean {
  const input = record(part.state.input);
  const names = ["request_user_input", "functions.request_user_input", "requestUserInput", "toolRequestUserInput"];
  return names.includes(part.originalTool) || (part.originalTool === "dynamicToolCall" && names.includes(String(input.tool ?? input.name)));
}
function questionMatches(request: DesktopPendingRequest, thread: string, tag: string, turnId?: string): boolean {
  const questions = records(request.params.questions);
  const labels = records(questions[0]?.options).map((option) => String(option.label).replace(/\s*\(Recommended\)$/i, "").trim());
  return request.method === "item/tool/requestUserInput" && request.params.threadId === thread
    && typeof request.params.turnId === "string" && request.params.turnId === turnId
    && questions.length === 1 && typeof questions[0].id === "string"
    && typeof questions[0].question === "string" && questions[0].question.includes(tag)
    && equal(labels, ["ALPHA", "BETA"]);
}
function interruptedTurn(view: View, turnId: string): boolean {
  return records(view.raw.turns).some((turn) => turn.turnId === turnId && turn.status === "interrupted")
    || view.snapshot.messages.some((message) => message.engineMeta?.codexTurnId === turnId && typeof message.error === "string" && /interrupt/i.test(message.error));
}

async function run(options: Options): Promise<void> {
  const started = Date.now();
  const finalDeadline = started + LIMIT_MS;
  const checksDeadline = finalDeadline - RESTORE_RESERVE_MS;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  function makePeer(): Peer {
    const client = new CodexDesktopIpcClient({ requestTimeoutMs: 8_000 });
    const peer: Peer = { client, state: new DesktopStateReducer(), adapter: new CodexDesktopAdapter({ client, syncTimeoutMs: 8_000, turnTimeoutMs: checksDeadline - Date.now() }) };
    client.on("stream", (stream: DesktopThreadStream) => {
      if (stream.conversationId !== options.thread || stream.hostId !== "local") return;
      try { peer.state.apply(stream.change); } catch { peer.invalidStream = true; }
    });
    return peer;
  }
  const a = makePeer();
  const b = makePeer();
  let stage = "attach";
  let original: NativeSettings | undefined;
  let originalTierOmitted = false;
  let ownerClientId: string | undefined;
  let settingsTouched = false;
  let settingsRestored = false;
  let answerPassed = false;
  let cancelPassed = false;
  let passed = false;
  let flight: Flight | undefined;
  const check = <T>(action: () => Promise<T>) => bounded(action, checksDeadline, controller.signal);
  const view = (peer: Peer): View => {
    assert(peer.client.connected && !peer.invalidStream, "desktop-stream-unavailable");
    const snapshot = peer.state.snapshot;
    const raw = peer.state.conversationState;
    assert(snapshot && raw && snapshot.session.id === options.thread && raw.id === options.thread, "thread-identity-mismatch");
    return { snapshot, raw, settings: settingsFrom(raw) };
  };
  const pair = (): Pair => [view(a), view(b)];
  const waitFor = async (predicate: (views: Pair) => boolean, restoring = false): Promise<Pair> => {
    const deadline = restoring ? finalDeadline : checksDeadline;
    const signal = restoring ? undefined : controller.signal;
    for (;;) {
      assert(!signal?.aborted, "stopped-by-user");
      assert(Date.now() < deadline, "time-limit-reached");
      const views = pair();
      if (predicate(views)) return views;
      await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, 100)), deadline, signal);
    }
  };
  function send(prompt: string): Flight {
    const tracked = { settled: false } as Flight;
    tracked.promise = a.adapter.sendMessage(options.thread, [{ type: "text", text: prompt }]).then(
      (message) => { tracked.settled = true; return { ok: true as const, message }; },
      () => { tracked.settled = true; return { ok: false as const }; },
    );
    return tracked;
  }
  function noUnexpectedTools(views: Pair, previous: Set<string>) {
    assert(!views.some(({ snapshot }) => snapshot.messages.some((message) => !previous.has(message.id)
      && message.parts.some((part) => part.type === "tool" && !questionTool(part)))), "unexpected-tool-execution");
    assert(!views.some(({ snapshot }) => snapshot.pendingRequests.some((request) => request.method !== "item/tool/requestUserInput")), "unexpected-approval-or-request");
  }
  async function ask(cancel: boolean) {
    stage = cancel ? "cancel-question-ask" : "question-ask";
    const before = pair();
    assert(idle(before), "test-thread-must-be-idle");
    const previous = new Set(before[0].snapshot.messages.map((message) => message.id));
    const tag = `CODEMUX_QUESTION_${randomUUID().replaceAll("-", "")}`;
    const marker = `CODEMUX_BETA_${randomUUID().replaceAll("-", "")}`;
    const prompt = `This is a bounded interaction synchronization test. Use the built-in request_user_input tool exactly once to ask one optional choice question. Do not use any other tool, including update_plan, shell, files, network, or subagents. Ask exactly: "For test ${tag}, choose ALPHA or BETA." Use header "Sync", id "sync_choice", and two options in this order: ALPHA (description "Choose the first test value") and BETA (description "Choose the second test value"). If required by the tool instructions, mark ALPHA as recommended. Wait for the answer. If the user selects BETA, reply with exactly ${marker} and nothing else. Do not continue automatically or run tools after the answer.`;
    flight = send(prompt);
    const pending = await waitFor((views) => {
      noUnexpectedTools(views, previous);
      const ready = views.every(({ snapshot }) => snapshot.pendingRequests.length === 1
        && questionMatches(snapshot.pendingRequests[0], options.thread, tag, snapshot.activeTurnId));
      if (!ready) assert(!flight?.settled, "expected-question-not-produced");
      return ready;
    });
    const request = pending[0].snapshot.pendingRequests[0];
    const turnId = pending[0].snapshot.activeTurnId!;
    assert(pending[1].snapshot.activeTurnId === turnId && pending[1].snapshot.pendingRequests[0].id === request.id, "pending-question-not-synchronized");
    const requestId = a.adapter.getPendingQuestions(options.thread).find((question) => question.metadata?.codexRequestId === request.id)?.id;
    assert(requestId != null, "adapter-question-identity-missing");
    assert([a, b].every((peer) => peer.adapter.getPendingQuestions(options.thread).some((question) => question.id === requestId)), "adapter-question-not-synchronized");
    report(stage, { passed: true, pendingOnBoth: true, questionCount: 1, optionCount: 2, sameActiveTurn: true });
    stage = cancel ? "cancel-question" : "answer-question";
    const current = view(b).snapshot;
    assert(current.activeTurnId === turnId && current.pendingRequests.some((candidate) => candidate.id === request.id), "test-turn-no-longer-current");
    if (cancel) {
      // The adapter reads the same current snapshot synchronously before its
      // first await. Only the question and turn just verified above can be stopped.
      await check(() => b.adapter.rejectQuestion(requestId, options.thread));
      await waitFor((views) => {
        noUnexpectedTools(views, previous);
        return idle(views) && views.every((item) => interruptedTurn(item, turnId));
      });
      assert([a, b].every((peer) => peer.adapter.getPendingQuestions(options.thread).length === 0), "cancelled-question-still-pending");
      cancelPassed = true;
      report(stage, { passed: true, sameTurnInterruptedOnBoth: true, pendingCountA: 0, pendingCountB: 0, noOtherTools: true });
      return;
    }
    await check(() => b.adapter.replyQuestion(requestId, [["BETA"]], options.thread));
    await waitFor((views) => { noUnexpectedTools(views, previous); return views.every(({ snapshot }) => snapshot.pendingRequests.length === 0); });
    const outcome = await check(() => flight!.promise);
    assert(outcome.ok && outcome.message.error == null && text(outcome.message) === marker, "question-answer-not-confirmed");
    const completed = await waitFor((views) => {
      noUnexpectedTools(views, previous);
      return idle(views) && equal(views[0].snapshot.messages, views[1].snapshot.messages);
    });
    assert(completed.every(({ snapshot }) => snapshot.messages.filter((message) => !previous.has(message.id)
      && message.role === "assistant" && message.engineMeta?.codexTurnId === turnId && text(message) === marker).length === 1), "answer-marker-not-unique-or-synchronized");
    assert([a, b].every((peer) => peer.adapter.getPendingQuestions(options.thread).length === 0), "answered-question-still-pending");
    answerPassed = true;
    report(stage, { passed: true, answerOnBoth: true, uniqueReplyCountPerPeer: 1, pendingCountA: 0, pendingCountB: 0, noOtherTools: true });
  }

  try {
    await check(() => Promise.all([a.adapter.start(), b.adapter.start()]));
    await check(() => Promise.all([a.adapter.attachThread(options.thread), b.adapter.attachThread(options.thread)]));
    const baseline = await waitFor((views) => equal(views[0].settings, views[1].settings));
    report(stage, { passed: true, readOnly: !options.write, settingsEqual: true, bothIdle: idle(baseline), pendingCountA: baseline[0].snapshot.pendingRequests.length, pendingCountB: baseline[1].snapshot.pendingRequests.length });
    if (options.write) {
      assert(idle(baseline), "test-thread-must-be-idle");
      original = structuredClone(baseline[0].settings);
      originalTierOmitted = !Object.hasOwn(record(baseline[0].raw.latestThreadSettings), "serviceTier");
      const owner = await check(() => a.client.discoverOwner(options.thread));
      assert(owner, "desktop-owner-unavailable");
      ownerClientId = owner.ownerClientId;
      stage = "prepare-plan-question";
      settingsTouched = true;
      await check(() => a.adapter.setMode(options.thread, "plan"));
      await check(() => a.adapter.setReasoningEffort(options.thread, "low"));
      await waitFor((views) => views.every((item) => item.settings.collaborationMode.mode === "plan" && item.settings.effort === "low"));
      report(stage, { passed: true, planOnBoth: true, lowEffortOnBoth: true });
      await ask(false);
      if (options.cancelQuestion) await ask(true);
    }
    passed = true;
  } catch (error) {
    report(stage, { passed: false, errorCode: error instanceof SmokeError ? error.code : "desktop-operation-failed", testTurnMayStillBeRunning: flight != null && !flight.settled });
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    if (settingsTouched && original && ownerClientId) {
      try {
        const patch: DesktopThreadSettingsPatch = structuredClone(original);
        const response = await bounded(() => a.client.updateThreadSettings(options.thread, ownerClientId!, patch), finalDeadline);
        assert(response.applied, "settings-restore-not-applied");
        await waitFor((views) => views.every((item) => equal(item.settings, original)), true);
        settingsRestored = true;
        report("restore-settings", { passed: true, restoredOnBoth: true, nativeEffortPreserved: true, omittedServiceTierRestoredAsNull: originalTierOmitted });
      } catch (error) {
        passed = false;
        process.exitCode = process.exitCode || 1;
        report("restore-settings", { passed: false, errorCode: error instanceof SmokeError ? error.code : "settings-restore-failed", requiresManualCheck: true });
      }
    }
    controller.abort();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await Promise.allSettled([a.adapter.stop(), b.adapter.stop()]);
    report("complete", { passed, writeEnabled: options.write, answerChecked: answerPassed, cancellationChecked: cancelPassed, settingsRestored: settingsTouched ? settingsRestored : null, automaticRetry: false, unrelatedTurnInterrupted: false, elapsedMs: Date.now() - started });
  }
}

try {
  const options = optionsFrom(process.argv.slice(2));
  if (options) await run(options);
} catch (error) {
  report("arguments", { passed: false, errorCode: error instanceof SmokeError ? error.code : "invalid-arguments" });
  process.exitCode = 2;
}
