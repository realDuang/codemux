/**
 * Live smoke checks for one explicitly selected, Desktop-owned test thread.
 *
 * bun scripts/codex-desktop-smoke.ts --thread <UUID>
 * bun scripts/codex-desktop-smoke.ts --thread <UUID> --write [--steer] [--interrupt]
 *
 * The default is read-only. Write checks append test messages to the selected
 * thread. Cleanup only detaches the clients; it never stops a Desktop process
 * or automatically interrupts a turn after a timeout.
 */
import { randomUUID } from "node:crypto";
import { CodexDesktopAdapter } from "../electron/main/engines/codex/desktop-adapter";
import type { UnifiedMessage, UnifiedSession } from "../src/types/unified";

const TIME_LIMIT_MS = 180_000;
interface Options { thread: string; write: boolean; steer: boolean; interrupt: boolean }
interface View { session: UnifiedSession; messages: UnifiedMessage[] }
interface PairView { a: View; b: View }
type Outcome<T> = { ok: true; value: T } | { ok: false };

class SmokeError extends Error {
  constructor(readonly code: string) { super(code); }
}

function report(stage: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ stage, ...fields }));
}

function parseOptions(args: string[]): Options | null {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    report("help", {
      usage: "bun scripts/codex-desktop-smoke.ts --thread <UUID> [--write [--steer] [--interrupt]]",
      defaultMode: "read-only", timeoutSeconds: TIME_LIMIT_MS / 1000,
      cleanup: "Detach both clients; leave Desktop and any running turn intact.",
    });
    return null;
  }
  const options: Options = { thread: "", write: false, steer: false, interrupt: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new SmokeError("duplicate-option");
    seen.add(flag);
    if (flag === "--thread") options.thread = args[++index] ?? "";
    else if (flag === "--write") options.write = true;
    else if (flag === "--steer") options.steer = true;
    else if (flag === "--interrupt") options.interrupt = true;
    else throw new SmokeError("unknown-option");
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.thread)) throw new SmokeError("explicit-thread-uuid-required");
  if ((options.steer || options.interrupt) && !options.write) throw new SmokeError("write-flag-required");
  return options;
}

