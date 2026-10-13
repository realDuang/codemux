/**
 * Bounded feature checks for one explicitly selected Desktop-owned test thread.
 * Defaults to read-only. --write restores native settings in finally; --image
 * additionally appends one image turn. No timeout retries or automatic stops.
 */
import { CodexDesktopAdapter } from "../electron/main/engines/codex/desktop-adapter";
import {
  CodexDesktopIpcClient,
  type DesktopCollaborationMode,
  type DesktopThreadSettingsPatch,
  type DesktopThreadStream,
} from "../electron/main/engines/codex/desktop-ipc-client";
import { DesktopStateReducer } from "../electron/main/engines/codex/desktop-state";
import type { UnifiedMessage, UnifiedSession } from "../src/types/unified";

const TOTAL_LIMIT_MS = 180_000;
const RESTORE_RESERVE_MS = 25_000;
// A 32 x 32 opaque red PNG. Only this built-in image is sent by --image.
const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const IMAGE_REPLY = "CODEMUX_IMAGE_RED";

interface Options { thread: string; write: boolean; image: boolean }
interface NativeSettings {
  model: string;
  effort: string | null;
  collaborationMode: DesktopCollaborationMode;
  serviceTier: string | null;
}
interface Peer {
  client: CodexDesktopIpcClient;
  adapter: CodexDesktopAdapter;
  state: DesktopStateReducer;
  streamError?: boolean;
}
interface View { session: UnifiedSession; settings: NativeSettings; messages: UnifiedMessage[] }
interface Pair { a: View; b: View }

class SmokeError extends Error {
  constructor(readonly code: string) { super(code); }
}

function report(stage: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ stage, ...fields }));
}

