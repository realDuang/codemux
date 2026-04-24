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
  buildSessionNotification,
  relativeTimeZh,
  truncateTitle,
  groupAndSortSessions,
} from "../../../../../electron/main/channels/shared/list-builders";
import {
  markdownToTelegramHtml,
} from "../../../../../electron/main/channels/telegram/telegram-transport";

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
  it("renders empty project list with default workspace guidance", () => {
    const text = buildProjectListText([]);
    expect(text).toContain("暂无可用项目");
    expect(text).toContain("桌面端");
    expect(text).toContain("/help");
  });

  it("buildSessionNotification shows project name, engine type, and short session ID", () => {
    const text = buildSessionNotification("codemux", "claude", "abc12345-6789-0000");
    expect(text).toContain("codemux");
    expect(text).toContain("claude");
    expect(text).toContain("abc12345");
    expect(text).not.toContain("6789-0000");
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
    const now = Date.now();
    const text = buildSessionListText(
      [{ id: "s1", title: "Existing", time: { updated: now } } as any],
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

  it("buildSessionListText shows all sessions without limit", () => {
    const now = Date.now();
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      title: `T${i}`,
      time: { updated: now - i * 100_000 },
    })) as any[];
    // Sessions are pre-sorted (caller's responsibility via groupAndSortSessions)
    const text = buildSessionListText(sessions, "proj");
    // All 12 sessions should be visible
    expect(text).toContain("1. T0");
    expect(text).toContain("12. T11");
  });

  it("buildSessionListText falls back to id-prefix title when missing", () => {
    const text = buildSessionListText(
      [{ id: "abcdef0123456789", time: { updated: Date.now() } } as any],
      "proj",
    );
    expect(text).toContain("Session abcdef01");
  });

  it("buildSessionListText appends [engineType] when present", () => {
    const text = buildSessionListText(
      [{ id: "x", title: "Hello", engineType: "claude", time: { updated: Date.now() } } as any],
      "proj",
    );
    expect(text).toContain("Hello [claude]");
  });

  it("buildSessionListText empty list shows /new hint by default", () => {
    const text = buildSessionListText([], "proj");
    expect(text).toContain("`/new`");
    expect(text).toContain("创建新会话");
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

  it("buildSessionListText displays relative time", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const text = buildSessionListText(
      [{ id: "s1", title: "Task", time: { updated: twoHoursAgo } } as any],
      "proj",
    );
    expect(text).toContain("(2小时前)");
  });

  it("buildSessionListText truncates long titles", () => {
    const longTitle = "A".repeat(40);
    const text = buildSessionListText(
      [{ id: "s1", title: longTitle, time: { updated: Date.now() } } as any],
      "proj",
    );
    expect(text).toContain("A".repeat(28) + "…");
    expect(text).not.toContain(longTitle);
  });

  it("buildSessionListText groups worktree sessions by worktreeId", () => {
    const now = Date.now();
    const sessions = [
      { id: "n1", title: "Normal 1", time: { updated: now } },
      { id: "n2", title: "Normal 2", time: { updated: now - 1000 } },
      { id: "w1", title: "WT Task 1", worktreeId: "fix-ci", time: { updated: now - 2000 } },
      { id: "w2", title: "WT Task 2", worktreeId: "fix-ci", time: { updated: now - 3000 } },
      { id: "w3", title: "WT Task 3", worktreeId: "feat-login", time: { updated: now - 4000 } },
    ] as any[];
    const text = buildSessionListText(sessions, "proj");
    // Normal sessions first
    expect(text).toContain("1. Normal 1");
    expect(text).toContain("2. Normal 2");
    // Worktree group headers
    expect(text).toContain("🌿 fix-ci");
    expect(text).toContain("🌿 feat-login");
    // Numbering continues across groups
    expect(text).toContain("3. WT Task 1");
    expect(text).toContain("4. WT Task 2");
    expect(text).toContain("5. WT Task 3");
    // Group header comes before its sessions
    const fixCiPos = text.indexOf("🌿 fix-ci");
    const wtTask1Pos = text.indexOf("3. WT Task 1");
    expect(fixCiPos).toBeLessThan(wtTask1Pos);
  });

  it("buildSessionListText omits worktree header when no worktree sessions", () => {
    const text = buildSessionListText(
      [{ id: "n1", title: "Normal", time: { updated: Date.now() } } as any],
      "proj",
    );
    expect(text).not.toContain("🌿");
  });
});