function messageText(message: UnifiedMessage): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function turnId(message: UnifiedMessage): string | undefined {
  const value = message.engineMeta?.codexTurnId;
  return typeof value === "string" ? value : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function sameMessages(pair: PairView): boolean {
  return JSON.stringify(stableValue(pair.a.messages)) === JSON.stringify(stableValue(pair.b.messages));
}

function idle(pair: PairView): boolean {
  return pair.a.session.activityStatus === "idle" && pair.b.session.activityStatus === "idle";
}

function containsTools(messages: UnifiedMessage[]): boolean {
  return messages.some((message) => message.parts.some((part) => part.type === "tool"));
}

function settle<T>(operation: Promise<T>): Promise<Outcome<T>> {
  // Keep failures observed while another client inspects or steers the turn.
  return operation.then((value) => ({ ok: true, value }), () => ({ ok: false }));
}

async function run(options: Options): Promise<void> {
  const started = Date.now();
  const controller = new AbortController();
  const adapters = new Set<CodexDesktopAdapter>();
  const makeAdapter = () => {
    const adapter = new CodexDesktopAdapter({ turnTimeoutMs: TIME_LIMIT_MS });
    adapters.add(adapter);
    return adapter;
  };
  const a = makeAdapter();
  let b = makeAdapter();
  let stage = "attach";
  let writeInFlight = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const onSignal = () => {
    controller.abort();
    rejectInterrupted(new SmokeError("stopped-by-user"));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const assertRunning = () => {
    if (controller.signal.aborted || Date.now() - started >= TIME_LIMIT_MS) throw new SmokeError("time-limit-reached");
  };
  const read = async (adapter: CodexDesktopAdapter): Promise<View> => {
    assertRunning();
    const [session, messages] = await Promise.all([adapter.getSession(options.thread), adapter.listMessages(options.thread)]);
    if (!session || session.id !== options.thread || session.engineMeta?.codexThreadId !== options.thread) throw new SmokeError("thread-identity-mismatch");
    return { session, messages };
  };
  const readPair = async (): Promise<PairView> => {
    const [first, second] = await Promise.all([read(a), read(b)]);
    return { a: first, b: second };
  };
  const waitFor = async (predicate: (pair: PairView) => boolean): Promise<PairView> => {
    for (;;) {
      assertRunning();
      const pair = await readPair();
      if (predicate(pair)) return pair;
      if ([pair.a.session.activityStatus, pair.b.session.activityStatus].includes("waiting")) throw new SmokeError("unexpected-approval-or-input");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  };
  const synchronized = () => waitFor((pair) => idle(pair) && sameMessages(pair));
  const send = (adapter: CodexDesktopAdapter, text: string) => settle(adapter.sendMessage(options.thread, [{ type: "text", text }]));
  const newMessages = (pair: PairView, previous: Set<string>) => pair.a.messages.filter((message) => !previous.has(message.id));
  const assertNoTools = (pair: PairView, previous: Set<string>) => {
    if (containsTools(newMessages(pair, previous))) throw new SmokeError("unexpected-tool-execution");
  };
  const phaseSummary = (pair: PairView) => ({
    identityPreserved: pair.a.session.id === options.thread && pair.b.session.id === options.thread,
    messagesEqual: sameMessages(pair), messageCountA: pair.a.messages.length, messageCountB: pair.b.messages.length,
    bothIdle: idle(pair), modelEqual: pair.a.session.modelId === pair.b.session.modelId,
  });

  const checkWriteRound = async (sender: CodexDesktopAdapter, label: string) => {
    stage = label;
    const before = await synchronized();
    const previous = new Set(before.a.messages.map((message) => message.id));
    const marker = `CODEMUX_${label.toUpperCase()}_${randomUUID().replaceAll("-", "")}`;
    writeInFlight = true;
    const outcome = await send(sender, `This is a plain-text synchronization test. Do not use any tools, run commands, browse, or modify files. Reply with exactly ${marker} and nothing else.`);
    if (!outcome.ok) throw new SmokeError("send-failed-or-completion-unknown");
    const pair = await synchronized();
    assertNoTools(pair, previous);
    const answerMatched = messageText(outcome.value).trim() === marker;
    const sameReplyOnBoth = [pair.a, pair.b].every((view) => view.messages.some((message) => message.id === outcome.value.id && messageText(message).trim() === marker));
    if (!answerMatched || !sameReplyOnBoth || previous.has(outcome.value.id)) throw new SmokeError("reply-not-synchronized");
    writeInFlight = false;
    report(stage, { passed: true, ...phaseSummary(pair), answerMatched, sameReplyOnBoth, noTools: true });
  };

  const waitForNewActiveAssistant = (previous: Set<string>) => waitFor((pair) => {
    if (containsTools(newMessages(pair, previous))) throw new SmokeError("unexpected-tool-execution");
    return pair.a.session.activityStatus === "running" && pair.b.session.activityStatus === "running" && pair.a.messages.some((message) =>
      !previous.has(message.id) && message.role === "assistant" && messageText(message).trim().length > 0 && !!turnId(message));
  });
  const longPrompt = (marker: string) => `This is a bounded plain-text streaming test. Do not use any tools, run commands, browse, or modify files. Output exactly 400 numbered lines, in ascending order from 1 to 400. Each line must contain its number followed by "${marker} shared desktop synchronization in progress". Do not abbreviate or skip lines. If a later user message arrives, immediately follow that new instruction.`;

  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => { controller.abort(); reject(new SmokeError("time-limit-reached")); }, TIME_LIMIT_MS);
    });
    const checks = async () => {
      await Promise.all([a.start(), b.start()]);
      await Promise.all([a.attachThread(options.thread), b.attachThread(options.thread)]);
      const baseline = await waitFor(sameMessages);
      report("attach", { passed: true, readOnly: !options.write, ...phaseSummary(baseline) });
      if (!options.write) return;
      if (!idle(baseline)) throw new SmokeError("test-thread-must-be-idle");
      await checkWriteRound(a, "a_to_b");
      await checkWriteRound(b, "b_to_a");

      stage = "reconnect";
      const beforeReconnect = await synchronized();
      await b.stop();
      adapters.delete(b);
      b = makeAdapter();
      await b.start();
      await b.attachThread(options.thread);
      const reconnected = await synchronized();
      const historyPreserved = JSON.stringify(stableValue(beforeReconnect.a.messages)) === JSON.stringify(stableValue(reconnected.b.messages));
      if (!historyPreserved) throw new SmokeError("history-changed-after-reconnect");
      report(stage, { passed: true, ...phaseSummary(reconnected), historyPreserved });

      if (options.steer) {
        stage = "steer";
        const before = await synchronized();
        const previous = new Set(before.a.messages.map((message) => message.id));
        const marker = `CODEMUX_STEER_STOP_${randomUUID().replaceAll("-", "")}`;
        writeInFlight = true;
        const first = send(a, longPrompt("CODEMUX_STEER_COUNT"));
        const active = await waitForNewActiveAssistant(previous);
        const activeTurnId = turnId(active.a.messages.find((message) => !previous.has(message.id) && message.role === "assistant" && messageText(message).trim().length > 0)!);
        const steered = send(b, `Stop the numbered output now. Do not use tools. In this same turn, finish your reply with this exact line: ${marker}`);
        const [firstOutcome, steerOutcome] = await Promise.all([first, steered]);
        if (!firstOutcome.ok || !steerOutcome.ok) throw new SmokeError("steering-completion-unknown");
        const pair = await synchronized();
        assertNoTools(pair, previous);
        const sameTurn = turnId(firstOutcome.value) === activeTurnId && turnId(steerOutcome.value) === activeTurnId;
        const markerOnBoth = [pair.a, pair.b].every((view) => view.messages.some((message) => message.role === "assistant" && turnId(message) === activeTurnId && messageText(message).includes(marker)));
        if (!sameTurn || !markerOnBoth) throw new SmokeError("steering-not-confirmed-in-same-turn");
        writeInFlight = false;
        report(stage, { passed: true, ...phaseSummary(pair), activeAssistantObserved: true, sameTurn, markerOnBoth, noTools: true });
      }

      if (options.interrupt) {
        stage = "interrupt";
        const before = await synchronized();
        const previous = new Set(before.a.messages.map((message) => message.id));
        writeInFlight = true;
        const first = send(a, longPrompt("CODEMUX_INTERRUPT_COUNT"));
        const active = await waitForNewActiveAssistant(previous);
        const activeTurnId = turnId(active.a.messages.find((message) => !previous.has(message.id) && message.role === "assistant" && messageText(message).trim().length > 0)!);
        await b.cancelMessage(options.thread);
        await first;
        const pair = await synchronized();
        assertNoTools(pair, previous);
        const interruptionOnBoth = [pair.a, pair.b].every((view) => view.messages.some((message) => turnId(message) === activeTurnId && typeof message.error === "string" && /interrupt/i.test(message.error)));
        if (!interruptionOnBoth) throw new SmokeError("interruption-not-confirmed");
        writeInFlight = false;
        report(stage, { passed: true, ...phaseSummary(pair), activeAssistantObserved: true, interruptionOnBoth, noTools: true });
      }
    };
    await Promise.race([checks(), deadline, interrupted]);
    report("complete", { passed: true, writeEnabled: options.write, steeringChecked: options.steer, interruptionChecked: options.interrupt, elapsedMs: Date.now() - started });
  } catch (error) {
    const code = error instanceof SmokeError ? error.code : "desktop-operation-failed";
    report(stage, { passed: false, errorCode: code, writeInFlight, elapsedMs: Date.now() - started });
    process.exitCode = code === "stopped-by-user" ? 130 : 1;
  } finally {
    controller.abort();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await Promise.allSettled([...adapters].map((adapter) => adapter.stop()));
    report("detached", { detachedOnly: true, desktopProcessStopped: false, automaticTurnInterrupt: false });
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options) await run(options);
} catch (error) {
  report("arguments", { passed: false, errorCode: error instanceof SmokeError ? error.code : "invalid-arguments" });
  process.exitCode = 2;
}
