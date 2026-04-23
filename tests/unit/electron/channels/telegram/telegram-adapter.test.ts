import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TELEGRAM_CONFIG } from "../../../../../electron/main/channels/telegram/telegram-types";

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
  telegramLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

import { TelegramAdapter } from "../../../../../electron/main/channels/telegram/telegram-adapter";

describe("TelegramAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInfo", () => {
    it("reports stopped status before start", () => {
      const a = new TelegramAdapter();
      const info = a.getInfo();
      expect(info.type).toBe("telegram");
      expect(info.status).toBe("stopped");
      expect(info.stats?.mode).toBe("polling");
    });

    it("reports webhook mode when webhookUrl set", () => {
      const a = new TelegramAdapter() as any;
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, webhookUrl: "https://x.com/wh" };
      expect(a.getInfo().stats?.mode).toBe("webhook");
    });
  });

  describe("start", () => {
    it("rejects when botToken is missing", async () => {
      const a = new TelegramAdapter();
      await expect(
        a.start({
          type: "telegram",
          name: "Telegram Bot",
          enabled: true,
          options: { ...DEFAULT_TELEGRAM_CONFIG },
        }),
      ).rejects.toThrow(/botToken/);
      expect(a.getInfo().status).toBe("error");
    });
  });

  describe("setWebhookServer", () => {
    it("stores reference", () => {
      const a = new TelegramAdapter() as any;
      const srv = { registerRoute: vi.fn(), unregisterRoute: vi.fn() };
      a.setWebhookServer(srv);
      expect(a.webhookServer).toBe(srv);
    });
  });

  describe("stop", () => {
    it("nulls transport / streamingController / gatewayClient and emits disconnected", async () => {
      const a = new TelegramAdapter() as any;
      a.status = "running";
      a.transport = { sendText: vi.fn(), deleteWebhook: vi.fn(async () => true) };
      a.gatewayClient = { disconnect: vi.fn() };
      a.streamingController = {};
      const events: string[] = [];
      a.on("status.changed", (s: any) => events.push(`status:${s}`));
      a.on("disconnected", (r: any) => events.push(`disconnected:${r}`));

      await a.stop();

      expect(a.transport).toBeNull();
      expect(a.gatewayClient).toBeNull();
      expect(a.streamingController).toBeNull();
      expect(a.getInfo().status).toBe("stopped");
      expect(events).toContain("status:stopped");
      expect(events).toContain("disconnected:stopped");
    });

    it("unregisters webhook route and deletes webhook on Telegram", async () => {
      const a = new TelegramAdapter() as any;
      const unregister = vi.fn();
      const deleteWebhook = vi.fn(async () => true);
      a.webhookServer = { unregisterRoute: unregister };
      a.transport = { deleteWebhook };
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, webhookUrl: "https://x.com/wh" };
      await a.stop();
      expect(unregister).toHaveBeenCalledWith("/webhook/telegram");
      expect(deleteWebhook).toHaveBeenCalled();
    });

    it("aborts in-flight long polling before shutdown completes", async () => {
      const adapter = new TelegramAdapter() as any;
      const getUpdates = vi.fn((_offset?: number, _timeout?: number, signal?: AbortSignal) => new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }));

      adapter.status = "running";
      adapter.config = { ...DEFAULT_TELEGRAM_CONFIG, botToken: "token" };
      adapter.transport = {
        getUpdates,
        deleteWebhook: vi.fn().mockResolvedValue(true),
      };
      adapter.pollingActive = true;
      adapter.pollingGeneration = 1;
      adapter.pollingAbortController = new AbortController();
      adapter.pollingLoopPromise = adapter.pollingLoop(1, adapter.pollingAbortController.signal);

      await Promise.resolve();
      await expect(adapter.stop()).resolves.toBeUndefined();

      expect(getUpdates).toHaveBeenCalledWith(undefined, 30, expect.any(AbortSignal));
      expect(adapter.pollingAbortController).toBeNull();
      expect(adapter.transport).toBeNull();
      expect(adapter.status).toBe("stopped");
    });
  });

  describe("updateConfig", () => {
    it("restarts when webhook delivery settings change", async () => {
      const adapter = new TelegramAdapter() as any;
      adapter.status = "running";
      adapter.config = {
        ...DEFAULT_TELEGRAM_CONFIG,
        botToken: "token",
        webhookUrl: "",
        webhookSecretToken: "",
      };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({
        options: {
          webhookUrl: "https://example.com/webhook/telegram",
          webhookSecretToken: "secret",
        },
      });

      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("restarts when botToken changes", async () => {
      const a = new TelegramAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, botToken: "old" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { botToken: "new" } });
      expect(a.start).toHaveBeenCalled();
    });

    it("does not restart when only autoApprovePermissions changes", async () => {
      const a = new TelegramAdapter() as any;
      a.status = "running";
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, botToken: "t" };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { autoApprovePermissions: false } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.start).not.toHaveBeenCalled();
    });

    it("does not restart when adapter is not running", async () => {
      const a = new TelegramAdapter() as any;
      a.status = "stopped";
      a.config = { ...DEFAULT_TELEGRAM_CONFIG };
      a.stop = vi.fn().mockResolvedValue(undefined);
      a.start = vi.fn().mockResolvedValue(undefined);
      await a.updateConfig({ options: { botToken: "x" } });
      expect(a.stop).not.toHaveBeenCalled();
      expect(a.start).not.toHaveBeenCalled();
      expect(a.config.botToken).toBe("x");
    });

    it("does not restart when the same bot token is re-saved", async () => {
      const adapter = new TelegramAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_TELEGRAM_CONFIG, botToken: "token" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { botToken: "token" } });

      expect(adapter.stop).not.toHaveBeenCalled();
      expect(adapter.start).not.toHaveBeenCalled();
    });
  });

  describe("isTempSessionExpired", () => {
    it("false within TTL, true past TTL", () => {
      const a = new TelegramAdapter() as any;
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 1000 })).toBe(false);
      expect(a.isTempSessionExpired({ lastActiveAt: Date.now() - 999_999_999 })).toBe(true);
    });
  });

  describe("isBotMentioned / stripBotMention", () => {
    it("returns false without entities or username", () => {
      const a = new TelegramAdapter() as any;
      expect(a.isBotMentioned({ text: "hi" })).toBe(false);
      a.botUsername = "mybot";
      expect(a.isBotMentioned({ text: "hi" })).toBe(false);
    });

    it("returns true when bot is @mentioned", () => {
      const a = new TelegramAdapter() as any;
      a.botUsername = "mybot";
      const result = a.isBotMentioned({
        text: "hello @mybot please",
        entities: [{ type: "mention", offset: 6, length: 6 }],
      });
      expect(result).toBe(true);
    });

    it("returns true when message has a bot_command entity", () => {
      const a = new TelegramAdapter() as any;
      a.botUsername = "mybot";
      const result = a.isBotMentioned({
        text: "/help",
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      });
      expect(result).toBe(true);
    });

    it("returns false for unrelated mention", () => {
      const a = new TelegramAdapter() as any;
      a.botUsername = "mybot";
      const result = a.isBotMentioned({
        text: "hello @other",
        entities: [{ type: "mention", offset: 6, length: 6 }],
      });
      expect(result).toBe(false);
    });

    it("stripBotMention removes @username", () => {
      const a = new TelegramAdapter() as any;
      a.botUsername = "mybot";
      expect(a.stripBotMention("hello @mybot world")).toBe("hello  world");
    });

    it("stripBotMention returns text unchanged when no username set", () => {
      const a = new TelegramAdapter() as any;
      expect(a.stripBotMention("hi")).toBe("hi");
    });
  });

  describe("processUpdate", () => {
    it("dispatches message updates", async () => {
      const a = new TelegramAdapter() as any;
      a.handleTelegramMessage = vi.fn(async () => undefined);
      await a.processUpdate({ update_id: 1, message: { text: "x" } });
      expect(a.handleTelegramMessage).toHaveBeenCalled();
    });

    it("dispatches callback_query updates", async () => {
      const a = new TelegramAdapter() as any;
      a.handleCallbackQuery = vi.fn(async () => undefined);
      await a.processUpdate({ update_id: 1, callback_query: { id: "x" } });
      expect(a.handleCallbackQuery).toHaveBeenCalled();
    });
  });

  describe("handleTelegramMessage", () => {
    function makeBase() {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {};
      a.handleP2PMessage = vi.fn(async () => undefined);
      a.handleGroupMessage = vi.fn(async () => undefined);
      return a;
    }

    it("ignores messages without text", async () => {
      const a = makeBase();
      await a.handleTelegramMessage({
        message_id: 1,
        from: { id: 1, first_name: "A" },
        chat: { id: 100, type: "private" },
        date: 0,
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("ignores messages from bots", async () => {
      const a = makeBase();
      await a.handleTelegramMessage({
        message_id: 1,
        from: { id: 1, first_name: "A", is_bot: true },
        chat: { id: 100, type: "private" },
        date: 0,
        text: "hi",
      });
      expect(a.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("dedupes by chatId:message_id", async () => {
      const a = makeBase();
      const ev = {
        message_id: 1,
        from: { id: 1, first_name: "A" },
        chat: { id: 100, type: "private" as const },
        date: 0,
        text: "hi",
      };
      await a.handleTelegramMessage(ev);
      await a.handleTelegramMessage(ev);
      expect(a.handleP2PMessage).toHaveBeenCalledTimes(1);
    });

    it("routes private chat to handleP2PMessage and stores P2P chat", async () => {
      const a = makeBase();
      await a.handleTelegramMessage({
        message_id: 1,
        from: { id: 1, first_name: "Alice", username: "ali" },
        chat: { id: 100, type: "private" },
        date: 0,
        text: "hi",
      });
      expect(a.handleP2PMessage).toHaveBeenCalledWith("100", "1", "hi");
      expect(a.sessionMapper.getP2PChat("100")).toBeDefined();
    });

    it("routes group chat to handleGroupMessage when bot mentioned", async () => {
      const a = makeBase();
      a.botUsername = "mybot";
      await a.handleTelegramMessage({
        message_id: 1,
        from: { id: 1, first_name: "Alice" },
        chat: { id: 200, type: "group" },
        date: 0,
        text: "hello @mybot",
        entities: [{ type: "mention", offset: 6, length: 6 }],
      });
      expect(a.handleGroupMessage).toHaveBeenCalled();
    });

    it("routes group chat to handleGroupMessage when text starts with /", async () => {
      const a = makeBase();
      await a.handleTelegramMessage({
        message_id: 1,
        from: { id: 1, first_name: "Alice" },
        chat: { id: 200, type: "supergroup" },
        date: 0,
        text: "/help",
      });
      expect(a.handleGroupMessage).toHaveBeenCalled();
    });

    it("ignores group messages without mention or command", async () => {
      const a = makeBase();
      await a.handleTelegramMessage({
        message_id: 1,
        from: { id: 1, first_name: "Alice" },
        chat: { id: 200, type: "group" },
        date: 0,
        text: "just chatting",
      });
      expect(a.handleGroupMessage).not.toHaveBeenCalled();
    });
  });

  describe("handleCallbackQuery", () => {
    function makeCb() {
      const a = new TelegramAdapter() as any;
      a.transport = { answerCallbackQuery: vi.fn(async () => undefined) };
      a.gatewayClient = {
        replyPermission: vi.fn(async () => undefined),
        replyQuestion: vi.fn(async () => undefined),
      };
      return a;
    }

    it("returns when data missing", async () => {
      const a = makeCb();
      await a.handleCallbackQuery({ id: "x" });
      expect(a.transport.answerCallbackQuery).not.toHaveBeenCalled();
    });

    it("returns when chat id missing", async () => {
      const a = makeCb();
      await a.handleCallbackQuery({ id: "x", data: "perm:1:2" });
      expect(a.transport.answerCallbackQuery).not.toHaveBeenCalled();
    });

    it("perm action calls replyPermission", async () => {
      const a = makeCb();
      await a.handleCallbackQuery({
        id: "cb1",
        data: "perm:p1:opt1",
        message: { chat: { id: 100, type: "private" } },
      });
      expect(a.gatewayClient.replyPermission).toHaveBeenCalledWith({
        permissionId: "p1",
        optionId: "opt1",
      });
    });

    it("question action calls replyQuestion and clears pending", async () => {
      const a = makeCb();
      a.sessionMapper.setPendingQuestion("100", { questionId: "q1", sessionId: "s1" });
      await a.handleCallbackQuery({
        id: "cb1",
        data: "question:q1:Yes",
        message: { chat: { id: 100, type: "private" } },
      });
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q1",
        answers: [["Yes"]],
      });
      expect(a.sessionMapper.getPendingQuestion("100")).toBeUndefined();
    });

    it("unknown action falls through to verbose log", async () => {
      const a = makeCb();
      await a.handleCallbackQuery({
        id: "cb1",
        data: "unknown:x",
        message: { chat: { id: 100, type: "private" } },
      });
      expect(a.transport.answerCallbackQuery).toHaveBeenCalled();
    });
  });

  describe("handleP2PMessage dispatch", () => {
    function makeP2P() {
      const a = new TelegramAdapter() as any;
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
      a.sessionMapper.setPendingQuestion("c1", { questionId: "q-1", sessionId: "s-1" });
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

    it("dispatches pending project selection by number", async () => {
      const a = makeP2P();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setPendingSelection("c1", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      } as any);
      a.handlePendingSelection = vi.fn(async () => true);
      await a.handleP2PMessage("c1", "u1", "1");
      expect(a.handlePendingSelection).toHaveBeenCalled();
    });
  });

  describe("handleP2PCommand routing", () => {
    function makeCmd() {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = null;
      return a;
    }

    it("returns when command is null", async () => {
      const a = makeCmd();
      await a.handleP2PCommand("c1", null);
      expect(a.transport.sendText).not.toHaveBeenCalled();
    });

    it("returns when transport missing", async () => {
      const a = makeCmd();
      a.transport = null;
      await a.handleP2PCommand("c1", { command: "help", args: "" });
      expect(true).toBe(true);
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

    it("/new and /switch dispatch", async () => {
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
    it("handleP2PNewCommand prompts when no project selected", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleP2PNewCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PNewCommand calls createNewSessionForProject when project known", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleP2PNewCommand("c1");
      expect(a.createNewSessionForProject).toHaveBeenCalled();
    });

    it("handleP2PNewCommand cleans up existing temp before create", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x", engineType: "claude", projectId: "p",
      });
      a.sessionMapper.setTempSession("c1", {
        conversationId: "t1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.cleanupExpiredTempSession = vi.fn(async () => undefined);
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleP2PNewCommand("c1");
      expect(a.cleanupExpiredTempSession).toHaveBeenCalled();
    });

    it("handleP2PSwitchCommand prompts when no project selected", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleP2PSwitchCommand("c1");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/project");
    });

    it("handleP2PSwitchCommand calls showSessionListForProject", async () => {
      const a = new TelegramAdapter() as any;
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

  describe("showProjectList / showSessionListForProject / showGroupProjectList", () => {
    it("showProjectList sends list and stores pending", async () => {
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllProjects: vi.fn(async () => []) };
      await a.showProjectList("c1");
      expect(a.sessionMapper.getPendingSelection("c1")).toBeUndefined();
    });

    it("showProjectList no-ops without gatewayClient", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn() };
      await a.showProjectList("c1");
      expect(a.transport.sendText).not.toHaveBeenCalled();
    });

    it("showSessionListForProject filters by directory and stores pending", async () => {
      const a = new TelegramAdapter() as any;
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

    it("showGroupProjectList stores pending for group", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "a", directory: "/a", engineType: "claude" },
        ]),
      };
      await a.showGroupProjectList("g1");
      expect(a.sessionMapper.getPendingSelection("g1")?.type).toBe("project");
    });
  });

  describe("createNewSessionForProject / createTempSessionAndSend / queue / cleanup", () => {
    it("createNewSessionForProject stores temp session", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => ({ id: "s1", engineType: "claude" })),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.createNewSessionForProject(
        "c1",
        { directory: "/d", engineType: "claude", projectId: "p" },
        "alpha",
      );
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("s1");
    });

    it("createNewSessionForProject reports error", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => { throw new Error("nope"); }),
      };
      await a.createNewSessionForProject(
        "c1",
        { directory: "/d", projectId: "p" },
        "alpha",
      );
      expect(a.transport.sendText.mock.calls.at(-1)[1]).toContain("创建会话失败");
    });

    it("createTempSessionAndSend stores temp + enqueues message", async () => {
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
      await expect(a.enqueueP2PMessage("c1", "x")).resolves.toBeUndefined();
    });

    it("enqueueP2PMessage starts processing when not running", async () => {
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: true,
      });
      await a.processP2PQueue("c1");
      expect(a.sessionMapper.getTempSession("c1")?.processing).toBe(false);
    });

    it("processP2PQueue calls sendToEngineP2P when queue has items", async () => {
      const a = new TelegramAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: ["hi"], processing: false,
      });
      a.sendToEngineP2P = vi.fn(async () => undefined);
      await a.processP2PQueue("c1");
      expect(a.sendToEngineP2P).toHaveBeenCalled();
    });

    it("sendToEngineP2P bails when prerequisites missing", async () => {
      const a = new TelegramAdapter() as any;
      const t = { processing: true } as any;
      await a.sendToEngineP2P("c1", t, "hi");
      expect(t.processing).toBe(false);
    });

    it("cleanupExpiredTempSession deletes session and clears mapping", async () => {
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn() };
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("handleProjectSelection / handleSessionSelection / handlePendingSelection", () => {
    it("handleProjectSelection returns false on non-numeric input", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "abc", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection returns false on out-of-range index", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      const ok = await a.handleProjectSelection("c1", "5", {
        type: "project",
        projects: [{ id: "p1", name: "a", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleProjectSelection on valid index sets last project + shows sessions", async () => {
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      const ok = await a.handleSessionSelection("c1", "abc", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection returns false when pending lacks directory or projectId", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      const ok = await a.handleSessionSelection("c1", "1", {
        type: "session",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("handleSessionSelection on valid index binds temp session", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handleSessionSelection("c1", "1", {
        type: "session", directory: "/d", projectId: "p", projectName: "alpha",
        sessions: [{ id: "s1", title: "x", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      expect(a.sessionMapper.getTempSession("c1")?.conversationId).toBe("s1");
    });

    it("handlePendingSelection dispatches to project handler", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { listAllSessions: vi.fn(async () => []) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handlePendingSelection("c1", "u1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("handlePendingSelection dispatches to session handler", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await a.handlePendingSelection("c1", "u1", "1", {
        type: "session", directory: "/d", projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("handlePendingSelection returns false for unknown type", async () => {
      const a = new TelegramAdapter() as any;
      const ok = await a.handlePendingSelection("c1", "u1", "1", { type: "unknown" });
      expect(ok).toBe(false);
    });
  });

  describe("handleGroupMessage / handleGroupCommand", () => {
    it("handleGroupMessage shows /bind hint when no binding and unknown text", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleGroupMessage("g1", "hi");
      expect(a.transport.sendText.mock.calls[0][1]).toContain("/bind");
    });

    it("handleGroupMessage /help (no binding) sends help text", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      await a.handleGroupMessage("g1", "/help");
      expect(a.transport.sendText).toHaveBeenCalled();
    });

    it("handleGroupMessage /bind (no binding) calls showGroupProjectList", async () => {
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.showGroupProjectList = vi.fn(async () => undefined);
      await a.handleGroupMessage("g1", "/bind");
      expect(a.showGroupProjectList).toHaveBeenCalledWith("g1");
    });

    it("handleGroupMessage routes commands to handleGroupCommand when bound", async () => {
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
      a.transport = { sendText: vi.fn(async () => "") };
      a.gatewayClient = { replyQuestion: vi.fn(async () => undefined) };
      a.sessionMapper.createGroupBinding({
        chatId: "g1", conversationId: "s1", engineType: "claude",
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      });
      a.sessionMapper.setPendingQuestion("g1", { questionId: "q-1", sessionId: "s1" });
      await a.handleGroupMessage("g1", "an answer");
      expect(a.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["an answer"]],
      });
    });

    it("handleGroupMessage routes plain text to sendToEngine", async () => {
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
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
      const a = new TelegramAdapter() as any;
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

  describe("sendToEngine (group)", () => {
    it("returns silently when prerequisites missing", async () => {
      const a = new TelegramAdapter() as any;
      const binding = {
        chatId: "g1", conversationId: "s1", engineType: "claude" as const,
        directory: "/d", projectId: "p", ownerUserId: "u1",
        streamingSessions: new Map(), createdAt: Date.now(),
      };
      await expect(a.sendToEngine("g1", binding, "hi")).resolves.toBeUndefined();
    });
  });

  describe("gateway event handlers", () => {
    function makeGw() {
      const a = new TelegramAdapter() as any;
      a.transport = {
        sendText: vi.fn(async () => ""),
        sendMessageWithKeyboard: vi.fn(async () => undefined),
      };
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

    it("handlePermissionAsked sends inline keyboard when not auto-approved", () => {
      const a = makeGw();
      a.config = { ...a.config, autoApprovePermissions: false };
      a.gatewayClient = { replyPermission: vi.fn() };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1", engineType: "claude", directory: "/d", projectId: "p",
        lastActiveAt: Date.now(), messageQueue: [], processing: false,
      });
      a.handlePermissionAsked({
        id: "perm-1", sessionId: "conv-1", title: "Confirm?",
        options: [{ id: "ok", label: "OK" }, { id: "no", label: "No" }],
      });
      expect(a.transport.sendMessageWithKeyboard).toHaveBeenCalled();
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
      expect(a.transport.sendMessageWithKeyboard).toHaveBeenCalled();
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

    it("subscribeGatewayEvents wires callbacks", () => {
      const a = new TelegramAdapter() as any;
      const handlers: Record<string, (...args: unknown[]) => unknown> = {};
      a.gatewayClient = {
        on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => { handlers[event] = cb; }),
      };
      a.subscribeGatewayEvents();
      expect(Object.keys(handlers).sort()).toEqual([
        "message.part.updated",
        "message.updated",
        "permission.asked",
        "question.asked",
        "session.updated",
      ].sort());
    });
  });

  describe("webhook handling", () => {
    it("handleWebhookRequest rejects bad secret token", async () => {
      const a = new TelegramAdapter() as any;
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, webhookSecretToken: "secret" };
      const res = await a.handleWebhookRequest({
        method: "POST", headers: { "x-telegram-bot-api-secret-token": "bad" }, body: {},
      });
      expect(res.status).toBe(403);
    });

    it("handleWebhookRequest rejects non-POST", async () => {
      const a = new TelegramAdapter() as any;
      a.config = { ...DEFAULT_TELEGRAM_CONFIG };
      const res = await a.handleWebhookRequest({ method: "GET", headers: {}, body: null });
      expect(res.status).toBe(405);
    });

    it("handleWebhookRequest accepts valid POST and processes update", async () => {
      const a = new TelegramAdapter() as any;
      a.config = { ...DEFAULT_TELEGRAM_CONFIG };
      a.processUpdate = vi.fn(async () => undefined);
      const res = await a.handleWebhookRequest({
        method: "POST", headers: {}, body: { update_id: 1 },
      });
      expect(res.status).toBe(200);
      expect(a.processUpdate).toHaveBeenCalled();
    });
  });

  describe("setupWebhook", () => {
    it("registers route and calls transport.setWebhook", async () => {
      const a = new TelegramAdapter() as any;
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, webhookUrl: "https://x.com/wh", webhookSecretToken: "s" };
      const registerRoute = vi.fn();
      a.webhookServer = { registerRoute };
      a.transport = { setWebhook: vi.fn(async () => true) };
      await a.setupWebhook();
      expect(registerRoute).toHaveBeenCalledWith("/webhook/telegram", expect.any(Function));
      expect(a.transport.setWebhook).toHaveBeenCalledWith("https://x.com/wh", "s");
    });

    it("throws when setWebhook returns false", async () => {
      const a = new TelegramAdapter() as any;
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, webhookUrl: "https://x.com/wh" };
      a.transport = { setWebhook: vi.fn(async () => false) };
      await expect(a.setupWebhook()).rejects.toThrow(/Failed to set/);
    });

    it("returns silently when transport or webhookUrl missing", async () => {
      const a = new TelegramAdapter() as any;
      a.config = { ...DEFAULT_TELEGRAM_CONFIG, webhookUrl: "" };
      await expect(a.setupWebhook()).resolves.toBeUndefined();
    });
  });
});
