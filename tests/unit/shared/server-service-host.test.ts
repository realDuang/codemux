import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRuntimeOptions } from "../../../shared/service-runtime";
import type { UnifiedCodexAdapterOptions } from "../../../electron/main/engines/codex/unified-adapter";
import type { DesktopCatalogOptions } from "../../../electron/main/engines/codex/desktop-catalog";

const state = vi.hoisted(() => {
  const adapter = (engineType: string) => ({
    engineType, start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  });
  const codex = {
    ...adapter("codex"),
    listHistoricalSessions: vi.fn(async (_limit: number) => []),
    listModels: vi.fn(async () => ({ providers: [], models: [] })),
    renameStoredThread: vi.fn(async (_threadId: string, _title: string) => {}),
    readStoredThread: vi.fn(async (_threadId: string, _options: { activeOnly: boolean }) => ({ thread: { id: "native" }, archived: false })),
    archiveStoredThread: vi.fn(async (_threadId: string) => ({ id: "native" })),
    unarchiveStoredThread: vi.fn(async (_threadId: string) => ({ id: "native" })),
    createDesktopCatalogClient: vi.fn(() => ({ request: vi.fn() })),
  };
  const unified = adapter("codex");
  const unsubscribe = vi.fn();
  return {
    codex,
    unified,
    openCode: adapter("opencode"),
    copilot: adapter("copilot"),
    claude: adapter("claude"),
    settings: {} as Record<string, unknown>,
    rows: [] as Array<{ engineType?: string; catalogSourceId?: string; engineSessionId?: string }>,
    runtimeOptions: undefined as ServiceRuntimeOptions | undefined,
    catalogOptions: undefined as DesktopCatalogOptions | undefined,
    runtime: { stop: vi.fn(async () => {}), isStartupReady: vi.fn(() => true), isStopping: vi.fn(() => false) },
    manager: { registerAdapter: vi.fn(), flushPendingState: vi.fn(async () => {}) },
    gateway: { revalidateClients: vi.fn(), close: vi.fn(async () => {}), getPort: vi.fn(() => 8233) },
    channels: { setWebhookServer: vi.fn(), registerAdapter: vi.fn() },
    unifiedFactory: vi.fn((_options: UnifiedCodexAdapterOptions) => unified),
    migrate: vi.fn(async (_options: unknown) => {}),
    enrollment: vi.fn((_path: string) => ({ sourceId: "local-source", cutoffMs: 1000 })),
    unsubscribe,
    subscribe: vi.fn((_listener: () => void) => unsubscribe),
    conversationFlush: vi.fn(async () => {}),
    worktreeFlush: vi.fn(async () => {}),
    orchestrationFlush: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("#runtime-host", () => ({ runtimeHost: { paths: { userDataPath: "/server-data" }, isPackaged: false } }));
vi.mock("../../../shared/service-runtime", () => ({
  ServiceRuntime: vi.fn(function (options: ServiceRuntimeOptions) {
    state.runtimeOptions = options;
    return state.runtime;
  }),
}));
vi.mock("../../../electron/main/gateway/engine-manager", () => ({ EngineManager: vi.fn(function () { return state.manager; }) }));
vi.mock("../../../electron/main/gateway/ws-server", () => ({ GatewayServer: vi.fn(function () { return state.gateway; }) }));
vi.mock("../../../electron/main/engines/opencode", () => ({ OpenCodeAdapter: vi.fn(function () { return state.openCode; }) }));
vi.mock("../../../electron/main/engines/copilot", () => ({ CopilotSdkAdapter: vi.fn(function () { return state.copilot; }) }));
vi.mock("../../../electron/main/engines/claude", () => ({ ClaudeCodeAdapter: vi.fn(function () { return state.claude; }) }));
vi.mock("../../../electron/main/engines/codex", () => ({ CodexAdapter: vi.fn(function () { return state.codex; }) }));
vi.mock("../../../electron/main/engines/codex/unified-adapter", () => ({ UnifiedCodexAdapter: vi.fn(function (options: UnifiedCodexAdapterOptions) { return state.unifiedFactory(options); }) }));
vi.mock("../../../electron/main/engines/codex/desktop-catalog-enrollment", () => ({ getOrCreateCodexCatalogEnrollment: state.enrollment }));
vi.mock("../../../electron/main/engines/codex/desktop-catalog", () => ({
  CodexDesktopCatalog: vi.fn(function (options: DesktopCatalogOptions) { state.catalogOptions = options; }),
}));
vi.mock("../../../electron/main/channels/channel-manager", () => ({ ChannelManager: vi.fn(function () { return state.channels; }) }));
vi.mock("../../../electron/main/channels/webhook-server", () => ({ WebhookServer: vi.fn(function () {}) }));
vi.mock("../../../electron/main/channels/feishu/feishu-adapter", () => ({ FeishuAdapter: vi.fn(function () {}) }));
vi.mock("../../../electron/main/channels/dingtalk/dingtalk-adapter", () => ({ DingTalkAdapter: vi.fn(function () {}) }));
vi.mock("../../../electron/main/channels/telegram/telegram-adapter", () => ({ TelegramAdapter: vi.fn(function () {}) }));
vi.mock("../../../electron/main/channels/wecom/wecom-adapter", () => ({ WeComAdapter: vi.fn(function () {}) }));
vi.mock("../../../electron/main/channels/teams/teams-adapter", () => ({ TeamsAdapter: vi.fn(function () {}) }));
vi.mock("../../../electron/main/channels/weixin-ilink/weixin-ilink-adapter", () => ({ WeixinIlinkAdapter: vi.fn(function () {}) }));
vi.mock("../../../electron/main/services/device-store", () => ({ deviceStore: {} }));
vi.mock("../../../electron/main/services/conversation-store", () => ({
  conversationStore: { list: vi.fn(() => state.rows), flushAll: state.conversationFlush, migrateCodexConversations: state.migrate },
}));
vi.mock("../../../electron/main/services/auth-api-server", () => ({ authApiServer: {} }));
vi.mock("../../../electron/main/services/production-server", () => ({ productionServer: {} }));
vi.mock("../../../electron/main/services/remote-access-manager", () => ({
  remoteAccessManager: { subscribe: state.subscribe }, setRemoteAccessPort: vi.fn(), stopRemoteAccessTunnel: vi.fn(),
}));
vi.mock("../../../electron/main/services/scheduled-task-service", () => ({ scheduledTaskService: {} }));
vi.mock("../../../electron/main/services/default-workspace", () => ({ ensureDefaultWorkspace: vi.fn() }));
vi.mock("../../../electron/main/services/terminal-service", () => ({ getTerminalService: vi.fn() }));
vi.mock("../../../electron/main/services/file-service", () => ({ unwatchAll: vi.fn() }));
vi.mock("../../../electron/main/services/worktree-store", () => ({ worktreeStore: { flush: state.worktreeFlush } }));
vi.mock("../../../electron/main/services/orchestrator-service", () => ({ orchestratorService: { flush: state.orchestrationFlush } }));
vi.mock("../../../electron/main/services/tunnel-manager", () => ({ tunnelManager: {} }));
vi.mock("../../../electron/main/channels/weixin-ilink/weixin-ilink-qr-flow", () => ({ getQrCode: vi.fn(), pollQrStatus: vi.fn() }));
vi.mock("../../../electron/main/services/logger", () => ({
  getLogFilePath: vi.fn(), getFileLogLevel: vi.fn(), setFileLogLevel: vi.fn(),
  loadSettings: vi.fn(() => state.settings), saveSettings: vi.fn(), mainLog: state.log,
}));

import { createServiceHost } from "../../../server/service-host";
import { conversationStore } from "../../../electron/main/services/conversation-store";

describe("createServiceHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODEMUX_CODEX_DESKTOP_BRIDGE", undefined);
    state.settings = {};
    state.rows = [];
    state.runtimeOptions = undefined;
    state.catalogOptions = undefined;
    state.runtime.stop.mockResolvedValue();
    state.codex.stop.mockResolvedValue();
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([
    { saved: undefined, env: undefined, enabled: false },
    { saved: true, env: undefined, enabled: true },
    { saved: "true", env: undefined, enabled: false },
    { saved: true, env: "0", enabled: false },
    { saved: false, env: "1", enabled: true },
    { saved: true, env: "true", enabled: false },
    { saved: true, env: "", enabled: false },
  ])("preserves Desktop opt-in for saved=$saved and env=$env", ({ saved, env, enabled }) => {
    state.settings = { codexDesktopBridgeEnabled: saved };
    vi.stubEnv("CODEMUX_CODEX_DESKTOP_BRIDGE", env);

    createServiceHost("static");

    const expected = [state.openCode, state.copilot, state.claude, state.unified];
    expect(state.manager.registerAdapter.mock.calls.map(([registered]) => registered)).toEqual(expected);
    expect(state.runtimeOptions?.engines.map(([, engine]) => engine)).toEqual(expected);
    expect(state.unifiedFactory).toHaveBeenCalledOnce();
    expect(state.unifiedFactory.mock.calls[0][0].sharingEnabled).toBe(enabled);
    expect(state.channels.registerAdapter).toHaveBeenCalledTimes(6);
    expect(state.enrollment).toHaveBeenCalledOnce();
    expect(state.codex.start).not.toHaveBeenCalled();
  });

  it("uses the regular Codex adapter for metadata without registering the private execution adapter", async () => {
    vi.stubEnv("CODEMUX_CODEX_DESKTOP_BRIDGE", "1");
    createServiceHost("dev-proxy");
    const options = state.unifiedFactory.mock.calls[0][0];

    await options.listCandidates!(25);
    await options.renameStoredThread!("native", "Renamed");
    await options.readStoredThread!("native");
    await options.archiveStoredThread!("native");

    expect(state.codex.listHistoricalSessions).toHaveBeenCalledWith(25);
    expect(state.codex.start).not.toHaveBeenCalled();
    expect(state.codex.renameStoredThread).toHaveBeenCalledWith("native", "Renamed");
    expect(state.codex.readStoredThread).toHaveBeenCalledWith("native", { activeOnly: true });
    expect(state.codex.archiveStoredThread).toHaveBeenCalledWith("native");
    expect(options.catalogManagement).toBeUndefined();
  });

  it("uses the original enrollment and admits same-source shared and independent native IDs", () => {
    state.settings = { codexDesktopBridgeEnabled: true };
    state.rows = [
      { engineType: "codex", catalogSourceId: "local-source", engineSessionId: "00000000-0000-0000-0000-000000000001" },
      { engineType: "codex", catalogSourceId: "other-source", engineSessionId: "00000000-0000-0000-0000-000000000002" },
      { engineType: "codex", engineSessionId: "00000000-0000-0000-0000-000000000003" },
      { catalogSourceId: "local-source" },
    ];
    createServiceHost("static");
    expect(state.enrollment).toHaveBeenCalledOnce();

    state.unifiedFactory.mock.calls[0][0].catalogFactory!();

    expect(state.enrollment).toHaveBeenCalledWith("/server-data", expect.any(String));
    expect(conversationStore.list).toHaveBeenCalledWith({ engineType: "codex" });
    expect(state.catalogOptions).toMatchObject({
      sourceId: "local-source", cutoffMs: 1000, previouslyAdmittedThreadIds: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000003"],
    });
    expect(state.catalogOptions?.client).toBe(state.codex.createDesktopCatalogClient.mock.results[0].value);
    state.catalogOptions?.onError?.(new Error("Catalog unavailable"));
    expect(state.log.warn).toHaveBeenCalledWith("Codex catalog refresh failed:", "Catalog unavailable");
  });

  it("waits for metadata runtime cleanup before draining final persisted state", async () => {
    state.settings = { codexDesktopBridgeEnabled: true };
    let finish!: () => void;
    state.codex.stop.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const host = createServiceHost("static");

    const stopping = host.stop();
    await vi.waitFor(() => expect(state.codex.stop).toHaveBeenCalledOnce());
    expect(state.runtime.stop).toHaveBeenCalledOnce();
    expect(state.manager.flushPendingState).not.toHaveBeenCalled();
    finish();
    await stopping;

    expect(state.manager.flushPendingState).toHaveBeenCalledOnce();
    expect(state.conversationFlush).toHaveBeenCalledOnce();
    expect(state.worktreeFlush).toHaveBeenCalledOnce();
    expect(state.orchestrationFlush).toHaveBeenCalledOnce();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  it("still stops metadata if another runtime cleanup fails", async () => {
    state.settings = { codexDesktopBridgeEnabled: true };
    const failure = new Error("Engine cleanup failed");
    state.runtime.stop.mockRejectedValue(failure);

    await expect(createServiceHost("static").stop()).rejects.toBe(failure);

    expect(state.codex.stop).toHaveBeenCalledOnce();
    expect(state.manager.flushPendingState).not.toHaveBeenCalled();
  });

  it("retains the ordinary shutdown path while Desktop sharing is disabled", async () => {
    await createServiceHost("static").stop();

    expect(state.codex.stop).toHaveBeenCalledOnce();
    expect(state.runtime.stop).toHaveBeenCalledOnce();
    expect(state.manager.flushPendingState).toHaveBeenCalledOnce();
    expect(state.conversationFlush).toHaveBeenCalledOnce();
    expect(state.unsubscribe).toHaveBeenCalledOnce();
  });
});
