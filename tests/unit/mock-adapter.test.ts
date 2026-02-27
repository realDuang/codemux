// ============================================================================
// Unit Tests — MockEngineAdapter
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { MockEngineAdapter } from "../../electron/main/engines/mock-adapter";
import type { UnifiedSession, UnifiedMessage, TextPart } from "../../src/types/unified";

describe("MockEngineAdapter", () => {
  let adapter: MockEngineAdapter;

  beforeEach(() => {
    adapter = new MockEngineAdapter({ engineType: "opencode", name: "Test OpenCode" });
  });

  // --- Lifecycle ---

  describe("lifecycle", () => {
    it("should start and set status to running", async () => {
      const events: string[] = [];
      adapter.on("status.changed", (data) => events.push(data.status));

      await adapter.start();

      expect(adapter.getStatus()).toBe("running");
      expect(events).toContain("running");
    });

    it("should stop and set status to stopped", async () => {
      await adapter.start();
      await adapter.stop();

      expect(adapter.getStatus()).toBe("stopped");
    });

    it("should report healthy when running", async () => {
      expect(await adapter.healthCheck()).toBe(false);
      await adapter.start();
      expect(await adapter.healthCheck()).toBe(true);
      await adapter.stop();
      expect(await adapter.healthCheck()).toBe(false);
    });

    it("should return correct engine info", async () => {
      await adapter.start();
      const info = adapter.getInfo();

      expect(info.type).toBe("opencode");
      expect(info.name).toBe("Test OpenCode");
      expect(info.version).toBe("1.0.0-mock");
      expect(info.status).toBe("running");
      expect(info.capabilities).toBeDefined();
    });
  });

  // --- Sessions ---

  describe("sessions", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("should create a session", async () => {
      const session = await adapter.createSession("/test/project");

      expect(session.id).toBeTruthy();
      expect(session.engineType).toBe("opencode");
      expect(session.directory).toBe("/test/project");
      expect(session.title).toBe("New Session");
    });

    it("should emit session.created event", async () => {
      let emitted: UnifiedSession | null = null;
      adapter.on("session.created", (data) => { emitted = data.session; });

      const session = await adapter.createSession("/test/project");

      expect(emitted).not.toBeNull();
      expect(emitted!.id).toBe(session.id);
    });

    it("should list sessions", async () => {
      await adapter.createSession("/test/project-a");
      await adapter.createSession("/test/project-b");

      const all = await adapter.listSessions();
      expect(all).toHaveLength(2);
    });

    it("should filter sessions by directory", async () => {
      await adapter.createSession("/test/project-a");
      await adapter.createSession("/test/project-b");

      const filtered = await adapter.listSessions("/test/project-a");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].directory).toBe("/test/project-a");
    });

    it("should get a session by ID", async () => {
      const created = await adapter.createSession("/test/project");
      const found = await adapter.getSession(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it("should return null for unknown session ID", async () => {
      const found = await adapter.getSession("nonexistent");
      expect(found).toBeNull();
    });

    it("should delete a session", async () => {
      const session = await adapter.createSession("/test/project");
      await adapter.deleteSession(session.id);

      const found = await adapter.getSession(session.id);
      expect(found).toBeNull();
    });
  });

  // --- Messages ---

  describe("messages", () => {
    let sessionId: string;

    beforeEach(async () => {
      await adapter.start();
      const session = await adapter.createSession("/test/project");
      sessionId = session.id;
    });

    it("should send a message and return assistant response", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "Hello" },
      ]);

      expect(response.role).toBe("assistant");
      expect(response.parts).toHaveLength(1);
      expect((response.parts[0] as TextPart).text).toBe(
        "This is a mock response to: Hello"
      );
    });

    it("should handle math expressions", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "2+2" },
      ]);

      expect((response.parts[0] as TextPart).text).toBe("The answer is 4");
    });

    it("should handle multiplication", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "10 * 3" },
      ]);

      expect((response.parts[0] as TextPart).text).toBe("The answer is 30");
    });

    it("should handle division", async () => {
      const response = await adapter.sendMessage(sessionId, [
        { type: "text", text: "100 / 4" },
      ]);

      expect((response.parts[0] as TextPart).text).toBe("The answer is 25");
    });

    it("should store both user and assistant messages", async () => {
      await adapter.sendMessage(sessionId, [
        { type: "text", text: "test" },
      ]);

      const messages = await adapter.listMessages(sessionId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    it("should emit message events after sendMessage", async () => {
      const events: string[] = [];
      adapter.on("message.part.updated", () => events.push("part"));
      adapter.on("message.updated", (data) => events.push(`message:${data.message.role}`));

      await adapter.sendMessage(sessionId, [
        { type: "text", text: "test" },
      ]);

      // Events are deferred via setTimeout to avoid race conditions
      // in gateway broadcast; wait for them to fire
      await new Promise((r) => setTimeout(r, 50));

      expect(events).toContain("part");
      expect(events).toContain("message:user");
      expect(events).toContain("message:assistant");
    });

    it("should update session title on first message", async () => {
      await adapter.sendMessage(sessionId, [
        { type: "text", text: "Fix the authentication bug" },
      ]);

      const session = await adapter.getSession(sessionId);
      expect(session!.title).toBe("Fix the authentication bug");
    });

    it("should return empty array for unknown session", async () => {
      const messages = await adapter.listMessages("nonexistent");
      expect(messages).toEqual([]);
    });
  });

  // --- Models ---

  describe("models", () => {
    it("should return mock model list", async () => {
      const result = await adapter.listModels();
      expect(result.models).toHaveLength(2);
      expect(result.models[0].modelId).toBe("mock/test-model");
      expect(result.models[0].engineType).toBe("opencode");
    });

    it("should set model for session", async () => {
      await adapter.setModel("session-1", "mock/fast-model");
      // No error thrown = success
    });
  });

  // --- Modes ---

  describe("modes", () => {
    it("should return available modes", () => {
      const modes = adapter.getModes();
      expect(modes).toHaveLength(2);
      expect(modes.map((m) => m.id)).toEqual(["agent", "plan"]);
    });

    it("should set mode for session", async () => {
      await adapter.setMode("session-1", "plan");
      // No error thrown = success
    });
  });

  // --- Permissions ---

  describe("permissions", () => {
    it("should emit permission.replied event", async () => {
      let emitted = false;
      adapter.on("permission.replied", () => { emitted = true; });

      await adapter.replyPermission("perm-1", { optionId: "allow" });

      expect(emitted).toBe(true);
    });
  });

  // --- Projects ---

  describe("projects", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("should derive projects from sessions", async () => {
      await adapter.createSession("/test/project-a");
      await adapter.createSession("/test/project-a"); // same dir
      await adapter.createSession("/test/project-b");

      const projects = await adapter.listProjects();
      expect(projects).toHaveLength(2);

      const dirs = projects.map((p) => p.directory);
      expect(dirs).toContain("/test/project-a");
      expect(dirs).toContain("/test/project-b");
    });
  });

  // --- Test Helpers ---

  describe("test helpers", () => {
    it("should seed sessions and messages", async () => {
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

      const found = await adapter.getSession("test-session");
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Seeded Session");

      const msgs = await adapter.listMessages("test-session");
      expect(msgs).toHaveLength(1);
    });

    it("should reset all data", async () => {
      await adapter.start();
      await adapter.createSession("/test");

      adapter.reset();

      expect(adapter.getStatus()).toBe("stopped");
      expect(await adapter.listSessions()).toEqual([]);
    });
  });
});
