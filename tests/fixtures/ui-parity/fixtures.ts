import { join } from "node:path";
import { normalizeCodexToolDisplayActions } from "../../../electron/main/engines/codex/converters";
import type {
  EngineType, ReasoningPart, TextPart, ToolPart, UnifiedMessage, UnifiedPart, UnifiedSession,
} from "../../../src/types/unified";

export const profiles = [
  { type: "opencode", label: "OpenCode", phased: false },
  { type: "copilot", label: "Copilot", phased: false },
  { type: "claude", label: "Claude", phased: false },
  { type: "codex", label: "Codex CLI", phased: true },
  { type: "codex-desktop", label: "Codex Desktop", phased: true },
] as const;

const fixtureTime = Date.UTC(2026, 9, 14, 0, 0, 0);

export function createFixtureSession(engineType: EngineType, directory: string): UnifiedSession {
  const profile = profiles.find((item) => item.type === engineType)!;
  return {
    id: `ui-parity-${engineType}`, engineType, directory,
    title: `UI parity - ${profile.label}`,
    time: { created: fixtureTime, updated: fixtureTime },
  };
}

export function richResponse(directory: string): string {
  const rows = Array.from({ length: 12 }, (_, i) =>
    `| Resource ${i + 1} | Completed | ${i + 1} files | A long description that preserves the original row and column boundaries |`);
  return [
    "The response keeps its own place between activity groups. **Readable progress**, useful details, and a quiet layout matter on every screen.",
    "## Rendering checks",
    "- A stable paragraph remains selectable while the tail grows.\n- 中文段落、标点和长路径应当正常换行。\n- [x] Preserve the original code and table values.\n- [ ] Verify keyboard, touch, and reduced motion.",
    "> The fixture uses synthetic data. No provider or native conversation is involved.",
    "```typescript\ninterface Result {\n  status: \"complete\";\n  description: string;\n}\n\nconst result: Result = {\n  status: \"complete\",\n  description: \"This intentionally long source line checks horizontal scrolling and wrapping without changing clipboard indentation or content.\",\n};\n\nconsole.log(result);\n```",
    ["| Resource | State | Count | Description |", "| --- | --- | ---: | --- |", ...rows].join("\n"),
    "Inline math: $E = mc^2$.\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
    "```mermaid\ngraph LR\n  Input[User input] --> Adapter[Engine adapter]\n  Adapter --> View[Shared renderer]\n  View --> Reply[Readable reply]\n```",
    `[Open source at line 124](<${join(directory, "sample source.ts")}:124>)`,
    `![Local fixture image](${join(directory, "image.png")})`,
    `![Unavailable image](${join(directory, "missing.png")})`,
    `![Local audio fixture](${join(directory, "sample.wav")})`,
    "[Ordinary HTTPS reference](https://example.com/reference)",
    "## Completion\n\nThe final answer stays visible after either activity group is collapsed. Sources and copy actions belong below the answer.",
  ].join("\n\n");
}

