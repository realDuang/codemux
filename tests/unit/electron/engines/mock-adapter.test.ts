// ============================================================================
// Unit Tests — MockEngineAdapter
// ============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockEngineAdapter } from "../../../../electron/main/engines/mock-adapter";
import type {
  UnifiedSession,
  UnifiedMessage,
  TextPart,
  ToolPart,
  ReasoningPart,
} from "../../../../src/types/unified";

describe("MockEngineAdapter", () => {
  let adapter: MockEngineAdapter;

  beforeEach(() => {
    adapter = new MockEngineAdapter({ engineType: "opencode", name: "Test OpenCode" });
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe("constructor", () => {
    it("uses provided name", () => {
      const a = new MockEngineAdapter({ engineType: "claude", name: "My Claude" });
      expect(a.getInfo().name).toBe("My Claude");
    });

    it("uses default name when name is omitted", () => {
      const a = new MockEngineAdapter({ engineType: "copilot" });
      expect(a.getInfo().name).toBe("Mock copilot");
    });

    it("stores engineType correctly", () => {
      const a = new MockEngineAdapter({ engineType: "codex" });
      expect(a.engineType).toBe("codex");
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("starts, stops and reports health correctly", async () => {
      const events: string[] = [];
      adapter.on("status.changed", (data) => events.push(data.status));

      expect(await adapter.healthCheck()).toBe(false);

      await adapter.start();
      expect(adapter.getStatus()).toBe("running");
      expect(events).toContain("starting");
      expect(events).toContain("running");
      expect(await adapter.healthCheck()).toBe(true);

      await adapter.stop();
      expect(adapter.getStatus()).toBe("stopped");
      expect(events).toContain("stopped");
      expect(await adapter.healthCheck()).toBe(false);
    });

    it("emits starting status before running on start", async () => {
      const events: string[] = [];
      adapter.on("status.changed", (data) => events.push(data.status));
      await adapter.start();
      expect(events[0]).toBe("starting");
      expect(events[1]).toBe("running");
    });

    it("returns correct engine info", async () => {
      await adapter.start();
      const info = adapter.getInfo();
      expect(info.type).toBe("opencode");
      expect(info.name).toBe("Test OpenCode");
      expect(info.version).toBe("1.0.0-mock");
      expect(info.status).toBe("running");
      expect(info.capabilities).toBeDefined();
      expect(info.authMethods).toBeDefined();
    });

    it("getInfo reflects current status", async () => {
      expect(adapter.getInfo().status).toBe("stopped");
      await adapter.start();
      expect(adapter.getInfo().status).toBe("running");
    });
  });

  // ---------------------------------------------------------------------------
  // Capabilities & Auth
  // ---------------------------------------------------------------------------

  describe("capabilities", () => {
    it("returns all expected capability flags", () => {
      const caps = adapter.getCapabilities();
      expect(caps.providerModelHierarchy).toBe(false);
      expect(caps.dynamicModes).toBe(true);
      expect(caps.messageCancellation).toBe(true);
      expect(caps.permissionAlways).toBe(true);
      expect(caps.imageAttachment).toBe(false);
      expect(caps.loadSession).toBe(true);
      expect(caps.listSessions).toBe(true);
      expect(caps.modelSwitchable).toBe(true);
      expect(caps.customModelInput).toBe(false);
      expect(caps.messageEnqueue).toBe(false);
      expect(caps.slashCommands).toBe(false);
      expect(caps.availableModes).toHaveLength(2);
    });

    it("returns empty auth methods", () => {
      expect(adapter.getAuthMethods()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  describe("sessions", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("creates, emits events, and retrieves sessions by ID", async () => {
      let emitted: UnifiedSession | null = null;
      adapter.on("session.created", (data) => {
        emitted = data.session;
      });

      const created = await adapter.createSession("/test/project");
      expect(created.id).toBeTruthy();
      expect(created.engineType).toBe("opencode");
      expect(created.directory).toBe("/test/project");
      expect(created.title).toBe("New Session");

      expect(emitted).not.toBeNull();
      expect(emitted!.id).toBe(created.id);

      const found = await adapter.getSession(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);

      expect(await adapter.getSession("nonexistent")).toBeNull();
    });

    it("sets time.created and time.updated on creation", async () => {
      const before = Date.now();
      const session = await adapter.createSession("/test/dir");
      const after = Date.now();
      expect(session.time.created).toBeGreaterThanOrEqual(before);
      expect(session.time.created).toBeLessThanOrEqual(after);
      expect(session.time.updated).toBe(session.time.created);
    });

    it("lists, filters, and deletes sessions", async () => {
      await adapter.createSession("/test/project-a");
      await adapter.createSession("/test/project-b");

      const all = await adapter.listSessions();
      expect(all).toHaveLength(2);

      const filtered = await adapter.listSessions("/test/project-a");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].directory).toBe("/test/project-a");

      const filteredMissing = await adapter.listSessions("/does/not/exist");
      expect(filteredMissing).toHaveLength(0);

      await adapter.deleteSession(all[0].id);
      expect(await adapter.listSessions()).toHaveLength(1);
    });

    it("deleteSession also removes messages, models, and modes", async () => {
      const session = await adapter.createSession("/test/dir");
      await adapter.setModel(session.id, "mock/fast-model");
      await adapter.setMode(session.id, "plan");
      await adapter.sendMessage(session.id, [{ type: "text", text: "hello" }]);

      await adapter.deleteSession(session.id);

      expect(await adapter.getSession(session.id)).toBeNull();
      expect(await adapter.listMessages(session.id)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Messages — instant mode (default)
  // ---------------------------------------------------------------------------

  describe("messages — instant mode", () => {
    let sessionId: string;

    beforeEach(async () => {
      await adapter.start();
      const session = await adapter.createSession("/test/project");
      sessionId = session.id;
    });

    it.each([
      ["Hello", "This is a mock response to: Hello"],
      ["2+2", "The answer is 4"],
      ["10 * 3", "The answer is 30"],
      ["100 / 4", "The answer is 25"],
      ["5 - 3", "The answer is 2"],
    ])("sends message and handles expression '%s'", async (input, expected) => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: input },
      ]);
      expect(response.role).toBe("assistant");
      expect((response.parts[0] as TextPart).text).toBe(expected);
    });

    it("handles division by zero (NaN) — falls back to echo", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "5 / 0" },
      ]);
      // NaN result means it falls through to echo
      expect((response.parts[0] as TextPart).text).toBe(
        "This is a mock response to: 5 / 0",
      );
    });

    it("handles empty message text", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "" },
      ]);
      expect((response.parts[0] as TextPart).text).toBe(
        "This is a mock response to an empty message.",
      );
    });

    it("handles content array with no text parts", async () => {
      const response = await adapter.sendMessage(sessionId, []);
      expect((response.parts[0] as TextPart).text).toBe(
        "This is a mock response to an empty message.",
      );
    });

    it("stores messages, emits events, updates session title", async () => {
      const events: string[] = [];
      adapter.on("message.part.updated", () => events.push("part"));
      adapter.on("message.updated", (data) =>
        events.push(`message:${data.message.role}`),
      );

      await adapter.sendMessage(sessionId, [
        { type: "text", text: "Fix the authentication bug" },
      ]);

      const messages = await adapter.listMessages(sessionId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");

      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain("part");
      expect(events).toContain("message:user");
      expect(events).toContain("message:assistant");

      const session = await adapter.getSession(sessionId);
      expect(session!.title).toBe("Fix the authentication bug");

      expect(await adapter.listMessages("nonexistent")).toEqual([]);
    });

    it("does not overwrite title when session title is not 'New Session'", async () => {
      // First message sets the title
      await adapter.sendMessage(sessionId, [
        { type: "text", text: "First message sets title" },
      ]);
      const afterFirst = await adapter.getSession(sessionId);
      expect(afterFirst!.title).toBe("First message sets title");

      // Second message should NOT overwrite the title
      await adapter.sendMessage(sessionId, [
        { type: "text", text: "Second message should not change title" },
      ]);
      const afterSecond = await adapter.getSession(sessionId);
      expect(afterSecond!.title).toBe("First message sets title");
    });

    it("does not update title when userText is empty", async () => {
      await adapter.sendMessage(sessionId, [{ type: "text", text: "" }]);
      const session = await adapter.getSession(sessionId);
      expect(session!.title).toBe("New Session");
    });

    it("truncates title to 50 chars for long input", async () => {
      const longText = "A".repeat(100);
      await adapter.sendMessage(sessionId, [{ type: "text", text: longText }]);
      const session = await adapter.getSession(sessionId);
      expect(session!.title).toHaveLength(50);
    });

    it("emits session.updated when session exists", async () => {
      let sessionUpdated = false;
      adapter.on("session.updated", () => {
        sessionUpdated = true;
      });
      await adapter.sendMessage(sessionId, [{ type: "text", text: "hi" }]);
      await new Promise((r) => setTimeout(r, 50));
      expect(sessionUpdated).toBe(true);
    });

    it("respects options.mode and options.modelId", async () => {
      const response = await adapter.sendMessage(
        sessionId,
        [{ type: "text", text: "test" }],
        { mode: "plan", modelId: "mock/fast-model" },
      );
      expect(response.mode).toBe("plan");
      expect(response.modelId).toBe("mock/fast-model");

      const messages = await adapter.listMessages(sessionId);
      const userMsg = messages[0];
      expect(userMsg.mode).toBe("plan");
      expect(userMsg.modelId).toBe("mock/fast-model");
    });

    it("defaults to mock/test-model when no modelId provided", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "test" },
      ]);
      expect(response.modelId).toBe("mock/test-model");
    });

    it("response includes token counts and cost", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "hello" },
      ]);
      expect(response.tokens).toBeDefined();
      expect(response.tokens!.input).toBeGreaterThanOrEqual(0);
      expect(response.tokens!.output).toBeGreaterThan(0);
      expect(response.cost).toBe(0);
    });

    it("getHistoricalMessages returns empty array", async () => {
      const result = await adapter.getHistoricalMessages();
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // cancelMessage
  // ---------------------------------------------------------------------------

  describe("cancelMessage", () => {
    it("is a no-op when no pending abort exists", async () => {
      await adapter.start();
      const session = await adapter.createSession("/test/dir");
      // Should not throw
      await expect(adapter.cancelMessage(session.id)).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Slow response mode
  // ---------------------------------------------------------------------------

  describe("slow response mode", () => {
    let sessionId: string;

    beforeEach(async () => {
      await adapter.start();
      const session = await adapter.createSession("/test/project");
      sessionId = session.id;
    });

    it("completes normally after delay", async () => {
      adapter.setSlowMode(50);
      const events: Array<{ role: string; error?: string }> = [];
      adapter.on("message.updated", (data) =>
        events.push({ role: data.message.role, error: data.message.error }),
      );
      adapter.on("message.part.updated", () =>
        events.push({ role: "part" }),
      );

      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "slow test" },
      ]);

      expect(response.role).toBe("assistant");
      expect(response.error).toBeUndefined();
      // session.updated should have been emitted
      const textPart = response.parts[0] as TextPart;
      expect(textPart.text).toContain("slow test");
    });

    it("emits in-progress message before completion", async () => {
      adapter.setSlowMode(200);
      const inProgressMessages: UnifiedMessage[] = [];
      adapter.on("message.updated", (data) => {
        if (!data.message.time.completed) {
          inProgressMessages.push(data.message);
        }
      });

      const responsePromise = adapter.sendMessage(sessionId, [
        { type: "text", text: "slow" },
      ]);

      // Give time for in-progress events to fire
      await new Promise((r) => setTimeout(r, 30));
      expect(inProgressMessages.length).toBeGreaterThan(0);
      expect(inProgressMessages[0].role).toBe("assistant");

      await responsePromise;
    });

    it("cancels mid-generation and returns Cancelled error", async () => {
      adapter.setSlowMode(5000);
      const cancelledMessages: UnifiedMessage[] = [];
      adapter.on("message.updated", (data) => {
        if (data.message.error === "Cancelled") {
          cancelledMessages.push(data.message);
        }
      });

      const responsePromise = adapter.sendMessage(sessionId, [
        { type: "text", text: "cancel me" },
      ]);

      // Wait a tick then cancel
      await new Promise((r) => setTimeout(r, 30));
      await adapter.cancelMessage(sessionId);

      const result = await responsePromise;
      expect(result.error).toBe("Cancelled");
      expect(result.parts).toEqual([]);
      expect(cancelledMessages.length).toBeGreaterThan(0);
    });

    it("session.updated is not emitted when session does not exist in slow mode", async () => {
      adapter.setSlowMode(50);
      let sessionUpdated = false;
      adapter.on("session.updated", () => {
        sessionUpdated = true;
      });

      // Send without a valid session (simulate missing session by not using the real sessionId)
      // We inject the message directly to a non-existent session
      const response = await adapter.sendMessage("nonexistent-session", [
        { type: "text", text: "test" },
      ]);

      expect(response.role).toBe("assistant");
      await new Promise((r) => setTimeout(r, 100));
      expect(sessionUpdated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming mode
  // ---------------------------------------------------------------------------

  describe("streaming mode", () => {
    let sessionId: string;

    beforeEach(async () => {
      await adapter.start();
      const session = await adapter.createSession("/test/project");
      sessionId = session.id;
    });

    it("completes full stream with reasoning, tool, and text parts", async () => {
      adapter.setStreamingMode(true, 5, 2);

      const partUpdates: string[] = [];
      adapter.on("message.part.updated", (data) => {
        partUpdates.push((data.part as { type: string }).type);
      });

      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "2+2" },
      ]);

      expect(response.role).toBe("assistant");
      expect(response.error).toBeUndefined();

      // Should have emitted reasoning parts, tool parts, and text parts
      expect(partUpdates).toContain("reasoning");
      expect(partUpdates).toContain("tool");
      expect(partUpdates).toContain("text");

      // Final message has all parts
      expect(response.parts.length).toBeGreaterThan(0);
    }, 10000);

    it("completes with toolCount=0 (no tool parts emitted)", async () => {
      adapter.setStreamingMode(true, 5, 0);

      const partTypes: string[] = [];
      adapter.on("message.part.updated", (data) => {
        partTypes.push((data.part as { type: string }).type);
      });

      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "hello" },
      ]);

      expect(response.role).toBe("assistant");
      expect(partTypes).not.toContain("tool");
      expect(partTypes).toContain("reasoning");
      expect(partTypes).toContain("text");
    }, 10000);

    it("emits session.updated and user message.updated immediately", async () => {
      adapter.setStreamingMode(true, 5, 1);

      const earlyEvents: string[] = [];
      adapter.on("session.updated", () => earlyEvents.push("session"));
      adapter.on("message.updated", (data) => earlyEvents.push(data.message.role));

      const responsePromise = adapter.sendMessage(sessionId, [
        { type: "text", text: "stream test" },
      ]);

      await new Promise((r) => setTimeout(r, 30));
      expect(earlyEvents).toContain("session");
      expect(earlyEvents).toContain("user");

      await responsePromise;
    }, 10000);

    it("cancels before text streaming phase starts", async () => {
      // Large toolCount and short interval to cancel before text phase
      adapter.setStreamingMode(true, 5, 10);

      const responsePromise = adapter.sendMessage(sessionId, [
        { type: "text", text: "cancel before text" },
      ]);

      // Cancel quickly before text streaming
      await new Promise((r) => setTimeout(r, 20));
      await adapter.cancelMessage(sessionId);

      const result = await responsePromise;
      expect(result.error).toBe("Cancelled");
      expect(result.parts).toEqual([]);
    }, 10000);

    it("streams text word by word until completion, emitting incremental updates", async () => {
      // No tools so text streaming starts quickly after the reasoning phase
      adapter.setStreamingMode(true, 5, 0);

      const textUpdates: string[] = [];
      adapter.on("message.part.updated", (data) => {
        const part = data.part as { type: string; text?: string };
        if (part.type === "text" && part.text !== undefined) {
          textUpdates.push(part.text);
        }
      });

      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "hello world" },
      ]);

      // Multiple incremental text updates should have been emitted
      expect(textUpdates.length).toBeGreaterThan(1);
      // Later updates accumulate more words
      expect(textUpdates[textUpdates.length - 1].length).toBeGreaterThan(
        textUpdates[0].length,
      );
      // Final message should have no error
      expect(response.error).toBeUndefined();
    }, 10000);

    it("tool parts use correct kind for read/grep/glob tools", async () => {
      adapter.setStreamingMode(true, 5, 6); // all 6 tool types

      const toolParts: ToolPart[] = [];
      adapter.on("message.part.updated", (data) => {
        if ((data.part as { type: string }).type === "tool") {
          toolParts.push(data.part as ToolPart);
        }
      });

      await adapter.sendMessage(sessionId, [{ type: "text", text: "tools" }]);

      // read/grep/glob/list → kind "read"; edit/shell/write → kind "edit"
      const readTools = toolParts.filter((p) =>
        ["read", "grep", "glob"].includes(p.normalizedTool ?? ""),
      );
      readTools.forEach((p) => expect(p.kind).toBe("read"));

      const editTools = toolParts.filter((p) =>
        ["edit", "shell", "write"].includes(p.normalizedTool ?? ""),
      );
      editTools.forEach((p) => expect(p.kind).toBe("edit"));
    }, 10000);

    it("session.updated not emitted when session doesn't exist in streaming mode", async () => {
      adapter.setStreamingMode(true, 5, 0);
      let sessionUpdated = false;
      adapter.on("session.updated", () => {
        sessionUpdated = true;
      });

      await adapter.sendMessage("nonexistent-session", [
        { type: "text", text: "test" },
      ]);

      await new Promise((r) => setTimeout(r, 30));
      expect(sessionUpdated).toBe(false);
    }, 10000);
  });

  // ---------------------------------------------------------------------------
  // setStreamingMode config
  // ---------------------------------------------------------------------------

  describe("setStreamingMode", () => {
    it("uses defaults for tokenIntervalMs and toolCount when not provided", async () => {
      // Just calling with enabled=false should not throw
      adapter.setStreamingMode(false);
      // calling with only enabled=true should use defaults (30ms, 3 tools)
      adapter.setStreamingMode(true);
      // Disable again so subsequent tests are not affected
      adapter.setStreamingMode(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  describe("models and modes", () => {
    it("manages models and available modes for sessions", async () => {
      const result = await adapter.listModels();
      expect(result.models).toHaveLength(2);
      expect(result.models[0].modelId).toBe("mock/test-model");
      expect(result.models[1].modelId).toBe("mock/fast-model");
      await adapter.setModel("session-1", "mock/fast-model");
    });

    it("getModes returns agent and plan", () => {
      const modes = adapter.getModes();
      expect(modes).toHaveLength(2);
      expect(modes.map((m) => m.id)).toEqual(["agent", "plan"]);
      expect(modes[0].label).toBe("Agent");
      expect(modes[1].label).toBe("Plan");
    });
  });

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------

  describe("getMode / setMode", () => {
    it("falls back to currentMode when session has no stored mode", () => {
      expect(adapter.getMode("unknown-session")).toBe("agent");
    });

    it("returns stored session mode after setMode", async () => {
      await adapter.setMode("session-1", "plan");
      expect(adapter.getMode("session-1")).toBe("plan");
    });

    it("setMode also updates currentMode for fallback", async () => {
      await adapter.setMode("session-1", "plan");
      // A different session with no stored mode should see "plan" as default
      expect(adapter.getMode("session-other")).toBe("plan");
    });

    it("different sessions can have different modes", async () => {
      await adapter.setMode("session-a", "agent");
      await adapter.setMode("session-b", "plan");
      expect(adapter.getMode("session-a")).toBe("agent");
      expect(adapter.getMode("session-b")).toBe("plan");
    });
  });

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  describe("permissions", () => {
    it("emits permission.replied event with optionId", async () => {
      let emittedOptionId: string | undefined;
      adapter.on("permission.replied", (data) => {
        emittedOptionId = data.optionId;
      });
      await adapter.replyPermission("perm-1", { optionId: "allow" });
      expect(emittedOptionId).toBe("allow");
    });

    it("emits permission.replied with the correct permissionId", async () => {
      let emittedPermissionId: string | undefined;
      adapter.on("permission.replied", (data) => {
        emittedPermissionId = data.permissionId;
      });
      await adapter.replyPermission("perm-42", { optionId: "deny" });
      expect(emittedPermissionId).toBe("perm-42");
    });

    it("replyQuestion is a no-op", async () => {
      await expect(
        adapter.replyQuestion("q-1", [["answer"]], "session-1"),
      ).resolves.toBeUndefined();
    });

    it("rejectQuestion is a no-op", async () => {
      await expect(
        adapter.rejectQuestion("q-1", "session-1"),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  describe("projects", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("derives projects from sessions", async () => {
      await adapter.createSession("/test/project-a");
      await adapter.createSession("/test/project-a");
      await adapter.createSession("/test/project-b");
      const projects = await adapter.listProjects();
      expect(projects).toHaveLength(2);
      const dirs = projects.map((p) => p.directory);
      expect(dirs).toContain("/test/project-a");
      expect(dirs).toContain("/test/project-b");
    });

    it("returns empty array when no sessions exist", async () => {
      const projects = await adapter.listProjects();
      expect(projects).toEqual([]);
    });

    it("uses directory name as project name", async () => {
      await adapter.createSession("/home/user/my-project");
      const projects = await adapter.listProjects();
      expect(projects[0].name).toBe("my-project");
    });

    it("builds project id from directory path", async () => {
      await adapter.createSession("/test/alpha");
      const projects = await adapter.listProjects();
      expect(projects[0].id).toBe("dir-/test/alpha");
    });

    it("handles Windows-style paths with backslashes", async () => {
      await adapter.createSession("C:\\Users\\user\\project");
      const projects = await adapter.listProjects();
      expect(projects[0].name).toBe("project");
      // id should normalize backslashes
      expect(projects[0].id).toBe("dir-C:/Users/user/project");
    });
  });

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  describe("test helpers", () => {
    it("seeds sessions/messages and resets all data", async () => {
      const session: UnifiedSession = {
        id: "test-session",
        engineType: "opencode",
        directory: "/test",
        title: "Seeded Session",
        time: { created: Date.now(), updated: Date.now() },
      };
      const messages: UnifiedMessage[] = [
        {
          id: "msg-1",
          sessionId: "test-session",
          role: "user",
          time: { created: Date.now() },
          parts: [
            {
              id: "part-1",
              messageId: "msg-1",
              sessionId: "test-session",
              type: "text",
              text: "Hello",
            } as TextPart,
          ],
        },
      ];
      adapter.seedSession(session, messages);
      expect((await adapter.getSession("test-session"))!.title).toBe(
        "Seeded Session",
      );
      expect(await adapter.listMessages("test-session")).toHaveLength(1);

      adapter.reset();
      expect(adapter.getStatus()).toBe("stopped");
      expect(await adapter.listSessions()).toEqual([]);
    });

    it("seedSession with no messages defaults to empty array", async () => {
      const session: UnifiedSession = {
        id: "seed-no-msgs",
        engineType: "opencode",
        directory: "/tmp",
        title: "Empty",
        time: { created: Date.now(), updated: Date.now() },
      };
      adapter.seedSession(session);
      expect(await adapter.listMessages("seed-no-msgs")).toEqual([]);
    });

    it("reset aborts all pending abort controllers", async () => {
      await adapter.start();
      const session = await adapter.createSession("/test/dir");
      adapter.setSlowMode(5000);

      const responsePromise = adapter.sendMessage(session.id, [
        { type: "text", text: "will be reset" },
      ]);

      await new Promise((r) => setTimeout(r, 30));

      // reset() should abort the pending controller and resolve the promise
      adapter.reset();

      // Promise should resolve (cancelled) after reset
      const result = await responsePromise;
      expect(result.error).toBe("Cancelled");
    });

    it("reset clears currentMode back to agent", async () => {
      await adapter.setMode("s", "plan");
      expect(adapter.getMode("unknown")).toBe("plan");
      adapter.reset();
      expect(adapter.getMode("unknown")).toBe("agent");
    });

    it("reset clears slowResponseDelay", async () => {
      await adapter.start();
      adapter.setSlowMode(5000);
      adapter.reset();

      // After reset, instant response should complete immediately
      await adapter.start();
      const session = await adapter.createSession("/test/dir");
      const start = Date.now();
      await adapter.sendMessage(session.id, [{ type: "text", text: "fast" }]);
      expect(Date.now() - start).toBeLessThan(200);
    });
  });

  // ---------------------------------------------------------------------------
  // generateResponse — edge cases
  // ---------------------------------------------------------------------------

  describe("generateResponse edge cases", () => {
    let sessionId: string;

    beforeEach(async () => {
      await adapter.start();
      const session = await adapter.createSession("/test/project");
      sessionId = session.id;
    });

    it("handles subtraction", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "10 - 3" },
      ]);
      expect((response.parts[0] as TextPart).text).toBe("The answer is 7");
    });

    it("handles float arithmetic", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "1.5 + 2.5" },
      ]);
      expect((response.parts[0] as TextPart).text).toBe("The answer is 4");
    });

    it("non-math text echoes back", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "What is TypeScript?" },
      ]);
      expect((response.parts[0] as TextPart).text).toBe(
        "This is a mock response to: What is TypeScript?",
      );
    });

    it("whitespace-only text is treated as empty", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "   " },
      ]);
      expect((response.parts[0] as TextPart).text).toBe(
        "This is a mock response to an empty message.",
      );
    });

    it("text content without .text property is ignored", async () => {
      // content with type "text" but no .text value
      const response = await adapter.sendMessage(sessionId, [
        { type: "text" } as any,
      ]);
      expect((response.parts[0] as TextPart).text).toBe(
        "This is a mock response to an empty message.",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // EngineAdapter base class default methods
  // ---------------------------------------------------------------------------

  describe("EngineAdapter base defaults", () => {
    it("hasSession returns true by default", () => {
      expect(adapter.hasSession("any-session")).toBe(true);
    });

    it("listHistoricalSessions returns sorted and limited sessions", async () => {
      await adapter.start();
      await adapter.createSession("/test/a");
      await adapter.createSession("/test/b");
      await adapter.createSession("/test/c");

      const all = await adapter.listHistoricalSessions(0);
      expect(all).toHaveLength(3);

      const limited = await adapter.listHistoricalSessions(2);
      expect(limited).toHaveLength(2);
    });

    it("setReasoningEffort is a no-op", async () => {
      await expect(adapter.setReasoningEffort("s", "high")).resolves.toBeUndefined();
    });

    it("getReasoningEffort returns null by default", () => {
      expect(adapter.getReasoningEffort("s")).toBeNull();
    });

    it("listCommands returns empty array by default", async () => {
      const cmds = await adapter.listCommands("s", "/dir");
      expect(cmds).toEqual([]);
    });

    it("invokeCommand returns handledAsCommand false by default", async () => {
      const result = await adapter.invokeCommand("s", "test", "args");
      expect(result).toEqual({ handledAsCommand: false });
    });
  });
});
