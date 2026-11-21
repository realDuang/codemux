import { afterEach, describe, expect, it, vi } from "vitest";
import { MockEngineAdapter } from "../../../../electron/main/engines/mock-adapter";
import { HostRoutedAdapter } from "../../../../electron/main/engines/host-routed-adapter";
import { AgentHostService } from "../../../../electron/main/session-sources/agent-host/service";
import { createAgentHostFixture } from "../session-sources/agent-host/fixture";
import { nativeChatId } from "../../../../electron/main/session-sources/agent-host/projection";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { migrateCodexConversationMetadata } from "../../../../electron/main/engines/codex/conversation-migration";
import type { ConversationMeta } from "../../../../src/types/unified";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("HostRoutedAdapter", () => {
  it.each(["copilot", "claude", "codex"])("preserves %s local SDK creation, configuration, commands, and history", async engineType => {
    const source = new AgentHostService();
    const sdk = new MockEngineAdapter({ engineType });
    const adapter = new HostRoutedAdapter(sdk, source);
    const create = vi.spyOn(sdk, "createSession");
    const mode = vi.spyOn(sdk, "setMode"), model = vi.spyOn(sdk, "setModel"), history = vi.spyOn(sdk, "getHistoricalMessages");
    const commands = vi.spyOn(sdk, "listCommands"), tier = vi.spyOn(sdk, "setServiceTier");
    await adapter.start();
    cleanup.push(() => adapter.stop());
    const session = await adapter.createSession("local-directory");
    await adapter.setMode(session.id, "plan");
    await adapter.setModel(session.id, "local-model");
    await adapter.setServiceTier(session.id, "fast");
    await adapter.listCommands(session.id, "local-directory");
    await adapter.getHistoricalMessages(session.id, "local-directory");
    expect(create).toHaveBeenCalledExactlyOnceWith("local-directory", undefined);
    expect(mode).toHaveBeenCalledExactlyOnceWith(session.id, "plan");
    expect(model).toHaveBeenCalledExactlyOnceWith(session.id, "local-model");
    expect(tier).toHaveBeenCalledExactlyOnceWith(session.id, "fast");
    expect(commands).toHaveBeenCalledExactlyOnceWith(session.id, "local-directory");
    expect(history).toHaveBeenCalledExactlyOnceWith(session.id, "local-directory", undefined);
    expect(adapter.getStatus()).toBe(sdk.getStatus());
    expect(adapter.getAuthMethods()).toEqual(sdk.getAuthMethods());
    expect(adapter.getSessionCapabilities(session.id)).toEqual(sdk.getSessionCapabilities(session.id));
  });

  it("adds host chats to the existing native catalog without replacing its source, projects, or sharing control", async () => {
    const server = await createAgentHostFixture("codex");
    cleanup.push(() => server.close());
    const source = new AgentHostService({ enabled: true, discover: async () => [server.endpoint] });
    cleanup.push(() => source.stop());
    const sdk = new MockEngineAdapter({ engineType: "codex" });
    const originalCapabilities = sdk.getCapabilities();
    vi.spyOn(sdk, "getCapabilities").mockReturnValue({ ...originalCapabilities, sessionCatalog: true, sessionSharing: true });
    const local = { id: "native-thread", engineType: "codex", directory: "local", title: "Native" };
    vi.spyOn(sdk, "getCatalog").mockResolvedValue({ sourceId: "native-catalog", engineType: "codex", revision: "1", complete: true, projects: [{ id: "native-project", directory: "local", name: "Local" }], sessions: [local] });
    const sharing = vi.spyOn(sdk, "setSessionSharing").mockResolvedValue({ enabled: true, available: true, peerName: "Desktop", status: "connected" });
    const adapter = new HostRoutedAdapter(sdk, source);
    await source.start();
    const catalog = await adapter.getCatalog();
    expect(catalog.sourceId).toBe("native-catalog");
    expect(catalog.sessions).toContainEqual(local);
    expect(catalog.sessions).toHaveLength(2);
    expect(catalog.projects.map(project => project.id)).toContain("native-project");
    await adapter.setSessionSharing(true);
    expect(sharing).toHaveBeenCalledExactlyOnceWith(true);
    expect(source.getState().enabled).toBe(true);
    await source.setEnabled(false);
    expect((await adapter.getCatalog()).sessions[0]).toEqual(local);
    expect(sharing).toHaveBeenCalledOnce();
  });

  it("keeps a host provider usable when its independent native catalog and SDK are unavailable", async () => {
    const host = await createAgentHostFixture("codex");
    cleanup.push(() => host.close());
    const source = new AgentHostService({ enabled: true, discover: async () => [host.endpoint] });
    cleanup.push(() => source.stop());
    const sdk = new MockEngineAdapter({ engineType: "codex" });
    vi.spyOn(sdk, "getCapabilities").mockReturnValue({ ...sdk.getCapabilities(), sessionCatalog: true });
    vi.spyOn(sdk, "getCatalog").mockRejectedValue(new Error("Local CLI unavailable"));
    const adapter = new HostRoutedAdapter(sdk, source, "existing-native-source");
    await source.start();
    const catalog = await adapter.getCatalog();
    expect(catalog).toMatchObject({ sourceId: "existing-native-source", complete: false, sessions: [expect.objectContaining({ engineType: "codex" })] });
    await adapter.sendMessage(catalog.sessions[0].id, [{ type: "text", text: "host remains usable" }]);
    expect(host.chat.activeTurn?.message.text).toBe("host remains usable");
    expect(sdk.getStatus()).toBe("stopped");
  });

  it.each(["claude", "codex"])("routes advertised %s chats through AHP without SDK resume, model, or permission fallback", async engineType => {
    const server = await createAgentHostFixture(engineType);
    cleanup.push(() => server.close());
    const source = new AgentHostService({ enabled: true, discover: async () => [server.endpoint] });
    cleanup.push(() => source.stop());
    const sdk = new MockEngineAdapter({ engineType });
    const send = vi.spyOn(sdk, "sendMessage"), restore = vi.spyOn(sdk, "restoreSession"), model = vi.spyOn(sdk, "setModel");
    const permission = vi.spyOn(sdk, "replyPermission");
    const adapter = new HostRoutedAdapter(sdk, source);
    await source.start();
    const session = (await adapter.getCatalog()).sessions[0];
    expect(session.engineType).toBe(engineType);
    expect(session.engineMeta?.ahpProvider).toBe(engineType);
    expect(session.connection?.models?.[0].engineType).toBe(engineType);
    expect(session.connection?.modes?.map(mode => mode.id)).toEqual(["interactive", "plan"]);
    await adapter.restoreSession(session.id, "");
    await adapter.setModel(session.id, "test-model");
    await adapter.sendMessage(session.id, [{ type: "text", text: "same host" }]);
    expect(server.chat.activeTurn?.message.text).toBe("same host");
    server.broadcast(server.chatUri, { type: "chat/toolCallStart", turnId: server.chat.activeTurn!.id, toolCallId: "approval", toolName: "Bash", displayName: "Command" });
    server.broadcast(server.chatUri, { type: "chat/toolCallReady", turnId: server.chat.activeTurn!.id, toolCallId: "approval", invocationMessage: "Command", toolInput: "{}" });
    await expect.poll(async () => (await adapter.getPendingPermissions()).length).toBe(1);
    const pending = (await adapter.getPendingPermissions())[0];
    expect(pending.engineType).toBe(engineType);
    await adapter.replyPermission(pending.id, { optionId: "deny" });
    expect(source.getPendingPermissions()).toEqual([]);
    await expect(adapter.replyPermission(pending.id, { optionId: "deny" })).rejects.toThrow("no longer");
    await source.setEnabled(false);
    await expect(adapter.sendMessage(session.id, [{ type: "text", text: "offline" }])).rejects.toThrow("unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
  });

  it("uses one opt-in source connection for mixed providers and never exposes unknown harnesses as Copilot", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    const secondUri = "ahp-chat:/claude";
    const second = { ...server.chat, resource: secondUri, provider: "claude" } as ChatState;
    server.extraChats.set(secondUri, second);
    server.session.chats.push({ resource: secondUri, title: "Claude chat", status: 1, modifiedAt: server.chat.modifiedAt, provider: "claude" });
    server.session.chats.push({ resource: "ahp-chat:/unknown", title: "Unknown", status: 1, modifiedAt: server.chat.modifiedAt, provider: "other-harness" });
    server.providers.push("claude", "other-harness");
    server.unavailableSession = true;
    server.models.push({ id: "claude-only", name: "Claude", provider: "claude" });
    const persistEnabled = vi.fn(async () => undefined), discover = vi.fn(async () => [server.endpoint]);
    const source = new AgentHostService({ discover, persistEnabled });
    cleanup.push(() => source.stop());
    const copilotSdk = new MockEngineAdapter({ engineType: "copilot" }), claudeSdk = new MockEngineAdapter({ engineType: "claude" });
    const copilot = new HostRoutedAdapter(copilotSdk, source), claude = new HostRoutedAdapter(claudeSdk, source);
    await source.start();
    expect(discover).not.toHaveBeenCalled();
    await source.setEnabled(true);
    expect(server.connectionCount).toBe(1);
    expect(server.requests.filter(request => request.method === "initialize")).toHaveLength(1);
    expect(source.getState()).toMatchObject({ id: "vscode", status: "connected",
      providers: [{ id: "copilotcli", engineType: "copilot", supported: true }, { id: "claude", engineType: "claude", supported: true }, { id: "other-harness", supported: false }] });
    const copilotSession = (await copilot.getCatalog()).sessions[0], claudeSession = (await claude.getCatalog()).sessions[0];
    expect((await copilot.getCatalog()).sessions).toHaveLength(1);
    expect((await claude.getCatalog()).sessions).toHaveLength(1);
    expect(claudeSession.connection?.models?.map(model => model.modelId)).toEqual(["claude-only"]);
    await claude.setModel(claudeSession.id, "claude-only");
    await expect(claude.setModel(claudeSession.id, "test-model")).rejects.toThrow("not available");
    await expect(copilot.sendMessage(claudeSession.id, [{ type: "text", text: "wrong provider" }])).rejects.toThrow("provider");
    await claude.sendMessage(claudeSession.id, [{ type: "text", text: "Claude route" }]);
    expect(server.extraChats.get(secondUri)?.activeTurn?.message.text).toBe("Claude route");
    expect(server.chat.activeTurn).toBeUndefined();
    await source.setEnabled(false);
    expect(persistEnabled.mock.calls).toEqual([[true], [false]]);
    for (const [adapter, id] of [[copilot, copilotSession.id], [claude, claudeSession.id]] as const) {
      expect((await adapter.getCatalog()).sessions[0].connection?.available).toBe(false);
      await expect(adapter.restoreSession(id, "")).rejects.toThrow("unavailable");
    }
    expect(server.requests.filter(request => request.method === "initialize")).toHaveLength(1);
    expect(copilot.getCapabilities().sessionSharing).not.toBe(true);
    expect(claude.getCapabilities().sessionSharing).not.toBe(true);
  });

  it("retains old Copilot IDs and provider-qualified saved histories while disabled", async () => {
    const old = { id: nativeChatId("source", "ahp-chat:/old"), engineType: "copilot", directory: "", title: "Old",
      connection: { origin: "VS Code", executor: "VS Code", shared: true, available: true },
      engineMeta: { ahpSource: "source", ahpSession: "ahp-session:/old", ahpChat: "ahp-chat:/old" } };
    const claude = { ...old, id: nativeChatId("source", "ahp-chat:/claude"), engineType: "claude",
      engineMeta: { ...old.engineMeta, ahpChat: "ahp-chat:/claude", ahpProvider: "claude" } };
    const source = new AgentHostService({ knownSessions: () => [old, claude], discover: vi.fn() });
    cleanup.push(() => source.stop());
    await source.start();
    expect((await source.getCatalog("copilot")).sourceId).toBe("copilot:vscode-local:v1");
    expect((await source.getCatalog("copilot")).sessions[0].id).toBe(old.id);
    const saved = (await source.getCatalog("copilot")).sessions[0];
    expect(saved.connection).toMatchObject({ source: "Agent Host", executor: "Agent Host", available: false });
    expect(saved.connection?.origin).toBeUndefined();
    expect((await source.getCatalog("claude")).sessions[0]).toMatchObject({ id: claude.id, connection: { available: false, sharingStatus: "disabled" } });
  });

  it("does not grant Codex SDK ownership to a saved host chat during startup migration", () => {
    const conversation = { id: "saved", engineType: "codex", engineSessionId: nativeChatId("source", "ahp-chat:/codex"),
      engineMeta: { ahpSource: "source", ahpChat: "ahp-chat:/codex", ahpProvider: "codex" } } as ConversationMeta;
    expect(migrateCodexConversationMetadata(conversation)).toBe(conversation);
    expect(conversation.engineMeta?.codexDesktopOwner).toBeUndefined();
  });

  it("keeps local creation and models on the SDK while native sends stay on the original executor", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    const sdk = new MockEngineAdapter({ engineType: "copilot" });
    const create = vi.spyOn(sdk, "createSession");
    const send = vi.spyOn(sdk, "sendMessage");
    const external = new AgentHostService({ enabled: true, discover: async () => [server.endpoint] });
    cleanup.push(() => external.stop());
    const adapter = new HostRoutedAdapter(sdk, external);
    cleanup.push(() => adapter.stop());
    await adapter.start();
    await external.start();
    const local = await adapter.createSession("test-workspace");
    const native = (await adapter.getCatalog()).sessions[0];
    expect(create).toHaveBeenCalledOnce();
    expect(adapter.getSessionCapabilities(local.id).authoritativeSessionState).not.toBe(true);
    expect(adapter.getSessionCapabilities(native.id).authoritativeSessionState).toBe(true);
    expect((await adapter.listModels()).models).toEqual((await sdk.listModels()).models);
    expect(native.connection?.models?.map(model => model.modelId)).toEqual(["test-model"]);
    await adapter.sendMessage(native.id, [{ type: "text", text: "same native executor" }]);
    expect(server.chat.activeTurn?.message.text).toBe("same native executor");
    expect(send).not.toHaveBeenCalled();
    await external.setEnabled(false);
    await expect(adapter.restoreSession(native.id, "")).rejects.toThrow("unavailable");
    await expect(adapter.sendMessage(native.id, [{ type: "text", text: "no fallback" }])).rejects.toThrow("unavailable");
    expect(create).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(await adapter.getSession(local.id)).not.toBeNull();
  });

  it("rejects unknown AHP identities instead of treating them as SDK history", async () => {
    const sdk = new MockEngineAdapter({ engineType: "copilot" });
    const restore = vi.spyOn(sdk, "restoreSession");
    const external = new AgentHostService({ discover: async () => [] });
    const adapter = new HostRoutedAdapter(sdk, external);
    cleanup.push(() => adapter.stop());
    await adapter.start();
    await expect(adapter.restoreSession("ahp:future:unknown", "")).rejects.toThrow("unavailable");
    expect(restore).not.toHaveBeenCalled();
  });
});
