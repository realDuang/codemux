import { describe, expect, it } from "vitest";
import {
  parseCommand,
  buildHelpText,
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
  buildHistoryEntries,
} from "../../../../../electron/main/channels/weixin-ilink/weixin-ilink-command-parser";
import type { UnifiedMessage, UnifiedProject, UnifiedSession } from "../../../../../src/types/unified";

describe("weixin-ilink command parser", () => {
  describe("parseCommand", () => {
    it("returns null for non-command text", () => {
      expect(parseCommand("hello world")).toBeNull();
      expect(parseCommand("")).toBeNull();
      expect(parseCommand("   ")).toBeNull();
    });

    it("parses simple commands", () => {
      const cmd = parseCommand("/help");
      expect(cmd).toEqual({ command: "help", args: [], raw: "/help" });
    });

    it("normalises command name to lowercase", () => {
      const cmd = parseCommand("/HELP");
      expect(cmd?.command).toBe("help");
    });

    it("parses commands with positional args", () => {
      const cmd = parseCommand("/mode plan");
      expect(cmd).toMatchObject({ command: "mode", args: ["plan"] });
      expect(cmd?.subcommand).toBeUndefined();
    });

    it("recognises known subcommands for project/session/engine/model", () => {
      expect(parseCommand("/project list")).toMatchObject({ command: "project", subcommand: "list", args: [] });
      expect(parseCommand("/session new")).toMatchObject({ command: "session", subcommand: "new", args: [] });
      expect(parseCommand("/model list")).toMatchObject({ command: "model", subcommand: "list", args: [] });
    });

    it("treats unknown subcommand as positional arg", () => {
      const cmd = parseCommand("/model gpt-4o");
      expect(cmd?.subcommand).toBeUndefined();
      expect(cmd?.args).toEqual(["gpt-4o"]);
    });

    it("trims surrounding whitespace", () => {
      const cmd = parseCommand("   /help   ");
      expect(cmd?.command).toBe("help");
    });

    it("ignores text not starting with /", () => {
      expect(parseCommand("help")).toBeNull();
    });
  });

  describe("buildHelpText", () => {
    it("returns multi-line help that mentions key commands", () => {
      const text = buildHelpText();
      expect(text).toContain("/project");
      expect(text).toContain("/cancel");
      expect(text).toContain("/status");
      expect(text).toContain("/mode");
      expect(text).toContain("/model");
      expect(text).toContain("/history");
      expect(text).toContain("/help");
    });

    it("does not advertise group-only commands like /bind", () => {
      expect(buildHelpText()).not.toContain("/bind");
    });
  });

  describe("buildProjectListText", () => {
    it("returns empty-list message when projects are empty", () => {
      expect(buildProjectListText([])).toContain("未找到项目");
    });

    it("numbers projects starting at 1 and prefers name over directory", () => {
      const projects: UnifiedProject[] = [
        { id: "p1", name: "Demo", directory: "/tmp/demo" } as UnifiedProject,
        { id: "p2", name: "", directory: "/tmp/foo/bar" } as UnifiedProject,
      ];
      const text = buildProjectListText(projects);
      expect(text).toContain("1. Demo");
      expect(text).toContain("2. bar");
    });
  });

  describe("buildSessionListText", () => {
    it("limits sessions to 9 entries and labels engine type", () => {
      const sessions: UnifiedSession[] = Array.from({ length: 12 }, (_, i) => ({
        id: `session-${i.toString().padStart(2, "0")}`,
        title: `Session ${i}`,
        directory: "/tmp/proj",
        engineType: "claude",
        time: { updated: Date.now() - i * 1000 },
      } as unknown as UnifiedSession));

      const text = buildSessionListText(sessions, "Proj");
      // Only 9 entries should appear (1..9)
      expect(text).toContain("1. Session 0 [claude]");
      expect(text).toContain("9. Session 8 [claude]");
      expect(text).not.toContain("10. Session 9");
    });

    it("only renders the new prompt when there are no existing sessions", () => {
      const text = buildSessionListText([], "Proj");
      expect(text).toContain('回复 "new"');
      expect(text).not.toContain("已有会话");
    });
  });

  describe("buildQuestionText", () => {
    it("renders question + numbered options", () => {
      const text = buildQuestionText("Pick one:", [
        { id: "a", label: "Option A" },
        { id: "b", label: "Option B" },
      ]);
      expect(text).toContain("Pick one:");
      expect(text).toContain("1. Option A");
      expect(text).toContain("2. Option B");
    });
  });

  describe("buildHistoryEntries", () => {
    const makeMsg = (role: "user" | "assistant", text: string): UnifiedMessage =>
      ({ role, parts: [{ type: "text", text }] } as unknown as UnifiedMessage);

    it("returns empty array for empty messages", () => {
      expect(buildHistoryEntries([])).toEqual([]);
    });

    it("emits one entry per message with role-based emoji", () => {
      const entries = buildHistoryEntries([
        makeMsg("user", "hi"),
        makeMsg("assistant", "hello"),
      ]);
      expect(entries).toEqual([
        { emoji: "👤", text: "hi" },
        { emoji: "🤖", text: "hello" },
      ]);
    });

    it("skips messages with no text content", () => {
      const messages: UnifiedMessage[] = [
        makeMsg("user", "   "),
        { role: "assistant", parts: [] } as unknown as UnifiedMessage,
        makeMsg("assistant", "real reply"),
      ];
      const entries = buildHistoryEntries(messages);
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe("real reply");
    });

    it("truncates very long content", () => {
      const longText = "x".repeat(800);
      const entries = buildHistoryEntries([makeMsg("assistant", longText)]);
      expect(entries[0].text.length).toBeLessThanOrEqual(800);
      expect(entries[0].text.endsWith("...")).toBe(true);
    });
  });
});
