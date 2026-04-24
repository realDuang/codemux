import { describe, it, expect } from "vitest";
import { parseCommand } from "../../../../../electron/main/channels/shared/command-parser";
import {
  buildHelpText,
} from "../../../../../electron/main/channels/shared/help-text-builder";
import {
  P2P_CAPABILITIES,
  GROUP_CAPABILITIES,
} from "../../../../../electron/main/channels/shared/command-types";
import {
  buildProjectListText,
  buildSessionListText,
  buildQuestionText,
  buildHistoryEntries,
} from "../../../../../electron/main/channels/shared/list-builders";

describe("shared command parser", () => {
  describe("parseCommand", () => {
    it("returns null for non-command text", () => {
      expect(parseCommand("hello")).toBeNull();
      expect(parseCommand("")).toBeNull();
      expect(parseCommand("   ")).toBeNull();
    });

    it("parses a simple command", () => {
      expect(parseCommand("/help")).toMatchObject({ command: "help", args: [] });
    });

    it("lowercases the command", () => {
      expect(parseCommand("/HELP")).toMatchObject({ command: "help" });
    });

    it("strips telegram-style @botname suffix", () => {
      expect(parseCommand("/help@MyBot")).toMatchObject({ command: "help" });
    });

    it("captures positional args", () => {
      expect(parseCommand("/mode plan")).toMatchObject({
        command: "mode",
        args: ["plan"],
      });
    });

    it("recognises /model list as a subcommand", () => {
      expect(parseCommand("/model list")).toMatchObject({
        command: "model",
        subcommand: "list",
        args: [],
      });
    });

    it("treats /model <id> as args, not subcommand", () => {
      expect(parseCommand("/model gpt-4o")).toMatchObject({
        command: "model",
        args: ["gpt-4o"],
      });
      expect(parseCommand("/model gpt-4o").subcommand).toBeUndefined();
    });

    it("trims whitespace", () => {
      expect(parseCommand("   /help   ")).toMatchObject({ command: "help" });
    });
  });
});

describe("shared help-text builder", () => {
  it("P2P help lists Class A + B + C commands", () => {
    const text = buildHelpText(P2P_CAPABILITIES);
    expect(text).toContain("/project");
    expect(text).toContain("/new");
    expect(text).toContain("/switch");
    expect(text).toContain("/cancel");
    expect(text).toContain("/status");
    expect(text).toContain("/mode");
    expect(text).toContain("/model");
    expect(text).toContain("/history");
    expect(text).toContain("/help");
  });

  it("group help omits Class A navigation commands", () => {
    const text = buildHelpText(GROUP_CAPABILITIES);
    expect(text).not.toContain("/project");
    expect(text).not.toContain("/new");
    expect(text).not.toContain("/switch");
    expect(text).toContain("/cancel");
    expect(text).toContain("/help");
  });

  it("group help footer mentions @bot when requiresMention is true", () => {
    const text = buildHelpText(GROUP_CAPABILITIES, { requiresMention: true });
    expect(text).toMatch(/@.*我|@.*command/);
  });
});