function parseOptions(args: string[]): Options | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    report("help", {
      usage: "bun scripts/codex-desktop-feature-smoke.ts --thread <UUID> [--write [--image]]",
      defaultMode: "read-only", timeoutSeconds: TOTAL_LIMIT_MS / 1000,
      cleanup: "Restore original native settings and detach; never retry or interrupt a turn.",
    });
    return null;
  }
  const options: Options = { thread: "", write: false, image: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new SmokeError("duplicate-option");
    seen.add(flag);
    if (flag === "--thread") options.thread = args[++index] ?? "";
    else if (flag === "--write") options.write = true;
    else if (flag === "--image") options.image = true;
    else throw new SmokeError("unknown-option");
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.thread)) throw new SmokeError("explicit-thread-uuid-required");
  if (options.image && !options.write) throw new SmokeError("write-flag-required");
  return options;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nativeSettings(state: Record<string, unknown>): NativeSettings {
  const settings = record(state.latestThreadSettings);
  const collaboration = record(settings.collaborationMode ?? state.latestCollaborationMode);
  const collaborationSettings = record(collaboration.settings);
  const model = settings.model ?? state.latestModel ?? collaborationSettings.model;
  const effort = Object.hasOwn(settings, "effort") ? settings.effort
    : Object.hasOwn(state, "latestReasoningEffort") ? state.latestReasoningEffort
      : collaborationSettings.reasoning_effort ?? null;
  const serviceTier = settings.serviceTier ?? null;
  if (typeof model !== "string" || !model || typeof collaboration.mode !== "string"
    || typeof collaborationSettings.model !== "string"
    || (effort !== null && typeof effort !== "string")
    || (serviceTier !== null && typeof serviceTier !== "string")) throw new SmokeError("native-settings-not-synchronized");
  // Preserve the native collaboration object, including developer instructions,
  // null values, and effort strings such as ultra. Never print that object.
  return { model, effort, serviceTier, collaborationMode: structuredClone(collaboration) as unknown as DesktopCollaborationMode };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function equal(a: unknown, b: unknown): boolean { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function text(message: UnifiedMessage): string { return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim(); }
function idle(pair: Pair): boolean { return pair.a.session.activityStatus === "idle" && pair.b.session.activityStatus === "idle"; }
function summary(settings: NativeSettings) {
  return { model: settings.model, effort: settings.effort, mode: settings.collaborationMode.mode, serviceTier: settings.serviceTier };
}
function requireApplied(response: { applied: boolean }, code: string): void {
  if (!response.applied) throw new SmokeError(code);
}

async function bounded<T>(action: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new SmokeError("stopped-by-user");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SmokeError("time-limit-reached");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SmokeError("time-limit-reached")), remaining);
      onAbort = () => reject(new SmokeError("stopped-by-user"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([action(), interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function run(options: Options): Promise<void> {
  const started = Date.now();
  const finalDeadline = started + TOTAL_LIMIT_MS;
  const checksDeadline = finalDeadline - RESTORE_RESERVE_MS;
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const makePeer = (): Peer => {
    const client = new CodexDesktopIpcClient({ requestTimeoutMs: 8_000 });
    const peer: Peer = {
      client, state: new DesktopStateReducer(),
      adapter: new CodexDesktopAdapter({ client, syncTimeoutMs: 8_000, turnTimeoutMs: checksDeadline - Date.now() }),
    };
    client.on("stream", (stream: DesktopThreadStream) => {
      if (stream.conversationId !== options.thread || stream.hostId !== "local") return;
      try { peer.state.apply(stream.change); } catch { peer.streamError = true; }
    });
    return peer;
  };
  const a = makePeer();
  const b = makePeer();
  let stage = "attach";
  let original: NativeSettings | undefined;
  let originalTierOmitted = false;
  let ownerClientId: string | undefined;
  let settingsWriteAttempted = false;
  let settingsRestored = false;
  let imageInFlight = false;
  let imagePassed = false;
  let passed = false;

  const read = async (peer: Peer): Promise<View> => {
    if (peer.streamError) throw new SmokeError("invalid-state-stream");
    const [session, messages] = await Promise.all([peer.adapter.getSession(options.thread), peer.adapter.listMessages(options.thread)]);
    if (!session || session.id !== options.thread || session.engineMeta?.codexThreadId !== options.thread) throw new SmokeError("thread-identity-mismatch");
    const state = peer.state.conversationState;
    if (!state || state.id !== options.thread) throw new SmokeError("snapshot-identity-mismatch");
    return { session, messages, settings: nativeSettings(state) };
  };
  const readPair = async (): Promise<Pair> => {
    const [first, second] = await Promise.all([read(a), read(b)]);
    return { a: first, b: second };
  };
  const waitFor = async (predicate: (pair: Pair) => boolean, restoring = false): Promise<Pair> => {
    const deadline = restoring ? finalDeadline : checksDeadline;
    const signal = restoring ? undefined : controller.signal;
    for (;;) {
      const pair = await bounded(readPair, deadline, signal);
      if (predicate(pair)) return pair;
      if (!restoring && [pair.a.session.activityStatus, pair.b.session.activityStatus].includes("waiting")) throw new SmokeError("unexpected-approval-or-input");
      await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, 100)), deadline, signal);
    }
  };
  const check = <T>(action: () => Promise<T>) => bounded(action, checksDeadline, controller.signal);
  const checkSettings = async (name: string, action: () => Promise<void>, predicate: (view: View) => boolean) => {
    stage = name;
    const before = await check(readPair);
    if (!idle(before)) throw new SmokeError("test-thread-must-be-idle");
    settingsWriteAttempted = true;
    await check(action);
    const pair = await waitFor((pair) => predicate(pair.a) && predicate(pair.b) && equal(pair.a.settings, pair.b.settings));
    report(stage, { passed: true, synchronized: true, changed: !equal(before.a.settings, pair.a.settings), ...summary(pair.b.settings) });
  };

  try {
    await check(() => Promise.all([a.adapter.start(), b.adapter.start()]));
    await check(() => Promise.all([a.adapter.attachThread(options.thread), b.adapter.attachThread(options.thread)]));
    const baseline = await waitFor((pair) => equal(pair.a.settings, pair.b.settings));
    report("attach", { passed: true, readOnly: !options.write, settingsEqual: true, bothIdle: idle(baseline), ...summary(baseline.b.settings) });
    if (options.write) {
      if (!idle(baseline)) throw new SmokeError("test-thread-must-be-idle");
      original = structuredClone(baseline.a.settings);
      originalTierOmitted = !Object.hasOwn(record(a.state.conversationState?.latestThreadSettings), "serviceTier");
      const owner = await check(() => a.client.discoverOwner(options.thread));
      if (!owner) throw new SmokeError("desktop-owner-unavailable");
      ownerClientId = owner.ownerClientId;

      stage = "model";
      await check(() => a.adapter.setModel(options.thread, original!.model));
      // setModel intentionally skips an unchanged model. Repeat the same native
      // value through the IPC API to verify acceptance without choosing a model.
      settingsWriteAttempted = true;
      const modelResponse = await check(() => a.client.updateThreadSettings(options.thread, ownerClientId!, {
        model: original!.model, collaborationMode: original!.collaborationMode,
      }));
      if (!modelResponse.applied) throw new SmokeError("model-setting-not-applied");
      await waitFor((pair) => pair.a.settings.model === original!.model && pair.b.settings.model === original!.model);
      report(stage, { passed: true, synchronized: true, coverage: "not-different-model", model: original.model });
      await checkSettings("effort", () => a.adapter.setReasoningEffort(options.thread, "low"), (view) => view.settings.effort === "low" && view.session.reasoningEffort === "low");
      await checkSettings("mode-plan", () => a.adapter.setMode(options.thread, "plan"), (view) => view.session.mode === "plan");
      await checkSettings("mode-default", () => a.adapter.setMode(options.thread, "default"), (view) => view.session.mode === "default");
      await checkSettings("service-tier", () => a.adapter.setServiceTier(options.thread, "fast"), (view) =>
        (view.settings.serviceTier === "priority" || view.settings.serviceTier === "fast") && view.session.serviceTier === "fast");

      if (options.image) {
        stage = "image";
        const before = await check(readPair);
        if (!idle(before)) throw new SmokeError("test-thread-must-be-idle");
        const previous = new Set(before.a.messages.map((message) => message.id));
        const prompt = `This is an image synchronization test. Do not use tools, run commands, browse, or change files. Identify the solid color in the attached image. If it is red, reply with exactly ${IMAGE_REPLY} and nothing else. If it is not red, reply COLOR_MISMATCH.`;
        imageInFlight = true;
        const response = await check(() => a.adapter.sendMessage(options.thread, [
          { type: "text", text: prompt }, { type: "image", mimeType: "image/png", data: RED_PNG },
        ]));
        imageInFlight = false;
        const pair = await waitFor((pair) => idle(pair) && equal(pair.a.messages, pair.b.messages));
        const added = pair.a.messages.filter((message) => !previous.has(message.id));
        if (added.some((message) => message.parts.some((part) => part.type === "tool"))) throw new SmokeError("unexpected-tool-execution");
        const imageOnBoth = [pair.a, pair.b].every((view) => view.messages.some((message) => !previous.has(message.id) && message.role === "user" && text(message) === prompt
          && message.parts.some((part) => part.type === "file" && part.mime === "image/png")));
        const replyOnBoth = text(response) === IMAGE_REPLY && [pair.a, pair.b].every((view) => view.messages.some((message) => message.id === response.id && !previous.has(message.id) && text(message) === IMAGE_REPLY));
        if (!imageOnBoth || !replyOnBoth) throw new SmokeError("image-or-reply-not-synchronized");
        imagePassed = true;
        report(stage, { passed: true, imageOnBoth, replyOnBoth, messagesEqual: true, noTools: true });
      }
    }
    passed = true;
  } catch (error) {
    const errorCode = error instanceof SmokeError ? error.code : "desktop-operation-failed";
    report(stage, { passed: false, errorCode, imageInFlight, elapsedMs: Date.now() - started });
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    if (settingsWriteAttempted && original && ownerClientId) {
      stage = "restore-settings";
      try {
        const patch: DesktopThreadSettingsPatch = structuredClone(original);
        const response = await bounded(() => a.client.updateThreadSettings(options.thread, ownerClientId!, patch), finalDeadline);
        requireApplied(response, "settings-restore-not-applied");
        await waitFor((pair) => equal(pair.a.settings, original) && equal(pair.b.settings, original), true);
        settingsRestored = true;
        report(stage, { passed: true, synchronized: true, originalNativeEffortPreserved: true, omittedServiceTierRestoredAsNull: originalTierOmitted });
      } catch (error) {
        passed = false;
        process.exitCode = process.exitCode || 1;
        report(stage, { passed: false, errorCode: error instanceof SmokeError ? error.code : "settings-restore-failed", requiresManualCheck: true });
      }
    }
    controller.abort();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await Promise.allSettled([a.adapter.stop(), b.adapter.stop()]);
    report("complete", {
      passed, writeEnabled: options.write, imageChecked: imagePassed,
      settingsRestored: settingsWriteAttempted ? settingsRestored : null,
      detachedOnly: true, automaticRetry: false, automaticTurnInterrupt: false,
      elapsedMs: Date.now() - started,
    });
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options) await run(options);
} catch (error) {
  report("arguments", { passed: false, errorCode: error instanceof SmokeError ? error.code : "invalid-arguments" });
  process.exitCode = 2;
}
