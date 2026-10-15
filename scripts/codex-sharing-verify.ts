/**
 * Real CLI/IPC acceptance for the stable production Codex engine and sharing lifecycle.
 *
 * bun scripts/codex-sharing-verify.ts --write [--questions] [--hold-ms 60000]
 *
 * Without --write this only checks the existing IPC router. With --write it
 * creates exactly one dedicated test thread and retains its native history.
 * Only the Electron logger shell is replaced; adapters, CLI, model and IPC are real.
 * No existing conversation, global model setting, or Desktop process is changed.
 */
import { mock } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDesktopAdapter } from "../electron/main/engines/codex/desktop-adapter";
import { CodexDesktopIpcClient, type DesktopThreadStream } from "../electron/main/engines/codex/desktop-ipc-client";
import { DesktopStateReducer, type DesktopConversationSnapshot } from "../electron/main/engines/codex/desktop-state";
import type { UnifiedMessage, UnifiedSession } from "../src/types/unified";

const TOTAL_MS = 600_000;
const SYNC_MS = 20_000;
// A cold no-owner lookup itself consumes the native router's 10-second
// discovery interval. Allow the complete attach/restore contract to finish.
const ATTACH_MS = 60_000;
interface Options { write: boolean; questions: boolean; holdMs: number }
interface Peer { client: CodexDesktopIpcClient; adapter: CodexDesktopAdapter; state: DesktopStateReducer; streamError: boolean }
interface Flight { settled: boolean; promise: Promise<{ ok: true; message: UnifiedMessage } | { ok: false }> }
class CheckError extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new CheckError(code); }
function report(stage: string, fields: Record<string, unknown>) { console.log(JSON.stringify({ stage, ...fields })); }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function textOf(message: UnifiedMessage): string { return message.parts.flatMap((part) => part.type === "text" && !part.synthetic ? [part.text] : []).join("\n").trim(); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function pause(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(value: unknown): string {
  if (!(value instanceof Error)) return "Non-Error failure";
  return value.message.split("\n")[0]
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*\S+/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 240);
}
function settled(operation: Promise<UnifiedMessage>): Flight {
  const flight: Flight = { settled: false, promise: Promise.resolve({ ok: false }) };
  flight.promise = operation.then((message) => { flight.settled = true; return { ok: true as const, message }; }, () => { flight.settled = true; return { ok: false as const }; });
  return flight;
}
function parseOptions(args: string[]): Options | undefined {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    report("help", { usage: "bun scripts/codex-sharing-verify.ts [--write [--questions] [--hold-ms 0..600000]]", default: "read-only IPC probe", createsDedicatedThread: true, preservesNativeHistory: true });
    return;
  }
  const options: Options = { write: false, questions: false, holdMs: 0 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    check(!seen.has(flag), "duplicate-option"); seen.add(flag);
    if (flag === "--write") options.write = true;
    else if (flag === "--questions") options.questions = true;
    else if (flag === "--hold-ms") options.holdMs = Number(args[++i]);
    else throw new CheckError("unknown-option");
  }
  check(Number.isSafeInteger(options.holdMs) && options.holdMs >= 0 && options.holdMs <= 600_000, "invalid-hold-ms");
  check(options.write || (!options.questions && options.holdMs === 0), "write-flag-required");
  return options;
}

