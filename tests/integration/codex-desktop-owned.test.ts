import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UnifiedMessage, UnifiedSession } from "../../src/types/unified";

// Explicitly opt in to creating ONE persistent test thread and sending ONE echo:
// CODEMUX_DESKTOP_TEST_CREATE=1 bunx vitest run --config vitest.desktop-live.config.ts
// CODEMUX_DESKTOP_TEST_HOLD_MS=60000 keeps its owner alive after the echo so the
// printed thread link can be opened manually in official Desktop. No UI is opened
// by this suite. Native test history remains available after cleanup.
// Only the Electron logger shell is mocked; all engines, processes and IPC are real.
vi.mock("../../electron/main/services/logger", () => ({
  codexLog: { info() {}, warn() {}, error() {}, debug() {} },
}));

import { CodexAdapter } from "../../electron/main/engines/codex";
import { CodexDesktopAdapter } from "../../electron/main/engines/codex/desktop-adapter";
import { CodexDesktopIpcClient } from "../../electron/main/engines/codex/desktop-ipc-client";
import {
  createCodexDesktopSharing,
  type CodexDesktopSharingService,
} from "../../electron/main/engines/codex/desktop-sharing";

const createEnabled = process.env.CODEMUX_DESKTOP_TEST_CREATE === "1";
const TURN_TIMEOUT_MS = 100_000;
const SYNC_TIMEOUT_MS = 15_000;
const MAX_HOLD_MS = 600_000;
const holdMs = createEnabled ? parseHoldMs(process.env.CODEMUX_DESKTOP_TEST_HOLD_MS) : 0;

interface Peer { client: CodexDesktopIpcClient; adapter: CodexDesktopAdapter }
interface Pair { ownerSession: UnifiedSession; followerSession: UnifiedSession; messages: UnifiedMessage[] }