export function createFixtureMessages(session: UnifiedSession): UnifiedMessage[] {
  const profile = profiles.find((item) => item.type === session.engineType)!;
  const sessionId = session.id;
  const userId = `${sessionId}:user:0001`;
  const messageId = `${sessionId}:assistant:0001`;
  let order = 0;
  const base = (suffix: string) => ({ id: `${messageId}:${suffix}`, sessionId, messageId, order: order++ });
  const text = (suffix: string, value: string, phase?: TextPart["phase"]): TextPart => ({
    ...base(suffix), type: "text", text: value, completed: true,
    ...(profile.phased ? { phase } : {}),
  });
  const reasoning: ReasoningPart = {
    ...base("reasoning"), type: "reasoning", completed: true,
    text: "**Inspecting the shared renderer**\n\nThe public summary keeps useful context.\n\n- Inspect the existing structure.\n- Preserve every engine's visible content.\n\n**Later emphasis remains in the body.**",
    ...(profile.phased ? { summaryFormat: "heading-prefixed" as const } : {}),
    time: { start: fixtureTime + 100, end: fixtureTime + 1700 },
  };
  const tool = (suffix: string, normalizedTool: ToolPart["normalizedTool"], title: string, input: unknown, output: unknown, error?: string): ToolPart => ({
    ...base(suffix), type: "tool", callId: suffix, originalTool: normalizedTool,
    normalizedTool, title, kind: normalizedTool === "edit" ? "edit" : normalizedTool === "read" ? "read" : "other",
    state: { status: error ? "error" : "completed", input, output,
      ...(error ? { error } : {}),
      time: { start: fixtureTime + 2000, end: fixtureTime + 2300, duration: 300 },
    } as ToolPart["state"],
  });
  const parts: UnifiedPart[] = [
    text("commentary", "Checking the layout, output states, and reusable controls.", "commentary"),
    reasoning,
    tool("read", "read", "Read sample source.ts", { filePath: join(session.directory, "sample source.ts"), offset: 120, limit: 8 }, "120: const line120 = 120;\n121: const line121 = 121;\n122: const line122 = 122;"),
    tool("grep", "grep", "Search source files", { pattern: "conversation", path: session.directory }, "src/components/conversation.css\nsrc/components/SessionTurn.tsx"),
    tool("glob", "glob", "Find renderer components", { pattern: "src/components/**/*.tsx" }, "src/components/MessageList.tsx\nsrc/components/SessionTurn.tsx"),
    text("partial", "The first result is ready. Tool details remain available without interrupting this paragraph.", "partial"),
    tool("shell", "shell", "Check long command output", { command: "printf FIXTURE_OUTPUT", description: "Inspect a deterministic command transcript" }, Array.from({ length: 35 }, (_, i) => `fixture line ${String(i + 1).padStart(2, "0")}: rendered output remains readable`).join("\n")),
    { ...tool("edit", "edit", "Update sample source.ts", { filePath: join(session.directory, "sample source.ts"), oldString: "const enabled = false", newString: "const enabled = true" }, "Updated one file."), diff: "--- a/sample source.ts\n+++ b/sample source.ts\n@@ -1,2 +1,2 @@\n-const enabled = false;\n+const enabled = true;\n export { enabled };" },
    tool("failed", "shell", "Check unavailable optional resource", { command: "fixture-check optional-resource" }, "Partial output before the fixture error.", "The optional fixture resource is unavailable. This is an intentional, recoverable display case."),
    tool("unknown", "unknown", "Engine-specific operation with a long descriptive title that must leave room for its controls", { scope: "fixture", operation: "inspect" }, { result: "Readable fallback retained", count: 3 }),
    text("final", richResponse(session.directory), "final"),
  ];
  if (profile.phased) {
    const batch = tool("preparation", "shell", "Prepare the implementation", {
      command: "fixture preparation batch",
      commandActions: [
        { type: "read", command: "cat skill", name: "SKILL.md", path: "/Users/fixture/.agents/skills/ego-browser/SKILL.md", displayLabel: "Ego Browser" },
        { type: "read", command: "cat skill", name: "SKILL.md", path: "/Users/fixture/.agents/skills/frontend-design/SKILL.md", displayLabel: "Frontend Design" },
        { type: "read", command: "cat AGENTS.md", name: "AGENTS.md", path: join(session.directory, "AGENTS.md") },
        { type: "search", command: "rg native MEMORY.md", query: "codemux|native|engine", path: join(session.directory, "MEMORY.md") },
        { type: "unknown", command: "git status --short && git log -1 --oneline" },
      ],
    }, "Preparation complete.");
    parts.splice(1, 0, batch);
    for (const part of parts) {
      if (part.type !== "tool") continue;
      const input = part.state.input as Record<string, unknown> | undefined;
      if (input) part.displayActions = normalizeCodexToolDisplayActions(input, session.directory);
      if (part.callId === "shell" && part.state.status === "completed") {
        part.state = { ...part.state, output: "", metadata: { stdout: part.state.output } };
      }
    }
    parts.forEach((part, index) => { part.order = index; });
  }
  const final = parts.at(-1) as TextPart;
  final.citations = [{ note: "Synthetic fixture source; no private memory was read.", reference: "fixture:ui-parity" }];
  parts.push({ ...base("attachment"), type: "file", mime: "image/png", filename: "Local fixture image.png", url: "", sourcePath: join(session.directory, "image.png") });
  return [
    { id: userId, sessionId, role: "user", time: { created: fixtureTime }, parts: [
      { id: `${userId}:text`, messageId: userId, sessionId, type: "text", text: `Check the ${profile.label} conversation layout. Preserve this long path: /workspace/a-project-with-a-very-long-name/src/components/share/renderer-and-interactions.tsx.\n\nPlease keep tool details, readable summaries, code, tables, sources, and media usable on mobile.` },
    ] },
    { id: messageId, sessionId, role: "assistant", time: { created: fixtureTime + 100, completed: fixtureTime + 4000 },
      workingDirectory: session.directory, parts, tokens: { input: 1234, output: 567, cache: { read: 100, write: 20 } }, cost: 0.0123, modelId: "fixture-model", },
  ];
}

