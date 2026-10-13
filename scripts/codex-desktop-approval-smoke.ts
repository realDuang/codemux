/**
 * One explicitly authorized command approval test for a selected Desktop thread.
 * Read-only unless --write is present. Only a unique stdout-only printf can be
 * approved; original native settings are restored and verified in finally.
 */
import { randomUUID } from "node:crypto";
import { CodexDesktopAdapter } from "../electron/main/engines/codex/desktop-adapter";
import {
  CodexDesktopIpcClient, type DesktopThreadSettingsPatch, type DesktopThreadStream,
} from "../electron/main/engines/codex/desktop-ipc-client";
import { DesktopStateReducer, type DesktopConversationSnapshot, type DesktopPendingRequest } from "../electron/main/engines/codex/desktop-state";
import type { ToolPart, UnifiedMessage } from "../src/types/unified";

const LIMIT_MS = 180_000;
const RESTORE_RESERVE_MS = 25_000;
const INTERRUPT_RESERVE_MS = 15_000;
// Desktop 26.1007.30912's native read-only preset uses this exact profile ID,
// on-request approval, and the user reviewer. Do not send sandboxPolicy with it.
const READ_ONLY_PROFILE = ":read-only";
interface Options { thread: string; write: boolean }
interface Peer { client: CodexDesktopIpcClient; adapter: CodexDesktopAdapter; state: DesktopStateReducer; invalidStream?: boolean }
interface View { snapshot: DesktopConversationSnapshot; raw: Record<string, unknown>; settings: Record<string, unknown> }
type Pair = [View, View];
type Outcome = { ok: true; message: UnifiedMessage } | { ok: false };
interface Flight { settled: boolean; promise: Promise<Outcome> }
class SmokeError extends Error { constructor(readonly code: string) { super(code); } }
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new SmokeError(code); }
function report(stage: string, fields: Record<string, unknown>) { console.log(JSON.stringify({ stage, ...fields })); }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(message: UnifiedMessage): string { return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim(); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function idle(views: Pair): boolean { return views.every(({ snapshot }) => !snapshot.isActive && snapshot.pendingRequests.length === 0); }

function optionsFrom(args: string[]): Options | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    report("help", { usage: "bun scripts/codex-desktop-approval-smoke.ts --thread <UUID> [--write]", readOnlyByDefault: true, timeoutSeconds: LIMIT_MS / 1000 });
    return null;
  }
  const options: Options = { thread: "", write: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    assert(!seen.has(flag), "duplicate-option");
    seen.add(flag);
    if (flag === "--thread") options.thread = args[++i] ?? "";
    else if (flag === "--write") options.write = true;
    else throw new SmokeError("unknown-option");
  }
  assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.thread), "explicit-thread-uuid-required");
  return options;
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

function readOnlyEffective(settings: Record<string, unknown>): boolean {
  const sandbox = record(settings.sandboxPolicy);
  return record(settings.activePermissionProfile).id === READ_ONLY_PROFILE
    && settings.approvalPolicy === "on-request" && settings.approvalsReviewer === "user"
    && sandbox.type === "readOnly" && sandbox.networkAccess === false;
}

function exactCommand(value: unknown, command: string): boolean {
  // Accept the literal printf or its exact non-login /bin/sh wrapper. The marker
  // contains no shell metacharacters; no generic shell parsing is necessary.
  if (Array.isArray(value)) return equal(value, ["/bin/sh", "-c", command]);
  if (typeof value !== "string") return false;
  return [command, `/bin/sh -c '${command}'`, `/bin/sh -c "${command}"`].includes(value.trim());
}
function commandApproval(request: DesktopPendingRequest, thread: string, turnId: string, command: string): boolean {
  return request.method === "item/commandExecution/requestApproval"
    && request.params.threadId === thread && request.params.turnId === turnId
    && typeof request.params.itemId === "string" && exactCommand(request.params.command, command)
    && (request.params.kind == null || request.params.kind === "command")
    && request.params.networkApprovalContext == null
    && (request.params.additionalPermissions == null || Object.keys(record(request.params.additionalPermissions)).length === 0);
}
function commandParts(view: View, previousIds: Set<string>): ToolPart[] {
  return view.snapshot.messages.flatMap((message) => previousIds.has(message.id) ? [] : message.parts.filter((part): part is ToolPart => part.type === "tool"));
}

