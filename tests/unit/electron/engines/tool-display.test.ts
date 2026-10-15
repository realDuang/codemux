import { describe, expect, it } from "vitest";
import { deriveToolDisplayActions, displayPath, normalizeMessageToolDisplay, normalizeToolPartDisplay } from "../../../../electron/main/engines/tool-display";
import type { NormalizedToolName, ToolPart, UnifiedMessage } from "../../../../src/types/unified";

const tool = (normalizedTool: NormalizedToolName, input: Record<string, unknown>, extra: Partial<ToolPart> = {}): ToolPart => ({
  id: `part-${normalizedTool}`, messageId: "msg", sessionId: "session", type: "tool", callId: "call",
  normalizedTool, originalTool: normalizedTool, title: normalizedTool, kind: "other",
  state: { status: "completed", input, output: "", time: { start: 1, end: 2, duration: 1 } },
  ...extra,
});

describe("deriveToolDisplayActions", () => {
  const cwd = "/repo";

  it("reads every engine's file-path key and shows it relative to the session", () => {
    expect(deriveToolDisplayActions(tool("read", { filePath: "/repo/src/a.ts" }), cwd)).toEqual([{ kind: "read", path: "src/a.ts" }]); // OpenCode, Claude
    expect(deriveToolDisplayActions(tool("read", { path: "/repo/README.md" }), cwd)).toEqual([{ kind: "read", path: "README.md" }]); // Copilot
    expect(deriveToolDisplayActions(tool("read", { file_path: "/elsewhere/b.ts" }), cwd)).toEqual([{ kind: "read", path: "/elsewhere/b.ts" }]);
  });

  it("maps commands, searches, listings, edits and fetches", () => {
    expect(deriveToolDisplayActions(tool("shell", { command: "npm test" }))).toEqual([{ kind: "shell", command: "npm test" }]);
    expect(deriveToolDisplayActions(tool("shell", { cmd: ["git", "status"] }))).toEqual([{ kind: "shell", command: "git status" }]);
    expect(deriveToolDisplayActions(tool("grep", { pattern: "TODO", path: "/repo/src" }), cwd)).toEqual([{ kind: "search", query: "TODO", path: "src" }]);
    expect(deriveToolDisplayActions(tool("glob", { pattern: "**/*.ts" }))).toEqual([{ kind: "search", query: "**/*.ts" }]);
    expect(deriveToolDisplayActions(tool("list", {}))).toEqual([{ kind: "list", path: "." }]);
    expect(deriveToolDisplayActions(tool("web_fetch", { url: "https://example.com" }))).toEqual([{ kind: "web", label: "https://example.com" }]);
    expect(deriveToolDisplayActions(tool("edit", { filePath: "/repo/a.ts" }, { locations: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }] }), cwd))
      .toEqual([{ kind: "edit", path: "a.ts" }, { kind: "edit", path: "b.ts" }]);
  });

  it("leaves tools without usable input to the adapter title", () => {
    expect(deriveToolDisplayActions(tool("shell", {}))).toBeUndefined();
    expect(deriveToolDisplayActions(tool("unknown", { anything: 1 }))).toBeUndefined();
    expect(deriveToolDisplayActions(tool("task", { description: "Delegate" }))).toBeUndefined();
  });
});

describe("normalizeToolPartDisplay", () => {
  it("keeps native display actions and diffs from the adapter", () => {
    const native = tool("shell", { command: "sed -n 1,20p a.ts" }, { displayActions: [{ kind: "read", path: "a.ts" }], diff: "native" });
    expect(normalizeToolPartDisplay(native)).toBe(native);
  });

  it("lifts a metadata diff and leaves non-tool parts untouched", () => {
    const edit = tool("edit", { filePath: "a.ts" });
    (edit.state as { metadata?: unknown }).metadata = { diff: "--- a\n+++ b" };
    expect(normalizeToolPartDisplay(edit)).toMatchObject({ diff: "--- a\n+++ b", displayActions: [{ kind: "edit", path: "a.ts" }] });
    const text = { id: "t", messageId: "msg", sessionId: "session", type: "text" as const, text: "hi" };
    expect(normalizeToolPartDisplay(text)).toBe(text);
  });

  it("uses the message working directory for whole messages", () => {
    const message: UnifiedMessage = { id: "msg", sessionId: "session", role: "assistant", time: { created: 1 }, workingDirectory: "/repo", parts: [tool("read", { filePath: "/repo/x.ts" })] };
    expect(normalizeMessageToolDisplay(message).parts[0]).toMatchObject({ displayActions: [{ kind: "read", path: "x.ts" }] });
  });
});

describe("displayPath", () => {
  it("handles Windows separators and the session root", () => {
    expect(displayPath("C:\\repo\\src\\a.ts", "C:\\repo")).toBe("src/a.ts");
    expect(displayPath("/repo", "/repo")).toBe("/repo");
  });
});

describe("malformed tool parts", () => {
  it("tolerates stored parts without state", () => {
    const legacy = { ...tool("read", {}), state: undefined } as unknown as ToolPart;
    expect(normalizeToolPartDisplay(legacy)).toBe(legacy);
  });
});
