import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FEISHU_CONFIG,
  TEMP_SESSION_TTL_MS,
} from "../../../../../electron/main/channels/feishu/feishu-types";

const { mockScopedLogger } = vi.hoisted(() => ({
  mockScopedLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  feishuLog: mockScopedLogger,
  larkLog: mockScopedLogger,
  channelLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
  getFeishuChannelLog: vi.fn(() => mockScopedLogger),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: {
      chat: {
        create: vi.fn(),
        update: vi.fn(),
      },
    },
  })),
  WSClient: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
  })),
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
  })),
  LoggerLevel: { info: 2 },
}));

import { FeishuAdapter } from "../../../../../electron/main/channels/feishu/feishu-adapter";

function makeBinding(overrides: Partial<any> = {}): any {
  return {
    chatId: "g1",
    conversationId: "s1",
    engineType: "claude",
    directory: "/d",
    projectId: "p",
    ownerOpenId: "u1",
    streamingSessions: new Map(),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("FeishuAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------
  describe("getInfo / mergeConfig", () => {
    it("reports stopped status before start", () => {
      const a = new FeishuAdapter();
      const info = a.getInfo();
      expect(info.type).toBe("feishu");
      expect(info.status).toBe("stopped");
    });

    it("uses the selected platform in the channel display name", () => {
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "lark" };
      expect(adapter.getInfo().name).toBe("Lark Bot");
    });

    it("merges defined fields while preserving existing values for undefined updates", () => {
      const adapter = new FeishuAdapter() as any;
      const baseConfig = {
        ...DEFAULT_FEISHU_CONFIG,
        appId: "app-1",
        appSecret: "secret-1",
        gatewayUrl: "ws://127.0.0.1:4200",
      };
      const merged = adapter.mergeConfig(baseConfig, {
        appId: undefined,
        appSecret: "secret-2",
        gatewayUrl: undefined,
        platform: "lark",
      });
      expect(merged.appId).toBe("app-1");
      expect(merged.appSecret).toBe("secret-2");
      expect(merged.gatewayUrl).toBe("ws://127.0.0.1:4200");
      expect(merged.platform).toBe("lark");
    });

    it("returns shallow copy when updates is undefined", () => {
      const adapter = new FeishuAdapter() as any;
      const merged = adapter.mergeConfig({ ...DEFAULT_FEISHU_CONFIG, appId: "x" }, undefined);
      expect(merged.appId).toBe("x");
    });
  });

  // ---------------------------------------------------------------------
  describe("start", () => {
    it("rejects when appId/appSecret is missing", async () => {
      const a = new FeishuAdapter();
      await expect(
        a.start({
          type: "feishu",
          name: "Feishu Bot",
          enabled: true,
          options: { ...DEFAULT_FEISHU_CONFIG },
        }),
      ).rejects.toThrow(/appId and appSecret/);
      expect(a.getInfo().status).toBe("error");
    });
  });

  // ---------------------------------------------------------------------
  describe("stop", () => {
    it("nulls transport / streamingController / gatewayClient and emits disconnected", async () => {
      const a = new FeishuAdapter() as any;
      a.status = "running";
      a.transport = { sendText: vi.fn() };
      a.gatewayClient = { disconnect: vi.fn() };
      a.streamingController = {};
      a.wsClient = { close: vi.fn() };
      a.larkClient = {};
      const events: string[] = [];
      a.on("status.changed", (s: any) => events.push(`status:${s}`));
      a.on("disconnected", (r: any) => events.push(`disconnected:${r}`));

      await a.stop();

      expect(a.transport).toBeNull();
      expect(a.gatewayClient).toBeNull();
      expect(a.streamingController).toBeNull();
      expect(a.larkClient).toBeNull();
      expect(a.wsClient).toBeNull();
      expect(a.getInfo().status).toBe("stopped");
      expect(events).toContain("status:stopped");
      expect(events).toContain("disconnected:stopped");
    });

    it("swallows wsClient close errors", async () => {
      const a = new FeishuAdapter() as any;
      a.status = "running";
      a.wsClient = { close: vi.fn(() => { throw new Error("boom"); }) };
      await expect(a.stop()).resolves.toBeUndefined();
      expect(a.wsClient).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  describe("updateConfig", () => {
    it("retries once after a transient busy error when restarting", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.status = "running";
      adapter.config = {
        ...DEFAULT_FEISHU_CONFIG,
        platform: "lark",
        appId: "old-app",
        appSecret: "old-secret",
      };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn()
        .mockRejectedValueOnce(
          new Error(
            "Failed to connect to Lark long connection. Original error: [ws] code: 1000040345, system busy",
          ),
        )
        .mockResolvedValueOnce(undefined);

      const updatePromise = adapter.updateConfig({
        options: { appId: "new-app", appSecret: "new-secret" },
      });
      await vi.runAllTimersAsync();
      await expect(updatePromise).resolves.toBeUndefined();
      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(2);
      expect(mockScopedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("retrying once"),
      );
    });

    it("does not retry non-transient restart failures", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.status = "running";
      adapter.config = {
        ...DEFAULT_FEISHU_CONFIG,
        platform: "lark",
        appId: "old-app",
        appSecret: "old-secret",
      };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockRejectedValueOnce(new Error("invalid app credentials"));

      const updatePromise = adapter.updateConfig({
        options: { appId: "new-app", appSecret: "new-secret" },
      });
      const rejection = expect(updatePromise).rejects.toThrow("invalid app credentials");
      await vi.runAllTimersAsync();
      await rejection;
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("does not restart when only autoApprovePermissions changes", async () => {
      const a = new FeishuAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_FEISHU_CONFIG, appId: "k", appSecret: "s" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { autoApprovePermissions: false } });
      expect(a.stop).not.toHaveBeenCalled();
    });

    it("does not restart when adapter is not running", async () => {
      const a = new FeishuAdapter() as any;
      a.status = "stopped";
      a.config = { ...DEFAULT_FEISHU_CONFIG };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { appId: "x", appSecret: "y" } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.config.appId).toBe("x");
    });
  });

  // ---------------------------------------------------------------------
  describe("createWsStartupMonitor", () => {
    it("maps SDK trace/info logs onto electron-log levels without dropping them", () => {
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "lark" };
      adapter.status = "starting";

      const monitor = adapter.createWsStartupMonitor("lark", true);
      monitor.logger.trace("trace message");
      monitor.logger.info("background reconnect info");
      monitor.logger.info("ws client ready");
      monitor.logger.error("err");
      monitor.logger.warn("warn");
      monitor.logger.debug("dbg");

      expect(mockScopedLogger.debug).toHaveBeenCalledWith("trace message");
      expect(mockScopedLogger.verbose).toHaveBeenCalledWith("background reconnect info");
      expect(mockScopedLogger.info).toHaveBeenCalledWith("ws client ready");
      monitor.cancel();
    });

    it("falls back to WSClient.start() resolution if the ready log never appears", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "lark" };

      const monitor = adapter.createWsStartupMonitor("lark", true);
      const readyPromise = monitor.readyPromise;
      monitor.markStartResolved();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(readyPromise).resolves.toBeUndefined();
      expect(mockScopedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("weak success signal"),
      );
    });

    it("rejects if startup neither resolves nor emits a ready log", async () => {
      vi.useFakeTimers();
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "feishu" };
      const monitor = adapter.createWsStartupMonitor("feishu", true);
      const readyPromise = monitor.readyPromise;
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(readyPromise).rejects.toThrow(
        "Timed out waiting for Feishu websocket connection",
      );
    });

    it("settles error when status=starting and a startup-failure marker appears", async () => {
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG, platform: "feishu" };
      adapter.status = "starting";
      const monitor = adapter.createWsStartupMonitor("feishu", true);
      monitor.logger.error("system busy on connect");
      await expect(monitor.readyPromise).rejects.toThrow();
    });

    it("cancel() resolves a pending readyPromise", async () => {
      const adapter = new FeishuAdapter() as any;
      adapter.config = { ...DEFAULT_FEISHU_CONFIG };
      const monitor = adapter.createWsStartupMonitor("feishu", false);
      monitor.cancel();
      await expect(monitor.readyPromise).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  describe("isTempSessionExpired", () => {
    it("false within TTL, true past TTL", () => {
      const a = new FeishuAdapter() as any;
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 1000 })).toBe(false);
      expect(
        a.isTempSessionExpired({ lastActiveAt: Date.now() - TEMP_SESSION_TTL_MS - 1 }),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  describe("handleFeishuMessage", () => {
    function make() {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      a.handleP2PMessage = vi.fn(async () => undefined);
      a.handleGroupMessage = vi.fn(async () => undefined);
      return a;
    }

    function ev(overrides: any = {}): any {
      return {
        message: {
          chat_id: "c1",
          chat_type: "p2p",
          content: JSON.stringify({ text: "hi" }),
          message_id: "m1",
          message_type: "text",
          ...overrides.message,
        },
        sender: {
          sender_id: { open_id: "u1" },
          sender_type: "user",
          ...overrides.sender,
        },
      };
    }

    it("ignores non-text messages", async () => {
      const a = make();
      await a.handleFeishuMessage(ev({ message: { message_type: "image" } }));
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("dedupes by message_id", async () => {
      const a = make();
      await a.handleFeishuMessage(ev());
      await a.handleFeishuMessage(ev());
      expect(a.handleP2PMessage).toHaveBeenCalledTimes(1);
    });

    it("falls back to raw content when JSON.parse fails", async () => {
      const a = make();
      await a.handleFeishuMessage(ev({ message: { content: "raw plain" } }));
      expect(a.handleP2PMessage).toHaveBeenCalledWith("c1", "raw plain");
    });

    it("strips @_user_N mentions and skips empty text", async () => {
      const a = make();
      await a.handleFeishuMessage(
        ev({ message: { content: JSON.stringify({ text: "@_user_1   " }) } }),
      );
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("routes p2p chat to handleP2PMessage and registers openId mapping", async () => {
      const a = make();
      await a.handleFeishuMessage(ev());
      expect(a.handleP2PMessage).toHaveBeenCalledWith("c1", "hi");
      expect(a.sessionMapper.getChatIdByOpenId("u1")).toBe("c1");
    });

    it("transfers pending selection by openId on first p2p message", async () => {
      const a = make();
      a.sessionMapper.setPendingSelectionByOpenId("u1", { type: "project", projects: [] });
      await a.handleFeishuMessage(ev());
      expect(a.sessionMapper.getPendingSelection("c1")?.type).toBe("project");
    });

    it("routes group chats to handleGroupMessage", async () => {
      const a = make();
      await a.handleFeishuMessage(
        ev({
          message: { chat_id: "g1", chat_type: "group" },
        }),
      );
      expect(a.handleGroupMessage).toHaveBeenCalledWith("g1", "hi");
    });
  });

  // ---------------------------------------------------------------------
  describe("handleP2PMessage dispatch", () => {
    function makeP2P() {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "mid") };
      a.gatewayClient = {
        replyQuestion: vi.fn(async () => undefined),
        listAllProjects: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
      };
      return a;
    }

    it("delegates parseable command and clears pending", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setPendingSelection("c1", { type: "project", projects: [] });
      a.handleP2PCommand = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "/help");
      expect(a.handleP2PCommand).toHaveBeenCalled();
      expect(a.sessionMapper.getPendingSelection("c1")).toBeUndefined();
    });

    it("freeform answer routes to pending question", async () => {
      const a = makeP2P();
      a.sessionMapper.setPendingQuestion("c1", { questionId: "q-1", sessionId: "s1" });
      await a.handleP2PMessage("c1", "my answer");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["my answer"]],
      });
    });

    it("falls back to showProjectList when nothing selected and no default project", async () => {
      const a = makeP2P();
      a.showProjectList = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "hi");
      expect(a.showProjectList).toHaveBeenCalledWith("c1");
    });

    it("uses default workspace fallback when present", async () => {
      const a = makeP2P();
      a.gatewayClient.listAllProjects = vi.fn(async () => [
        { id: "def", directory: "/def", engineType: "claude", isDefault: true },
      ]);
      a.createTempSessionAndSend = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "hi");
      expect(a.createTempSessionAndSend).toHaveBeenCalled();
    });

    it("enqueues to running temp session", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      });
      a.enqueueP2PMessage = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "hi");
      expect(a.enqueueP2PMessage).toHaveBeenCalledWith("c1", "hi");
    });

    it("creates temp session if last project selected and no temp exists", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/d", engineType: "claude", projectId: "p",
      });
      a.createTempSessionAndSend = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "hi");
      expect(a.createTempSessionAndSend).toHaveBeenCalled();
    });

    it("cleans up expired temp before recreating", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/d", engineType: "claude", projectId: "p",
      });
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now() - TEMP_SESSION_TTL_MS - 1,
        messageQueue: [], processing: false,
      });
      a.cleanupExpiredTempSession = vi.fn(async () => undefined);
      a.createTempSessionAndSend = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "hi");
      expect(a.cleanupExpiredTempSession).toHaveBeenCalledWith("c1");
      expect(a.createTempSessionAndSend).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  describe("handleP2PCommand routing", () => {
    function makeCmd() {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = null;
      return a;
    }

    it("returns when command is null or transport missing", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", null);
      a.transport = null;
      await a.handleP2PCommand("c1", { command: "help", args: [] });
      expect(true).toBe(true);
    });

    it("/help sends help text", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "help", args: [] });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("/project calls showProjectList", async () => {
      const a = makeCmd();
      a.showProjectList = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "project", args: [] });
      expect(a.showProjectList).toHaveBeenCalled();
    });

    it("/new and /switch dispatch", async () => {
      const a = makeCmd();
      a.handleP2PNewCommand = vi.fn(async () => undefined);
      a.handleP2PSwitchCommand = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "new", args: [] });
      await a.handleP2PCommand("c1", { command: "switch", args: [] });
      expect(a.handleP2PNewCommand).toHaveBeenCalled();
      expect(a.handleP2PSwitchCommand).toHaveBeenCalled();
    });

    it("falls through to unknown-command warning", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "foo", args: [] });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });
  });

  // ---------------------------------------------------------------------
  describe("handleP2PNewCommand / handleP2PSwitchCommand guards", () => {
    it("handleP2PNewCommand prompts when no project selected", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      await a.handleP2PNewCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PNewCommand prompts when openId missing", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      a.sessionMapper.getOrCreateP2PChat("c1", "");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/x", engineType: "claude", projectId: "p",
      });
      await a.handleP2PNewCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("用户身份");
    });

    it("handleP2PNewCommand calls createNewSessionForProject when ready", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleP2PNewCommand("c1");
      expect(a.createNewSessionForProject).toHaveBeenCalled();
    });

    it("handleP2PSwitchCommand prompts when no project selected", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleP2PSwitchCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PSwitchCommand calls showSessionListForProject", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.showSessionListForProject = vi.fn(async () => undefined);
      await a.handleP2PSwitchCommand("c1");
      expect(a.showSessionListForProject).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  describe("showProjectList / showSessionListForProject", () => {
    it("showProjectList sends list and stores pending when projects exist", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "alpha", directory: "/a", engineType: "claude", isDefault: false },
        ]),
      };
      await a.showProjectList("c1");
      expect(a.transport.sendText).toHaveBeenCalled();
      // Pending only stored if p2pChat state exists
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.showProjectList("c1");
      expect(a.sessionMapper.getPendingSelection("c1")?.type).toBe("project");
    });

    it("showProjectList auto-uses default workspace when no real projects", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "def", directory: "/def", engineType: "claude", isDefault: true },
        ]),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.showProjectList("c1");
      expect(a.sessionMapper.getP2PChat("c1")?.lastSelectedProject).toBeUndefined();
    });

    it("showProjectList sends empty list message when no projects at all", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllProjects: vi.fn(async () => []) };
      await a.showProjectList("c1");
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("showSessionListForProject filters by directory and stores pending", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllSessions: vi.fn(async () => [
          { id: "s1", directory: "/a", engineType: "claude", title: "x", projectId: "p" },
          { id: "s2", directory: "/b", engineType: "claude", title: "y", projectId: "other" },
        ]),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.showSessionListForProject(
        "c1",
        { directory: "/a", engineType: "claude", projectId: "p" },
        "alpha",
      );
      const pending = a.sessionMapper.getPendingSelection("c1");
      expect(pending?.type).toBe("session");
      expect(pending?.sessions).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  describe("createTempSessionAndSend / queue / cleanup", () => {
    it("createTempSessionAndSend stores temp + enqueues message", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => ({ id: "sess-2", engineType: "claude" })),
      };
      a.enqueueP2PMessage = vi.fn(async () => undefined);
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.createTempSessionAndSend(
        "c1",
        { directory: "/d", engineType: "claude", projectId: "p" },
        "hi",
      );
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("sess-2");
      expect(a.enqueueP2PMessage).toHaveBeenCalledWith("c1", "hi");
    });

    it("createTempSessionAndSend reports error on createSession failure", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => { throw new Error("nope"); }),
      };
      await a.createTempSessionAndSend(
        "c1",
        { directory: "/d", projectId: "p" },
        "hi",
      );
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("创建临时会话失败");
    });

    it("enqueueP2PMessage no-ops without temp session", async () => {
      const a = new FeishuAdapter() as any;
      await expect(a.enqueueP2PMessage("c1", "x")).resolves.toBeUndefined();
    });

    it("enqueueP2PMessage starts processing when not running", async () => {
      const a = new FeishuAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.processP2PQueue = vi.fn(async () => undefined);
      await a.enqueueP2PMessage("c1", "msg");
      expect(a.processP2PQueue).toHaveBeenCalledWith("c1");
    });

    it("processP2PQueue clears processing when queue empty", async () => {
      const a = new FeishuAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      });
      await a.processP2PQueue("c1");
      expect(a.sessionMapper.getTempSession("c1")?.processing).toBe(false);
    });

    it("cleanupExpiredTempSession deletes session and clears mapping", async () => {
      const a = new FeishuAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn(async () => undefined) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).toHaveBeenCalledWith("x");
      expect(a.sessionMapper.getTempSession("c1")).toBeUndefined();
    });

    it("cleanupExpiredTempSession swallows deletion errors", async () => {
      const a = new FeishuAdapter() as any;
      a.gatewayClient = {
        deleteSession: vi.fn(async () => { throw new Error("404"); }),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      await expect(a.cleanupExpiredTempSession("c1")).resolves.toBeUndefined();
      expect(a.sessionMapper.getTempSession("c1")).toBeUndefined();
    });

    it("cleanupExpiredTempSession is no-op without temp session", async () => {
      const a = new FeishuAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn() };
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  describe("handleProjectSelection / handleSessionSelection", () => {
    it("handleProjectSelection returns false on non-numeric input", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "abc", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection returns false on out-of-range index", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "5", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection on valid index sets last project + shows sessions", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handleProjectSelection("c1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "alpha", directory: "/foo/alpha", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.sessionMapper.getP2PChat("c1")?.lastSelectedProject).toMatchObject({
        directory: "/foo/alpha", projectId: "p1",
      });
    });

    it("handleSessionSelection returns false on non-numeric input", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handleSessionSelection("c1", "abc", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection returns false when openId missing", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      const ok = await a.handleSessionSelection("c1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection short-circuits if session already has a group", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.createGroupBinding(makeBinding({ chatId: "g1", conversationId: "s1" }));
      a.createGroupForSession = vi.fn(async () => undefined);
      const ok = await a.handleSessionSelection("c1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.createGroupForSession).not.toHaveBeenCalled();
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("已有对应的群聊");
    });

    it("handleSessionSelection on valid index calls createGroupForSession", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.createGroupForSession = vi.fn(async () => undefined);
      const ok = await a.handleSessionSelection("c1", "1", {
        type: "session", directory: "/d", projectId: "p", projectName: "alpha",
        sessions: [{ id: "s2", title: "x", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.createGroupForSession).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  describe("handlePendingSelection dispatch", () => {
    it("dispatches type=project to handleProjectSelection", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handlePendingSelection("c1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("dispatches type=session to handleSessionSelection", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.createGroupForSession = vi.fn(async () => undefined);
      const ok = await a.handlePendingSelection("c1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("returns false for unknown selection type", async () => {
      const a = new FeishuAdapter() as any;
      const ok = await a.handlePendingSelection("c1", "1", { type: "unknown" });
      expect(ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  describe("handleGroupMessage / handleGroupCommand", () => {
    it("handleGroupMessage warns when no binding", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleGroupMessage("g1", "hi");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("未绑定");
    });

    it("handleGroupMessage routes commands to handleGroupCommand", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.createGroupBinding(makeBinding());
      a.handleGroupCommand = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "/help");
      expect(a.handleGroupCommand).toHaveBeenCalled();
    });

    it("handleGroupMessage routes pending question reply", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { replyQuestion: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding(makeBinding());
      a.sessionMapper.setPendingQuestion("g1", { questionId: "q-1", sessionId: "s1" });
      await a.handleGroupMessage("g1", "an answer");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["an answer"]],
      });
    });

    it("handleGroupMessage routes plain text to sendToEngine", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.createGroupBinding(makeBinding());
      a.sendToEngine = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "hello");
      expect(a.sendToEngine).toHaveBeenCalled();
    });

    it("handleGroupCommand /help sends help text", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      const binding = makeBinding();
      await a.handleGroupCommand("g1", binding, { command: "help", args: [] });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("handleGroupCommand falls through to unknown-command warning", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        cancelMessage: vi.fn(),
        listMessages: vi.fn(async () => []),
      };
      const binding = makeBinding();
      await a.handleGroupCommand("g1", binding, { command: "foo", args: [] });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });

    it("handleGroupCommand returns when transport or gateway missing", async () => {
      const a = new FeishuAdapter() as any;
      await a.handleGroupCommand("g1", makeBinding(), { command: "help", args: [] });
      expect(true).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  describe("group lifecycle events", () => {
    it("handleGroupDisbanded cleans up binding and deletes session", async () => {
      const a = new FeishuAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding(makeBinding());
      await a.handleGroupDisbanded({ chat_id: "g1" });
      expect(a.sessionMapper.getGroupBinding("g1")).toBeUndefined();
      expect(a.gatewayClient.deleteSession).toHaveBeenCalledWith("s1");
    });

    it("handleBotRemovedFromGroup cleans up binding", async () => {
      const a = new FeishuAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding(makeBinding());
      await a.handleBotRemovedFromGroup({ chat_id: "g1" });
      expect(a.sessionMapper.getGroupBinding("g1")).toBeUndefined();
    });

    it("handleUserRemovedFromGroup cleans up only when owner leaves", async () => {
      const a = new FeishuAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding(makeBinding());
      await a.handleUserRemovedFromGroup({
        chat_id: "g1",
        users: [{ user_id: { open_id: "someone-else" } }],
      });
      expect(a.sessionMapper.getGroupBinding("g1")).toBeDefined();

      await a.handleUserRemovedFromGroup({
        chat_id: "g1",
        users: [{ user_id: { open_id: "u1" } }],
      });
      expect(a.sessionMapper.getGroupBinding("g1")).toBeUndefined();
    });

    it("handleUserRemovedFromGroup early-returns without chatId or binding", async () => {
      const a = new FeishuAdapter() as any;
      await a.handleUserRemovedFromGroup({});
      await a.handleUserRemovedFromGroup({ chat_id: "missing", users: [] });
      expect(true).toBe(true);
    });

    it("cleanupGroupResources logs delete failure but completes", async () => {
      const a = new FeishuAdapter() as any;
      a.gatewayClient = {
        deleteSession: vi.fn(async () => { throw new Error("nope"); }),
      };
      a.sessionMapper.createGroupBinding(makeBinding());
      await a.cleanupGroupResources("g1", "test");
      expect(mockScopedLogger.error).toHaveBeenCalled();
    });

    it("cleanupGroupResources no-ops when chatId is undefined", async () => {
      const a = new FeishuAdapter() as any;
      await a.cleanupGroupResources(undefined, "x");
      expect(true).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  describe("gateway event handlers", () => {
    function makeGw() {
      const a = new FeishuAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMessageTo: vi.fn(async () => "") };
      a.streamingController = {
        applyPart: vi.fn(),
        finalize: vi.fn(),
        flushAsIntermediateReply: vi.fn(async () => undefined),
        isBatchMode: false,
      };
      return a;
    }

    it("handleMessageCompleted skips non-assistant or non-completed", () => {
      const a = makeGw();
      a.finalizeP2PStreaming = vi.fn();
      a.handleMessageCompleted("conv-1", { role: "user", time: { completed: 1 } });
      a.handleMessageCompleted("conv-1", { role: "assistant", time: {} });
      expect(a.finalizeP2PStreaming).not.toHaveBeenCalled();
    });

    it("handleMessageCompleted finalizes via group binding when present", () => {
      const a = makeGw();
      const ss = { conversationId: "conv-1", completed: false } as any;
      a.sessionMapper.createGroupBinding(
        makeBinding({
          chatId: "g1", conversationId: "conv-1",
          streamingSessions: new Map([["m1", ss]]),
        }),
      );
      a.handleMessageCompleted("conv-1", { id: "m1", role: "assistant", time: { completed: 1 } });
      expect(a.streamingController.finalize).toHaveBeenCalled();
    });

    it("handleMessageCompleted routes to finalizeP2PStreaming for P2P temp", () => {
      const a = makeGw();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.finalizeP2PStreaming = vi.fn(async () => undefined);
      a.handleMessageCompleted("conv-1", { role: "assistant", time: { completed: 1 } });
      expect(a.finalizeP2PStreaming).toHaveBeenCalled();
    });

    it("handlePartUpdated forwards group streaming session to applyPart", () => {
      const a = makeGw();
      const ss = { conversationId: "conv-1", completed: false } as any;
      a.sessionMapper.createGroupBinding(
        makeBinding({
          chatId: "g1", conversationId: "conv-1",
          streamingSessions: new Map([["m1", ss]]),
        }),
      );
      a.handlePartUpdated("conv-1", { type: "text", text: "x" });
      expect(a.streamingController.applyPart).toHaveBeenCalled();
    });

    it("handlePartUpdated forwards P2P streaming session to applyPart", () => {
      const a = makeGw();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
        streamingSession: { completed: false } as any,
      });
      a.handlePartUpdated("conv-1", { type: "text", text: "x" });
      expect(a.streamingController.applyPart).toHaveBeenCalled();
    });

    it("handlePartUpdated no-ops when no streaming session is active", () => {
      const a = makeGw();
      a.handlePartUpdated("missing", { type: "text", text: "x" });
      expect(a.streamingController.applyPart).not.toHaveBeenCalled();
    });

    it("handlePermissionAsked auto-approves when configured + accept option exists", () => {
      const a = makeGw();
      a.config = { ...a.config, autoApprovePermissions: true };
      a.gatewayClient = { replyPermission: vi.fn() };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handlePermissionAsked({
        id: "perm-1", sessionId: "conv-1",
        options: [{ id: "ok", type: "accept", label: "Allow" }],
      });
      expect(a.gatewayClient.replyPermission).toHaveBeenCalledWith({
        permissionId: "perm-1", optionId: "ok",
      });
    });

    it("handlePermissionAsked drops events not mapped to a chat", () => {
      const a = makeGw();
      a.config = { ...a.config, autoApprovePermissions: true };
      a.gatewayClient = { replyPermission: vi.fn() };
      a.handlePermissionAsked({ id: "perm-1", sessionId: "missing", options: [] });
      expect(a.gatewayClient.replyPermission).not.toHaveBeenCalled();
    });

    it("handleQuestionAsked sends prompt and registers pendingQuestion", () => {
      const a = makeGw();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handleQuestionAsked({
        id: "q-1", sessionId: "conv-1",
        questions: [{ question: "go?", options: [{ label: "yes" }, { label: "no" }] }],
      });
      expect(a.transport.sendText).toHaveBeenCalled();
      expect(a.sessionMapper.getPendingQuestion("c1")?.questionId).toBe("q-1");
    });

    it("handleQuestionAsked sends 'no options' message when questions array empty", () => {
      const a = makeGw();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handleQuestionAsked({ id: "q-1", sessionId: "conv-1", questions: [] });
      expect(a.transport.sendText.mock.calls[0][1]).toContain("无选项");
    });

    it("handleQuestionAsked early-returns when no chat target found", () => {
      const a = makeGw();
      a.handleQuestionAsked({ id: "q-1", sessionId: "missing", questions: [] });
      expect(a.transport.sendText).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  describe("handleSessionUpdated", () => {
    it("updates streaming session titles and updates Lark group name", async () => {
      const a = new FeishuAdapter() as any;
      const updateChat = vi.fn(async () => undefined);
      a.larkClient = { im: { chat: { update: updateChat } } };
      const ss = { conversationId: "conv-1", completed: false, sessionTitle: "old" } as any;
      a.sessionMapper.createGroupBinding(
        makeBinding({
          chatId: "g1", conversationId: "conv-1",
          streamingSessions: new Map([["m1", ss]]),
        }),
      );
      await a.handleSessionUpdated({ id: "conv-1", title: "new title" });
      expect(ss.sessionTitle).toBe("new title");
      expect(updateChat).toHaveBeenCalled();
    });

    it("no-ops when no group binding", async () => {
      const a = new FeishuAdapter() as any;
      a.larkClient = { im: { chat: { update: vi.fn() } } };
      await expect(
        a.handleSessionUpdated({ id: "missing", title: "x" }),
      ).resolves.toBeUndefined();
    });

    it("no-ops when session lacks title", async () => {
      const a = new FeishuAdapter() as any;
      const updateChat = vi.fn();
      a.larkClient = { im: { chat: { update: updateChat } } };
      a.sessionMapper.createGroupBinding(
        makeBinding({ chatId: "g1", conversationId: "conv-1" }),
      );
      await a.handleSessionUpdated({ id: "conv-1" });
      expect(updateChat).not.toHaveBeenCalled();
    });

    it("logs error when Lark update fails", async () => {
      const a = new FeishuAdapter() as any;
      a.larkClient = {
        im: { chat: { update: vi.fn(async () => { throw new Error("boom"); }) } },
      };
      a.sessionMapper.createGroupBinding(
        makeBinding({ chatId: "g1", conversationId: "conv-1" }),
      );
      await a.handleSessionUpdated({ id: "conv-1", title: "t" });
      expect(mockScopedLogger.error).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  describe("createGroupForSession", () => {
    it("returns early if a group already exists for the conversation", async () => {
      const a = new FeishuAdapter() as any;
      a.larkClient = { im: { chat: { create: vi.fn() } } };
      a.gatewayClient = {};
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.createGroupBinding(makeBinding({ conversationId: "conv-1" }));
      await a.createGroupForSession("u1", "conv-1", "claude", "/d", "p", "alpha", "p2p");
      expect(a.larkClient.im.chat.create).not.toHaveBeenCalled();
      expect(a.transport.sendText.mock.calls[0][1]).toContain("Session already has a group");
    });

    it("creates a group, registers binding, and sends welcome card", async () => {
      const a = new FeishuAdapter() as any;
      a.larkClient = {
        im: {
          chat: {
            create: vi.fn(async () => ({ data: { chat_id: "new-g1" } })),
          },
        },
      };
      a.gatewayClient = {
        getSession: vi.fn(async () => ({ title: "MyTitle" })),
      };
      a.transport = {
        sendText: vi.fn(async () => ""),
        sendRichContent: vi.fn(async () => ""),
      };
      await a.createGroupForSession("u1", "conv-2", "claude", "/d", "p", "alpha", "p2p");
      expect(a.larkClient.im.chat.create).toHaveBeenCalled();
      expect(a.transport.sendRichContent).toHaveBeenCalled();
      expect(a.sessionMapper.getGroupBinding("new-g1")).toBeDefined();
    });

    it("reports failure when chat.create returns no chat_id", async () => {
      const a = new FeishuAdapter() as any;
      a.larkClient = { im: { chat: { create: vi.fn(async () => ({ data: {} })) } } };
      a.gatewayClient = { getSession: vi.fn(async () => null) };
      a.transport = { sendText: vi.fn(async () => "") };
      await a.createGroupForSession("u1", "conv-3", "claude", "/d", "p", "alpha", "p2p");
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("Failed to create group chat");
    });

    it("handles concurrent creation gracefully (markCreating returns false)", async () => {
      const a = new FeishuAdapter() as any;
      a.larkClient = { im: { chat: { create: vi.fn() } } };
      a.gatewayClient = {};
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.markCreating("conv-x");
      await a.createGroupForSession("u1", "conv-x", "claude", "/d", "p", "alpha", "p2p");
      expect(a.larkClient.im.chat.create).not.toHaveBeenCalled();
    });

    it("reports thrown errors back to user via P2P chat", async () => {
      const a = new FeishuAdapter() as any;
      a.larkClient = {
        im: { chat: { create: vi.fn(async () => { throw new Error("boom"); }) } },
      };
      a.gatewayClient = { getSession: vi.fn(async () => null) };
      a.transport = { sendText: vi.fn(async () => "") };
      await a.createGroupForSession("u1", "conv-4", "claude", "/d", "p", "alpha", "p2p");
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("Failed to create group");
    });
  });

  // ---------------------------------------------------------------------
  describe("handleBotMenuEvent", () => {
    function make() {
      const a = new FeishuAdapter() as any;
      a.transport = {
        sendText: vi.fn(async () => ""),
        sendMessageTo: vi.fn(async () => ""),
      };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => []),
      };
      return a;
    }

    it("returns when missing event_key or operator", async () => {
      const a = make();
      await a.handleBotMenuEvent({});
      await a.handleBotMenuEvent({ event_key: "switch_project" });
      expect(a.transport.sendMessageTo).not.toHaveBeenCalled();
    });

    it("switch_project triggers project list", async () => {
      const a = make();
      a.showProjectListFromMenu = vi.fn(async () => undefined);
      await a.handleBotMenuEvent({
        event_key: "switch_project",
        operator: { operator_id: { open_id: "u1" } },
      });
      expect(a.showProjectListFromMenu).toHaveBeenCalled();
    });

    it("new_session creates new session when chat + lastProject known", async () => {
      const a = make();
      a.sessionMapper.setOpenIdMapping("u1", "c1");
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleBotMenuEvent({
        event_key: "new_session",
        operator: { operator_id: { open_id: "u1" } },
      });
      expect(a.createNewSessionForProject).toHaveBeenCalled();
    });

    it("new_session falls back to project list when no last project", async () => {
      const a = make();
      a.showProjectListFromMenu = vi.fn(async () => undefined);
      await a.handleBotMenuEvent({
        event_key: "new_session",
        operator: { operator_id: { open_id: "u1" } },
      });
      expect(a.showProjectListFromMenu).toHaveBeenCalled();
    });

    it("switch_session calls showSessionListForProject when context known", async () => {
      const a = make();
      a.sessionMapper.setOpenIdMapping("u1", "c1");
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.showSessionListForProject = vi.fn(async () => undefined);
      await a.handleBotMenuEvent({
        event_key: "switch_session",
        operator: { operator_id: { open_id: "u1" } },
      });
      expect(a.showSessionListForProject).toHaveBeenCalled();
    });

    it("switch_session falls back to project list when no last project", async () => {
      const a = make();
      a.showProjectListFromMenu = vi.fn(async () => undefined);
      await a.handleBotMenuEvent({
        event_key: "switch_session",
        operator: { operator_id: { open_id: "u1" } },
      });
      expect(a.showProjectListFromMenu).toHaveBeenCalled();
    });

    it("help sends help text", async () => {
      const a = make();
      await a.handleBotMenuEvent({
        event_key: "help",
        operator: { operator_id: { open_id: "u1" } },
      });
      expect(a.transport.sendMessageTo).toHaveBeenCalled();
    });

    it("logs warning for unknown event_key", async () => {
      const a = make();
      await a.handleBotMenuEvent({
        event_key: "totally_unknown",
        operator: { operator_id: { open_id: "u1" } },
      });
      expect(mockScopedLogger.warn).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  describe("showProjectListFromMenu", () => {
    it("sends list and stores pending by openId when no chatId", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendMessageTo: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "alpha", directory: "/a", engineType: "claude", isDefault: false },
        ]),
      };
      await a.showProjectListFromMenu("u1", undefined, "u1", "open_id");
      const pending = a.sessionMapper.takePendingSelectionByOpenId("u1");
      expect(pending?.type).toBe("project");
    });

    it("stores pending by chatId when chatId is known", async () => {
      const a = new FeishuAdapter() as any;
      a.transport = { sendMessageTo: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "alpha", directory: "/a", engineType: "claude", isDefault: false },
        ]),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.showProjectListFromMenu("u1", "c1", "c1", "chat_id");
      expect(a.sessionMapper.getPendingSelection("c1")?.type).toBe("project");
    });
  });
});
