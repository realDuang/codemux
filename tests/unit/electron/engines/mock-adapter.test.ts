// ============================================================================
// Unit Tests — MockEngineAdapter
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { MockEngineAdapter } from "../../../../electron/main/engines/mock-adapter";
import type { UnifiedSession, UnifiedMessage, TextPart } from "../../../../src/types/unified";

describe("MockEngineAdapter", () => {
  let adapter: MockEngineAdapter;

  beforeEach(() => {
    adapter = new MockEngineAdapter({ engineType: "opencode", name: "Test OpenCode" });
  });

  describe("lifecycle", () => {
    it("starts, stops and reports health correctly", async () => {
      const events: string[] = [];
      adapter.on("status.changed", (data) => events.push(data.status));
      
      expect(await adapter.healthCheck()).toBe(false);
      
      await adapter.start();
      expect(adapter.getStatus()).toBe("running");
      expect(events).toContain("running");
      expect(await adapter.healthCheck()).toBe(true);

      await adapter.stop();
      expect(adapter.getStatus()).toBe("stopped");
      expect(await adapter.healthCheck()).toBe(false);
    });

    it("returns correct engine info", async () => {
      await adapter.start();
      const info = adapter.getInfo();
      expect(info.type).toBe("opencode");
      expect(info.name).toBe("Test OpenCode");
      expect(info.version).toBe("1.0.0-mock");
      expect(info.status).toBe("running");
      expect(info.capabilities).toBeDefined();
    });
  });

  describe("sessions", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("creates, emits events, and retrieves sessions by ID", async () => {
      let emitted: UnifiedSession | null = null;
      adapter.on("session.created", (data) => { emitted = data.session; });
      
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

    it("lists, filters, and deletes sessions", async () => {
      await adapter.createSession("/test/project-a");
      await adapter.createSession("/test/project-b");
      
      const all = await adapter.listSessions();
      expect(all).toHaveLength(2);

      const filtered = await adapter.listSessions("/test/project-a");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].directory).toBe("/test/project-a");

      await adapter.deleteSession(all[0].id);
      expect(await adapter.listSessions()).toHaveLength(1);
    });
  });

  describe("messages", () => {
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
    ])("sends message and handles expression '%s'", async (input, expected) => {
      const response = await adapter.sendMessage(sessionId, [{ type: "text", text: input }]);
      expect(response.role).toBe("assistant");
      expect((response.parts[0] as TextPart).text).toBe(expected);
    });

    it("stores messages, emits events, updates session title, and handles unknown sessions", async () => {
      const events: string[] = [];
      adapter.on("message.part.updated", () => events.push("part"));
      adapter.on("message.updated", (data) => events.push(`message:${data.message.role}`));
      
      await adapter.sendMessage(sessionId, [
        { type: "text", text: "Fix the authentication bug" },
      ]);
      
      // Verification of storage
      const messages = await adapter.listMessages(sessionId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");

      // Verification of events
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toContain("part");
      expect(events).toContain("message:user");
      expect(events).toContain("message:assistant");

      // Verification of title update
      const session = await adapter.getSession(sessionId);
      expect(session!.title).toBe("Fix the authentication bug");

      // Verification of unknown session
      expect(await adapter.listMessages("nonexistent")).toEqual([]);
    });
  });

  describe("models and modes", () => {
    it("manages models and available modes for sessions", async () => {
      // Models
      const result = await adapter.listModels();
      expect(result.models).toHaveLength(2);
      expect(result.models[0].modelId).toBe("mock/test-model");
      await adapter.setModel("session-1", "mock/fast-model");

      // Modes
      const modes = adapter.getModes();
      expect(modes).toHaveLength(2);
      expect(modes.map((m) => m.id)).toEqual(["agent", "plan"]);
      await adapter.setMode("session-1", "plan");
    });
  });

  describe("permissions", () => {
    it("emits permission.replied event", async () => {
      let emitted = false;
      adapter.on("permission.replied", () => { emitted = true; });
      await adapter.replyPermission("perm-1", { optionId: "allow" });
      expect(emitted).toBe(true);
    });
  });

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
  });

  describe("test helpers", () => {
    it("seeds sessions/messages and resets all data", async () => {
      // Seed
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
      expect((await adapter.getSession("test-session"))!.title).toBe("Seeded Session");
      expect(await adapter.listMessages("test-session")).toHaveLength(1);

      // Reset
      adapter.reset();
      expect(adapter.getStatus()).toBe("stopped");
      expect(await adapter.listSessions()).toEqual([]);
    });
  });
});