describe.skipIf(!createEnabled)("CodeMux-owned Codex Desktop live integration", () => {
  let directory = "";
  const services = new Set<CodexDesktopSharingService>();
  const peers = new Set<Peer>();
  let runtimeErrors = 0;
  let stage = "prepare";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "codemux-desktop-owned-"));
    await writeFile(join(directory, "AGENTS.md"), [
      "# Live synchronization test",
      "",
      "This directory is only a fixture for a bounded Codex connectivity test.",
      "Do not use tools, run commands, browse, read files, or modify any files.",
      "Follow the test prompt and return only the exact requested echo token.",
      "Do not begin background work or continue after that response.",
      "",
    ].join("\n"), { mode: 0o600 });
  });

  afterAll(async () => {
    // Stop only instances created by this suite. Never archive/delete the native
    // test thread, touch an existing thread, or stop official Desktop.
    await Promise.allSettled([...peers].map((peer) => peer.adapter.stop()));
    const stopped = await Promise.allSettled([...services].map((service) => service.stop()));
    if (directory) await rm(directory, { recursive: true, force: true });
    expect(stopped.every((result) => result.status === "fulfilled"), "Every test-owned runtime stopped cleanly").toBe(true);
  }, 90_000);

  function makeService() {
    const execution = new CodexAdapter();
    const ownerClient = new CodexDesktopIpcClient({ requestTimeoutMs: SYNC_TIMEOUT_MS });
    const service = createCodexDesktopSharing({
      privateExecutionAdapter: execution, ownerClient,
      turnTimeoutMs: TURN_TIMEOUT_MS, syncTimeoutMs: SYNC_TIMEOUT_MS,
      onError: (_threadId, error) => {
        runtimeErrors += 1;
        console.log(JSON.stringify({ stage, event: "owner-runtime-error", error: safeError(error) }));
      },
    });
    services.add(service);
    return { service, execution, ownerClient };
  }

  async function makePeer(threadId: string, expectedOwner: CodexDesktopIpcClient): Promise<Peer> {
    const client = new CodexDesktopIpcClient({ requestTimeoutMs: SYNC_TIMEOUT_MS });
    const peer = { client, adapter: new CodexDesktopAdapter({ client, turnTimeoutMs: TURN_TIMEOUT_MS }) };
    peers.add(peer);
    await peer.adapter.start();
    const owner = await client.discoverOwner(threadId);
    expect(owner !== null && owner.ownerClientId === expectedOwner.clientId, "The independent client discovers the actual CodeMux owner").toBe(true);
    expect(client.clientId !== expectedOwner.clientId, "The observer has a separate IPC connection").toBe(true);
    await peer.adapter.attachThread(threadId);
    return peer;
  }

  async function synchronized(service: CodexDesktopSharingService, peer: Peer, threadId: string): Promise<Pair> {
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    for (;;) {
      const [ownerSession, followerSession, ownerMessages, followerMessages] = await Promise.all([
        service.adapter.getSession(threadId), peer.adapter.getSession(threadId),
        service.adapter.listMessages(threadId), peer.adapter.listMessages(threadId),
      ]);
      expect(ownerSession?.id === threadId && followerSession?.id === threadId, "Both clients retain the native thread ID").toBe(true);
      expect(ownerSession?.engineMeta?.codexThreadId === threadId && followerSession?.engineMeta?.codexThreadId === threadId).toBe(true);
      expect(ownerSession?.engineMeta?.codexDesktopOwner).toBe("codemux");
      if (ownerSession?.activityStatus === "waiting" || followerSession?.activityStatus === "waiting") throw new Error("The no-tools test unexpectedly requires input or approval");
      if (ownerSession && followerSession && ownerSession.activityStatus === "idle" && followerSession.activityStatus === "idle"
        && digest(ownerMessages) === digest(followerMessages)) {
        expect(ownerMessages.every((message) => message.sessionId === threadId)).toBe(true);
        expect(ownerSession.modelId === followerSession.modelId).toBe(true);
        return { ownerSession, followerSession, messages: ownerMessages };
      }
      if (Date.now() >= deadline) throw new Error("The independent follower did not converge");
      await pause(100);
    }
  }

  it("creates a native thread, shares its echo, and strictly restores its identity and model after the service restarts", async () => {
    // External failures are reduced to a stage so stderr, request bodies and
    // credentials from a model provider can never enter a Vitest failure report.
    try {
      stage = "create";
      const first = makeService();
      const created = await first.service.adapter.createSession(directory);
      const threadId = created.id;
      expect(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)).toBe(true);
      expect(created.engineMeta?.codexThreadId === threadId).toBe(true);
      expect(created.engineMeta?.codexDesktopOwner).toBe("codemux");
      console.log(JSON.stringify({ stage: "owned-created", createdThreadId: threadId, url: `codex://threads/${threadId}` }));
      expect(first.execution.getStatus()).toBe("running");
      const nativeBefore = await first.execution.listSessions();
      expect(nativeBefore.map((session) => session.engineMeta?.codexThreadId)).toEqual([threadId]);
      expect(first.execution.hasSession(nativeBefore[0].id)).toBe(true);

      stage = "discover-and-attach";
      let peer = await makePeer(threadId, first.ownerClient);
      const baseline = await synchronized(first.service, peer, threadId);
      const originalModel = baseline.ownerSession.modelId;
      expect(typeof originalModel === "string" && originalModel.length > 0).toBe(true);
      const originalMeta = { ...baseline.ownerSession.engineMeta };
      const previousIds = new Set(baseline.messages.map((message) => message.id));

      stage = "echo";
      const marker = `CODEMUX_OWNED_${randomUUID()}`;
      const prompt = `For this connectivity test only, do not use tools, read or modify files, browse, or run commands. Reply with exactly this token and nothing else: ${marker}`;
      const userPush = watchMessage(peer.adapter, threadId, (message) => message.role === "user" && textOf(message) === prompt);
      const answerPush = watchMessage(peer.adapter, threadId, (message) => message.role === "assistant" && message.time.completed != null && textOf(message).trim() === marker);
      let reply: UnifiedMessage;
      try {
        [reply] = await Promise.all([
          first.service.adapter.sendMessage(threadId, [{ type: "text", text: prompt }]),
          userPush.promise, answerPush.promise,
        ]);
      } finally {
        userPush.dispose();
        answerPush.dispose();
      }
      expect(reply.error == null && textOf(reply).trim() === marker).toBe(true);
      const echoed = await synchronized(first.service, peer, threadId);
      const added = echoed.messages.filter((message) => !previousIds.has(message.id));
      expect(added.filter((message) => message.role === "user" && textOf(message) === prompt).length).toBe(1);
      expect(added.filter((message) => message.role === "assistant" && textOf(message).trim() === marker).length).toBe(1);
      expect(added.some((message) => message.parts.some((part) => part.type === "tool"))).toBe(false);
      expect(runtimeErrors).toBe(0);
      console.log(JSON.stringify({ stage: "owned-echo", passed: true, createdThreadId: threadId, url: `codex://threads/${threadId}`, holdMs, noTools: true, streamedToIndependentFollower: true }));

      if (holdMs > 0) {
        stage = "hold-for-manual-desktop-check";
        const until = Date.now() + holdMs;
        while (Date.now() < until) await pause(Math.min(1000, until - Date.now()));
        console.log(JSON.stringify({ stage: "owned-hold-finished", createdThreadId: threadId }));
      }

      stage = "follower-reconnect";
      const beforeReconnect = await synchronized(first.service, peer, threadId);
      await peer.adapter.stop();
      peers.delete(peer);
      peer = await makePeer(threadId, first.ownerClient);
      const reconnected = await synchronized(first.service, peer, threadId);
      expect(digest(reconnected.messages)).toBe(digest(beforeReconnect.messages));

      stage = "stop-first-service";
      await peer.adapter.stop();
      peers.delete(peer);
      await first.service.stop();
      expect(first.execution.getStatus()).toBe("stopped");
      expect(first.ownerClient.connected).toBe(false);

      stage = "restore-original-thread";
      const second = makeService();
      const restored = await second.service.adapter.restoreSession(threadId, directory, originalMeta);
      expect(restored.id === threadId && restored.engineMeta?.codexThreadId === threadId).toBe(true);
      expect(restored.engineMeta?.codexDesktopOwner).toBe("codemux");
      expect(restored.modelId === originalModel, "Restoration preserves the original model").toBe(true);
      // A new private runtime must have restored the thread. Following an owner
      // acquired by official Desktop would not establish this restart guarantee.
      expect(second.execution.getStatus(), "The new private runtime actually resumed the original thread").toBe("running");
      const nativeAfter = await second.execution.listSessions();
      expect(nativeAfter.map((session) => session.engineMeta?.codexThreadId)).toEqual([threadId]);
      expect(second.execution.hasSession(nativeAfter[0].id)).toBe(true);
      peer = await makePeer(threadId, second.ownerClient);
      const afterRestore = await synchronized(second.service, peer, threadId);
      expect(afterRestore.ownerSession.modelId === originalModel && afterRestore.followerSession.modelId === originalModel).toBe(true);
      expect(digest(afterRestore.messages)).toBe(digest(reconnected.messages));
      expect(runtimeErrors).toBe(0);
      console.log(JSON.stringify({ stage: "owned-restored", passed: true, createdThreadId: threadId, originalThreadIdPreserved: true, originalModelPreserved: true, privateRuntimeRestored: true, historyEqualAfterReconnectAndRestart: true }));
    } catch (error) {
      console.log(JSON.stringify({ stage, event: "owned-acceptance-error", error: safeError(error) }));
      // Keeping the original cause would let Vitest print unsanitized provider data.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Live CodeMux-owned acceptance failed during ${stage}; provider details are withheld`);
    }
  }, 360_000 + holdMs);
});

