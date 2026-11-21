import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputRequest, ChatState } from "@microsoft/agent-host-protocol";
import { AgentHostConnection } from "../../../../../electron/main/session-sources/agent-host/connection";
import { AgentHostService } from "../../../../../electron/main/session-sources/agent-host/service";
import { parseEndpoint } from "../../../../../electron/main/session-sources/agent-host/discovery";
import { inputAnswers, nativeChatId, projectChat } from "../../../../../electron/main/session-sources/agent-host/projection";
import { createAgentHostFixture } from "./fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(configure?: (server: Awaited<ReturnType<typeof createAgentHostFixture>>) => void) {
  const server = await createAgentHostFixture();
  cleanup.push(() => server.close());
  configure?.(server);
  const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 100_000 });
  cleanup.push(() => adapter.stop());
  await adapter.start();
  const id = (await adapter.listSessions("copilot"))[0].id;
  return { server, adapter, id };
}

describe("local endpoint validation", () => {
  it("accepts authenticated local pipes and rejects remote or invalid metadata", () => {
    const valid = { schemaVersion: 2, type: "editor", pid: 123, instanceId: "one", connectionToken: "a".repeat(32),
      endpoint: { type: "socket", path: "\\\\.\\pipe\\vscode-agent-host-one" } };
    expect(parseEndpoint(valid, "profile", "win32")?.source).toBe("profile");
    expect(parseEndpoint({ ...valid, type: "standalone" }, "profile", "win32")?.type).toBe("standalone");
    for (const patch of [{ type: "unknown" }, { schemaVersion: 1 }, { connectionToken: "" }, { pid: -1 },
      { endpoint: { type: "tcp", host: "evil.example", port: 80 } },
      { endpoint: { type: "socket", path: "\\\\other-machine\\pipe\\vscode-agent-host-one" } }]) {
      expect(parseEndpoint({ ...valid, ...patch }, "profile", "win32")).toBeUndefined();
    }
  });
});

describe("AgentHostConnection", () => {
  it("refuses a standalone host when its token is incorrect", async () => {
    const server = await createAgentHostFixture("copilotcli", "tcp");
    cleanup.push(() => server.close());
    const client = new AgentHostConnection({ ...server.endpoint, token: "wrong-token-for-local-fixture" },
      { onChange() {}, onCatalogChange() {}, onClose() {} });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toThrow("Cannot connect");
    expect(server.requests).toHaveLength(0);
  });

  it("buffers actions arriving before a subscription snapshot and rejects unaccepted writes", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    const client = new AgentHostConnection(server.endpoint, { onChange() {}, onCatalogChange() {}, onClose() {} });
    cleanup.push(() => client.close());
    await client.connect();
    server.snapshotInterleave = () => server.broadcast(server.chatUri, { type: "chat/turnStarted", turnId: "race",
      startedAt: "2026-11-19T00:00:00Z", message: { text: "hello", origin: { kind: "user" } } });
    await client.subscribe(server.chatUri);
    expect(client.chats.get(server.chatUri)?.activeTurn?.id).toBe("race");
    server.rejectNext = true;
    await expect(client.dispatch(server.chatUri, { type: "chat/turnCancelled", turnId: "race", duration: 0 })).rejects.toThrow("rejected");
    expect(client.chats.get(server.chatUri)?.activeTurn?.id).toBe("race");
  });
});