describe("shared list builders", () => {
  it("renders empty project list", () => {
    expect(buildProjectListText([])).toContain("未找到项目");
  });

  it("renders numbered project list", () => {
    const text = buildProjectListText([
      { id: "p1", name: "alpha", directory: "/a", engineType: "claude" } as any,
      { id: "p2", name: "beta", directory: "/b", engineType: "claude" } as any,
    ]);
    expect(text).toContain("1. alpha");
    expect(text).toContain("2. beta");
  });

  it("renders session list with /new hint by default", () => {
    const text = buildSessionListText(
      [{ id: "s1", title: "Existing", time: { updated: 100 } } as any],
      "myproj",
    );
    expect(text).toContain("myproj");
    expect(text).toContain("/new");
    expect(text).toContain("1. Existing");
  });

  it("renders session list with legacy 'new' keyword hint when requested", () => {
    const text = buildSessionListText([], "myproj", { newHint: "keyword" });
    expect(text).toContain('"new"');
  });

  it("buildHistoryEntries returns one entry per textual message", () => {
    const entries = buildHistoryEntries([
      { role: "user", parts: [{ type: "text", text: "hello" }] } as any,
      { role: "assistant", parts: [{ type: "text", text: "world" }] } as any,
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ emoji: "👤", text: "hello" });
    expect(entries[1]).toMatchObject({ emoji: "🤖", text: "world" });
  });

  it("buildHistoryEntries returns [] for empty messages array", () => {
    expect(buildHistoryEntries([])).toEqual([]);
  });

  it("buildHistoryEntries skips messages with no textual content", () => {
    const entries = buildHistoryEntries([
      { role: "user", parts: [{ type: "image", url: "x" }] } as any,
      { role: "assistant", parts: [{ type: "text", text: "   " }] } as any,
      { role: "user", parts: [{ type: "text", text: "real" }] } as any,
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("real");
  });

  it("buildHistoryEntries concatenates multiple text parts with newline", () => {
    const entries = buildHistoryEntries([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "line1" },
          { type: "tool_use", id: "x" },
          { type: "text", text: "line2" },
        ],
      } as any,
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("line1\nline2");
  });

  it("buildHistoryEntries truncates content longer than 500 chars with ellipsis", () => {
    const long = "a".repeat(600);
    const entries = buildHistoryEntries([
      { role: "user", parts: [{ type: "text", text: long }] } as any,
    ]);
    expect(entries[0].text).toHaveLength(503);
    expect(entries[0].text.endsWith("...")).toBe(true);
  });

  it("buildHistoryEntries does not truncate content of exactly 500 chars", () => {
    const exact = "b".repeat(500);
    const entries = buildHistoryEntries([
      { role: "user", parts: [{ type: "text", text: exact }] } as any,
    ]);
    expect(entries[0].text).toBe(exact);
  });

  it("buildSessionListText sorts by updated DESC and limits to 9", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      title: `T${i}`,
      time: { updated: i * 100 },
    })) as any[];
    const text = buildSessionListText(sessions, "proj");
    // The most recent (T11) should be first, T3 should be the 9th (last shown)
    expect(text).toContain("1. T11");
    expect(text).toContain("9. T3");
    expect(text).not.toContain("T2");
    expect(text).not.toContain("T0");
  });

  it("buildSessionListText falls back to id-prefix title when missing", () => {
    const text = buildSessionListText(
      [{ id: "abcdef0123456789", time: { updated: 1 } } as any],
      "proj",
    );
    expect(text).toContain("Session abcdef01");
  });

  it("buildSessionListText appends [engineType] when present", () => {
    const text = buildSessionListText(
      [{ id: "x", title: "Hello", engineType: "claude", time: { updated: 1 } } as any],
      "proj",
    );
    expect(text).toContain("Hello [claude]");
  });

  it("buildSessionListText empty list shows /new hint by default", () => {
    const text = buildSessionListText([], "proj");
    expect(text).toContain("使用 /new 创建新会话");
  });

  it("buildProjectListText falls back to directory basename when name is missing", () => {
    const text = buildProjectListText([
      { id: "p", name: "", directory: "/foo/bar/baz", engineType: "claude" } as any,
    ]);
    expect(text).toContain("1. baz");
  });

  it("buildProjectListText falls back to directory itself when basename empty", () => {
    const text = buildProjectListText([
      { id: "p", name: "", directory: "weird", engineType: "claude" } as any,
    ]);
    expect(text).toContain("1. weird");
  });

  it("buildQuestionText renders question and numbered options", () => {
    const text = buildQuestionText("Continue?", [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ]);
    expect(text).toContain("Agent 提问");
    expect(text).toContain("Continue?");
    expect(text).toContain("1. Yes");
    expect(text).toContain("2. No");
    expect(text).toContain("回复消息以回答");
  });

  it("buildQuestionText handles empty options gracefully", () => {
    const text = buildQuestionText("Just FYI", []);
    expect(text).toContain("Just FYI");
    expect(text).not.toMatch(/^\s+1\./m);
  });
});