function parseHoldMs(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_HOLD_MS) throw new Error("CODEMUX_DESKTOP_TEST_HOLD_MS must be an integer from 0 to 600000");
  return parsed;
}

function safeError(value: unknown): { name: string; code?: string; message: string } {
  const error = value instanceof Error ? value : new Error("Non-Error failure");
  const rawCode = "code" in error ? error.code : undefined;
  const code = typeof rawCode === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(rawCode) ? rawCode : undefined;
  const message = error.message.split("\n")[0]
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*\S+/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 240);
  return { name: /^[A-Za-z0-9_]{1,80}$/.test(error.name) ? error.name : "Error", code, message };
}

function pause(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function textOf(message: UnifiedMessage): string { return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }

function watchMessage(adapter: CodexDesktopAdapter, threadId: string, predicate: (message: UnifiedMessage) => boolean) {
  let observer: ((event: { sessionId: string; message: UnifiedMessage }) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer) clearTimeout(timer);
    if (observer) adapter.off("message.updated", observer);
  };
  const promise = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => { dispose(); reject(new Error("The expected independent follower push did not arrive")); }, TURN_TIMEOUT_MS);
    observer = ({ sessionId, message }) => {
      if (sessionId === threadId && predicate(message)) { dispose(); resolve(); }
    };
    adapter.on("message.updated", observer);
  });
  return { promise, dispose };
}