describe("AgentHostService", () => {
  it.each(["socket", "tcp"] as const)("does not infer a creating app from a %s host, provider, or extension metadata", async transport => {
    const server = await createAgentHostFixture("copilotcli", transport);
    cleanup.push(() => server.close());
    Object.assign(server.session, { _meta: { creator: "VS Code", application: "Agency" } });
    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 100_000 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const session = (await adapter.listSessions("copilot"))[0];
    expect(session.connection).toMatchObject({ source: "Agent Host", executor: "Agent Host", available: true });
    expect(session.connection?.origin).toBeUndefined();
    await adapter.restoreSession(session.id);
    expect((await adapter.getSession(session.id))?.connection?.origin).toBeUndefined();
    await adapter.setEnabled(false);
    expect((await adapter.getCatalog("copilot")).sessions[0].connection).toMatchObject({
      source: "Agent Host", executor: "Agent Host", available: false,
    });
    await adapter.setEnabled(true);
    expect((await adapter.listSessions("copilot"))[0]).toMatchObject({ id: session.id, engineType: "copilot" });
    expect((await adapter.getSession(session.id))?.connection?.origin).toBeUndefined();
  });

  it.each(["127.0.0.1", "localhost"])("continues an authenticated standalone owner's chat over %s TCP", async host => {
    const server = await createAgentHostFixture("copilotcli", "tcp");
    cleanup.push(() => server.close());
    if (server.endpoint.transport.type === "tcp") server.endpoint.transport.host = host;
    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 100_000 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const sessions = await adapter.listSessions("copilot");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].connection?.available).toBe(true);
    await adapter.sendMessage(sessions[0].id, [{ type: "text", text: "same standalone owner" }]);
    expect(server.chat.activeTurn?.message.text).toBe("same standalone owner");
    await adapter.setEnabled(false);
    await adapter.setEnabled(true);
    expect((await adapter.listSessions("copilot"))[0].id).toBe(sessions[0].id);
    expect(server.requests.some(request => ["createSession", "disposeSession"].includes(request.method))).toBe(false);
  });

  it("discovers without loading transcripts, continues the same chat, and follows external deltas", async () => {
    const { server, adapter, id } = await setup();
    expect(server.requests.some(request => request.method === "subscribe" && request.params.channel === server.chatUri)).toBe(false);
    const updated = vi.fn();
    adapter.on("message.updated", updated);
    await adapter.sendMessage(id, [{ type: "text", text: "continue" }]);
    const turnId = server.chat.activeTurn!.id;
    expect(server.chat.activeTurn?.message.text).toBe("continue");
    expect(server.requests.some(request => request.method === "createSession")).toBe(false);
    server.broadcast(server.chatUri, { type: "chat/responsePart", turnId, part: { kind: "markdown", id: "reply", content: "" } });
    server.broadcast(server.chatUri, { type: "chat/delta", turnId, partId: "reply", content: "same owner" });
    server.broadcast(server.chatUri, { type: "chat/turnComplete", turnId, duration: 10 });
    await expect.poll(() => updated.mock.calls.some(([event]) => event.message.parts.some((part: { text?: string }) => part.text === "same owner"))).toBe(true);
    const history = await adapter.listMessages(id);
    expect(history).toHaveLength(2);
    expect(history[1].parts[0]).toMatchObject({ type: "text", text: "same owner" });
    expect((await adapter.listMessages(id)).map(message => message.id)).toEqual(history.map(message => message.id));
  });

  it("keeps unavailable identities and never creates a replacement after reconnect or disabling sharing", async () => {
    const { server, adapter, id } = await setup();
    await adapter.restoreSession(id);
    await adapter.setEnabled(false);
    expect((await adapter.getCatalog("copilot")).sessions[0].connection?.available).toBe(false);
    await expect(adapter.sendMessage(id, [{ type: "text", text: "offline" }])).rejects.toThrow("unavailable");
    await adapter.setEnabled(true);
    expect((await adapter.listSessions("copilot"))[0].id).toBe(id);
    await adapter.restoreSession(id);
    expect(adapter.hasSession(id)).toBe(true);
    await adapter.removeSession(id);
    expect(server.requests.some(request => ["disposeSession", "createSession"].includes(request.method))).toBe(false);
  });

  it("rejects a pending native approval and withdraws prompts when another client completes them", async () => {
    const { server, adapter, id } = await setup();
    await adapter.sendMessage(id, [{ type: "text", text: "test approval" }]);
    const turnId = server.chat.activeTurn!.id;
    server.broadcast(server.chatUri, { type: "chat/toolCallStart", turnId, toolCallId: "tool", toolName: "powershell", displayName: "Print marker" });
    server.broadcast(server.chatUri, { type: "chat/toolCallReady", turnId, toolCallId: "tool", invocationMessage: "Print marker", toolInput: "{\"command\":\"echo test\"}" });
    await expect.poll(() => adapter.getPendingPermissions(id).length).toBe(1);
    const permission = adapter.getPendingPermissions(id)[0];
    await expect(adapter.replyPermission(permission.id, { optionId: "deny" }, "another-chat")).rejects.toThrow();
    await adapter.replyPermission(permission.id, { optionId: "deny" }, id);
    expect(server.chat.activeTurn?.responseParts.find(part => part.kind === "toolCall")).toMatchObject({ toolCall: { status: "cancelled", reason: "denied" } });
    expect(adapter.getPendingPermissions(id)).toHaveLength(0);
    await expect(adapter.replyPermission(permission.id, { optionId: "allow" }, id)).rejects.toThrow("no longer");
  });

  it("validates model changes and sends mode changes to the native owner", async () => {
    const { adapter, server, id } = await setup();
    await adapter.setMode(id, "plan");
    expect(server.session.config?.values.mode).toBe("plan");
    await adapter.setModel(id, "test-model");
    expect(server.chat.draft?.model?.id).toBe("test-model");
    await expect(adapter.setModel(id, "nonexistent")).rejects.toThrow("not available");
    await expect(adapter.setReasoningEffort(id, "max")).rejects.toThrow("not supported");
  });

  it("uses the owner queue instead of starting a competing turn", async () => {
    const { adapter, server, id } = await setup();
    const consumed = vi.fn();
    adapter.on("message.queued.consumed", consumed);
    await adapter.sendMessage(id, [{ type: "text", text: "first" }]);
    const original = server.chat.activeTurn!.id;
    await adapter.sendMessage(id, [{ type: "text", text: "second" }], { clientMessageId: "optimistic-second" });
    expect(server.chat.activeTurn?.id).toBe(original);
    expect(server.chat.queuedMessages?.[0].message.text).toBe("second");
    const queued = server.chat.queuedMessages![0];
    server.broadcast(server.chatUri, { type: "chat/turnComplete", turnId: original, duration: 1 });
    server.broadcast(server.chatUri, { type: "chat/turnStarted", turnId: "next", queuedMessageId: queued.id,
      startedAt: "2026-11-19T00:00:01Z", message: queued.message });
    await expect.poll(() => consumed.mock.calls.length).toBe(1);
    expect(consumed.mock.calls[0][0]).toMatchObject({ sessionId: id, clientMessageId: "optimistic-second" });
  });

  it("keeps conflicting live owners unavailable across catalogue refreshes", async () => {
    const first = await createAgentHostFixture(), second = await createAgentHostFixture();
    cleanup.push(() => first.close(), () => second.close());
    const adapter = new AgentHostService({ enabled: true, discover: async () => [first.endpoint, second.endpoint], pollMs: 20 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const id = (await adapter.listSessions("copilot"))[0].id;
    await expect.poll(() => first.requests.filter(request => request.method === "listSessions").length).toBeGreaterThan(2);
    expect((await adapter.getSession(id))?.connection?.available).toBe(false);
    await expect(adapter.sendMessage(id, [{ type: "text", text: "unsafe" }])).rejects.toThrow("unavailable");
    expect(first.chat.activeTurn).toBeUndefined();
    expect(second.chat.activeTurn).toBeUndefined();
  });

  it("reconnects after transport loss without replacing or duplicating the native chat", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 20 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const id = (await adapter.listSessions("copilot"))[0].id;
    await adapter.sendMessage(id, [{ type: "text", text: "persisted" }]);
    const before = (await adapter.listMessages(id)).map(message => message.id);
    server.dropConnections();
    await expect.poll(() => server.requests.filter(request => request.method === "initialize").length).toBe(2);
    await expect.poll(async () => (await adapter.getSession(id))?.connection?.available).toBe(true);
    expect((await adapter.listMessages(id)).map(message => message.id)).toEqual(before);
    expect(server.requests.some(request => request.method === "createSession")).toBe(false);
  });

  it("preserves native model configuration and maps extra-high and maximum effort separately", async () => {
    const { server, adapter, id } = await setup(server => {
      server.models.push({ id: "reasoning-model", provider: "copilotcli", name: "Reasoning", configSchema: {
        type: "object", properties: { thinkingLevel: { type: "string", enum: ["low", "xhigh", "max"] } },
      } });
      server.broadcast(server.chatUri, { type: "chat/draftChanged", draft: {
        text: "native draft", origin: { kind: "user" }, model: { id: "reasoning-model", config: { contextSize: 922000, thinkingLevel: "xhigh" } },
      } });
    });
    await adapter.restoreSession(id);
    expect(adapter.getReasoningEffort(id)).toBe("max");
    await adapter.setReasoningEffort(id, "ultra");
    expect(server.chat.draft?.model?.config).toEqual({ contextSize: 922000, thinkingLevel: "max" });
    await adapter.setModel(id, "reasoning-model");
    expect(server.chat.draft?.text).toBe("native draft");
    await adapter.sendMessage(id, [{ type: "text", text: "keep native config" }]);
    expect(server.chat.activeTurn?.message.model?.config).toEqual({ contextSize: 922000, thinkingLevel: "max" });
    await adapter.setReasoningEffort(id, null);
    expect(server.chat.draft?.model?.config).toEqual({ contextSize: 922000 });
  });

  it("loads a read-only chat without allowing messages to its executor", async () => {
    const { adapter, server, id } = await setup(server => {
      server.broadcast(server.chatUri, { type: "chat/turnStarted", turnId: "old", startedAt: "2026-11-19T00:00:00Z",
        message: { text: "read-only history", origin: { kind: "user" } } });
      server.broadcast(server.chatUri, { type: "chat/turnComplete", turnId: "old", duration: 1 });
      Object.assign(server.chat, { interactivity: "read-only" });
    });
    expect((await adapter.listMessages(id))[0].parts[0]).toMatchObject({ text: "read-only history" });
    expect((await adapter.getSession(id))?.connection).toMatchObject({ available: true, readOnly: true });
    await expect(adapter.sendMessage(id, [{ type: "text", text: "forbidden" }])).rejects.toThrow("read-only");
    expect(server.chat.activeTurn).toBeUndefined();
  });

  it("completes native questions and refuses a stale second reply", async () => {
    const { adapter, server, id } = await setup();
    await adapter.sendMessage(id, [{ type: "text", text: "ask" }]);
    server.broadcast(server.chatUri, { type: "chat/responsePart", turnId: server.chat.activeTurn!.id, part: {
      kind: "inputRequest", request: { id: "question", message: "This operation produces a large log.\nConfirm before continuing.", questions: [
        { id: "choice", kind: "single-select", message: "Pick", required: true, options: [{ id: "one", label: "First" }] },
      ] },
    } });
    await expect.poll(() => adapter.getPendingQuestions(id).length).toBe(1);
    const question = adapter.getPendingQuestions(id)[0];
    expect(question).toMatchObject({
      message: "This operation produces a large log.\nConfirm before continuing.",
      questions: [{ question: "Pick", options: [{ label: "First" }] }],
    });
    await adapter.replyQuestion(question.id, [["First"]], id);
    expect(adapter.getPendingQuestions(id)).toHaveLength(0);
    await expect(adapter.replyQuestion(question.id, [["First"]], id)).rejects.toThrow("no longer");
    expect(server.chat.activeTurn?.responseParts[0]).toMatchObject({ kind: "inputRequest", response: "accept",
      request: { answers: { choice: { state: "submitted", value: { kind: "selected", value: "one" } } } } });
  });
});