async function run(options: Options): Promise<void> {
  const probe = new CodexDesktopIpcClient({ requestTimeoutMs: 8_000 });
  try { await probe.connect(); report("router", { passed: true, readOnly: !options.write, connected: probe.connected }); }
  finally { probe.close(); }
  if (!options.write) return;

  // CodexAdapter's only Electron dependency is logging. Keep all execution paths
  // real and suppress provider details rather than exposing them in stdout.
  mock.module("../electron/main/services/logger", () => ({ codexLog: { info() {}, warn() {}, error() {}, debug() {} } }));
  const { UnifiedCodexAdapter } = await import("../electron/main/engines/codex/unified-adapter");
  let stage = "prepare";
  const started = Date.now();
  const deadline = started + TOTAL_MS + options.holdMs;
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  let runtimeErrors = 0;
  const execution = new UnifiedCodexAdapter({ sharingEnabled: false,
    onError: (_id, error) => { runtimeErrors += 1; report(stage, { event: "owner-runtime-error", message: safeError(error) }); },
    syncTimeoutMs: SYNC_MS, turnTimeoutMs: TOTAL_MS });
  const bridge = {
    get sharingEnabled() { return execution.getSessionSharing().enabled; },
    adapter: execution,
    async attachExistingSession(id: string) {
      await execution.setSessionSharing(true);
      const session = await execution.getSession(id);
      check(session, "shared-session-missing");
      return session;
    },
    async detachSharing() { await execution.setSessionSharing(false); },
    async stop() { await execution.stop(); },
  };
  let peer: Peer | undefined;
  let session: UnifiedSession | undefined;
  let threadId = "";
  let ownerId = "";
  let passed = false;
  const expected = new Map<string, string>();
  const assertRunning = () => { check(!signalReceived, "stopped-by-user"); check(Date.now() < deadline, "time-limit-reached"); };
  async function bounded<T>(action: () => Promise<T>, limit = SYNC_MS): Promise<T> {
    assertRunning();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([action(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CheckError("operation-timeout")), Math.min(limit, deadline - Date.now())); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  function snapshot(): DesktopConversationSnapshot {
    check(peer?.client.connected && !peer.streamError, "follower-stream-unavailable");
    const view = peer.state.snapshot;
    check(view && view.session.id === threadId && view.session.engineMeta?.codexThreadId === threadId, "follower-thread-identity-mismatch");
    return view;
  }
  async function waitFor(predicate: (view: DesktopConversationSnapshot) => boolean, limit = SYNC_MS): Promise<DesktopConversationSnapshot> {
    const until = Math.min(deadline, Date.now() + limit);
    for (;;) {
      assertRunning(); check(Date.now() < until, "state-timeout");
      const view = snapshot();
      if (predicate(view)) return view;
      await pause(50);
    }
  }
  async function attachPeer(): Promise<Peer> {
    const client = new CodexDesktopIpcClient({ requestTimeoutMs: SYNC_MS });
    const next: Peer = { client, adapter: new CodexDesktopAdapter({ client, syncTimeoutMs: SYNC_MS, turnTimeoutMs: TOTAL_MS }), state: new DesktopStateReducer(), streamError: false };
    client.on("stream", (stream: DesktopThreadStream) => {
      if (stream.conversationId !== threadId || stream.hostId !== "local") return;
      try { next.state.apply(stream.change); } catch { next.streamError = true; }
    });
    try {
      await next.adapter.start();
      const owner = await client.discoverOwner(threadId);
      check(owner, "test-owner-not-discovered");
      if (ownerId) check(owner.ownerClientId === ownerId, "owner-changed-unexpectedly");
      ownerId = owner.ownerClientId;
      check(ownerId !== client.clientId, "follower-must-be-independent");
      await next.adapter.attachThread(threadId);
      await client.loadCompleteHistory(threadId, ownerId);
      return next;
    } catch (error) { await next.adapter.stop(); throw error; }
  }
  function uniqueMessages(messages: UnifiedMessage[]): void {
    check(new Set(messages.map((message) => message.id)).size === messages.length, "duplicate-message-ids");
    for (const message of messages) check(new Set(message.parts.map((part) => part.id)).size === message.parts.length, "duplicate-part-ids");
  }
  function assertExpected(messages: UnifiedMessage[]): void {
    uniqueMessages(messages);
    for (const [prompt, answer] of expected) {
      check(messages.filter((message) => message.role === "user" && textOf(message) === prompt).length === 1, "missing-or-duplicate-user-history");
      check(messages.filter((message) => message.role === "assistant" && textOf(message) === answer).length === 1, "missing-or-duplicate-assistant-history");
    }
  }
  async function consistent(): Promise<DesktopConversationSnapshot> {
    return waitFor((view) => {
      if (view.isActive || view.incompleteHistory || view.pendingRequests.length) return false;
      uniqueMessages(view.messages);
      for (const [prompt, answer] of expected) {
        const users = view.messages.filter((message) => message.role === "user" && textOf(message) === prompt).length;
        const assistants = view.messages.filter((message) => message.role === "assistant" && textOf(message) === answer).length;
        check(users <= 1 && assistants <= 1, "duplicated-history");
        if (users !== 1 || assistants !== 1) return false;
      }
      return true;
    });
  }
  const sendRuntime = (prompt: string) => settled(execution.sendMessage(session!.id, [{ type: "text", text: prompt }]));
  const sendFollower = (prompt: string) => settled(peer!.adapter.sendMessage(threadId, [{ type: "text", text: prompt }]));
  async function startLongRuntimeTurn(label: string): Promise<{ flight: Flight; turnId: string; prompt: string }> {
    const prompt = `This is bounded live connection test ${label}-${randomUUID()}. Do not use any tools, files, commands, network, browser, or subagents. Output every integer from 1 through 3000 on its own line without skipping or summarizing. If a new user message arrives, follow it instead.`;
    const flight = sendRuntime(prompt);
    const until = Date.now() + 120_000;
    let turnId: string | undefined;
    while (Date.now() < until) {
      assertRunning();
      const current = await execution.getSession(session!.id);
      const messages = await execution.listMessages(session!.id);
      const user = messages.findLast(message => message.role === "user" && textOf(message) === prompt);
      if (current?.activityStatus === "running" && typeof user?.engineMeta?.codexTurnId === "string") {
        turnId = user.engineMeta.codexTurnId;
        break;
      }
      check(!flight.settled, "turn-finished-before-sharing-check");
      await pause(50);
    }
    check(turnId && !flight.settled, "ordinary-turn-not-running");
    report(stage, { event: "ordinary-turn-running", turnId, sharingEnabled: bridge.sharingEnabled, nativeStatus: "inProgress" });
    return { flight, turnId, prompt };
  }
  async function assertEcho(flight: Flight, prompt: string, marker: string, shared: boolean): Promise<void> {
    const result = await bounded(() => flight.promise, 120_000);
    check(result.ok && result.message.error == null && textOf(result.message) === marker, "echo-not-confirmed");
    expected.set(prompt, marker);
    const ownMessages = await bounded(() => execution.listMessages(session!.id));
    assertExpected(ownMessages);
    check(!ownMessages.some((message) => message.parts.some((part) => part.type === "tool")), "unexpected-tool-execution");
    if (shared) {
      const view = await consistent();
      const internal = await bridge.adapter.listMessages(threadId);
      check(digest(internal) === digest(view.messages), "shared-renderer-histories-differ");
      report(stage, { passed: true, sameNativeThread: true, exactEchoOnRuntimeAndFollower: true, uniqueHistory: true, followerMessageCount: view.messages.length, runtimeMessageCount: ownMessages.length });
    } else report(stage, { passed: true, runtimeRunning: await execution.healthCheck(), exactEcho: true, uniqueHistory: true });
  }
  async function echo(label: string, sender: "runtime" | "follower", shared = true) {
    stage = label;
    const marker = `CODEMUX_${label.replaceAll("-", "_").toUpperCase()}_${randomUUID().replaceAll("-", "")}`;
    const prompt = `This is a bounded plain-text synchronization test. Do not use any tools, commands, files, browser, network, or subagents. Reply with exactly ${marker} and nothing else.`;
    await assertEcho(sender === "runtime" ? sendRuntime(prompt) : sendFollower(prompt), prompt, marker, shared);
  }
  async function crossTurn(sender: "runtime" | "follower", interrupt: boolean) {
    stage = `${sender}-start-${interrupt ? "opposite-cancel" : "opposite-steer"}`;
    await consistent();
    const tag = randomUUID().replaceAll("-", "");
    const prompt = `This is bounded test ${tag}. Do not use any tool, files, commands, browser, network or subagents. Write the integers 1 through 400, one per line, without omitting any. If a new user message arrives, follow the new instruction instead.`;
    const flight = sender === "runtime" ? sendRuntime(prompt) : sendFollower(prompt);
    const active = await waitFor((view) => {
      const arrived = view.isActive && typeof view.activeTurnId === "string" && view.messages.some((message) => message.role === "user" && textOf(message) === prompt);
      if (!arrived) check(!flight.settled, "turn-finished-before-control-check");
      return arrived;
    });
    const turnId = active.activeTurnId!;
    if (interrupt) {
      if (sender === "runtime") await bounded(() => peer!.client.interruptTurn(threadId, ownerId, turnId));
      else await bounded(() => execution.cancelMessage(session!.id));
      await bounded(() => flight.promise, 30_000);
      const completed = await waitFor((view) => !view.isActive && view.pendingRequests.length === 0);
      const turns = record(peer!.state.conversationState).turns;
      check(Array.isArray(turns) && turns.some((turn) => record(turn).turnId === turnId && record(turn).status === "interrupted"), "same-turn-interruption-not-confirmed");
      uniqueMessages(completed.messages);
      report(stage, { passed: true, sameTurn: true, interruptedTurnId: turnId, runtimeSurvived: await execution.healthCheck() });
      return;
    }
    const marker = `CODEMUX_STEER_${tag}`;
    const steering = `Stop the number list now. Do not use tools. Reply with exactly ${marker} and nothing else.`;
    if (sender === "runtime") {
      await bounded(() => peer!.client.steerTurn(threadId, ownerId, { input: [{ type: "text", text: steering, text_elements: [] }], restoreMessage: { text: steering, context: {} }, clientUserMessageId: `codemux-sharing-verification-${tag}` }));
    } else {
      const steer = sendRuntime(steering);
      void steer.promise;
    }
    await bounded(() => flight.promise, 120_000);
    const completed = await waitFor((view) => !view.isActive && view.pendingRequests.length === 0);
    const steered = completed.messages.filter((message) => message.role === "user" && textOf(message) === steering);
    check(steered.length === 1 && steered[0].engineMeta?.codexTurnId === turnId, "steering-started-new-turn-or-duplicated");
    check(completed.messages.some((message) => message.role === "assistant" && message.engineMeta?.codexTurnId === turnId && textOf(message) === marker), "steer-marker-not-returned-in-original-turn");
    uniqueMessages(completed.messages);
    report(stage, { passed: true, sameTurn: true, steeredTurnId: turnId, exactMarker: true, runtimeSurvived: await execution.healthCheck() });
  }

  try {
    const directory = await mkdtemp(join(tmpdir(), "codemux-sharing-acceptance-"));
    await writeFile(join(directory, "AGENTS.md"), "# Bounded connectivity fixture\n\nUse no tools unless a prompt explicitly asks for one built-in user-input question. Never read or change files, run commands, browse, contact a network, or spawn agents. Return only the requested test response.\n", { mode: 0o600 });
    // The production facade starts with sharing disabled and keeps one identity through toggles.
    session = await bounded(() => execution.createSession(directory), 120_000);
    const native = session.engineMeta?.codexThreadId;
    check(typeof native === "string" && native.length > 0, "created-native-thread-id-missing"); threadId = native;
    await writeFile(join(directory, "test-thread.json"), JSON.stringify({ threadId, engineSessionId: session.id, directory, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    report(stage, { passed: true, createdThreadId: threadId, url: `codex://threads/${threadId}`, directory, independentBeforeSharing: true, nativeHistoryRetained: true });
    await execution.renameSession(session.id, "CodeMux production sharing verification");
    await echo("before-sharing", "runtime", false);

    stage = "attach-during-active-turn";
    const before = await execution.listMessages(session.id);
    const originalMessages = new Map(before.map((message) => [message.id, digest(message)]));
    const running = await startLongRuntimeTurn("attach");
    const attached = await bounded(() => bridge.attachExistingSession(session!.id), ATTACH_MS);
    check(attached.id === threadId && attached.engineMeta?.codexThreadId === threadId, "attach-changed-native-identity");
    check(await execution.healthCheck() && execution.hasSession(session.id), "attach-replaced-original-runtime");
    peer = await bounded(attachPeer, ATTACH_MS);
    check(!running.flight.settled, "ordinary-turn-finished-before-attachment");
    const attachedActive = await waitFor((view) => view.isActive && view.activeTurnId === running.turnId);
    assertExpected(attachedActive.messages);
    check(attachedActive.messages.some((message) => message.role === "user" && textOf(message) === running.prompt && message.engineMeta?.codexTurnId === running.turnId), "running-input-not-shared");
    // Stop the exact pre-existing active turn through the newly attached peer.
    await bounded(() => peer!.client.interruptTurn(threadId, ownerId, running.turnId));
    await bounded(() => running.flight.promise, 30_000);
    await consistent();
    const nativeTurns = record(peer.state.conversationState).turns;
    check(Array.isArray(nativeTurns) && nativeTurns.some((turn) => record(turn).turnId === running.turnId && record(turn).status === "interrupted"), "attached-follower-did-not-stop-original-turn");
    const after = await execution.listMessages(session.id);
    check([...originalMessages].every(([id, hash]) => after.some((message) => message.id === id && digest(message) === hash)), "attachment-mutated-existing-history");
    report(stage, { passed: true, threadId, originalEngineSessionId: session.id, sameLoadedRuntime: true, sameActiveTurnId: running.turnId, stoppedOriginalTurnFromNewFollower: true, existingHistoryVisible: true, independentFollower: true });

    await echo("runtime-to-follower", "runtime");
    await echo("follower-to-runtime", "follower");
    stage = "desktop-composer-queue";
    const queueMarker = `CODEMUX_QUEUE_${randomUUID().replaceAll("-", "")}`;
    const queuePrompt = `Do not use tools. Reply with exactly ${queueMarker} and nothing else.`;
    const queued = { id: randomUUID(), text: queuePrompt, createdAt: Date.now(),
      context: { messageThreadId: threadId, prompt: queuePrompt, turnTrigger: "composer_queue" },
      submissionIntent: "start", submission: { hostId: "local", status: "queued" },
      submissionOptions: { permissionSelection: { kind: "custom" } } };
    expected.set(queuePrompt, queueMarker);
    await peer.client.setQueuedFollowUps(threadId, ownerId, [queued]);
    const queuedHistory = await consistent();
    await peer.client.setQueuedFollowUps(threadId, ownerId, [queued]);
    await pause(200);
    check((await consistent()).messages.length === queuedHistory.messages.length, "queue-replay-duplicated-turn");
    report(stage, { passed: true, exactReply: true, replayDeduplicated: true, nativeCustomPermissions: true });

    await crossTurn("runtime", false);
    await crossTurn("follower", false);
    await crossTurn("runtime", true);
    await crossTurn("follower", true);

    stage = "follower-disconnect";
    const beforeReconnect = digest((await consistent()).messages);
    await peer.adapter.stop(); peer = undefined;
    check(await execution.healthCheck(), "follower-disconnect-stopped-runtime");
    peer = await bounded(attachPeer, ATTACH_MS);
    check(digest((await consistent()).messages) === beforeReconnect, "reconnect-lost-or-duplicated-history");
    report(stage, { passed: true, sameOwner: true, runtimeSurvived: true, historyEqualAfterReconnect: true });

    if (options.questions) {
      stage = "questions";
      // The existing real interaction harness backs up native settings, uses the
      // built-in plan question, answers from an independent peer and restores.
      const child = Bun.spawn([process.execPath, "scripts/codex-desktop-interaction-smoke.ts", "--thread", threadId, "--write", "--cancel-question"], { cwd: process.cwd(), stdout: "inherit", stderr: "pipe" });
      const stderr = new Response(child.stderr).text();
      let exitCode: number;
      try { exitCode = await bounded(() => child.exited, 190_000); }
      finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
        await stderr;
      }
      check(exitCode === 0, "real-question-acceptance-failed");
      report(stage, { passed: true, builtInQuestion: true, independentAnswerAndCancellation: true, originalSettingsRestored: true });
    } else report("questions", { checked: false, reason: "Use --questions for the real plan-mode request_user_input path." });
    report("approval", { checked: false, reason: "Core test forbids commands. Use the separate approval smoke only after confirming the test owner's permission profile support." });

    stage = "sharing-disconnect-during-active-turn";
    const disconnecting = await startLongRuntimeTurn("detach");
    await waitFor((view) => view.isActive && view.activeTurnId === disconnecting.turnId);
    await peer.adapter.stop(); peer = undefined;
    await bounded(() => bridge.detachSharing());
    check(await execution.healthCheck() && execution.hasSession(session.id), "sharing-disconnect-stopped-runtime");
    check(!disconnecting.flight.settled, "sharing-disconnect-ended-active-turn");
    await bounded(() => execution.cancelMessage(session!.id));
    const cancelled = await bounded(() => disconnecting.flight.promise, 30_000);
    check(cancelled.ok && cancelled.message.engineMeta?.codexTurnId === disconnecting.turnId && cancelled.message.error != null, "detached-runtime-could-not-control-original-turn");
    report(stage, { passed: true, runtimeSurvived: true, activeTurnSurvivedDetach: true, sameTurnCancelledDirectly: disconnecting.turnId, originalSessionRetained: true });
    // Question history may legitimately contain a question tool. The no-tool
    // assertion applies to the core matrix, so only send this final echo before
    // optional interaction coverage has introduced that history.
    if (!options.questions) await echo("after-sharing-detach", "runtime", false);
    stage = "sharing-reattach";
    ownerId = "";
    await bounded(() => bridge.attachExistingSession(session!.id), ATTACH_MS);
    peer = await bounded(attachPeer, ATTACH_MS);
    await consistent();
    report(stage, { passed: true, sameThreadId: true, allPriorHistoryPreserved: true });
    if (options.holdMs > 0) {
      stage = "hold-for-app-verification";
      report(stage, { ready: true, threadId, url: `codex://threads/${threadId}`, holdMs: options.holdMs, runtimeAlive: true });
      const until = Date.now() + options.holdMs;
      while (Date.now() < until) { assertRunning(); await pause(Math.min(1000, until - Date.now())); }
    }
    check(runtimeErrors === 0, "owner-runtime-errors-observed");
    passed = true;
  } catch (error) {
    report(stage, { passed: false, errorCode: error instanceof CheckError ? error.code : "sharing-verification-failed", errorName: error instanceof Error ? error.name : "Unknown", message: safeError(error), threadId });
    process.exitCode = signalReceived ? 130 : 1;
  } finally {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    // These instances and the thread were created by this harness. Stopping
    // them cannot terminate an unrelated or official Desktop-owned turn.
    if (peer) await peer.adapter.stop();
    await bridge.stop();
    report("complete", { passed, threadId, runtimeStopped: execution.getStatus() === "stopped", nativeHistoryRetained: true, unrelatedSessionsTouched: false, elapsedMs: Date.now() - started });
  }
}

try { const options = parseOptions(process.argv.slice(2)); if (options) await run(options); }
catch (error) { report("startup", { passed: false, errorCode: error instanceof CheckError ? error.code : "startup-failed", message: safeError(error) }); process.exitCode = 1; }
