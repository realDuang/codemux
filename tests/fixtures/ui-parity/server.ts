import http from "node:http";
import { copyFile, mkdtemp, readFile as readFixtureFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, mergeConfig } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import webConfig from "../../../vite.web.config";
import { MockEngineAdapter } from "../../../electron/main/engines/mock-adapter";
import { listDirectory, readFile } from "../../../electron/main/services/file-service";
import { startTestServer } from "../../e2e/setup/test-server";
import type { GatewayNotification, ReasoningPart, TextPart, ToolPart, UnifiedMessage } from "../../../src/types/unified";
import { createFixtureMessages, createFixtureSession, createHistory, createLazyHistoryMessages, profiles } from "./fixtures";
import { createInteractionFixture, type FixtureGatewayRequest } from "./interaction-fixture";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env.UI_PARITY_PORT ?? 60790);
const production = process.env.UI_PARITY_PRODUCTION === "1";
const directory = await mkdtemp(join(tmpdir(), "codemux-ui-parity-"));
await writeFile(join(directory, "sample source.ts"), Array.from({ length: 220 }, (_, index) =>
  `export const line${index + 1} = ${index + 1}; // Source line ${index + 1}`).join("\n"));
await copyFile(join(repo, "public/assets/pwa-maskable-512.png"), join(directory, "image.png"));
const wav = Buffer.alloc(44 + 3200);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(3200, 40);
await writeFile(join(directory, "sample.wav"), wav);

const sessions = profiles.map((profile) => createFixtureSession(profile.type, directory));
const lazySessions = process.env.UI_PARITY_LAZY_STEPS === "1" ? profiles.map((profile) => ({
  ...createFixtureSession(profile.type, directory), id: `ui-parity-lazy-${profile.type}`, title: `UI parity lazy history - ${profile.label}`,
})) : [];
sessions.push(...lazySessions);
const backend = await startTestServer({ port: 0, lazyStepsSessionIds: lazySessions.map((session) => session.id) });
const active = new Map<string, AbortController>();
const clients = new Set<WebSocket>();
const authenticatedClients = new Set<WebSocket>();
let streamSequence = 0;
const emit = (notification: GatewayNotification) => {
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(notification));
};

function publish(adapter: MockEngineAdapter, sessionId: string, messages: UnifiedMessage[], notifications = messages) {
  const session = sessions.find((item) => item.id === sessionId)!;
  adapter.seedSession(session, messages);
  for (const message of notifications) {
    emit({ type: "message.updated", payload: { sessionId, message } });
    for (const part of message.parts) emit({ type: "message.part.updated", payload: { sessionId, messageId: message.id, part } });
  }
}

async function stream(adapter: MockEngineAdapter, sessionId: string, prompt: string) {
  if (active.has(sessionId)) throw new Error("A fixture stream is already running in this session.");
  const controller = new AbortController();
  active.set(sessionId, controller);
  const prefix = `${sessionId}:stream:${++streamSequence}`;
  const now = Date.now();
  const phased = profiles.find((item) => item.type === adapter.engineType)!.phased;
  const history = await adapter.listMessages(sessionId);
  const user: UnifiedMessage = { id: `${prefix}:user`, sessionId, role: "user", time: { created: now }, parts: [
    { id: `${prefix}:user:text`, messageId: `${prefix}:user`, sessionId, type: "text", text: prompt },
  ] };
  const message: UnifiedMessage = { id: `${prefix}:assistant`, sessionId, role: "assistant", workingDirectory: directory, time: { created: now + 1 }, parts: [] };
  const base = (suffix: string, order: number) => ({ id: `${prefix}:${suffix}`, messageId: message.id, sessionId, order });
  const reason: ReasoningPart = { ...base("reason", 0), type: "reasoning", text: "**Inspecting", completed: false,
    ...(phased ? { summaryFormat: "heading-prefixed" as const } : {}), time: { start: now } };
  const tool: ToolPart = { ...base("tool", 1), type: "tool", callId: `${prefix}:tool`, normalizedTool: "shell", originalTool: "fixture_command", title: "Running a deterministic display fixture", kind: "other", state: { status: "pending", input: { command: "fixture-render" }, time: { start: now } } };
  const answer: TextPart = { ...base("answer", 2), type: "text", text: "", completed: false, ...(phased ? { phase: "final" as const } : {}) };
  message.parts = [reason];
  const all = [...history, user, message];
  let started = false;
  const tick = async (delay: number) => {
    publish(adapter, sessionId, all, started ? [message] : [user, message]);
    started = true;
    await new Promise((done) => setTimeout(done, delay));
  };
  try {
    await tick(700);
    reason.text = "**Inspecting the stream**\n\nThe visible summary grows without repeating its heading.\n\n" + Array.from({ length: 12 }, (_, i) => `- Summary detail ${i + 1}: retain the full readable text.`).join("\n");
    if (prompt.includes("reasoning-scroll")) {
      for (let index = 0; index < 25 && !controller.signal.aborted; index++) {
        reason.text += `\n- Additional visible detail ${index + 13}: preserve the reader's position.`;
        await tick(200);
      }
    } else await tick(700);
    reason.completed = true;
    reason.time = { start: now, end: Date.now() };
    message.parts = [reason, tool, answer];
    tool.state = { status: "running", input: { command: "fixture-render" }, time: { start: now + 700 } };
    await tick(700);
    tool.state = { status: "completed", input: { command: "fixture-render" }, output: "FIXTURE_OK", time: { start: now + 700, end: now + 1400, duration: 700 } };
    answer.text = "Stable first paragraph for selection.\n\n```typescript\nconst stable = \"copy and horizontal scroll state survive later updates\";\n```\n\n";
    for (let index = 0; index < 160 && !controller.signal.aborted; index++) {
      answer.text += `Chunk ${index + 1}: the response continues. `;
      if (index % 8 === 7) answer.text += "\n\n";
      await tick(40);
    }
    if (controller.signal.aborted) {
      message.error = "Fixture stream interrupted; partial content is preserved.";
    } else {
      answer.text += "\n\n```text\nUNFINISHED_CODE";
      await tick(1200);
      answer.text += "\n```\n\nSTREAM_COMPLETE";
    }
    answer.completed = true;
    message.time.completed = Date.now();
    publish(adapter, sessionId, all, [message]);
    return message;
  } finally {
    active.delete(sessionId);
  }
}