describe("native projection", () => {
  it("scopes chat and message identities by source while preserving ordered text, reasoning, and errors", () => {
    const chat = { resource: "ahp-chat:/same", title: "", modifiedAt: "2026-11-19T00:00:00Z", status: 2, turns: [{
      id: "turn", startedAt: "2026-11-19T00:00:00Z", state: "error", message: { text: "prompt", origin: { kind: "user" } },
      responseParts: [{ kind: "reasoning", id: "reason", content: "working" }, { kind: "markdown", id: "text", content: "answer" },
        { kind: "error", error: { errorType: "test", message: "failed" } }],
    }] } as ChatState;
    const a = nativeChatId("source-a", chat.resource), b = nativeChatId("source-b", chat.resource);
    const messages = projectChat(a, chat, "", "copilot");
    expect(a).not.toBe(b);
    expect(messages[1].id).not.toBe(projectChat(b, chat, "", "copilot")[1].id);
    expect(messages[1]).toMatchObject({ error: "failed", parts: [{ type: "reasoning", order: 0 }, { type: "text", order: 1 }] });
  });

  it("maps choice labels to native IDs and validates constrained answers without dropping whitespace", () => {
    const request = { id: "input", questions: [
      { id: "choice", kind: "single-select", message: "Pick", required: true, options: [{ id: "native-id", label: "Visible choice" }] },
      { id: "count", kind: "integer", message: "Count", min: 1, max: 3 },
      { id: "text", kind: "text", message: "Text", min: 1 },
    ] } as ChatInputRequest;
    expect(inputAnswers(request, [["Visible choice"], ["2"], [" x "]])).toMatchObject({
      choice: { state: "submitted", value: { kind: "selected", value: "native-id" } },
      count: { value: { kind: "number", value: 2 } }, text: { value: { value: " x " } },
    });
    expect(() => inputAnswers(request, [["bad"], ["2"], ["x"]])).toThrow();
    expect(() => inputAnswers(request, [["Visible choice"], ["2.5"], ["x"]])).toThrow();
    expect(() => inputAnswers(request, [[], ["2"], ["x"]])).toThrow();
  });
});
