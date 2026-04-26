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
  wecomLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

import { WeComAdapter } from "../../../../../electron/main/channels/wecom/wecom-adapter";
import { DEFAULT_WECOM_CONFIG } from "../../../../../electron/main/channels/wecom/wecom-types";

describe("WeComAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInfo / getWebhookMeta", () => {
    it("reports stopped status before start", () => {
      const a = new WeComAdapter();
      const info = a.getInfo();
      expect(info.type).toBe("wecom");
      expect(info.status).toBe("stopped");
    });

    it("returns expected webhook meta", () => {
      const a = new WeComAdapter();
      const meta = a.getWebhookMeta();
      expect(meta.path).toBe("/webhook/wecom");
      expect(meta.platformConfigGuide).toBeDefined();
    });
  });

  describe("start", () => {
    it("rejects when corpId/corpSecret missing", async () => {
      const a = new WeComAdapter();
      await expect(
        a.start({
          type: "wecom",
          name: "WeCom Bot",
          enabled: true,
          options: { ...DEFAULT_WECOM_CONFIG },
        }),
      ).rejects.toThrow(/corpId and corpSecret/);
      expect(a.getInfo().status).toBe("error");
    });

    it("rejects when callbackToken/callbackEncodingAESKey missing", async () => {
      const a = new WeComAdapter();
      await expect(
        a.start({
          type: "wecom",
          name: "WeCom Bot",
          enabled: true,
          options: {
            ...DEFAULT_WECOM_CONFIG,
            corpId: "c",
            corpSecret: "s",
          },
        }),
      ).rejects.toThrow(/callbackToken and callbackEncodingAESKey/);
      expect(a.getInfo().status).toBe("error");
    });
  });

  describe("setWebhookServer", () => {
    it("stores webhook server reference", () => {
      const a = new WeComAdapter() as any;
      const srv = { registerRoute: vi.fn(), unregisterRoute: vi.fn() };
      a.setWebhookServer(srv);
      expect(a.webhookServer).toBe(srv);
    });
  });

  describe("stop", () => {
    it("nulls transport / streamingController / gatewayClient and emits disconnected", async () => {
      const a = new WeComAdapter() as any;
      a.status = "running";
      a.transport = { sendText: vi.fn() };
      a.gatewayClient = { disconnect: vi.fn() };
      a.streamingController = {};
      a.tokenManager = {};
      a.crypto = {};
      a.webhookServer = { unregisterRoute: vi.fn() };
      const events: string[] = [];
      a.on("status.changed", (s: any) => events.push(`status:${s}`));
      a.on("disconnected", (r: any) => events.push(`disconnected:${r}`));

      await a.stop();

      expect(a.transport).toBeNull();
      expect(a.gatewayClient).toBeNull();
      expect(a.streamingController).toBeNull();
      expect(a.tokenManager).toBeNull();
      expect(a.crypto).toBeNull();
      expect(a.webhookServer.unregisterRoute).toHaveBeenCalledWith("/webhook/wecom");
      expect(events).toContain("status:stopped");
      expect(events).toContain("disconnected:stopped");
    });
  });

  describe("updateConfig", () => {
    it("restarts when corpId changes", async () => {
      const a = new WeComAdapter() as any;
      a.status = "running";
      a.config = {
        ...DEFAULT_WECOM_CONFIG,
        corpId: "old",
        corpSecret: "s",
        callbackToken: "t",
        callbackEncodingAESKey: "k",
      };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { corpId: "new" } });
      expect(a.stop).toHaveBeenCalled();
      expect(a.start).toHaveBeenCalled();
    });

    it("restarts when agentId changes", async () => {
      const a = new WeComAdapter() as any;
      a.status = "running";
      a.config = {
        ...DEFAULT_WECOM_CONFIG,
        corpId: "c", corpSecret: "s", callbackToken: "t",
        callbackEncodingAESKey: "k", agentId: 1,
      };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { agentId: 2 } });
      expect(a.start).toHaveBeenCalled();
    });

    it("does not restart when only autoApprovePermissions changes", async () => {
      const a = new WeComAdapter() as any;
      a.status = "running";
      a.config = {
        ...DEFAULT_WECOM_CONFIG, corpId: "c", corpSecret: "s",
        callbackToken: "t", callbackEncodingAESKey: "k",
      };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { autoApprovePermissions: false } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.start).not.toHaveBeenCalled();
    });

    it("does not restart when adapter not running", async () => {
      const a = new WeComAdapter() as any;
      a.status = "stopped";
      a.config = { ...DEFAULT_WECOM_CONFIG };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { corpId: "x" } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.start).not.toHaveBeenCalled();
      expect(a.config.corpId).toBe("x");
    });
  });

  describe("isTempSessionExpired", () => {
    it("false within TTL, true past TTL", () => {
      const a = new WeComAdapter() as any;
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 1000 })).toBe(false);
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 999_999_999 })).toBe(true);
    });
  });

  describe("processIncomingMessage", () => {
    function makeBase() {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      a.handleP2PMessage = vi.fn(async () => undefined);
      return a;
    }

    it("ignores non-text messages", async () => {
      const a = makeBase();
      await a.processIncomingMessage({
        toUserName: "corp", fromUserName: "u1", createTime: 0,
        msgType: "image", msgId: "m1", agentId: 1,
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("dedupes by msgId", async () => {
      const a = makeBase();
      const msg = {
        toUserName: "corp", fromUserName: "u1", createTime: 0,
        msgType: "text", content: "hi", msgId: "m1", agentId: 1,
      };
      await a.processIncomingMessage(msg);
      await a.processIncomingMessage(msg);
      expect(a.handleP2PMessage).toHaveBeenCalledTimes(1);
    });

    it("skips empty content", async () => {
      const a = makeBase();
      await a.processIncomingMessage({
        toUserName: "corp", fromUserName: "u1", createTime: 0,
        msgType: "text", content: "  ", msgId: "m1", agentId: 1,
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("registers P2P chat and routes to handleP2PMessage", async () => {
      const a = makeBase();
      await a.processIncomingMessage({
        toUserName: "corp", fromUserName: "u1", createTime: 0,
        msgType: "text", content: "hi", msgId: "m1", agentId: 1,
      });
      expect(a.handleP2PMessage).toHaveBeenCalledWith("user:u1", "u1", "hi");
      expect(a.sessionMapper.getP2PChat("user:u1")).toBeDefined();
    });
  });

  describe("handleWebhook routing", () => {
    it("returns 405 for unknown methods", async () => {
      const a = new WeComAdapter() as any;
      const res = await a.handleWebhook({ method: "PUT", query: {}, headers: {}, rawBody: Buffer.from("") });
      expect(res.status).toBe(405);
    });

    it("GET returns 500 if crypto not initialized", async () => {
      const a = new WeComAdapter() as any;
      const res = await a.handleWebhook({ method: "GET", query: {}, headers: {}, rawBody: Buffer.from("") });
      expect(res.status).toBe(500);
    });

    it("GET returns 400 when params missing", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = { verifyUrl: vi.fn(), generateSignature: vi.fn(), debugDecrypt: vi.fn() };
      const res = await a.handleWebhook({ method: "GET", query: {}, headers: {}, rawBody: Buffer.from("") });
      expect(res.status).toBe(400);
    });

    it("GET returns 200 with plaintext on successful verification", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = {
        verifyUrl: vi.fn(() => "echoed"),
        generateSignature: vi.fn(),
        debugDecrypt: vi.fn(),
      };
      const res = await a.handleWebhook({
        method: "GET",
        query: { msg_signature: "s", timestamp: "t", nonce: "n", echostr: "e" },
        headers: {},
        rawBody: Buffer.from(""),
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe("echoed");
    });

    it("GET returns 403 with sig mismatch path", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = {
        verifyUrl: vi.fn(() => null),
        generateSignature: vi.fn(() => "different"),
        debugDecrypt: vi.fn(() => ({ error: "bad" })),
      };
      const res = await a.handleWebhook({
        method: "GET",
        query: { msg_signature: "s", timestamp: "t", nonce: "n", echostr: "e" },
        headers: {},
        rawBody: Buffer.from(""),
      });
      expect(res.status).toBe(403);
    });

    it("GET returns 403 with sig OK but decrypt fail path", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = {
        verifyUrl: vi.fn(() => null),
        generateSignature: vi.fn(() => "s"),
        debugDecrypt: vi.fn(() => ({ error: "decryption error" })),
      };
      const res = await a.handleWebhook({
        method: "GET",
        query: { msg_signature: "s", timestamp: "t", nonce: "n", echostr: "e" },
        headers: {},
        rawBody: Buffer.from(""),
      });
      expect(res.status).toBe(403);
    });

    it("POST returns 500 if crypto missing", async () => {
      const a = new WeComAdapter() as any;
      const res = await a.handleWebhook({
        method: "POST",
        query: { msg_signature: "s", timestamp: "t", nonce: "n" },
        headers: {},
        rawBody: Buffer.from(""),
      });
      expect(res.status).toBe(500);
    });

    it("POST returns 400 if params missing", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = { decryptMessage: vi.fn() };
      const res = await a.handleWebhook({
        method: "POST", query: {}, headers: {}, rawBody: Buffer.from(""),
      });
      expect(res.status).toBe(400);
    });

    it("POST returns 400 if Encrypt element missing", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = { decryptMessage: vi.fn() };
      const res = await a.handleWebhook({
        method: "POST",
        query: { msg_signature: "s", timestamp: "t", nonce: "n" },
        headers: {},
        rawBody: Buffer.from("<xml></xml>"),
      });
      expect(res.status).toBe(400);
    });

    it("POST returns 403 if decrypt fails", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = { decryptMessage: vi.fn(() => null) };
      const res = await a.handleWebhook({
        method: "POST",
        query: { msg_signature: "s", timestamp: "t", nonce: "n" },
        headers: {},
        rawBody: Buffer.from("<xml><Encrypt><![CDATA[abc]]></Encrypt></xml>"),
      });
      expect(res.status).toBe(403);
    });

    it("POST returns 200 success on decrypted payload", async () => {
      const a = new WeComAdapter() as any;
      a.crypto = {
        decryptMessage: vi.fn(() => "<xml><MsgType><![CDATA[image]]></MsgType><MsgId><![CDATA[m1]]></MsgId><FromUserName><![CDATA[u1]]></FromUserName></xml>"),
      };
      const res = await a.handleWebhook({
        method: "POST",
        query: { msg_signature: "s", timestamp: "t", nonce: "n" },
        headers: {},
        rawBody: Buffer.from("<xml><Encrypt><![CDATA[abc]]></Encrypt></xml>"),
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe("success");
    });
  });

  describe("handleP2PMessage dispatch", () => {
    function makeP2P() {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        replyQuestion: vi.fn(async () => undefined),
        listAllProjects: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
      };
      return a;
    }

    it("delegates command to handleP2PCommand and clears pending selection", async () => {
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
      await a.handleP2PMessage("c1", "u1", "answer");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["answer"]],
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
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      });
      a.enqueueP2PMessage = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "hi");
      expect(a.enqueueP2PMessage).toHaveBeenCalledWith("c1", "hi");
    });

    it("creates temp session when last project selected and no temp exists", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/d", engineType: "claude", projectId: "p",
      });
      a.createTempSessionAndSend = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "hi");
      expect(a.createTempSessionAndSend).toHaveBeenCalled();
    });
  });

  describe("handleP2PCommand routing", () => {
    function makeCmd() {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = null;
      return a;
    }

    it("returns when command is null", async () => {
      const a = makeCmd();
      await expect(a.handleP2PCommand("c1", null)).resolves.toBeUndefined();
    });

    it("returns when transport missing", async () => {
      const a = makeCmd();
      a.transport = null;
      await expect(a.handleP2PCommand("c1", { command: "help", args: "" })).resolves.toBeUndefined();
    });

    it("/help sends help text", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "help", args: "" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("/start sends help text", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "start", args: "" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("/project calls showProjectList", async () => {
      const a = makeCmd();
      a.showProjectList = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "project", args: "" });
      expect(a.showProjectList).toHaveBeenCalled();
    });

    it("/new and /switch dispatch to handleNewCommand / handleSwitchCommand", async () => {
      const a = makeCmd();
      a.handleNewCommand = vi.fn(async () => undefined);
      a.handleSwitchCommand = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "new", args: "" });
      await a.handleP2PCommand("c1", { command: "switch", args: "" });
      expect(a.handleNewCommand).toHaveBeenCalled();
      expect(a.handleSwitchCommand).toHaveBeenCalled();
    });

    it("falls through to unknown-command warning", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "foo", args: "" });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });
  });

  describe("handleNewCommand / handleSwitchCommand guards", () => {
    it("handleNewCommand prompts when no project is selected", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleNewCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleNewCommand calls createNewSessionForProject when project known", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleNewCommand("c1");
      expect(a.createNewSessionForProject).toHaveBeenCalled();
    });

    it("handleNewCommand cleans up existing temp session before creating", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.cleanupExpiredTempSession = vi.fn(async () => undefined);
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleNewCommand("c1");
      expect(a.cleanupExpiredTempSession).toHaveBeenCalled();
    });

    it("handleSwitchCommand prompts when no project selected", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleSwitchCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleSwitchCommand calls showSessionListForProject", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.showSessionListForProject = vi.fn(async () => undefined);
      await a.handleSwitchCommand("c1");
      expect(a.showSessionListForProject).toHaveBeenCalled();
    });
  });

  describe("showProjectList / showSessionListForProject", () => {
    it("showProjectList stores pending after sending list", async () => {
      const a = new WeComAdapter() as any;
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

    it("showProjectList does not store pending when list empty", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllProjects: vi.fn(async () => []) };
      await a.showProjectList("c1");
      expect(a.sessionMapper.getPendingSelection("c1")).toEqual({ type: "project", projects: [] });
    });

    it("showSessionListForProject filters by directory and stores pending", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllSessions: vi.fn(async () => [
          { id: "s1", directory: "/a", engineType: "claude", title: "x", projectId: "p" },
          { id: "s2", directory: "/b", engineType: "claude", title: "y", projectId: "other" },
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

  describe("createNewSessionForProject", () => {
    it("creates session and stores temp on success", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => ({ id: "sess-1", engineType: "claude" })),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.createNewSessionForProject(
        "c1", "u1",
        { directory: "/foo/x", engineType: "claude", projectId: "p" },
        "alpha",
      );
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("sess-1");
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("alpha");
    });

    it("reports error when createSession fails", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => { throw new Error("boom"); }),
      };
      await a.createNewSessionForProject(
        "c1", "u1",
        { directory: "/foo/x", engineType: "claude", projectId: "p" },
        "alpha",
      );
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("创建会话失败");
    });
  });

  describe("createTempSessionAndSend / enqueue / process / cleanup", () => {
    it("createTempSessionAndSend stores temp and enqueues", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => ({ id: "s2", engineType: "claude" })),
      };
      a.enqueueP2PMessage = vi.fn(async () => undefined);
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.createTempSessionAndSend(
        "c1",
        { directory: "/d", engineType: "claude", projectId: "p" },
        "hi",
      );
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("s2");
      expect(a.enqueueP2PMessage).toHaveBeenCalledWith("c1", "hi");
    });

    it("createTempSessionAndSend reports error on failure", async () => {
      const a = new WeComAdapter() as any;
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
      const a = new WeComAdapter() as any;
      await expect(a.enqueueP2PMessage("c1", "x")).resolves.toBeUndefined();
    });

    it("enqueueP2PMessage starts processing when not running", async () => {
      const a = new WeComAdapter() as any;
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
      const a = new WeComAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      });
      await a.processP2PQueue("c1");
      expect(a.sessionMapper.getTempSession("c1")?.processing).toBe(false);
    });

    it("processP2PQueue calls sendToEngineP2P when message queued", async () => {
      const a = new WeComAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: ["hi"], processing: false,
      });
      a.sendToEngineP2P = vi.fn(async () => undefined);
      await a.processP2PQueue("c1");
      expect(a.sendToEngineP2P).toHaveBeenCalled();
    });

    it("sendToEngineP2P aborts when gateway/transport missing", async () => {
      const a = new WeComAdapter() as any;
      const temp = {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      };
      await a.sendToEngineP2P("c1", temp, "hi");
      expect(temp.processing).toBe(false);
    });

    it("sendToEngineP2P sends placeholder and assigns msg id", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "ph-1") };
      a.streamingController = { applyPart: vi.fn(), finalize: vi.fn() };
      const sendPromise = Promise.resolve({ id: "msg-1" });
      a.gatewayClient = { sendMessage: vi.fn(() => sendPromise) };
      const temp: any = {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: 0, messageQueue: [], processing: true,
      };
      await a.sendToEngineP2P("c1", temp, "hi");
      await sendPromise;
      expect(a.transport.sendText).toHaveBeenCalled();
      expect(temp.streamingSession).toBeDefined();
    });

    it("cleanupExpiredTempSession deletes session and clears mapping", async () => {
      const a = new WeComAdapter() as any;
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
      const a = new WeComAdapter() as any;
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
      const a = new WeComAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn() };
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("handleProjectSelection / handleSessionSelection / handlePendingSelection", () => {
    it("handleProjectSelection returns false on non-numeric input", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "abc", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection returns false on out-of-range index", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "5", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection on valid index sets last project + shows sessions", async () => {
      const a = new WeComAdapter() as any;
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
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      const ok = await a.handleSessionSelection("c1", "u1", "abc", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection returns false when missing dir/projectId", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      const ok = await a.handleSessionSelection("c1", "u1", "1", {
        type: "session",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection short-circuits when session already has group", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      const ok = await a.handleSessionSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("已有对应的群聊");
    });

    it("handleSessionSelection on valid index stores temp session", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handleSessionSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p", projectName: "alpha",
        sessions: [{ id: "s1", title: "x", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("s1");
    });

    it("handlePendingSelection dispatches by type", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok1 = await a.handlePendingSelection("c1", "u1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      });
      const ok2 = await a.handlePendingSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      const ok3 = await a.handlePendingSelection("c1", "u1", "1", { type: "unknown" });
      expect(ok1).toBe(true);
      expect(ok2).toBe(true);
      expect(ok3).toBe(false);
    });
  });

  describe("handleGroupMessage / handleGroupCommand", () => {
    it("handleGroupMessage warns when no binding", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleGroupMessage("g1", "hi");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("未绑定");
    });

    it("handleGroupMessage routes commands to handleGroupCommand", async () => {
      const a = new WeComAdapter() as any;
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
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { replyQuestion: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.sessionMapper.setPendingQuestion("group:g1", { questionId: "q-1" });
      await a.handleGroupMessage("g1", "an answer");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["an answer"]],
      });
    });

    it("handleGroupMessage routes plain text to sendToEngine", async () => {
      const a = new WeComAdapter() as any;
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
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await a.handleGroupCommand("group:g1", binding, { command: "help", args: "" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("handleGroupCommand falls through to unknown-command warning", async () => {
      const a = new WeComAdapter() as any;
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
      await a.handleGroupCommand("group:g1", binding, { command: "foo", args: "" });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });
  });

  describe("createGroupForSession", () => {
    it("short-circuits when session already has a group binding", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), createGroup: vi.fn() };
      a.gatewayClient = { getSession: vi.fn() };
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      await a.createGroupForSession("u1", "conv-1", "claude", "/d", "p", "alpha", "p2p");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("已有对应的群聊");
      expect(a.transport.createGroup).not.toHaveBeenCalled();
    });

    it("creates group binding and sends welcome on success", async () => {
      const a = new WeComAdapter() as any;
      a.transport = {
        sendText: vi.fn(async () => ""),
        createGroup: vi.fn(async () => "newchat"),
      };
      a.gatewayClient = {
        getSession: vi.fn(async () => ({ title: "MySession" })),
      };
      await a.createGroupForSession("u1", "conv-1", "claude", "/d", "p", "alpha", "p2p");
      expect(a.transport.createGroup).toHaveBeenCalled();
      expect(a.sessionMapper.findGroupByConversationId("conv-1")?.chatId).toBe("newchat");
    });

    it("warns when createGroup returns no chatid", async () => {
      const a = new WeComAdapter() as any;
      a.transport = {
        sendText: vi.fn(async () => ""),
        createGroup: vi.fn(async () => null),
      };
      a.gatewayClient = { getSession: vi.fn(async () => ({ title: "T" })) };
      await a.createGroupForSession("u1", "conv-1", "claude", "/d", "p", "alpha", "p2p");
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("失败");
    });

    it("reports error when createGroup throws", async () => {
      const a = new WeComAdapter() as any;
      a.transport = {
        sendText: vi.fn(async () => ""),
        createGroup: vi.fn(async () => { throw new Error("oops"); }),
      };
      a.gatewayClient = { getSession: vi.fn(async () => ({ title: "T" })) };
      await a.createGroupForSession("u1", "conv-1", "claude", "/d", "p", "alpha", "p2p");
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("创建群聊失败");
    });
  });

  describe("sendToEngine (group)", () => {
    it("aborts when streamingController missing", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "ph") };
      a.gatewayClient = { sendMessage: vi.fn(async () => ({ id: "m" })) };
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await a.sendToEngine("group:g1", binding, "hi");
      expect(a.transport.sendText).not.toHaveBeenCalled();
    });

    it("sends placeholder and registers streaming session on success", async () => {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "ph") };
      a.streamingController = {};
      const sendPromise = Promise.resolve({ id: "m1" });
      a.gatewayClient = { sendMessage: vi.fn(() => sendPromise) };
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      a.sessionMapper.createGroupBinding(binding);
      await a.sendToEngine("group:g1", binding, "hi");
      await sendPromise;
      expect(a.transport.sendText).toHaveBeenCalled();
    });
  });

  describe("gateway event handlers", () => {
    function makeGw() {
      const a = new WeComAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), updateGroup: vi.fn(async () => undefined) };
      a.streamingController = { applyPart: vi.fn(), finalize: vi.fn() };
      return a;
    }

    it("subscribeGatewayEvents wires handlers on gatewayClient", () => {
      const a = new WeComAdapter() as any;
      const handlers: Record<string, (...args: unknown[]) => unknown> = {};
      a.gatewayClient = {
        on: vi.fn((evt: string, cb: (...args: unknown[]) => unknown) => { handlers[evt] = cb; }),
      };
      a.subscribeGatewayEvents();
      expect(Object.keys(handlers)).toEqual(
        expect.arrayContaining([
          "message.part.updated",
          "message.updated",
          "permission.asked",
          "question.asked",
          "session.updated",
        ]),
      );
    });

    it("subscribeGatewayEvents no-op without gateway client", () => {
      const a = new WeComAdapter() as any;
      expect(() => a.subscribeGatewayEvents()).not.toThrow();
    });

    it("handleMessageCompleted skips non-assistant or non-completed", () => {
      const a = makeGw();
      a.finalizeP2PStreaming = vi.fn();
      a.handleMessageCompleted("conv-1", { role: "user", time: { completed: 1 } });
      a.handleMessageCompleted("conv-1", { role: "assistant", time: {} });
      expect(a.finalizeP2PStreaming).not.toHaveBeenCalled();
    });

    it("handleMessageCompleted finalizes via group binding", () => {
      const a = makeGw();
      const ss = { conversationId: "conv-1", completed: false } as any;
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      });
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

    it("handlePartUpdated forwards group streaming to applyPart", () => {
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

    it("handlePartUpdated forwards P2P streaming to applyPart", () => {
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

    it("handlePartUpdated no-ops with no active session", () => {
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

    it("handleQuestionAsked sends 'no options' message when array empty", () => {
      const a = makeGw();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handleQuestionAsked({ id: "q-1", sessionId: "conv-1", questions: [] });
      expect(a.transport.sendText.mock.calls[0][1]).toContain("无选项");
    });

    it("handleQuestionAsked routes to group target when bound", () => {
      const a = makeGw();
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.handleQuestionAsked({
        id: "q-1", sessionId: "conv-1",
        questions: [{ question: "go?", options: [{ label: "yes" }] }],
      });
      expect(a.sessionMapper.getPendingQuestion("group:g1")?.questionId).toBe("q-1");
    });

    it("handleSessionUpdated updates streaming titles + group name", async () => {
      const a = makeGw();
      const ss = { conversationId: "conv-1", completed: false, sessionTitle: "old" } as any;
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/foo/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      });
      await a.handleSessionUpdated({ id: "conv-1", title: "new title" });
      expect(ss.sessionTitle).toBe("new title");
      expect(a.transport.updateGroup).toHaveBeenCalled();
    });

    it("handleSessionUpdated no-ops without binding", async () => {
      const a = makeGw();
      await expect(a.handleSessionUpdated({ id: "missing", title: "x" })).resolves.toBeUndefined();
    });

    it("handleSessionUpdated swallows updateGroup errors", async () => {
      const a = makeGw();
      a.transport.updateGroup = vi.fn(async () => { throw new Error("rate"); });
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/foo/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      await expect(a.handleSessionUpdated({ id: "conv-1", title: "t" })).resolves.toBeUndefined();
    });
  });

  describe("finalizeP2PStreaming", () => {
    it("finalizes streaming and processes next queued message", async () => {
      const a = new WeComAdapter() as any;
      a.streamingController = { finalize: vi.fn() };
      a.processP2PQueue = vi.fn(async () => undefined);
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: 0, messageQueue: [], processing: false,
        streamingSession: { completed: false } as any,
      });
      await a.finalizeP2PStreaming("c1", { id: "m1", role: "assistant" });
      expect(a.streamingController.finalize).toHaveBeenCalled();
      expect(a.processP2PQueue).toHaveBeenCalledWith("c1");
    });

    it("no-ops when no temp session / streaming exists", async () => {
      const a = new WeComAdapter() as any;
      a.streamingController = { finalize: vi.fn() };
      await a.finalizeP2PStreaming("c1", { id: "m1", role: "assistant" });
      expect(a.streamingController.finalize).not.toHaveBeenCalled();
    });
  });
});
