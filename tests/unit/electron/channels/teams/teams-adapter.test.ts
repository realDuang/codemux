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
  teamsLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

import { TeamsAdapter } from "../../../../../electron/main/channels/teams/teams-adapter";
import { DEFAULT_TEAMS_CONFIG } from "../../../../../electron/main/channels/teams/teams-types";

function makeAdapterWithStubs(): any {
  const a = new TeamsAdapter() as any;
  a.transport = {
    sendText: vi.fn(async () => "compound-1"),
    sendAdaptiveCard: vi.fn(async () => "card-1"),
    setServiceUrl: vi.fn(),
  };
  a.renderer = {
    renderStreamingUpdate: vi.fn(() => "thinking..."),
    buildQuestionCard: vi.fn(() => ({ kind: "questionCard" })),
    buildPermissionCard: vi.fn(() => ({ kind: "permCard" })),
  };
  a.streamingController = { applyPart: vi.fn(), finalize: vi.fn() };
  return a;
}

describe("TeamsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInfo / getWebhookMeta", () => {
    it("reports stopped initially and webhook path", () => {
      const a = new TeamsAdapter();
      const info = a.getInfo();
      expect(info.type).toBe("teams");
      expect(info.status).toBe("stopped");
      expect(a.getWebhookMeta().path).toBe("/api/messages");
    });
  });

  describe("start", () => {
    it("rejects when microsoftAppId/microsoftAppPassword is missing", async () => {
      const a = new TeamsAdapter();
      await expect(
        a.start({
          type: "teams",
          name: "Teams Bot",
          enabled: true,
          options: { ...DEFAULT_TEAMS_CONFIG },
        }),
      ).rejects.toThrow(/microsoftAppId and microsoftAppPassword/);
      expect(a.getInfo().status).toBe("error");
    });

    it("calls stop first when already running", async () => {
      const a = new TeamsAdapter() as any;
      a.status = "running";
      const stopSpy = vi.spyOn(a, "stop").mockResolvedValue(undefined);
      await expect(
        a.start({
          type: "teams",
          name: "Teams",
          enabled: true,
          options: { ...DEFAULT_TEAMS_CONFIG },
        }),
      ).rejects.toThrow();
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("nulls transport / streamingController / gatewayClient and emits disconnected", async () => {
      const a = new TeamsAdapter() as any;
      a.status = "running";
      a.transport = { sendText: vi.fn() };
      a.gatewayClient = { disconnect: vi.fn() };
      a.streamingController = {};
      a.conversationRefs.set("c1", {} as any);
      a.webhookServer = { unregisterRoute: vi.fn() };
      const events: string[] = [];
      a.on("status.changed", (s: any) => events.push(`status:${s}`));
      a.on("disconnected", (r: any) => events.push(`disconnected:${r}`));

      await a.stop();

      expect(a.transport).toBeNull();
      expect(a.gatewayClient).toBeNull();
      expect(a.streamingController).toBeNull();
      expect(a.conversationRefs.size).toBe(0);
      expect(a.getInfo().status).toBe("stopped");
      expect(events).toContain("status:stopped");
      expect(events).toContain("disconnected:stopped");
      expect(a.webhookServer.unregisterRoute).toHaveBeenCalledWith("/api/messages");
    });
  });

  describe("updateConfig", () => {
    it("restarts when microsoftAppId changes", async () => {
      const a = new TeamsAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_TEAMS_CONFIG, microsoftAppId: "old" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { microsoftAppId: "new" } });
      expect(a.stop).toHaveBeenCalled();
      expect(a.start).toHaveBeenCalled();
    });

    it("restarts when tenantId changes", async () => {
      const a = new TeamsAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_TEAMS_CONFIG, tenantId: "old" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { tenantId: "new" } });
      expect(a.start).toHaveBeenCalled();
    });

    it("does not restart when only autoApprovePermissions changes", async () => {
      const a = new TeamsAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_TEAMS_CONFIG, microsoftAppId: "k", microsoftAppPassword: "p" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { autoApprovePermissions: false } });
      expect(a.stop).not.toHaveBeenCalled();
    });

    it("does not restart when not running", async () => {
      const a = new TeamsAdapter() as any;
      a.status = "stopped";
      a.config = { ...DEFAULT_TEAMS_CONFIG };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { microsoftAppId: "x" } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.config.microsoftAppId).toBe("x");
    });
  });

  describe("setWebhookServer", () => {
    it("stores reference", () => {
      const a = new TeamsAdapter() as any;
      const ws = { registerRoute: vi.fn(), unregisterRoute: vi.fn() };
      a.setWebhookServer(ws);
      expect(a.webhookServer).toBe(ws);
    });
  });

  describe("isTempSessionExpired", () => {
    it("false within TTL, true past TTL", () => {
      const a = new TeamsAdapter() as any;
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 1000 })).toBe(false);
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 999_999_999 })).toBe(true);
    });
  });

  describe("handleWebhookRequest", () => {
    it("returns 405 for non-POST", async () => {
      const a = makeAdapterWithStubs();
      const res = await a.handleWebhookRequest({ method: "GET", headers: {}, body: {} });
      expect(res.status).toBe(405);
    });

    it("returns 401 when Authorization missing", async () => {
      const a = makeAdapterWithStubs();
      a.config.skipAuth = false;
      const res = await a.handleWebhookRequest({ method: "POST", headers: {}, body: { type: "message" } });
      expect(res.status).toBe(401);
    });

    it("returns 401 with bad Authorization scheme", async () => {
      const a = makeAdapterWithStubs();
      a.config.skipAuth = false;
      const res = await a.handleWebhookRequest({
        method: "POST",
        headers: { authorization: "Basic xyz" },
        body: { type: "message" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for missing activity body when skipAuth", async () => {
      const a = makeAdapterWithStubs();
      a.config.skipAuth = true;
      const res = await a.handleWebhookRequest({ method: "POST", headers: {}, body: null });
      expect(res.status).toBe(400);
    });

    it("returns 202 and dispatches activity", async () => {
      const a = makeAdapterWithStubs();
      a.config.skipAuth = true;
      a.processActivity = vi.fn().mockResolvedValue(undefined);
      const res = await a.handleWebhookRequest({
        method: "POST",
        headers: {},
        body: { type: "message", id: "1", conversation: { id: "c1" }, from: { id: "u1" } },
      });
      expect(res.status).toBe(202);
      expect(a.processActivity).toHaveBeenCalled();
    });
  });

  describe("processActivity", () => {
    it("stores conversation reference and dispatches by type", async () => {
      const a = makeAdapterWithStubs();
      a.handleMessage = vi.fn(async () => undefined);
      await a.processActivity({
        type: "message",
        id: "m1",
        serviceUrl: "https://svc",
        conversation: { id: "c1", tenantId: "t" },
        recipient: { id: "bot" },
      });
      expect(a.transport.setServiceUrl).toHaveBeenCalledWith("c1", "https://svc");
      expect(a.conversationRefs.get("c1")?.serviceUrl).toBe("https://svc");
      expect(a.handleMessage).toHaveBeenCalled();
    });

    it("dispatches conversationUpdate", async () => {
      const a = makeAdapterWithStubs();
      a.handleConversationUpdate = vi.fn(async () => undefined);
      await a.processActivity({
        type: "conversationUpdate",
        id: "m1",
        serviceUrl: "https://svc",
        conversation: { id: "c1" },
        recipient: { id: "bot" },
      });
      expect(a.handleConversationUpdate).toHaveBeenCalled();
    });

    it("dispatches invoke", async () => {
      const a = makeAdapterWithStubs();
      a.handleInvoke = vi.fn(async () => undefined);
      await a.processActivity({
        type: "invoke",
        id: "m1",
        serviceUrl: "https://svc",
        conversation: { id: "c1" },
        recipient: { id: "bot" },
      });
      expect(a.handleInvoke).toHaveBeenCalled();
    });

    it("ignores unknown activity type", async () => {
      const a = makeAdapterWithStubs();
      await expect(
        a.processActivity({
          type: "weird",
          id: "m1",
          serviceUrl: "https://svc",
          conversation: { id: "c1" },
          recipient: { id: "bot" },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("handleMessage", () => {
    it("skips messages without text or from bot itself", async () => {
      const a = makeAdapterWithStubs();
      a.handleP2PMessage = vi.fn();
      await a.handleMessage({
        type: "message",
        id: "m1",
        conversation: { id: "c1" },
        from: { id: "u1" },
        recipient: { id: "bot" },
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();

      await a.handleMessage({
        type: "message",
        id: "m2",
        conversation: { id: "c1" },
        from: { id: "bot" },
        recipient: { id: "bot" },
        text: "hello",
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("dedupes by activity id", async () => {
      const a = makeAdapterWithStubs();
      a.handleP2PMessage = vi.fn(async () => undefined);
      const ev = {
        type: "message",
        id: "m1",
        conversation: { id: "c1", conversationType: "personal" as const },
        from: { id: "u1" },
        recipient: { id: "bot" },
        text: "hi",
      };
      await a.handleMessage(ev);
      await a.handleMessage(ev);
      expect(a.handleP2PMessage).toHaveBeenCalledTimes(1);
    });

    it("routes personal messages to handleP2PMessage", async () => {
      const a = makeAdapterWithStubs();
      a.handleP2PMessage = vi.fn(async () => undefined);
      await a.handleMessage({
        type: "message",
        id: "m1",
        conversation: { id: "c1", conversationType: "personal" as const },
        from: { id: "u1", aadObjectId: "aad1", name: "Alice" },
        recipient: { id: "bot" },
        text: "hi",
      });
      expect(a.handleP2PMessage).toHaveBeenCalledWith("c1", "aad1", "hi");
    });

    it("routes group with mention to handleGroupMessage", async () => {
      const a = makeAdapterWithStubs();
      a.handleGroupMessage = vi.fn(async () => undefined);
      await a.handleMessage({
        type: "message",
        id: "m1",
        conversation: { id: "g1", conversationType: "groupChat" as const },
        from: { id: "u1" },
        recipient: { id: "bot" },
        text: "<at>Bot</at> hi",
        entities: [{ type: "mention", mentioned: { id: "bot", name: "Bot" } }],
        serviceUrl: "https://svc",
      });
      expect(a.handleGroupMessage).toHaveBeenCalled();
    });

    it("ignores group message without mention/command/pending", async () => {
      const a = makeAdapterWithStubs();
      a.handleGroupMessage = vi.fn(async () => undefined);
      await a.handleMessage({
        type: "message",
        id: "m1",
        conversation: { id: "g1", conversationType: "groupChat" as const },
        from: { id: "u1" },
        recipient: { id: "bot" },
        text: "just chatting",
      });
      expect(a.handleGroupMessage).not.toHaveBeenCalled();
    });
  });

  describe("isBotMentioned / stripMentions", () => {
    it("isBotMentioned finds bot id in entities", () => {
      const a = new TeamsAdapter() as any;
      expect(
        a.isBotMentioned(
          { entities: [{ type: "mention", mentioned: { id: "bot" } }] },
          "bot",
        ),
      ).toBe(true);
      expect(a.isBotMentioned({}, "bot")).toBe(false);
      expect(a.isBotMentioned({ entities: [] }, "bot")).toBe(false);
    });

    it("stripMentions removes <at>...</at> tags", () => {
      const a = new TeamsAdapter() as any;
      expect(a.stripMentions("<at>Bot</at> hello")).toBe("hello");
    });
  });

  describe("handleConversationUpdate", () => {
    it("welcomes when bot is added", async () => {
      const a = makeAdapterWithStubs();
      await a.handleConversationUpdate({
        type: "conversationUpdate",
        conversation: { id: "g1" },
        recipient: { id: "bot" },
        membersAdded: [{ id: "bot" }],
        serviceUrl: "https://svc",
      });
      expect(a.transport.setServiceUrl).toHaveBeenCalledWith("g1", "https://svc");
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("cleans up when bot is removed", async () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.conversationRefs.set("g1", {} as any);
      await a.handleConversationUpdate({
        type: "conversationUpdate",
        conversation: { id: "g1" },
        recipient: { id: "bot" },
        membersRemoved: [{ id: "bot" }],
      });
      expect(a.sessionMapper.getGroupBinding("g1")).toBeUndefined();
      expect(a.conversationRefs.has("g1")).toBe(false);
    });
  });

  describe("handleInvoke", () => {
    it("no-ops without gatewayClient or value", async () => {
      const a = makeAdapterWithStubs();
      await expect(
        a.handleInvoke({ type: "invoke", conversation: { id: "c1" } }),
      ).resolves.toBeUndefined();
    });

    it("perm action calls replyPermission", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { replyPermission: vi.fn(async () => undefined) };
      await a.handleInvoke({
        type: "invoke",
        conversation: { id: "c1" },
        value: { action: "perm", permissionId: "p1", optionId: "o1" },
      });
      expect(a.gatewayClient.replyPermission).toHaveBeenCalledWith({
        permissionId: "p1",
        optionId: "o1",
      });
    });

    it("question action clears pending and replies", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { replyQuestion: vi.fn(async () => undefined) };
      a.sessionMapper.setPendingQuestion("c1", { questionId: "q1", sessionId: "s1" });
      await a.handleInvoke({
        type: "invoke",
        conversation: { id: "c1" },
        value: { action: "question", questionId: "q1", selectedOption: "yes" },
      });
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q1",
        answers: [["yes"]],
      });
      expect(a.sessionMapper.getPendingQuestion("c1")).toBeUndefined();
    });

    it("unknown invoke action is ignored", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { replyPermission: vi.fn() };
      await a.handleInvoke({
        type: "invoke",
        conversation: { id: "c1" },
        value: { action: "weird" },
      });
      expect(a.gatewayClient.replyPermission).not.toHaveBeenCalled();
    });
  });

  describe("handleP2PMessage dispatch", () => {
    function makeP2P() {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {
        replyQuestion: vi.fn(async () => undefined),
        listAllProjects: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
        createSession: vi.fn(async () => ({ id: "s1", engineType: "claude" })),
        sendMessage: vi.fn(async () => ({ id: "m1" })),
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
      a.sessionMapper.setPendingQuestion("c1", { questionId: "q-1", sessionId: "s" });
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

    it("creates temp session if last project selected and no temp exists", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/d", engineType: "claude", projectId: "p",
      });
      a.createTempSessionAndSend = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "hi");
      expect(a.createTempSessionAndSend).toHaveBeenCalled();
    });

    it("handles pending selection numeric reply", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setPendingSelection("c1", {
        type: "project",
        projects: [{ id: "p1", name: "alpha", directory: "/a", engineType: "claude" }],
      });
      a.showSessionListForProject = vi.fn(async () => undefined);
      await a.handleP2PMessage("c1", "u1", "1");
      expect(a.showSessionListForProject).toHaveBeenCalled();
    });
  });

  describe("handleP2PCommand routing", () => {
    function makeCmd() {
      const a = makeAdapterWithStubs();
      a.gatewayClient = null;
      return a;
    }

    it("returns when command is null or transport missing", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", null);
      a.transport = null;
      await a.handleP2PCommand("c1", { command: "help", args: [], raw: "/help" });
      expect(true).toBe(true);
    });

    it("/help sends help text", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "help", args: [], raw: "/help" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("/start sends help text", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "start", args: [], raw: "/start" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("/project calls showProjectList", async () => {
      const a = makeCmd();
      a.showProjectList = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "project", args: [], raw: "/project" });
      expect(a.showProjectList).toHaveBeenCalled();
    });

    it("/new and /switch dispatch to handleP2PNewCommand / handleP2PSwitchCommand", async () => {
      const a = makeCmd();
      a.handleP2PNewCommand = vi.fn(async () => undefined);
      a.handleP2PSwitchCommand = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "new", args: [], raw: "/new" });
      await a.handleP2PCommand("c1", { command: "switch", args: [], raw: "/switch" });
      expect(a.handleP2PNewCommand).toHaveBeenCalled();
      expect(a.handleP2PSwitchCommand).toHaveBeenCalled();
    });

    it("falls through to unknown-command warning", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", { command: "foo", args: [], raw: "/foo" });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });

    it("with gatewayClient: passes session-ops to handleSessionOpsCommand path", async () => {
      const a = makeCmd();
      a.gatewayClient = {
        cancelMessage: vi.fn(async () => undefined),
        listMessages: vi.fn(async () => []),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      // /history isn't in the switch case, exits via session-ops handler
      await a.handleP2PCommand("c1", { command: "history", args: [], raw: "/history" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });
  });

  describe("handleP2PNewCommand / handleP2PSwitchCommand", () => {
    it("handleP2PNewCommand prompts when no project selected", async () => {
      const a = makeAdapterWithStubs();
      await a.handleP2PNewCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PNewCommand calls createNewSessionForProject when project known", async () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleP2PNewCommand("c1");
      expect(a.createNewSessionForProject).toHaveBeenCalled();
    });

    it("handleP2PNewCommand cleans up existing temp session", async () => {
      const a = makeAdapterWithStubs();
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
      await a.handleP2PNewCommand("c1");
      expect(a.cleanupExpiredTempSession).toHaveBeenCalled();
    });

    it("handleP2PSwitchCommand prompts when no project selected", async () => {
      const a = makeAdapterWithStubs();
      await a.handleP2PSwitchCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PSwitchCommand calls showSessionListForProject", async () => {
      const a = makeAdapterWithStubs();
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
      const a = makeAdapterWithStubs();
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "alpha", directory: "/a", engineType: "claude" },
        ]),
      };
      await a.showProjectList("c1");
      expect(a.transport.sendText).toHaveBeenCalled();
      expect(a.sessionMapper.getPendingSelection("c1")?.type).toBe("project");
    });

    it("showProjectList returns when no gatewayClient", async () => {
      const a = makeAdapterWithStubs();
      await expect(a.showProjectList("c1")).resolves.toBeUndefined();
    });

    it("showProjectList does not store pending when list is empty", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { listAllProjects: vi.fn(async () => []) };
      await a.showProjectList("c1");
      expect(a.sessionMapper.getPendingSelection("c1")).toEqual({ type: "project", projects: [] });
    });

    it("showSessionListForProject filters by directory", async () => {
      const a = makeAdapterWithStubs();
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

  describe("createNewSessionForProject / createTempSessionAndSend", () => {
    it("createNewSessionForProject stores temp + sends message on success", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {
        createSession: vi.fn(async () => ({ id: "sess-1", engineType: "claude" })),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.createNewSessionForProject(
        "c1",
        { directory: "/d", engineType: "claude", projectId: "p" },
        "alpha",
      );
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("sess-1");
    });

    it("createNewSessionForProject reports error on failure", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {
        createSession: vi.fn(async () => { throw new Error("nope"); }),
      };
      await a.createNewSessionForProject(
        "c1",
        { directory: "/d", projectId: "p" },
        "x",
      );
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("创建会话失败");
    });

    it("createTempSessionAndSend stores temp + enqueues message", async () => {
      const a = makeAdapterWithStubs();
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

    it("createTempSessionAndSend reports error on failure", async () => {
      const a = makeAdapterWithStubs();
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
  });

  describe("enqueueP2PMessage / processP2PQueue / cleanupExpiredTempSession", () => {
    it("enqueueP2PMessage no-ops without temp session", async () => {
      const a = makeAdapterWithStubs();
      await expect(a.enqueueP2PMessage("c1", "x")).resolves.toBeUndefined();
    });

    it("enqueueP2PMessage starts processing when not running", async () => {
      const a = makeAdapterWithStubs();
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
      const a = makeAdapterWithStubs();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      });
      await a.processP2PQueue("c1");
      expect(a.sessionMapper.getTempSession("c1")?.processing).toBe(false);
    });

    it("processP2PQueue no-ops without temp session", async () => {
      const a = makeAdapterWithStubs();
      await expect(a.processP2PQueue("c1")).resolves.toBeUndefined();
    });

    it("cleanupExpiredTempSession deletes session and clears mapping", async () => {
      const a = makeAdapterWithStubs();
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
      const a = makeAdapterWithStubs();
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
      const a = makeAdapterWithStubs();
      a.gatewayClient = { deleteSession: vi.fn() };
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("handleProjectSelection / handleSessionSelection / handlePendingSelection", () => {
    it("handleProjectSelection returns false on non-numeric input", async () => {
      const a = makeAdapterWithStubs();
      const ok = await a.handleProjectSelection("c1", "abc", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection returns false on out-of-range", async () => {
      const a = makeAdapterWithStubs();
      const ok = await a.handleProjectSelection("c1", "9", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection on valid index sets last project + shows sessions", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handleProjectSelection("c1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "alpha", directory: "/foo/alpha", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.sessionMapper.getP2PChat("c1")?.lastSelectedProject?.projectId).toBe("p1");
    });

    it("handleSessionSelection returns false when missing dir/projectId", async () => {
      const a = makeAdapterWithStubs();
      const ok = await a.handleSessionSelection("c1", "1", {
        type: "session",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection returns false on bad index", async () => {
      const a = makeAdapterWithStubs();
      const ok = await a.handleSessionSelection("c1", "abc", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection on valid index sets temp session", async () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handleSessionSelection("c1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude", title: "x" }],
      });
      expect(ok).toBe(true);
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("s1");
    });

    it("handlePendingSelection dispatches by type", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handlePendingSelection("c1", "u1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      });
      expect(ok).toBe(true);

      const ok2 = await a.handlePendingSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok2).toBe(true);

      const ok3 = await a.handlePendingSelection("c1", "u1", "1", { type: "weird" });
      expect(ok3).toBe(false);
    });
  });

  describe("handleGroupMessage / handleGroupCommand", () => {
    it("handleGroupMessage warns when no binding", async () => {
      const a = makeAdapterWithStubs();
      await a.handleGroupMessage("g1", "hi", "https://svc");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("未绑定");
    });

    it("handleGroupMessage shows help on /help when no binding", async () => {
      const a = makeAdapterWithStubs();
      await a.handleGroupMessage("g1", "/help", "https://svc");
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("handleGroupMessage shows project list on /bind when no binding", async () => {
      const a = makeAdapterWithStubs();
      a.showGroupProjectList = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "/bind", "https://svc");
      expect(a.showGroupProjectList).toHaveBeenCalled();
    });

    it("handleGroupMessage with binding routes commands to handleGroupCommand", async () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.handleGroupCommand = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "/help", "https://svc");
      expect(a.handleGroupCommand).toHaveBeenCalled();
    });

    it("handleGroupMessage routes pending question reply", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { replyQuestion: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.sessionMapper.setPendingQuestion("g1", { questionId: "q-1", sessionId: "s1" });
      await a.handleGroupMessage("g1", "an answer", "https://svc");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["an answer"]],
      });
    });

    it("handleGroupMessage routes plain text to sendToEngine", async () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.sendToEngine = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "hello", "https://svc");
      expect(a.sendToEngine).toHaveBeenCalled();
    });

    it("handleGroupMessage with pending selection routes to handleGroupPendingSelection", async () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.setPendingSelection("g1", {
        type: "project",
        projects: [{ id: "p1", name: "alpha", directory: "/a", engineType: "claude" }],
      });
      a.handleGroupPendingSelection = vi.fn(async () => true);
      await a.handleGroupMessage("g1", "1", "https://svc");
      expect(a.handleGroupPendingSelection).toHaveBeenCalled();
    });

    it("handleGroupCommand /help sends help text", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {};
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await a.handleGroupCommand("g1", binding, { command: "help", args: [], raw: "/help" });
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("handleGroupCommand falls through to unknown-command warning", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {};
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await a.handleGroupCommand("g1", binding, { command: "foo", args: [], raw: "/foo" });
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("未知命令");
    });

    it("handleGroupCommand returns when no command/gateway/transport", async () => {
      const a = makeAdapterWithStubs();
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await a.handleGroupCommand("g1", binding, null);
      expect(a.transport.sendText).not.toHaveBeenCalled();
    });
  });

  describe("showGroupProjectList / handleGroupPendingSelection", () => {
    it("showGroupProjectList sends list and stores pending", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "alpha", directory: "/a", engineType: "claude" },
        ]),
      };
      await a.showGroupProjectList("g1", "https://svc");
      expect(a.sessionMapper.getPendingSelection("g1")?.type).toBe("project");
    });

    it("handleGroupPendingSelection dispatches by type", async () => {
      const a = makeAdapterWithStubs();
      a.handleGroupProjectSelection = vi.fn(async () => true);
      a.handleGroupSessionSelection = vi.fn(async () => true);
      const ok1 = await a.handleGroupPendingSelection("g1", "1", { type: "project" }, "u");
      const ok2 = await a.handleGroupPendingSelection("g1", "1", { type: "session" }, "u");
      const ok3 = await a.handleGroupPendingSelection("g1", "1", { type: "weird" }, "u");
      expect(ok1).toBe(true);
      expect(ok2).toBe(true);
      expect(ok3).toBe(false);
    });

    it("handleGroupProjectSelection returns false on bad input", async () => {
      const a = makeAdapterWithStubs();
      const ok = await a.handleGroupProjectSelection("g1", "abc", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      }, "u");
      expect(ok).toBe(false);
    });

    it("handleGroupProjectSelection sends sessions on valid index", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleGroupProjectSelection("g1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "alpha", directory: "/d", engineType: "claude" }],
      }, "https://svc");
      expect(ok).toBe(true);
      expect(a.sessionMapper.getPendingSelection("g1")?.type).toBe("session");
    });

    it("handleGroupSessionSelection returns false when missing dir/projectId", async () => {
      const a = makeAdapterWithStubs();
      const ok = await a.handleGroupSessionSelection("g1", "1", {
        type: "session",
        sessions: [{ id: "s1", engineType: "claude" }],
      }, "u");
      expect(ok).toBe(false);
    });

    it("handleGroupSessionSelection on 'new' creates session and binding", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {
        createSession: vi.fn(async () => ({ id: "newsess", engineType: "claude", title: "t" })),
      };
      const ok = await a.handleGroupSessionSelection("g1", "new", {
        type: "session", directory: "/d", projectId: "p", engineType: "claude",
        sessions: [],
      }, "https://svc");
      expect(ok).toBe(true);
      expect(a.sessionMapper.getGroupBinding("g1")?.conversationId).toBe("newsess");
    });

    it("handleGroupSessionSelection on 'new' reports createSession error", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {
        createSession: vi.fn(async () => { throw new Error("nope"); }),
      };
      const ok = await a.handleGroupSessionSelection("g1", "new", {
        type: "session", directory: "/d", projectId: "p", engineType: "claude",
        sessions: [],
      }, "https://svc");
      expect(ok).toBe(true);
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("创建会话失败");
    });

    it("handleGroupSessionSelection valid numeric creates binding", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {};
      const ok = await a.handleGroupSessionSelection("g1", "1", {
        type: "session", directory: "/d", projectId: "p", engineType: "claude",
        sessions: [{ id: "s1", title: "t1", engineType: "claude" }],
        projectName: "alpha",
      }, "https://svc");
      expect(ok).toBe(true);
      expect(a.sessionMapper.getGroupBinding("g1")?.conversationId).toBe("s1");
    });

    it("handleGroupSessionSelection bad index returns false", async () => {
      const a = makeAdapterWithStubs();
      a.gatewayClient = {};
      const ok = await a.handleGroupSessionSelection("g1", "9", {
        type: "session", directory: "/d", projectId: "p", engineType: "claude",
        sessions: [{ id: "s1", engineType: "claude" }],
      }, "https://svc");
      expect(ok).toBe(false);
    });
  });

  describe("gateway event handlers", () => {
    it("handleMessageCompleted skips non-assistant or non-completed", () => {
      const a = makeAdapterWithStubs();
      a.finalizeP2PStreaming = vi.fn();
      a.handleMessageCompleted("conv-1", { role: "user", time: { completed: 1 } });
      a.handleMessageCompleted("conv-1", { role: "assistant", time: {} });
      expect(a.finalizeP2PStreaming).not.toHaveBeenCalled();
    });

    it("handleMessageCompleted finalizes via group binding when present", () => {
      const a = makeAdapterWithStubs();
      const ss = { conversationId: "conv-1", completed: false } as any;
      const binding = {
        chatId: "g1", conversationId: "conv-1", engineType: "claude" as const,
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      };
      a.sessionMapper.createGroupBinding(binding);
      a.handleMessageCompleted("conv-1", { id: "m1", role: "assistant", time: { completed: 1 } });
      expect(a.streamingController.finalize).toHaveBeenCalled();
    });

    it("handleMessageCompleted routes to finalizeP2PStreaming for P2P temp", () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.finalizeP2PStreaming = vi.fn(async () => undefined);
      a.handleMessageCompleted("conv-1", { role: "assistant", time: { completed: 1 } });
      expect(a.finalizeP2PStreaming).toHaveBeenCalled();
    });

    it("finalizeP2PStreaming finalizes streaming and processes queue", async () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
        streamingSession: { completed: false } as any,
      });
      a.processP2PQueue = vi.fn(async () => undefined);
      await a.finalizeP2PStreaming("c1", { id: "m1", role: "assistant", time: { completed: 1 } });
      expect(a.streamingController.finalize).toHaveBeenCalled();
      expect(a.processP2PQueue).toHaveBeenCalled();
    });

    it("handlePartUpdated forwards group streaming session to applyPart", () => {
      const a = makeAdapterWithStubs();
      const ss = { conversationId: "conv-1", completed: false } as any;
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      });
      a.handlePartUpdated("conv-1", { type: "text", text: "x" });
      expect(a.streamingController.applyPart).toHaveBeenCalled();
    });

    it("handlePartUpdated forwards P2P streaming session to applyPart", () => {
      const a = makeAdapterWithStubs();
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
      const a = makeAdapterWithStubs();
      a.handlePartUpdated("missing", { type: "text", text: "x" });
      expect(a.streamingController.applyPart).not.toHaveBeenCalled();
    });

    it("handlePermissionAsked auto-approves when configured + accept option exists", () => {
      const a = makeAdapterWithStubs();
      a.config.autoApprovePermissions = true;
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
      const a = makeAdapterWithStubs();
      a.config.autoApprovePermissions = true;
      a.gatewayClient = { replyPermission: vi.fn() };
      a.handlePermissionAsked({ id: "perm-1", sessionId: "missing", options: [] });
      expect(a.gatewayClient.replyPermission).not.toHaveBeenCalled();
    });

    it("handlePermissionAsked sends adaptive card when not auto-approved", () => {
      const a = makeAdapterWithStubs();
      a.config.autoApprovePermissions = false;
      a.gatewayClient = { replyPermission: vi.fn() };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handlePermissionAsked({
        id: "perm-1", sessionId: "conv-1", title: "Allow?",
        options: [{ id: "ok", label: "Allow" }, { id: "no", label: "Deny" }],
      });
      expect(a.transport.sendAdaptiveCard).toHaveBeenCalled();
    });

    it("handleQuestionAsked sends adaptive card and registers pendingQuestion", () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handleQuestionAsked({
        id: "q-1", sessionId: "conv-1",
        questions: [{ question: "go?", options: [{ label: "yes" }, { label: "no" }] }],
      });
      expect(a.transport.sendAdaptiveCard).toHaveBeenCalled();
      expect(a.sessionMapper.getPendingQuestion("c1")?.questionId).toBe("q-1");
    });

    it("handleQuestionAsked sends 'no options' message when questions array empty", () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handleQuestionAsked({ id: "q-1", sessionId: "conv-1", questions: [] });
      expect(a.transport.sendText.mock.calls[0][1]).toContain("无选项");
    });

    it("handleSessionUpdated updates streaming session titles for bound group", () => {
      const a = makeAdapterWithStubs();
      const ss = { conversationId: "conv-1", completed: false, sessionTitle: "old" } as any;
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", serviceUrl: "u",
        streamingSessions: new Map([["m1", ss]]),
        createdAt: Date.now(),
      });
      a.handleSessionUpdated({ id: "conv-1", title: "new title" });
      expect(ss.sessionTitle).toBe("new title");
    });

    it("handleSessionUpdated no-ops when no group binding", () => {
      const a = makeAdapterWithStubs();
      expect(() => a.handleSessionUpdated({ id: "missing", title: "x" })).not.toThrow();
    });
  });

  describe("restoreServiceUrls", () => {
    it("registers serviceUrls from persisted bindings", () => {
      const a = makeAdapterWithStubs();
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "conv-1", engineType: "claude",
        directory: "/d", projectId: "p", serviceUrl: "https://svc",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.restoreServiceUrls();
      expect(a.transport.setServiceUrl).toHaveBeenCalledWith("g1", "https://svc");
      expect(a.conversationRefs.get("g1")?.serviceUrl).toBe("https://svc");
    });

    it("no-ops when no transport", () => {
      const a = new TeamsAdapter() as any;
      expect(() => a.restoreServiceUrls()).not.toThrow();
    });
  });
});
