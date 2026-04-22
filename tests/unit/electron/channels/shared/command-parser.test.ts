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
});
