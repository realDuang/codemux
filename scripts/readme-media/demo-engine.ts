// ============================================================================
// Demo engine — a scripted, in-memory engine used only to record README media.
// It plays back curated agent turns (reasoning, tools, diffs, todos, answer)
// through the real EngineManager, and applies its file edits to the demo
// project so the file explorer and git panels show genuine changes.
// ============================================================================

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockEngineAdapter } from "../../electron/main/engines/mock-adapter";
import type {
  AgentMode,
  EngineCapabilities,
  EngineInfo,
  EngineType,
  MessagePromptContent,
  ModelListResult,
  PermissionReply,
  ReasoningPart,
  TextPart,
  ToolPart,
  UnifiedMessage,
  UnifiedPart,
} from "../../src/types/unified";
import { pickScenario, type Step } from "./scenarios";

interface DemoProfile {
  name: string;
  version: string;
  models: Array<{ id: string; name: string }>;
  modes: AgentMode[];
}

export const DEMO_PROFILES: Record<string, DemoProfile> = {
  claude: {
    name: "Claude Code",
    version: "2.1.0",
    models: [{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }, { id: "haiku", name: "Haiku" }],
    modes: [
      { id: "default", label: "Manual", description: "Ask before edits, shell commands and network access" },
      { id: "acceptEdits", label: "Accept Edits", description: "Auto-accept file edits" },
      { id: "plan", label: "Plan", description: "Explore and plan without editing files" },
    ],
  },
  copilot: {
    name: "GitHub Copilot",
    version: "1.0.0",
    models: [{ id: "gpt-5", name: "GPT-5" }, { id: "claude-sonnet", name: "Claude Sonnet" }],
    modes: [
      { id: "agent", label: "Agent", description: "Edit files and run commands" },
      { id: "plan", label: "Plan", description: "Plan before making changes" },
      { id: "autopilot", label: "Autopilot", description: "Work without asking" },
    ],
  },
  opencode: {
    name: "OpenCode",
    version: "1.0.0",
    models: [{ id: "anthropic/claude-sonnet", name: "Claude Sonnet" }, { id: "openai/gpt-5", name: "GPT-5" }],
    modes: [
      { id: "build", label: "Build", description: "Default build mode" },
      { id: "plan", label: "Plan", description: "Read-only planning mode" },
    ],
  },
  codex: {
    name: "Codex",
    version: "0.50.0",
    models: [{ id: "gpt-5-codex", name: "gpt-5-codex" }, { id: "gpt-5", name: "gpt-5" }],
    modes: [
      { id: "agent", label: "Agent", description: "Edit files and run commands" },
      { id: "plan", label: "Plan", description: "Read-only planning" },
    ],
  },
};

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${String(++counter).padStart(6, "0")}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DemoEngineAdapter extends MockEngineAdapter {
  private readonly profile: DemoProfile;
  /** Multiplies every scripted delay; 0 plays a turn instantly (used for seeding). */
  speed = Number(process.env.DEMO_SPEED ?? 1);
  private pendingPermission?: (optionId: string) => void;

  constructor(engineType: EngineType) {
    const profile = DEMO_PROFILES[engineType];
    super({ engineType, name: profile.name });
    this.profile = profile;
  }

  override getInfo(): EngineInfo {
    return { ...super.getInfo(), version: this.profile.version, authenticated: true } as EngineInfo;
  }

  override getCapabilities(): EngineCapabilities {
    return { ...super.getCapabilities(), imageAttachment: true, dynamicModes: false, availableModes: this.getModes() };
  }

  override getModes(): AgentMode[] {
    return this.profile.modes;
  }

  override async listModels(): Promise<ModelListResult> {
    return { models: this.profile.models.map((model) => ({ modelId: model.id, name: model.name, engineType: this.engineType })) };
  }

  override async replyPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    await super.replyPermission(permissionId, reply);
    this.pendingPermission?.(reply.optionId);
  }

  override async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string; directory?: string },
  ): Promise<UnifiedMessage> {
    const prompt = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    const session = (await this.getSession(sessionId))!;
    const directory = options?.directory ?? session.directory;
    if (session.title === "New Session" && prompt) {
      session.title = prompt.split("\n")[0].slice(0, 60);
      session.time.updated = Date.now();
      this.emit("session.updated", { session });
    }

    const scenario = pickScenario(prompt);
    const modelId = options?.modelId ?? this.profile.models[0].id;
    const message: UnifiedMessage = {
      id: nextId("msg"), sessionId, role: "assistant", time: { created: Date.now() }, parts: [],
      modelId, mode: options?.mode, workingDirectory: directory,
    };
    const wait = (ms: number) => (this.speed > 0 ? sleep(ms * this.speed) : Promise.resolve());
    const publish = (part: UnifiedPart) => {
      const index = message.parts.findIndex((item) => item.id === part.id);
      if (index >= 0) message.parts[index] = part; else message.parts.push(part);
      this.emit("message.part.updated", { sessionId, messageId: message.id, part: { ...part } as UnifiedPart });
    };
    const base = () => ({ id: nextId("part"), messageId: message.id, sessionId });

    this.emit("message.updated", { sessionId, message: { ...message, parts: [] } });
    await wait(400);

    for (const step of scenario.steps) await this.play(step, { directory, publish, base, wait, sessionId });

    message.time.completed = Date.now();
    message.tokens = scenario.tokens;
    message.cost = scenario.cost;
    this.emit("message.updated", { sessionId, message: { ...message, parts: message.parts.map((part) => ({ ...part })) } });
    return message;
  }

  private async play(step: Step, ctx: {
    directory: string; sessionId: string;
    publish: (part: UnifiedPart) => void;
    base: () => { id: string; messageId: string; sessionId: string };
    wait: (ms: number) => Promise<void>;
  }) {
    const { publish, base, wait, directory } = ctx;
    if (step.kind === "reasoning") {
      const part: ReasoningPart = { ...base(), type: "reasoning", text: "", completed: false, time: { start: Date.now() } };
      for (const chunk of words(step.text, 3)) {
        part.text += chunk;
        publish(part);
        await wait(45);
      }
      part.completed = true;
      part.time = { start: part.time!.start, end: Date.now() };
      publish(part);
      return;
    }
    if (step.kind === "text") {
      const part: TextPart = { ...base(), type: "text", text: "", completed: false };
      for (const chunk of words(step.text, 2)) {
        part.text += chunk;
        publish(part);
        await wait(28);
      }
      part.completed = true;
      publish(part);
      return;
    }
    if (step.kind === "permission") {
      const id = nextId("perm");
      const answered = new Promise<string>((resolve) => { this.pendingPermission = resolve; });
      this.emit("permission.asked", { permission: {
        id, sessionId: ctx.sessionId, engineType: this.engineType, title: step.title, kind: "other", toolName: "shell",
        details: [{ label: "Command", value: step.command, mono: true }],
        options: [
          { id: "allow_once", label: "Allow Once", type: "accept_once" },
          { id: "allow_always", label: "Always Allow", type: "accept_always" },
          { id: "reject", label: "Deny", type: "reject" },
        ],
      } });
      if (this.speed > 0) await Promise.race([answered, sleep(step.autoApproveMs ?? 60_000)]);
      this.pendingPermission = undefined;
      this.emit("permission.replied", { permissionId: id, optionId: "allow_once" });
      return;
    }

    // Tool step
    const input = typeof step.input === "function" ? step.input(directory) : step.input;
    const part: ToolPart = {
      ...base(), type: "tool", callId: nextId("call"), normalizedTool: step.tool, originalTool: step.originalTool ?? step.tool,
      title: step.title, kind: step.tool === "edit" || step.tool === "write" ? "edit" : step.tool === "read" ? "read" : "other",
      state: { status: "running", input, time: { start: Date.now() } },
    };
    if (step.file) part.locations = [{ path: join(directory, step.file) }];
    publish(part);
    await wait(step.durationMs ?? 700);
    if (step.apply && step.file) {
      const path = join(directory, step.file);
      const before = await readFile(path, "utf8").catch(() => "");
      const after = step.apply(before);
      await writeFile(path, after);
    }
    const start = (part.state as { time: { start: number } }).time.start;
    part.state = {
      status: "completed", input, output: step.output ?? "",
      ...(step.metadata ? { metadata: step.metadata } : {}),
      time: { start, end: Date.now(), duration: Date.now() - start },
    } as ToolPart["state"];
    if (step.diff) part.diff = step.diff;
    publish(part);
  }
}

/** Split text into small streaming chunks while keeping whitespace. */
function words(text: string, size: number): string[] {
  const tokens = text.match(/\S+\s*|\s+/g) ?? [];
  const chunks: string[] = [];
  for (let index = 0; index < tokens.length; index += size) chunks.push(tokens.slice(index, index + size).join(""));
  return chunks;
}
