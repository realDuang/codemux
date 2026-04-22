import { beforeEach, describe, expect, it, vi } from "vitest";

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
  channelLog: mockScopedLogger,
  dingtalkLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

import { DingTalkAdapter } from "../../../../../electron/main/channels/dingtalk/dingtalk-adapter";
import { DEFAULT_DINGTALK_CONFIG } from "../../../../../electron/main/channels/dingtalk/dingtalk-types";

describe("DingTalkAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInfo", () => {
    it("reports stopped status before start", () => {
      const a = new DingTalkAdapter();
      const info = a.getInfo();
      expect(info.type).toBe("dingtalk");
      expect(info.status).toBe("stopped");
    });
  });

  describe("start", () => {
    it("rejects when appKey/appSecret is missing", async () => {
      const a = new DingTalkAdapter();
      await expect(
        a.start({
          type: "dingtalk",
          name: "DingTalk Bot",
          enabled: true,
          options: { ...DEFAULT_DINGTALK_CONFIG },
        }),
      ).rejects.toThrow(/appKey and appSecret/);
      expect(a.getInfo().status).toBe("error");
    });

    it("rejects when robotCode is missing", async () => {
      const a = new DingTalkAdapter();
      await expect(
        a.start({
          type: "dingtalk",
          name: "DingTalk Bot",
          enabled: true,
          options: {
            ...DEFAULT_DINGTALK_CONFIG,
            appKey: "k",
            appSecret: "s",
          },
        }),
      ).rejects.toThrow(/robotCode/);
      expect(a.getInfo().status).toBe("error");
    });
  });

  describe("stop", () => {
    it("nulls transport / streamingController / gatewayClient and emits disconnected", async () => {
      const a = new DingTalkAdapter() as any;
      a.status = "running";
      a.transport = { sendText: vi.fn() };
      a.gatewayClient = { disconnect: vi.fn() };
      a.streamingController = {};
      a.tokenManager = {};
      const events: string[] = [];
      a.on("status.changed", (s: any) => events.push(`status:${s}`));
      a.on("disconnected", (r: any) => events.push(`disconnected:${r}`));

      await a.stop();

      expect(a.transport).toBeNull();
      expect(a.gatewayClient).toBeNull();
      expect(a.streamingController).toBeNull();
      expect(a.tokenManager).toBeNull();
      expect(a.getInfo().status).toBe("stopped");
      expect(events).toContain("status:stopped");
      expect(events).toContain("disconnected:stopped");
    });
  });

  describe("updateConfig", () => {
    it("restarts when appKey changes", async () => {
      const a = new DingTalkAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_DINGTALK_CONFIG, appKey: "old", appSecret: "s", robotCode: "r" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { appKey: "new" } });
      expect(a.stop).toHaveBeenCalledTimes(1);
      expect(a.start).toHaveBeenCalledTimes(1);
    });

    it("restarts when robotCode changes", async () => {
      const a = new DingTalkAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_DINGTALK_CONFIG, appKey: "k", appSecret: "s", robotCode: "old" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { robotCode: "new" } });
      expect(a.start).toHaveBeenCalled();
    });

    it("does not restart when only autoApprovePermissions changes", async () => {
      const a = new DingTalkAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_DINGTALK_CONFIG, appKey: "k", appSecret: "s", robotCode: "r" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { autoApprovePermissions: false } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.start).not.toHaveBeenCalled();
    });

    it("does not restart when adapter is not running", async () => {
      const a = new DingTalkAdapter() as any;
      a.status = "stopped";
      a.config = { ...DEFAULT_DINGTALK_CONFIG };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { appKey: "x" } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.start).not.toHaveBeenCalled();
      expect(a.config.appKey).toBe("x");
    });
  });

  describe("isTempSessionExpired", () => {
    it("false within TTL, true past TTL", () => {
      const a = new DingTalkAdapter() as any;
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 1000 })).toBe(false);
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 999_999_999 })).toBe(true);
    });
  });

  describe("handleDingTalkMessage", () => {
    function makeBase() {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      a.handleP2PMessage = vi.fn(async () => undefined);
      a.handleGroupMessage = vi.fn(async () => undefined);
      return a;
    }

    it("ignores non-text messages", async () => {
      const a = makeBase();
      await a.handleDingTalkMessage({
        msgId: "m1",
        msgtype: "image",
        conversationType: "1",
        text: { content: "" },
        senderStaffId: "u1",
        chatbotUserId: "bot",
        senderNick: "alice",
        conversationId: "c1",
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("dedupes by msgId", async () => {
      const a = makeBase();
      const ev = {
        msgId: "m1",
        msgtype: "text",
        conversationType: "1" as const,
        text: { content: "hi" },
        senderStaffId: "u1",
        chatbotUserId: "bot",
        senderNick: "alice",
        conversationId: "c1",
      };
      await a.handleDingTalkMessage(ev);
      await a.handleDingTalkMessage(ev);
      expect(a.handleP2PMessage).toHaveBeenCalledTimes(1);
    });

    it("skips empty text content", async () => {
      const a = makeBase();
      await a.handleDingTalkMessage({
        msgId: "m1",
        msgtype: "text",
        conversationType: "1",
        text: { content: "  " },
        senderStaffId: "u1",
        chatbotUserId: "bot",
        senderNick: "alice",
        conversationId: "c1",
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("routes P2P (conversationType=1) to handleP2PMessage and registers chat", async () => {
      const a = makeBase();
      await a.handleDingTalkMessage({
        msgId: "m1",
        msgtype: "text",
        conversationType: "1",
        text: { content: "hi" },
        senderStaffId: "u1",
        chatbotUserId: "bot",
        senderNick: "alice",
        conversationId: "c1",
      });
      expect(a.handleP2PMessage).toHaveBeenCalledWith("c1", "u1", "hi");
      expect(a.sessionMapper.getP2PChat("c1")).toBeDefined();
    });

    it("routes group (conversationType=2) to handleGroupMessage", async () => {
      const a = makeBase();
      await a.handleDingTalkMessage({
        msgId: "m1",
        msgtype: "text",
        conversationType: "2",
        text: { content: "hi" },
        senderStaffId: "u1",
        chatbotUserId: "bot",
        senderNick: "alice",
        conversationId: "c1",
        chatId: "g1",
      });
      expect(a.handleGroupMessage).toHaveBeenCalledWith("g1", "hi");
    });
  });

  describe("handleP2PMessage dispatch", () => {
    function makeP2P() {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        replyQuestion: vi.fn(async () => undefined),
        listAllProjects: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
      };
      return a;
    }

    it("delegates parseable command to handleP2PCommand and clears pending", async () => {
      const a = makeP2P();
      a.sessionMapper.setPendingSelection("c1", { type: "project", projects: [] });
      a.handleP2PCommand = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "/help");
      expect(a.handleP2PCommand).toHaveBeenCalled();
      expect(a.sessionMapper.getPendingSelection("c1")).toBeUndefined();
    });

    it("freeform answer routes to pending question", async () => {
      const a = makeP2P();
      a.sessionMapper.setPendingQuestion("c1", { questionId: "q-1" });
      await a.handleP2PMessage("c1", "u1", "my answer");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["my answer"]],
      });
    });

    it("falls back to showProjectList when nothing selected", async () => {
      const a = makeP2P();
      a.showProjectList = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "hi");
      expect(a.showProjectList).toHaveBeenCalledWith("c1");
    });

    it("enqueues to running temp session", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: true,
      });
      a.enqueueP2PMessage = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "hi");
      expect(a.enqueueP2PMessage).toHaveBeenCalledWith("c1", "hi");
    });

    it("creates temp session if last project selected and no temp exists", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/d",
        engineType: "claude",
        projectId: "p",
      });
      a.createTempSessionAndSend = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "hi");
      expect(a.createTempSessionAndSend).toHaveBeenCalled();
    });
  });

  describe("handleP2PCommand routing", () => {
    function makeCmd() {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = null;
      return a;
    }

    it("returns when command is null or transport missing", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", null);
      a.transport = null;
      await a.handleP2PCommand("c1", { command: "help", args: "" });
      expect(true).toBe(true);
    });

    it("/help sends help text", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "help", args: "" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("/project calls showProjectList", async () => {
      const a = makeCmd();
      a.showProjectList = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "project", args: "" });
      expect(a.showProjectList).toHaveBeenCalled();
    });

    it("/new and /switch dispatch to handleP2PNewCommand / handleP2PSwitchCommand", async () => {
      const a = makeCmd();
      a.handleP2PNewCommand = vi.fn(async () => undefined);
      a.handleP2PSwitchCommand = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "new", args: "" });
      await a.handleP2PCommand("c1", { command: "switch", args: "" });
      expect(a.handleP2PNewCommand).toHaveBeenCalled();
      expect(a.handleP2PSwitchCommand).toHaveBeenCalled();
    });

    it("falls through to unknown-command warning", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "foo", args: "" });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });
  });

  describe("handleP2PNewCommand / handleP2PSwitchCommand guards", () => {
    it("handleP2PNewCommand prompts when no project is selected", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      await a.handleP2PNewCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PNewCommand prompts when ownerUserId missing", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      a.sessionMapper.getOrCreateP2PChat("c1", "");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/x", engineType: "claude", projectId: "p",
      });
      await a.handleP2PNewCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("用户身份");
    });

    it("handleP2PNewCommand calls createNewSessionForProject when project + user known", async () => {
      const a = new DingTalkAdapter() as any;
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
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleP2PSwitchCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PSwitchCommand calls showSessionListForProject", async () => {
      const a = new DingTalkAdapter() as any;
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

  describe("showProjectList / showSessionListForProject", () => {
    it("showProjectList sends list and stores pending", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "alpha", directory: "/a", engineType: "claude" },
        ]),
      };
      await a.showProjectList("c1");
      expect(a.transport.sendText).toHaveBeenCalled();
      expect(a.sessionMapper.getPendingSelection("c1")?.type).toBe("project");
    });

    it("showProjectList does not store pending when list is empty", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllProjects: vi.fn(async () => []) };
      await a.showProjectList("c1");
      expect(a.sessionMapper.getPendingSelection("c1")).toBeUndefined();
    });

    it("showSessionListForProject filters by directory and stores pending", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllSessions: vi.fn(async () => [
          { id: "s1", directory: "/a", engineType: "claude", title: "x" },
          { id: "s2", directory: "/b", engineType: "claude", title: "y" },
        ]),
      };
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

  describe("createTempSessionAndSend / enqueueP2PMessage / processP2PQueue / cleanupExpiredTempSession", () => {
    it("createTempSessionAndSend stores temp + enqueues message", async () => {
      const a = new DingTalkAdapter() as any;
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
      const a = new DingTalkAdapter() as any;
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
      const a = new DingTalkAdapter() as any;
      await expect(a.enqueueP2PMessage("c1", "x")).resolves.toBeUndefined();
    });

    it("enqueueP2PMessage starts processing when not running", async () => {
      const a = new DingTalkAdapter() as any;
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
      const a = new DingTalkAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      });
      await a.processP2PQueue("c1");
      expect(a.sessionMapper.getTempSession("c1")?.processing).toBe(false);
    });

    it("cleanupExpiredTempSession deletes session and clears mapping", async () => {
      const a = new DingTalkAdapter() as any;
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
      const a = new DingTalkAdapter() as any;
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
      const a = new DingTalkAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn() };
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("handleProjectSelection / handleSessionSelection", () => {
    it("handleProjectSelection returns false on non-numeric input", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "abc", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection returns false on out-of-range index", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "5", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection on valid index sets last project + shows sessions", async () => {
      const a = new DingTalkAdapter() as any;
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
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      const ok = await a.handleSessionSelection("c1", "u1", "abc", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection returns false when pending lacks directory or projectId", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      const ok = await a.handleSessionSelection("c1", "u1", "1", {
        type: "session",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection short-circuits if session already has a group", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      // Pre-bind a group for this session id
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.createGroupForSession = vi.fn(async () => undefined);
      const ok = await a.handleSessionSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.createGroupForSession).not.toHaveBeenCalled();
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("已有对应的群聊");
    });

    it("handleSessionSelection on valid index calls createGroupForSession", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.createGroupForSession = vi.fn(async () => undefined);
      const ok = await a.handleSessionSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p", projectName: "alpha",
        sessions: [{ id: "s1", title: "x", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.createGroupForSession).toHaveBeenCalled();
    });
  });

  describe("handlePendingSelection dispatch", () => {
    it("dispatches to handleProjectSelection for type=project", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handlePendingSelection("c1", "u1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("dispatches to handleSessionSelection for type=session", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.createGroupForSession = vi.fn(async () => undefined);
      const ok = await a.handlePendingSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("returns false for unknown selection type", async () => {
      const a = new DingTalkAdapter() as any;
      const ok = await a.handlePendingSelection("c1", "u1", "1", { type: "unknown" });
      expect(ok).toBe(false);
    });
  });

  describe("handleGroupMessage / handleGroupCommand", () => {
    it("handleGroupMessage warns when no binding", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleGroupMessage("g1", "hi");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("未绑定");
    });

    it("handleGroupMessage routes commands to handleGroupCommand", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.handleGroupCommand = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "/help");
      expect(a.handleGroupCommand).toHaveBeenCalled();
    });

    it("handleGroupMessage routes pending question reply", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { replyQuestion: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.sessionMapper.setPendingQuestion("g1", { questionId: "q-1" });
      await a.handleGroupMessage("g1", "an answer");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["an answer"]],
      });
    });

    it("handleGroupMessage routes plain text to sendToEngine", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.sendToEngine = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "hello");
      expect(a.sendToEngine).toHaveBeenCalled();
    });

    it("handleGroupCommand /help sends help text", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await a.handleGroupCommand("g1", binding, { command: "help", args: "" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("handleGroupCommand falls through to unknown-command warning", async () => {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        cancelMessage: vi.fn(),
        listMessages: vi.fn(async () => []),
      };
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await a.handleGroupCommand("g1", binding, { command: "foo", args: "" });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });
  });

  describe("gateway event handlers", () => {
    function makeGw() {
      const a = new DingTalkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.streamingController = { applyPart: vi.fn(), finalize: vi.fn() };
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
      const binding = {
        chatId: "g1", conversationId: "conv-1", engineType: "claude" as const,
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      };
      a.sessionMapper.createGroupBinding(binding);
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
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      });
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

    it("handleSessionUpdated updates streaming session titles for bound group", () => {
      const a = makeGw();
      const ss = { conversationId: "conv-1", completed: false, sessionTitle: "old" } as any;
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      });
      a.handleSessionUpdated({ id: "conv-1", title: "new title" });
      expect(ss.sessionTitle).toBe("new title");
    });

    it("handleSessionUpdated no-ops when no group binding", () => {
      const a = makeGw();
      expect(() => a.handleSessionUpdated({ id: "missing", title: "x" })).not.toThrow();
    });
  });
});
