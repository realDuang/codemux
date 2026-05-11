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
  weixinIlinkLog: mockScopedLogger,
  getDefaultEngineFromSettings: vi.fn(() => "opencode"),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? process.cwd()),
  },
}));

import { WeixinIlinkAdapter } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-adapter";
import { DEFAULT_WEIXIN_ILINK_CONFIG } from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-types";

describe("WeixinIlinkAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getInfo", () => {
    it("reports stopped status with long-poll mode by default", () => {
      const adapter = new WeixinIlinkAdapter();
      const info = adapter.getInfo();
      expect(info.type).toBe("weixin-ilink");
      expect(info.status).toBe("stopped");
      expect(info.stats?.mode).toBe("long-poll");
      expect(info.stats?.connected).toBe(false);
    });
  });

  describe("start", () => {
    it("rejects when no botToken is configured", async () => {
      const adapter = new WeixinIlinkAdapter();
      await expect(
        adapter.start({
          type: "weixin-ilink",
          name: "WeChat iLink Bot",
          enabled: true,
          options: { ...DEFAULT_WEIXIN_ILINK_CONFIG },
        }),
      ).rejects.toThrow(/botToken/);
      expect(adapter.getInfo().status).toBe("error");
    });
  });

  describe("stop", () => {
    it("aborts the in-flight long-poll and cleans up state", async () => {
      const adapter = new WeixinIlinkAdapter() as any;

      const getUpdates = vi.fn(
        (_buf: string, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
              { once: true },
            );
          }),
      );

      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "token", accountId: "acct" };
      adapter.transport = {
        getUpdates,
      };
      adapter.gatewayClient = { disconnect: vi.fn() };
      adapter.streamingController = {};

      adapter.pollingActive = true;
      adapter.pollingGeneration = 1;
      const ac = new AbortController();
      adapter.pollAbortController = ac;
      adapter.pollingLoopPromise = adapter.pollingLoop(1, ac.signal);

      await Promise.resolve();
      await expect(adapter.stop()).resolves.toBeUndefined();

      expect(getUpdates).toHaveBeenCalled();
      expect(adapter.pollAbortController).toBeNull();
      expect(adapter.transport).toBeNull();
      expect(adapter.gatewayClient).toBeNull();
      expect(adapter.streamingController).toBeNull();
      expect(adapter.getInfo().status).toBe("stopped");
    });
  });

  describe("updateConfig", () => {
    it("restarts when botToken changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "old" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { botToken: "new" } });

      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("restarts when accountId changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "token", accountId: "a" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { accountId: "b" } });
      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("does not restart when only autoApprovePermissions changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "token" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { autoApprovePermissions: false } });
      expect(adapter.stop).not.toHaveBeenCalled();
      expect(adapter.start).not.toHaveBeenCalled();
    });

    it("does not restart when adapter is not running, even if token changes", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "stopped";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "old" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      adapter.start = vi.fn().mockResolvedValue(undefined);

      await adapter.updateConfig({ options: { botToken: "new" } });
      expect(adapter.stop).not.toHaveBeenCalled();
      expect(adapter.start).not.toHaveBeenCalled();
      expect(adapter.config.botToken).toBe("new");
    });
  });

  describe("logout", () => {
    it("exposes CLEARED_CREDENTIALS static with empty botToken/accountId", () => {
      expect(WeixinIlinkAdapter.CLEARED_CREDENTIALS).toEqual({
        botToken: "",
        accountId: "",
      });
    });

    it("from stopped state: clears bindings and credentials without calling stop()", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "stopped";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      const clearSpy = vi.spyOn(adapter.sessionMapper, "clearAllBindings");

      await adapter.logout();

      expect(adapter.stop).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(adapter.config.botToken).toBe("");
      expect(adapter.config.accountId).toBe("");
    });

    it("from running state: stops the adapter then wipes bindings + credentials", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);
      const clearSpy = vi.spyOn(adapter.sessionMapper, "clearAllBindings");

      await adapter.logout();

      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(adapter.config.botToken).toBe("");
      expect(adapter.config.accountId).toBe("");
    });
  });

  describe("handleSessionExpired", () => {
    it("calls logout, transitions to error, emits status.changed and auth.expired", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockResolvedValue(undefined);

      const events: Array<{ name: string; payload: any }> = [];
      adapter.on("status.changed", (s: any) => events.push({ name: "status.changed", payload: s }));
      adapter.on("auth.expired", (p: any) => events.push({ name: "auth.expired", payload: p }));

      await adapter.handleSessionExpired();

      expect(adapter.stop).toHaveBeenCalled();
      expect(adapter.status).toBe("error");
      expect(adapter.error).toMatch(/expired/i);
      // First emission must be status.changed("error"), then auth.expired
      const statusEvt = events.find((e) => e.name === "status.changed");
      const authEvt = events.find((e) => e.name === "auth.expired");
      expect(statusEvt?.payload).toBe("error");
      expect(authEvt?.payload.clearOptions).toEqual(
        WeixinIlinkAdapter.CLEARED_CREDENTIALS,
      );
      expect(authEvt?.payload.reason).toMatch(/expired/i);
    });

    it("still emits auth.expired even if logout() throws", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.status = "running";
      adapter.config = { ...DEFAULT_WEIXIN_ILINK_CONFIG, botToken: "tk", accountId: "acct" };
      adapter.stop = vi.fn().mockRejectedValue(new Error("stop failed"));

      const handler = vi.fn();
      adapter.on("auth.expired", handler);

      await adapter.handleSessionExpired();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(adapter.status).toBe("error");
    });
  });

  describe("isAbortError", () => {
    it("recognises errors with name=AbortError", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      expect(adapter.isAbortError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    });

    it("recognises errors whose message equals 'Aborted'", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      expect(adapter.isAbortError(new Error("Aborted"))).toBe(true);
    });

    it("returns false for non-error values and unrelated errors", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      expect(adapter.isAbortError(undefined)).toBe(false);
      expect(adapter.isAbortError(null)).toBe(false);
      expect(adapter.isAbortError("string")).toBe(false);
      expect(adapter.isAbortError(new Error("network failure"))).toBe(false);
    });
  });

  describe("extractText", () => {
    it("returns plain text from a type-1 item", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      const out = adapter.extractText({
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      });
      expect(out).toBe("hello");
    });

    it("renders [Image] / [Voice] / [File] / [Video] for non-text types", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      const out = adapter.extractText({
        item_list: [
          { type: 2 },
          { type: 3 },
          { type: 4, file_item: { filename: "doc.pdf" } },
          { type: 5 },
        ],
      });
      expect(out).toContain("[Image]");
      expect(out).toContain("[Voice]");
      expect(out).toContain("[File: doc.pdf]");
      expect(out).toContain("[Video]");
    });

    it("uses voice_item.text when present (transcribed voice)", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      const out = adapter.extractText({
        item_list: [{ type: 3, voice_item: { text: "transcribed" } }],
      });
      expect(out).toBe("transcribed");
    });

    it("falls back to 'unknown' filename when missing", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      const out = adapter.extractText({ item_list: [{ type: 4 }] });
      expect(out).toContain("[File: unknown]");
    });

    it("renders [Unknown message type: X] for unknown item types", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      const out = adapter.extractText({ item_list: [{ type: 99 }] });
      expect(out).toContain("[Unknown message type: 99]");
    });

    it("returns empty string when item_list is empty or undefined", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      expect(adapter.extractText({ item_list: [] })).toBe("");
      expect(adapter.extractText({})).toBe("");
    });

    it("joins multiple parts with newline", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      const out = adapter.extractText({
        item_list: [
          { type: 1, text_item: { text: "line1" } },
          { type: 1, text_item: { text: "line2" } },
        ],
      });
      expect(out).toBe("line1\nline2");
    });
  });

  describe("isTempSessionExpired", () => {
    it("returns false when within TTL", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      expect(
        adapter.isTempSessionExpired({ lastActiveAt: Date.now() - 1000 }),
      ).toBe(false);
    });

    it("returns true when past TTL", () => {
      const adapter = new WeixinIlinkAdapter() as any;
      expect(
        adapter.isTempSessionExpired({
          lastActiveAt: Date.now() - 999_999_999,
        }),
      ).toBe(true);
    });
  });

  describe("handleProjectSelection", () => {
    function makeAdapterWithTransport() {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => "id"), sendMarkdown: vi.fn(async () => "") };
      adapter.gatewayClient = {
        listSessions: vi.fn(async () => ({ items: [] })),
        listAllSessions: vi.fn(async () => []),
      };
      return adapter;
    }

    it("returns false on non-numeric input", async () => {
      const adapter = makeAdapterWithTransport();
      const ok = await adapter.handleProjectSelection("c1", "abc", {
        type: "project",
        projects: [{ id: "p1", name: "alpha", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("returns false on out-of-range index", async () => {
      const adapter = makeAdapterWithTransport();
      const ok = await adapter.handleProjectSelection("c1", "5", {
        type: "project",
        projects: [{ id: "p1", name: "alpha", directory: "/a", engineType: "claude" }],
      });
      expect(ok).toBe(false);
    });

    it("on valid index, sets last project and shows session list", async () => {
      const adapter = makeAdapterWithTransport();
      adapter.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await adapter.handleProjectSelection("c1", "1", {
        type: "project",
        projects: [
          { id: "p1", name: "alpha", directory: "/foo/alpha", engineType: "claude" },
        ],
      });
      expect(ok).toBe(true);
      expect(adapter.sessionMapper.getP2PChat("c1")?.lastSelectedProject).toMatchObject({
        directory: "/foo/alpha",
        engineType: "claude",
        projectId: "p1",
      });
      expect(adapter.transport.sendMarkdown).toHaveBeenCalled();
    });
  });

  describe("handleSessionSelection", () => {
    it("returns false when transport is null", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = null;
      expect(
        await adapter.handleSessionSelection("c1", "1", {
          type: "session",
          directory: "/d",
          projectId: "p",
          sessions: [{ id: "s1", title: "x", engineType: "claude" }],
        }),
      ).toBe(false);
    });

    it("returns false when pending lacks directory or projectId", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      expect(
        await adapter.handleSessionSelection("c1", "1", {
          type: "session",
          sessions: [{ id: "s1", engineType: "claude" }],
        }),
      ).toBe(false);
    });

    it("returns false on out-of-range index", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      expect(
        await adapter.handleSessionSelection("c1", "5", {
          type: "session",
          directory: "/d",
          projectId: "p",
          sessions: [{ id: "s1", engineType: "claude" }],
        }),
      ).toBe(false);
    });

    it("on valid index, registers temp session and announces switch", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      adapter.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await adapter.handleSessionSelection("c1", "1", {
        type: "session",
        directory: "/d",
        projectId: "p",
        sessions: [{ id: "sess-ABCDEFGH", title: "Hi", engineType: "claude" }],
      });
      expect(ok).toBe(true);
      const temp = adapter.sessionMapper.getTempSession("c1");
      expect(temp.conversationId).toBe("sess-ABCDEFGH");
      expect(adapter.transport.sendMarkdown).toHaveBeenCalled();
      const arg = adapter.transport.sendMarkdown.mock.calls[0][1] as string;
      expect(arg).toContain("sess-ABC");
    });
  });

  describe("handlePendingSelection dispatch", () => {
    it("dispatches to project selection for type=project", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      adapter.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await adapter.handlePendingSelection("c1", "1", {
        type: "project",
        projects: [{ id: "p1", name: "n", directory: "/d", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("dispatches to session selection for type=session", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      adapter.sessionMapper.getOrCreateP2PChat("c1", "u1");
      const ok = await adapter.handlePendingSelection("c1", "1", {
        type: "session",
        directory: "/d",
        projectId: "p",
        sessions: [{ id: "s1", engineType: "claude" }],
      });
      expect(ok).toBe(true);
    });

    it("returns false for unknown selection type", async () => {
      const adapter = new WeixinIlinkAdapter() as any;
      const ok = await adapter.handlePendingSelection("c1", "1", { type: "unknown" });
      expect(ok).toBe(false);
    });
  });

  describe("handleInboundMessage", () => {
    function makeInboundAdapter() {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { setContextToken: vi.fn(), sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      adapter.gatewayClient = {
        replyQuestion: vi.fn(async () => undefined),
        listProjects: vi.fn(async () => []),
      };
      // Don't actually run the routing — short-circuit handleP2PMessage
      adapter.handleP2PMessage = vi.fn(async () => undefined);
      return adapter;
    }

    it("ignores messages with no from_user_id", async () => {
      const adapter = makeInboundAdapter();
      await adapter.handleInboundMessage({});
      expect(adapter.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("dedupes by message_id", async () => {
      const adapter = makeInboundAdapter();
      const msg = {
        from_user_id: "u1",
        message_id: 42,
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      };
      await adapter.handleInboundMessage(msg);
      await adapter.handleInboundMessage(msg);
      expect(adapter.handleP2PMessage).toHaveBeenCalledTimes(1);
    });

    it("caches context_token on transport when present", async () => {
      const adapter = makeInboundAdapter();
      await adapter.handleInboundMessage({
        from_user_id: "u1",
        message_id: 1,
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "hi" } }],
      });
      expect(adapter.transport.setContextToken).toHaveBeenCalledWith("u1", "ctx");
    });

    it("skips messages with no extractable text", async () => {
      const adapter = makeInboundAdapter();
      await adapter.handleInboundMessage({
        from_user_id: "u1",
        message_id: 1,
        item_list: [],
      });
      expect(adapter.handleP2PMessage).not.toHaveBeenCalled();
    });

    it("forwards extracted text to handleP2PMessage", async () => {
      const adapter = makeInboundAdapter();
      await adapter.handleInboundMessage({
        from_user_id: "u1",
        message_id: 1,
        item_list: [{ type: 1, text_item: { text: "ping" } }],
      });
      expect(adapter.handleP2PMessage).toHaveBeenCalledWith("u1", "u1", "ping");
    });
  });

  describe("handleP2PMessage dispatch", () => {
    function makeP2P() {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      adapter.gatewayClient = {
        replyQuestion: vi.fn(async () => undefined),
        listAllProjects: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
      };
      return adapter;
    }

    it("delegates parseable command to handleP2PCommand and clears pending", async () => {
      const adapter = makeP2P();
      adapter.sessionMapper.setPendingSelection("c1", { type: "project", projects: [] });
      adapter.handleP2PCommand = vi.fn(async () => undefined);
      await adapter.handleP2PMessage("c1", "u1", "/help");
      expect(adapter.handleP2PCommand).toHaveBeenCalled();
      expect(adapter.sessionMapper.getPendingSelection("c1")).toBeUndefined();
    });

    it("freeform answer routes to pending question via gatewayClient.replyQuestion", async () => {
      const adapter = makeP2P();
      adapter.sessionMapper.setPendingQuestion("c1", { questionId: "q-1" });
      await adapter.handleP2PMessage("c1", "u1", "my answer");
      expect(adapter.gatewayClient.replyQuestion).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: [["my answer"]],
      });
      expect(adapter.sessionMapper.getPendingQuestion("c1")).toBeUndefined();
    });

    it("falls back to showProjectList when no project / session / temp is selected", async () => {
      const adapter = makeP2P();
      adapter.showProjectList = vi.fn(async () => undefined);
      await adapter.handleP2PMessage("c1", "u1", "hi");
      expect(adapter.showProjectList).toHaveBeenCalledWith("c1");
    });

    it("enqueues to running temp session", async () => {
      const adapter = makeP2P();
      adapter.sessionMapper.getOrCreateP2PChat("c1", "u1");
      adapter.sessionMapper.setTempSession("c1", {
        conversationId: "x",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: true,
      });
      adapter.enqueueP2PMessage = vi.fn(async () => undefined);
      await adapter.handleP2PMessage("c1", "u1", "hi");
      expect(adapter.enqueueP2PMessage).toHaveBeenCalledWith("c1", "hi");
    });

    it("creates temp session if last project selected and no temp exists", async () => {
      const adapter = makeP2P();
      adapter.sessionMapper.getOrCreateP2PChat("c1", "u1");
      adapter.sessionMapper.setP2PLastProject("c1", {
        directory: "/d",
        engineType: "claude",
        projectId: "p",
      });
      adapter.createTempSessionAndSend = vi.fn(async () => undefined);
      await adapter.handleP2PMessage("c1", "u1", "hi");
      expect(adapter.createTempSessionAndSend).toHaveBeenCalled();
    });
  });

  describe("handleP2PCommand routing", () => {
    function makeCmdAdapter() {
      const adapter = new WeixinIlinkAdapter() as any;
      adapter.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      adapter.gatewayClient = {
        cancelMessage: vi.fn(async () => undefined),
        setMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        listModels: vi.fn(async () => ({ models: [] })),
        listMessages: vi.fn(async () => []),
        listAllProjects: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
      };
      return adapter;
    }

    it("returns early when command is null or transport missing", async () => {
      const a = makeCmdAdapter();
      await a.handleP2PCommand("c1", null);
      a.transport = null;
      await a.handleP2PCommand("c1", { command: "help", args: "" });
      expect(true).toBe(true);
    });

    it("dispatches /help to send help text", async () => {
      const a = makeCmdAdapter();
      a.gatewayClient = null; // skip session-ops shortcut
      await a.handleP2PCommand("c1", { command: "help", args: "" });
      expect(a.transport.sendMarkdown).toHaveBeenCalled();
    });

    it("dispatches /project to showProjectList", async () => {
      const a = makeCmdAdapter();
      a.gatewayClient = null;
      a.showProjectList = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "project", args: "" });
      expect(a.showProjectList).toHaveBeenCalled();
    });

    it("dispatches /new and /switch", async () => {
      const a = makeCmdAdapter();
      a.gatewayClient = null;
      a.handleNewCommand = vi.fn(async () => undefined);
      a.handleSwitchCommand = vi.fn(async () => undefined);
      await a.handleP2PCommand("c1", { command: "new", args: "" });
      await a.handleP2PCommand("c1", { command: "switch", args: "" });
      expect(a.handleNewCommand).toHaveBeenCalled();
      expect(a.handleSwitchCommand).toHaveBeenCalled();
    });

    it("falls through to unknown-command warning for unsupported commands", async () => {
      const a = makeCmdAdapter();
      a.gatewayClient = null;
      await a.handleP2PCommand("c1", { command: "foo", args: "" });
      expect(a.transport.sendMarkdown.mock.calls.at(-1)[1]).toContain("未知命令");
    });
  });

  describe("handleNewCommand / handleSwitchCommand guards", () => {
    it("handleNewCommand prompts when no project is selected", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      await a.handleNewCommand("c1");
      expect(a.transport.sendMarkdown.mock.calls[0][1]).toContain("/project");
    });

    it("handleSwitchCommand prompts when no project is selected", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      await a.handleSwitchCommand("c1");
      expect(a.transport.sendMarkdown.mock.calls[0][1]).toContain("/project");
    });

    it("handleNewCommand creates a new session under the last project", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x",
        engineType: "claude",
        projectId: "p",
      });
      a.createNewSessionForProject = vi.fn(async () => undefined);
      await a.handleNewCommand("c1");
      expect(a.createNewSessionForProject).toHaveBeenCalled();
    });

    it("handleSwitchCommand calls showSessionListForProject", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setP2PLastProject("c1", {
        directory: "/foo/x",
        engineType: "claude",
        projectId: "p",
      });
      a.showSessionListForProject = vi.fn(async () => undefined);
      await a.handleSwitchCommand("c1");
      expect(a.showSessionListForProject).toHaveBeenCalled();
    });
  });

  describe("showProjectList / showSessionListForProject", () => {
    it("showProjectList sends list and stores pending selection", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.gatewayClient = {
        listAllProjects: vi.fn(async () => [
          { id: "p1", name: "alpha", directory: "/a", engineType: "claude" },
        ]),
      };
      await a.showProjectList("c1");
      expect(a.transport.sendMarkdown).toHaveBeenCalled();
      expect(a.sessionMapper.getPendingSelection("c1")?.type).toBe("project");
    });

    it("showProjectList does not store pending when list is empty", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.gatewayClient = { listAllProjects: vi.fn(async () => []) };
      await a.showProjectList("c1");
      expect(a.sessionMapper.getPendingSelection("c1")).toEqual({ type: "project", projects: [] });
    });

    it("showSessionListForProject filters sessions by directory and stores pending", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
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
      expect(a.transport.sendMarkdown).toHaveBeenCalled();
      const pending = a.sessionMapper.getPendingSelection("c1");
      expect(pending?.type).toBe("session");
      expect(pending?.sessions).toHaveLength(1);
    });
  });

  describe("createNewSessionForProject / createTempSessionAndSend", () => {
    it("createNewSessionForProject sets temp session and notifies user on success", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => ({ id: "sess-1", engineType: "claude" })),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      await a.createNewSessionForProject(
        "c1",
        { directory: "/d", engineType: "claude", projectId: "p" },
        "proj",
      );
      const t = a.sessionMapper.getTempSession("c1");
      expect(t?.conversationId).toBe("sess-1");
      expect(a.transport.sendMarkdown.mock.calls.at(-1)[1]).toContain("proj");
    });

    it("createNewSessionForProject reports error message on failure", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => {
          throw new Error("boom");
        }),
      };
      await a.createNewSessionForProject(
        "c1",
        { directory: "/d", projectId: "p" },
        "proj",
      );
      expect(a.transport.sendMarkdown.mock.calls.at(-1)[1]).toContain("创建会话失败");
    });

    it("createTempSessionAndSend stores temp + enqueues message", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
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
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.gatewayClient = {
        createSession: vi.fn(async () => {
          throw new Error("nope");
        }),
      };
      await a.createTempSessionAndSend(
        "c1",
        { directory: "/d", projectId: "p" },
        "hi",
      );
      expect(a.transport.sendMarkdown.mock.calls.at(-1)[1]).toContain("创建临时会话失败");
    });
  });

  describe("enqueueP2PMessage / processP2PQueue / cleanupExpiredTempSession", () => {
    it("enqueueP2PMessage no-ops when there is no temp session", async () => {
      const a = new WeixinIlinkAdapter() as any;
      await expect(a.enqueueP2PMessage("c1", "x")).resolves.toBeUndefined();
    });

    it("enqueueP2PMessage starts processing when not already running", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      });
      a.processP2PQueue = vi.fn(async () => undefined);
      await a.enqueueP2PMessage("c1", "msg");
      expect(a.processP2PQueue).toHaveBeenCalledWith("c1");
    });

    it("processP2PQueue clears processing when queue is empty", async () => {
      const a = new WeixinIlinkAdapter() as any;
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
      await a.processP2PQueue("c1");
      expect(a.sessionMapper.getTempSession("c1")?.processing).toBe(false);
    });

    it("cleanupExpiredTempSession deletes session and clears mapping", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn(async () => undefined) };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      });
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).toHaveBeenCalledWith("x");
      expect(a.sessionMapper.getTempSession("c1")).toBeUndefined();
    });

    it("cleanupExpiredTempSession swallows deletion errors", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.gatewayClient = {
        deleteSession: vi.fn(async () => {
          throw new Error("not found");
        }),
      };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "x",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      });
      await expect(a.cleanupExpiredTempSession("c1")).resolves.toBeUndefined();
      expect(a.sessionMapper.getTempSession("c1")).toBeUndefined();
    });

    it("cleanupExpiredTempSession is no-op without a temp session", async () => {
      const a = new WeixinIlinkAdapter() as any;
      a.gatewayClient = { deleteSession: vi.fn() };
      await a.cleanupExpiredTempSession("c1");
      expect(a.gatewayClient.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("event handlers (gateway)", () => {
    function makeGwAdapter() {
      const a = new WeixinIlinkAdapter() as any;
      a.transport = { sendText: vi.fn(async () => ""), sendMarkdown: vi.fn(async () => "") };
      a.streamingController = {
        applyPart: vi.fn(),
        finalize: vi.fn(),
      };
      return a;
    }

    it("handleMessageCompleted skips non-assistant or non-completed messages", () => {
      const a = makeGwAdapter();
      a.finalizeP2PStreaming = vi.fn(async () => undefined);
      a.handleMessageCompleted("conv-1", { role: "user", time: { completed: 1 } });
      a.handleMessageCompleted("conv-1", { role: "assistant", time: {} });
      expect(a.finalizeP2PStreaming).not.toHaveBeenCalled();
    });

    it("handleMessageCompleted warns when no P2P chat is mapped", () => {
      const a = makeGwAdapter();
      a.finalizeP2PStreaming = vi.fn();
      a.handleMessageCompleted("nope", { role: "assistant", time: { completed: 1 } });
      expect(a.finalizeP2PStreaming).not.toHaveBeenCalled();
    });

    it("handleMessageCompleted routes mapped completion to finalizeP2PStreaming", () => {
      const a = makeGwAdapter();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      });
      a.finalizeP2PStreaming = vi.fn(async () => undefined);
      a.handleMessageCompleted("conv-1", { role: "assistant", time: { completed: 1 } });
      expect(a.finalizeP2PStreaming).toHaveBeenCalled();
    });

    it("handlePartUpdated forwards to streamingController.applyPart", () => {
      const a = makeGwAdapter();
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
        streamingSession: { completed: false },
      });
      a.handlePartUpdated("conv-1", { type: "text", text: "x" });
      expect(a.streamingController.applyPart).toHaveBeenCalled();
    });

    it("handlePartUpdated no-ops when no streaming session is active", () => {
      const a = makeGwAdapter();
      a.handlePartUpdated("missing", { type: "text", text: "x" });
      expect(a.streamingController.applyPart).not.toHaveBeenCalled();
    });

    it("handlePermissionAsked auto-approves when configured + accept option exists", () => {
      const a = makeGwAdapter();
      a.config = { ...a.config, autoApprovePermissions: true };
      a.gatewayClient = { replyPermission: vi.fn() };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      });
      a.handlePermissionAsked({
        id: "perm-1",
        sessionId: "conv-1",
        title: "do it?",
        options: [{ id: "ok", type: "accept", label: "Allow" }],
      });
      expect(a.gatewayClient.replyPermission).toHaveBeenCalledWith({
        permissionId: "perm-1",
        optionId: "ok",
      });
    });

    it("handlePermissionAsked sends a numbered prompt when not auto-approving", () => {
      const a = makeGwAdapter();
      a.config = { ...a.config, autoApprovePermissions: false };
      a.sessionMapper.getOrCreateP2PChat("c1", "u1");
      a.sessionMapper.setTempSession("c1", {
        conversationId: "conv-1",
        engineType: "claude",
        directory: "/d",
        projectId: "p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
      });
      a.handlePermissionAsked({
        id: "perm-1",
        sessionId: "conv-1",
        title: "do it?",
        options: [{ id: "no", label: "Deny" }, { id: "yes", label: "OK" }],
      });
      expect(a.transport.sendMarkdown).toHaveBeenCalled();
      const sent = a.transport.sendMarkdown.mock.calls[0][1] as string;
      expect(sent).toContain("权限请求");
      expect(sent).toContain("1.");
    });

    it("handlePermissionAsked drops events not mapped to a chat", () => {
      const a = makeGwAdapter();
      a.handlePermissionAsked({
        id: "perm-1",
        sessionId: "missing",
        options: [{ id: "ok" }],
      });
      expect(a.transport.sendMarkdown).not.toHaveBeenCalled();
    });
  });
});