describe("relativeTimeZh", () => {
  it("returns 刚刚 for recent timestamps", () => {
    expect(relativeTimeZh(Date.now())).toBe("刚刚");
    expect(relativeTimeZh(Date.now() - 30_000)).toBe("刚刚");
  });

  it("returns minutes for 1-59 minutes", () => {
    expect(relativeTimeZh(Date.now() - 5 * 60_000)).toBe("5分钟前");
    expect(relativeTimeZh(Date.now() - 59 * 60_000)).toBe("59分钟前");
  });

  it("returns hours for 1-23 hours", () => {
    expect(relativeTimeZh(Date.now() - 2 * 3600_000)).toBe("2小时前");
    expect(relativeTimeZh(Date.now() - 23 * 3600_000)).toBe("23小时前");
  });

  it("returns days for 1-6 days", () => {
    expect(relativeTimeZh(Date.now() - 3 * 86400_000)).toBe("3天前");
  });

  it("returns weeks for 1-4 weeks", () => {
    expect(relativeTimeZh(Date.now() - 14 * 86400_000)).toBe("2周前");
  });

  it("returns months for 5+ weeks", () => {
    expect(relativeTimeZh(Date.now() - 60 * 86400_000)).toBe("2月前");
  });
});

describe("truncateTitle", () => {
  it("returns title as-is when within limit", () => {
    expect(truncateTitle("short")).toBe("short");
  });

  it("returns title as-is when exactly at limit", () => {
    const exact = "A".repeat(28);
    expect(truncateTitle(exact)).toBe(exact);
  });

  it("truncates and adds ellipsis when over limit", () => {
    const long = "A".repeat(40);
    expect(truncateTitle(long)).toBe("A".repeat(28) + "…");
  });

  it("respects custom maxLen", () => {
    expect(truncateTitle("abcdefgh", 5)).toBe("abcde…");
  });
});

describe("groupAndSortSessions", () => {
  it("places normal sessions before worktree sessions", () => {
    const now = Date.now();
    const sessions = [
      { id: "w1", worktreeId: "wt", time: { updated: now } },
      { id: "n1", time: { updated: now - 1000 } },
    ] as any[];
    const result = groupAndSortSessions(sessions);
    expect(result[0].id).toBe("n1");
    expect(result[1].id).toBe("w1");
  });

  it("sorts each group by recency (most recent first)", () => {
    const now = Date.now();
    const sessions = [
      { id: "n1", time: { updated: now - 2000 } },
      { id: "n2", time: { updated: now } },
      { id: "w1", worktreeId: "wt", time: { updated: now - 3000 } },
      { id: "w2", worktreeId: "wt", time: { updated: now - 1000 } },
    ] as any[];
    const result = groupAndSortSessions(sessions);
    expect(result.map((s: any) => s.id)).toEqual(["n2", "n1", "w2", "w1"]);
  });

  it("groups worktree sessions by worktreeId and sorts groups by most-recent session", () => {
    const now = Date.now();
    const sessions = [
      { id: "a1", worktreeId: "alpha", time: { updated: now - 5000 } },
      { id: "b1", worktreeId: "beta", time: { updated: now - 1000 } },
      { id: "a2", worktreeId: "alpha", time: { updated: now - 3000 } },
    ] as any[];
    const result = groupAndSortSessions(sessions);
    // beta group (most recent at now-1000) comes before alpha group (now-3000)
    expect(result.map((s: any) => s.id)).toEqual(["b1", "a2", "a1"]);
  });

  it("returns empty array for empty input", () => {
    expect(groupAndSortSessions([])).toEqual([]);
  });
});

describe("markdown format", () => {
  it("builders use **bold** headers, not ───── dividers", () => {
    const projectList = buildProjectListText([
      { id: "p1", name: "alpha", directory: "/a", engineType: "claude" } as any,
    ]);
    expect(projectList).toContain("**📋 项目列表**");
    expect(projectList).not.toContain("─");

    const sessionList = buildSessionListText(
      [{ id: "s1", title: "T", time: { updated: Date.now() } } as any],
      "proj",
    );
    expect(sessionList).toContain("**📋 会话列表");
    expect(sessionList).not.toContain("─");

    const question = buildQuestionText("Q?", [{ id: "y", label: "Yes" }]);
    expect(question).toContain("**📋 Agent 提问**");
    expect(question).not.toContain("─");
  });

  it("buildSessionNotification uses **bold** and `code`", () => {
    const text = buildSessionNotification("codemux", "claude", "abc12345-long");
    expect(text).toContain("**codemux**");
    expect(text).toContain("`abc12345`");
  });
});

describe("markdownToTelegramHtml", () => {
  it("converts **bold** to <b>bold</b>", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts `code` to <code>code</code>", () => {
    expect(markdownToTelegramHtml("`abc`")).toBe("<code>abc</code>");
  });

  it("escapes HTML entities", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("handles mixed formatting", () => {
    const input = "**📋 项目列表**\n\n1. alpha\n\n使用 `/help` 查看。";
    const html = markdownToTelegramHtml(input);
    expect(html).toContain("<b>📋 项目列表</b>");
    expect(html).toContain("<code>/help</code>");
    expect(html).toContain("1. alpha");
  });

  it("returns plain text unchanged", () => {
    expect(markdownToTelegramHtml("no formatting")).toBe("no formatting");
  });
});