for (const profile of profiles) {
  let adapter = backend.mockAdapters.get(profile.type);
  if (!adapter) {
    adapter = new MockEngineAdapter({ engineType: profile.type, name: `Fixture ${profile.label}` });
    await adapter.start();
    backend.mockAdapters.set(profile.type, adapter);
  }
  const session = sessions.find((item) => item.engineType === profile.type)!;
  adapter.seedSession(session, createFixtureMessages(session));
  const boundAdapter = adapter;
  adapter.sendMessage = async (sessionId, content) => stream(boundAdapter, sessionId, content.map((item) => item.text ?? "").join("\n"));
  adapter.cancelMessage = async (sessionId) => { active.get(sessionId)?.abort(); };
}
for (const session of lazySessions) {
  backend.mockAdapters.get(session.engineType)!.seedSession(session, createLazyHistoryMessages(session));
}
// Optional, explicitly supplied local replay; never load personal conversations by default.
const replayPath = process.env.UI_PARITY_IMAGE_REPLAY;
if (replayPath) {
  const replay = JSON.parse(await readFixtureFile(replayPath, "utf8")) as UnifiedMessage;
  const session = sessions.find(item => item.id === "ui-parity-codex-desktop")!;
  const user = createFixtureMessages(session)[0];
  const message = { ...replay, id: "image-replay:assistant", sessionId: session.id,
    time: { created: user.time.created + 100, completed: user.time.created + 4000 },
    parts: replay.parts.map(part => ({ ...part, messageId: "image-replay:assistant", sessionId: session.id })) };
  backend.mockAdapters.get(session.engineType)!.seedSession(session, [user, message]);
}
await backend.registerSessionRoutes();

const interactionSession = sessions.find((session) => session.id === "ui-parity-codex-desktop")!;
const interactionAdapter = backend.mockAdapters.get(interactionSession.engineType)!;
const emitInteraction = (notification: GatewayNotification) => {
  for (const client of authenticatedClients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(notification));
};
const interactions = process.env.UI_PARITY_INTERACTIONS === "1" ? createInteractionFixture({
  session: interactionSession, emit: emitInteraction,
  publishReceipt: async (message) => {
    interactionAdapter.seedSession(interactionSession, [...await interactionAdapter.listMessages(interactionSession.id), message]);
    emitInteraction({ type: "message.updated", payload: { sessionId: interactionSession.id, message } });
    for (const part of message.parts) emitInteraction({ type: "message.part.updated", payload: { sessionId: interactionSession.id, messageId: message.id, part } });
  },
}) : undefined;