async function run(options: Options): Promise<void> {
  const started = Date.now();
  const finalDeadline = started + LIMIT_MS;
  const checksDeadline = finalDeadline - RESTORE_RESERVE_MS - INTERRUPT_RESERVE_MS;
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
  let original: Record<string, unknown> | undefined;
  let originalProfileId: string | undefined;
  let ownerClientId: string | undefined;
  let settingsTouched = false;
  let settingsRestored = false;
  let approvalPassed = false;
  let ownFailedTurnInterrupted = false;
  let passed = false;
  let flight: Flight | undefined;
  let testTurnId: string | undefined;
  let prompt = "";
  let previousIds = new Set<string>();
  const marker = `CODEMUX_APPROVAL_${randomUUID().replaceAll("-", "")}`;
  const command = `printf ${marker}`;
  const check = <T>(action: () => Promise<T>) => bounded(action, checksDeadline, controller.signal);
  const view = (peer: Peer): View => {
    assert(peer.client.connected && !peer.invalidStream, "desktop-stream-unavailable");
    const raw = peer.state.conversationState;
    const snapshot = peer.state.snapshot;
    assert(raw && snapshot && raw.id === options.thread && snapshot.session.id === options.thread, "thread-identity-mismatch");
    return { raw, snapshot, settings: record(raw.latestThreadSettings) };
  };
  const pair = (): Pair => [view(a), view(b)];
  const waitFor = async (predicate: (views: Pair) => boolean, deadline = checksDeadline, cleanup = false): Promise<Pair> => {
    for (;;) {
      assert(cleanup || !controller.signal.aborted, "stopped-by-user");
      assert(Date.now() < deadline, "time-limit-reached");
      const views = pair();
      if (predicate(views)) return views;
      await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, 100)), deadline, cleanup ? undefined : controller.signal);
    }
  };
  function captureTestTurn(views: Pair): string | undefined {
    const ids = views.map(({ snapshot }) => snapshot.messages.find((message) => !previousIds.has(message.id) && message.role === "user" && text(message) === prompt)?.engineMeta?.codexTurnId);
    if (typeof ids[0] === "string" && ids[0] === ids[1]) {
      assert(testTurnId == null || testTurnId === ids[0], "test-turn-identity-changed");
      testTurnId = ids[0];
    }
    return testTurnId;
  }
  function assertOnlyPrintf(views: Pair) {
    for (const current of views) {
      const parts = commandParts(current, previousIds);
      assert(parts.length <= 1 && parts.every((part) => part.originalTool === "commandExecution" && exactCommand(record(part.state.input).command, command)), "unexpected-command-or-tool");
      assert(current.snapshot.pendingRequests.every((request) => request.method === "item/commandExecution/requestApproval"), "unexpected-approval-type");
    }
  }

  try {
    await check(() => Promise.all([a.adapter.start(), b.adapter.start()]));
    await check(() => Promise.all([a.adapter.attachThread(options.thread), b.adapter.attachThread(options.thread)]));
    const baseline = await waitFor((views) => equal(views[0].settings, views[1].settings));
    const required = ["model", "effort", "collaborationMode", "serviceTier", "approvalPolicy", "approvalsReviewer", "activePermissionProfile", "sandboxPolicy"];
    const completeSettings = required.every((key) => Object.hasOwn(baseline[0].settings, key));
    report(stage, { passed: true, readOnly: !options.write, bothIdle: idle(baseline), nativeSettingsEqual: true, completeSettingsBackupAvailable: completeSettings, pendingCountA: baseline[0].snapshot.pendingRequests.length, pendingCountB: baseline[1].snapshot.pendingRequests.length });
    if (options.write) {
      assert(idle(baseline), "test-thread-must-be-idle");
      assert(completeSettings, "complete-original-settings-required");
      original = structuredClone(baseline[0].settings);
      const profileId = record(original.activePermissionProfile).id;
      assert(typeof profileId === "string" && profileId.length > 0, "original-permission-profile-required");
      originalProfileId = profileId;
      const owner = await check(() => a.client.discoverOwner(options.thread));
      assert(owner, "desktop-owner-unavailable");
      ownerClientId = owner.ownerClientId;
      const collaborationMode = record(original.collaborationMode);
      assert(typeof collaborationMode.mode === "string" && typeof record(collaborationMode.settings).model === "string", "original-collaboration-settings-required");
      stage = "prepare-read-only-approval";
      settingsTouched = true;
      const prepared = await check(() => a.client.updateThreadSettings(options.thread, ownerClientId!, {
        permissions: READ_ONLY_PROFILE, approvalPolicy: "on-request", approvalsReviewer: "user", effort: "low",
        collaborationMode: { ...collaborationMode, mode: "default", settings: { ...record(collaborationMode.settings), model: String(record(collaborationMode.settings).model), reasoning_effort: "low" } },
      }));
      assert(prepared.applied, "read-only-settings-not-applied");
      await waitFor((views) => views.every((current) => readOnlyEffective(current.settings) && current.settings.effort === "low" && record(current.settings.collaborationMode).mode === "default"));
      report(stage, { passed: true, readOnlyOnBoth: true, networkDisabledOnBoth: true, onRequestOnBoth: true, userReviewerOnBoth: true });

      stage = "request-command-approval";
      const before = pair();
      assert(idle(before), "test-thread-must-be-idle");
      previousIds = new Set(before[0].snapshot.messages.map((message) => message.id));
      prompt = `This is a bounded command approval synchronization test. Call the built-in exec_command tool exactly once with cmd exactly "${command}", shell "/bin/sh", login false, and sandbox_permissions "require_escalated". Request escalation explicitly so the user can approve this one stdout-only command. Use justification "Approve the stdout-only CodeMux synchronization test." Do not use any other tools, commands, pipes, redirection, shell substitutions, files, or network. Do not retry if blocked or denied. After the command completes, reply with exactly ${marker} and nothing else.`;
      const tracked = { settled: false } as Flight;
      tracked.promise = a.adapter.sendMessage(options.thread, [{ type: "text", text: prompt }]).then(
        (message) => { tracked.settled = true; return { ok: true as const, message }; },
        () => { tracked.settled = true; return { ok: false as const }; },
      );
      flight = tracked;
      const pending = await waitFor((views) => {
        const turnId = captureTestTurn(views);
        assertOnlyPrintf(views);
        const ready = turnId != null && views.every(({ snapshot }) => snapshot.activeTurnId === turnId && snapshot.pendingRequests.length === 1
          && commandApproval(snapshot.pendingRequests[0], options.thread, turnId, command));
        if (!ready) assert(!tracked.settled, "modern-command-approval-not-produced");
        return ready;
      });
      const request = pending[0].snapshot.pendingRequests[0];
      const requestId = a.adapter.getPendingPermissions(options.thread).find((permission) => permission.metadata?.codexRequestId === request.id)?.id;
      assert(requestId != null, "adapter-approval-identity-missing");
      assert(pending[1].snapshot.pendingRequests[0].id === request.id, "approval-not-synchronized");
      assert([a, b].every((peer) => peer.adapter.getPendingPermissions(options.thread).some((permission) => permission.id === requestId && permission.options.some((option) => option.id === "allow_once"))), "allow-once-not-offered");
      report(stage, { passed: true, modernCommandApprovalOnBoth: true, exactPrintfVerified: true, pendingCountA: 1, pendingCountB: 1 });
      stage = "approve-once";
      const current = view(b).snapshot;
      assert(current.activeTurnId === testTurnId && current.pendingRequests.some((candidate) => candidate.id === request.id && commandApproval(candidate, options.thread, testTurnId!, command)), "test-approval-no-longer-current");
      await check(() => b.adapter.replyPermission(requestId, { optionId: "allow_once" }, options.thread));
      await waitFor((views) => { captureTestTurn(views); assertOnlyPrintf(views); return views.every(({ snapshot }) => snapshot.pendingRequests.length === 0); });
      const outcome = await check(() => tracked.promise);
      assert(outcome.ok && outcome.message.error == null && text(outcome.message) === marker, "command-reply-not-confirmed");
      const complete = await waitFor((views) => { assertOnlyPrintf(views); return idle(views) && equal(views[0].snapshot.messages, views[1].snapshot.messages); });
      assert(complete.every((current) => {
        const parts = commandParts(current, previousIds);
        return parts.length === 1 && parts[0].callId === request.params.itemId && parts[0].state.status === "completed"
          && typeof parts[0].state.output === "string" && parts[0].state.output.trim() === marker
          && record(parts[0].state.input).exitCode === 0;
      }), "printf-completion-not-synchronized");
      assert(complete.every(({ snapshot }) => snapshot.messages.filter((message) => !previousIds.has(message.id) && message.role === "assistant"
        && message.engineMeta?.codexTurnId === testTurnId && text(message) === marker).length === 1), "reply-marker-not-unique");
      approvalPassed = true;
      report(stage, { passed: true, pendingCountA: 0, pendingCountB: 0, completedCommandCountPerPeer: 1, markerOnBoth: true, noOtherTools: true });
    }
    passed = true;
  } catch (error) {
    report(stage, { passed: false, errorCode: error instanceof SmokeError ? error.code : "desktop-operation-failed", testTurnMayStillBeRunning: flight != null && !flight.settled });
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    if (!passed && flight && ownerClientId) {
      try {
        const current = pair();
        const turnId = captureTestTurn(current);
        if (turnId && current.every(({ snapshot }) => snapshot.isActive && snapshot.activeTurnId === turnId)) {
          const deadline = Math.min(Date.now() + INTERRUPT_RESERVE_MS, finalDeadline - RESTORE_RESERVE_MS);
          await bounded(() => a.client.interruptTurn(options.thread, ownerClientId!, turnId), deadline);
          await waitFor((views) => views.every(({ snapshot }) => !snapshot.isActive && snapshot.pendingRequests.length === 0), deadline, true);
          ownFailedTurnInterrupted = true;
          report("stop-failed-test-turn", { passed: true, onlyConfirmedTestTurn: true });
        }
      } catch {
        report("stop-failed-test-turn", { passed: false, requiresManualCheck: true });
      }
    }
    if (settingsTouched && original && originalProfileId && ownerClientId) {
      try {
        const patch: DesktopThreadSettingsPatch = { ...structuredClone(original), permissions: originalProfileId };
        // Resolve the original named profile again; the resulting effective
        // sandbox is verified against the backed-up object, never sent with it.
        delete patch.sandboxPolicy;
        const restored = await bounded(() => a.client.updateThreadSettings(options.thread, ownerClientId!, patch), finalDeadline);
        assert(restored.applied, "settings-restore-not-applied");
        await waitFor((views) => views.every((current) => equal(current.settings, original)), finalDeadline, true);
        settingsRestored = true;
        report("restore-settings", { passed: true, originalNativeSettingsEqualOnBoth: true, originalPermissionProfileRestored: true });
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
    report("complete", { passed, writeEnabled: options.write, approvalChecked: approvalPassed, settingsRestored: settingsTouched ? settingsRestored : null, ownFailedTurnInterrupted, automaticRetry: false, unrelatedTurnInterrupted: false, elapsedMs: Date.now() - started });
  }
}

try {
  const options = optionsFrom(process.argv.slice(2));
  if (options) await run(options);
} catch (error) {
  report("arguments", { passed: false, errorCode: error instanceof SmokeError ? error.code : "invalid-arguments" });
  process.exitCode = 2;
}