export function createHistory(session: UnifiedSession, count = 30): UnifiedMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const userId = `${session.id}:history:${index}:user`;
    const assistantId = `${session.id}:history:${index}:assistant`;
    return [
      { id: userId, sessionId: session.id, role: "user" as const, time: { created: fixtureTime - 100_000 + index * 2000 }, parts: [
        { id: `${userId}:text`, messageId: userId, sessionId: session.id, type: "text" as const, text: `Earlier request ${index + 1}` },
      ] },
      { id: assistantId, sessionId: session.id, role: "assistant" as const, time: { created: fixtureTime - 99_000 + index * 2000, completed: fixtureTime - 98_500 + index * 2000 }, workingDirectory: session.directory, parts: [
        { id: `${assistantId}:text`, messageId: assistantId, sessionId: session.id, type: "text" as const, text: `Earlier response ${index + 1}. This text establishes a stable reading position before the current turn.\n\nA second paragraph verifies history layout and session restoration.`, completed: true },
      ] },
    ];
  }).flat();
}

/** Full stored history; the test server returns its step parts only on message.steps. */
export function createLazyHistoryMessages(session: UnifiedSession): UnifiedMessage[] {
  const phased = profiles.find((profile) => profile.type === session.engineType)!.phased;
  const userId = `${session.id}:user:lazy`;
  const messageId = `${session.id}:assistant:lazy`;
  const base = (suffix: string, order: number) => ({ id: `${messageId}:${suffix}`, messageId, sessionId: session.id, order });
  const tool = (suffix: string, order: number): ToolPart => ({
    ...base(suffix, order), type: "tool", callId: suffix, normalizedTool: "shell", originalTool: "fixture_command",
    title: `Inspect lazy history ${suffix}`, kind: "other",
    state: { status: "completed", input: { command: `fixture-${suffix}` }, output: `LAZY_STEP_${suffix.toUpperCase()}`,
      time: { start: fixtureTime + 200, end: fixtureTime + 400, duration: 200 } },
  });
  const text = (suffix: string, order: number, value: string, phase: TextPart["phase"]): TextPart => ({
    ...base(suffix, order), type: "text", text: value, completed: true, ...(phased ? { phase } : {}),
  });
  return [
    { id: userId, sessionId: session.id, role: "user", time: { created: fixtureTime }, parts: [
      { id: `${userId}:text`, messageId: userId, sessionId: session.id, type: "text", text: `Restore ${session.id} cached reasoning and tool steps, then collapse them again.` },
    ] },
    { id: messageId, sessionId: session.id, role: "assistant", workingDirectory: session.directory,
      time: { created: fixtureTime + 100, completed: fixtureTime + 1000 }, parts: [
        text("commentary", 0, "LAZY_HISTORY_COMMENTARY remains readable.", "commentary"),
        { ...base("reasoning", 1), type: "reasoning", completed: true,
          text: "**Inspecting cached steps**\n\nLAZY_HISTORY_REASONING_BODY is available after the first request.",
          ...(phased ? { summaryFormat: "heading-prefixed" as const } : {}),
          time: { start: fixtureTime + 100, end: fixtureTime + 200 } },
        tool("first", 2),
        text("partial", 3, "LAZY_HISTORY_PARTIAL remains readable.", "partial"),
        tool("second", 4),
        { ...base("notice", 5), type: "system-notice", noticeType: "info", text: "LAZY_HISTORY_NOTICE remains readable." },
        text("final", 6, "LAZY_HISTORY_RESPONSE remains visible while the restored steps are collapsed.", "final"),
      ] },
  ];
}