const bridge = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/__fixture/")) {
    const sessionId = url.searchParams.get("session") ?? "ui-parity-codex";
    const session = sessions.find((item) => item.id === sessionId);
    const adapter = session && backend.mockAdapters.get(session.engineType);
    const reply = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/__fixture/state") {
      const messages = adapter ? await adapter.listMessages(sessionId) : [];
      reply({ directory, sessions, active: [...active.keys()], lazySteps: lazySessions.some((item) => item.id === sessionId),
        messageStepRequests: Object.fromEntries(messages.map((message) => [message.id, backend.messageStepRequests.get(message.id) ?? 0])),
        ...(interactions && { interactions: interactions.state() }),
        ...(adapter && { messages }) });
      return;
    }
    if (req.method !== "POST" || !session || !adapter) { reply({ error: "Use POST and an existing fixture session." }, 400); return; }
    if (active.has(sessionId)) { reply({ error: "Wait for the fixture stream to finish before changing history." }, 409); return; }
    if (url.pathname === "/__fixture/reset") {
      if (sessionId === interactions?.sessionId) interactions.reset();
      if (lazySessions.some((item) => item.id === sessionId)) {
        const messages = createLazyHistoryMessages(session);
        // Reload the page after reset; broadcasting parts would bypass the lazy history path.
        adapter.seedSession(session, messages);
        for (const message of messages) backend.messageStepRequests.delete(message.id);
      } else publish(adapter, sessionId, createFixtureMessages(session));
    } else if (url.pathname === "/__fixture/history") {
      publish(adapter, sessionId, [...createHistory(session), ...createFixtureMessages(session)]);
    } else if (url.pathname === "/__fixture/disconnect") {
      for (const client of clients) client.close(1012, "Fixture reconnect check");
    } else if (url.pathname === "/__fixture/interaction" && interactions) {
      if (sessionId !== interactions.sessionId) { reply({ error: "Use the Codex Desktop interaction fixture session." }, 400); return; }
      try { reply({ ok: true, sessionId, ...interactions.create(url.searchParams.get("kind")) }); }
      catch (error) { reply({ error: String(error) }, 400); }
      return;
    } else {
      reply({ error: "Unknown fixture hook." }, 404); return;
    }
    reply({ ok: true, sessionId });
    return;
  }
  const remote = http.request(backend.baseUrl + (req.url ?? "/"), { method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode ?? 500, response.headers); response.pipe(res);
  });
  remote.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(remote);
});
const wss = new WebSocketServer({ server: bridge, path: "/ws" });
wss.on("connection", (client) => {
  const upstream = new WebSocket(backend.wsUrl);
  const pending: string[] = [];
  let authenticated = false;
  clients.add(client);
  upstream.on("open", () => { for (const data of pending) upstream.send(data); });
  upstream.on("message", (data) => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()); });
  client.on("message", async (data) => {
    const raw = data.toString();
    let request: FixtureGatewayRequest;
    try { request = JSON.parse(raw); } catch { return; }
    if (request.type === "auth") {
      authenticated = request.token === "test-token" || Boolean(request.token && backend.authStore.verifyToken(request.token).valid);
      if (authenticated) authenticatedClients.add(client); else authenticatedClients.delete(client);
    }
    if (interactions) {
      try {
        const result = await interactions.handleRequest(request, authenticated);
        if (result !== undefined) {
          client.send(JSON.stringify({ type: "response", requestId: request.requestId, payload: result }));
          return;
        }
      } catch (error) {
        client.send(JSON.stringify({ type: "response", requestId: request.requestId, payload: null, error: { code: "FIXTURE_INTERACTION_ERROR", message: String(error) } }));
        return;
      }
    }
    if (request.type === "file.read" || request.type === "file.list") {
      try {
        if (!authenticated) throw new Error("Fixture authentication is required.");
        const payload = request.payload ?? {};
        if (resolve(typeof payload.directory === "string" ? payload.directory : "") !== directory) throw new Error("Only the temporary fixture directory is readable.");
        const path = typeof payload.path === "string" ? payload.path : "";
        const result = request.type === "file.read"
          ? await readFile(path, directory)
          : await listDirectory(path ? resolve(directory, path) : directory, directory);
        client.send(JSON.stringify({ type: "response", requestId: request.requestId, payload: result }));
      } catch (error) {
        client.send(JSON.stringify({ type: "response", requestId: request.requestId, payload: null, error: { code: "FIXTURE_FILE_ERROR", message: String(error) } }));
      }
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(raw); else pending.push(raw);
  });
  client.on("close", () => { clients.delete(client); authenticatedClients.delete(client); upstream.close(); });
  upstream.on("error", () => client.close());
});
await new Promise<void>((done) => bridge.listen(production ? port : 0, "127.0.0.1", done));
const bridgeAddress = bridge.address();
if (!bridgeAddress || typeof bridgeAddress === "string") throw new Error("Fixture bridge did not bind a port.");
const target = `http://127.0.0.1:${bridgeAddress.port}`;
const vite = production ? undefined : await createServer(mergeConfig(webConfig, {
  configFile: false, clearScreen: false,
  server: { host: "127.0.0.1", port, strictPort: true,
    proxy: { "/ws": { target, ws: true }, "/api": { target }, "/__fixture": { target } },
  },
}));
await vite?.listen();
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, directory, sessions: sessions.map(({ id, title }) => ({ id, title })), pid: process.pid }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const controller of active.values()) controller.abort();
  for (const client of clients) client.terminate();
  await vite?.close();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => bridge.close(() => done()));
  await backend.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
