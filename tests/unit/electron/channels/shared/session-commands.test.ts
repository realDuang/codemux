import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessionOpsCommand } from "../../../../../electron/main/channels/shared/session-commands";
import type { ParsedCommand } from "../../../../../electron/main/channels/shared/command-types";
import type { SessionContext } from "../../../../../electron/main/channels/shared/session-commands";

function cmd(name: string, opts: Partial<ParsedCommand> = {}): ParsedCommand {
  return {
    command: name,
    args: opts.args ?? [],
    subcommand: opts.subcommand,
    raw: opts.raw ?? `/${name}`,
  };
}

interface Harness {
  sendText: ReturnType<typeof vi.fn>;
  gatewayClient: {
    cancelMessage: ReturnType<typeof vi.fn>;
    listModes: ReturnType<typeof vi.fn>;
    setMode: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    updateSessionConfig: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    listMessages: ReturnType<typeof vi.fn>;
  };
  context: SessionContext | null;
}

function makeHarness(context: SessionContext | null = defaultContext()): Harness {
  return {
    sendText: vi.fn(async () => undefined),
    gatewayClient: {
      cancelMessage: vi.fn(async () => undefined),
      listModes: vi.fn(async () => [
        { id: "bypassPermissions", label: "Bypass Permissions" },
        { id: "default", label: "Default" },
        { id: "plan", label: "Plan" },
      ]),
      setMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      updateSessionConfig: vi.fn(async () => undefined),
      getSession: vi.fn(async () => ({ id: "conv-1", engineType: "claude", directory: "/repo", mode: "plan", modelId: "m2" })),
      listModels: vi.fn(async () => ({
        models: [
          {
            modelId: "m1",
            name: "Model One",
            capabilities: {
              supportedReasoningEfforts: ["low", "medium"],
              defaultReasoningEffort: "medium",
            },
          },
          {
            modelId: "m2",
            name: "Model Two",
            capabilities: {
              supportedReasoningEfforts: ["low", "medium", "high"],
              defaultReasoningEffort: "high",
            },
          },
        ],
        currentModelId: "m1",
      })),
      listMessages: vi.fn(async () => []),
    },
    context,
  };
}

function defaultContext(): SessionContext {
  return {
    conversationId: "conv-1",
    engineType: "claude",
    title: "My Session",
    directory: "/home/user/proj",
  };
}

function invoke(h: Harness, c: ParsedCommand) {
  return handleSessionOpsCommand(c, {
    sendText: h.sendText as any,
    gatewayClient: h.gatewayClient as any,
    getContext: () => h.context,
  });
}

describe("handleSessionOpsCommand", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("returns false for non session-op commands", async () => {
    expect(await invoke(h, cmd("project"))).toBe(false);
    expect(await invoke(h, cmd("help"))).toBe(false);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("returns true and warns when no active context", async () => {
    h.context = null;
    expect(await invoke(h, cmd("status"))).toBe(true);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0][0]).toContain("当前没有活动会话");
  });

  it("/cancel calls gatewayClient.cancelMessage", async () => {
    expect(await invoke(h, cmd("cancel"))).toBe(true);
    expect(h.gatewayClient.cancelMessage).toHaveBeenCalledWith("conv-1");
    expect(h.sendText.mock.calls[0][0]).toContain("已取消");
  });

  it("/status renders project, engine, title and conv id", async () => {
    expect(await invoke(h, cmd("status"))).toBe(true);
    const out = h.sendText.mock.calls[0][0];
    expect(out).toContain("会话状态");
    expect(out).toContain("proj");
    expect(out).toContain("claude");
    expect(out).toContain("My Session");
    expect(out).toContain("conv-1");
  });

  it("/status without directory falls back to engine line", async () => {
    h.context = { conversationId: "c", engineType: "codex" };
    expect(await invoke(h, cmd("status"))).toBe(true);
    expect(h.sendText.mock.calls[0][0]).toContain("引擎：codex");
  });

  it("/mode with no args lists modes and marks the current session mode", async () => {
    expect(await invoke(h, cmd("mode"))).toBe(true);
    expect(h.gatewayClient.listModes).toHaveBeenCalledWith("claude");
    expect(h.gatewayClient.getSession).toHaveBeenCalledWith("conv-1");
    const out = h.sendText.mock.calls[0][0];
    expect(out).toContain("Default");
    expect(out).toContain("`default`");
    expect(out).toContain("Bypass Permissions");
    expect(out).toContain("Plan");
    expect(out).toContain("`plan`（当前会话）");
    expect(out).toContain("/mode mode-id");
  });

  it("/mode list (subcommand) lists modes", async () => {
    expect(await invoke(h, cmd("mode", { subcommand: "list" }))).toBe(true);
    expect(h.gatewayClient.listModes).toHaveBeenCalledWith("claude");
  });

  it("/mode <id> calls setMode for the current session", async () => {
    expect(await invoke(h, cmd("mode", { args: ["bypassPermissions"] }))).toBe(true);
    expect(h.gatewayClient.setMode).toHaveBeenCalledWith({
      sessionId: "conv-1",
      modeId: "bypassPermissions",
    });
    expect(h.sendText.mock.calls[0][0]).toContain("bypassPermissions");
  });

  it("/mode rejects modes not exposed by the current engine", async () => {
    expect(await invoke(h, cmd("mode", { args: ["autopilot"] }))).toBe(true);
    expect(h.gatewayClient.setMode).not.toHaveBeenCalled();
    expect(h.sendText.mock.calls[0][0]).toContain("当前引擎支持的模式");
  });

  it("/model with no args lists models and marks the current session model", async () => {
    expect(await invoke(h, cmd("model"))).toBe(true);
    expect(h.gatewayClient.listModels).toHaveBeenCalledWith("claude");
    expect(h.gatewayClient.getSession).toHaveBeenCalledWith("conv-1");
    const out = h.sendText.mock.calls[0][0];
    expect(out).toContain("Model One");
    expect(out).toContain("`m1`");
    expect(out).toContain("Model Two");
    expect(out).toContain("`m2`（当前会话）");
    expect(out).not.toContain("`m1`（当前会话）");
    expect(out).toContain("/model model-id");
  });

  it("/model list (subcommand) lists models", async () => {
    expect(await invoke(h, cmd("model", { subcommand: "list" }))).toBe(true);
    expect(h.gatewayClient.listModels).toHaveBeenCalled();
  });

  it("/model <id> updates the current session and recalibrates unsupported effort", async () => {
    h.gatewayClient.getSession.mockResolvedValueOnce({
      id: "conv-1",
      engineType: "claude",
      directory: "/repo",
      modelId: "m2",
      reasoningEffort: "high",
    });

    expect(await invoke(h, cmd("model", { args: ["m1"] }))).toBe(true);
    expect(h.gatewayClient.setModel).not.toHaveBeenCalled();
    expect(h.gatewayClient.updateSessionConfig).toHaveBeenCalledWith("conv-1", {
      modelId: "m1",
      reasoningEffort: "medium",
    });
    expect(h.sendText.mock.calls[0][0]).toContain("m1");
  });

  it("/model <id> preserves compatible current session effort", async () => {
    h.gatewayClient.getSession.mockResolvedValueOnce({
      id: "conv-1",
      engineType: "claude",
      directory: "/repo",
      modelId: "m2",
      reasoningEffort: "medium",
    });

    expect(await invoke(h, cmd("model", { args: ["m1"] }))).toBe(true);
    expect(h.gatewayClient.updateSessionConfig).toHaveBeenCalledWith("conv-1", {
      modelId: "m1",
      reasoningEffort: "medium",
    });
  });

  it("/model <id> clears effort when the target model has no effort support", async () => {
    h.gatewayClient.getSession.mockResolvedValueOnce({
      id: "conv-1",
      engineType: "claude",
      directory: "/repo",
      modelId: "m2",
      reasoningEffort: "high",
    });
    h.gatewayClient.listModels.mockResolvedValueOnce({
      models: [{ modelId: "m3", name: "Model Three" }],
      currentModelId: "m1",
    });

    expect(await invoke(h, cmd("model", { args: ["m3"] }))).toBe(true);
    expect(h.gatewayClient.updateSessionConfig).toHaveBeenCalledWith("conv-1", {
      modelId: "m3",
      reasoningEffort: null,
    });
  });

  it("/effort with no args lists efforts for the current session model", async () => {
    expect(await invoke(h, cmd("effort"))).toBe(true);
    expect(h.gatewayClient.listModels).toHaveBeenCalledWith("claude");
    expect(h.gatewayClient.getSession).toHaveBeenCalledWith("conv-1");
    const out = h.sendText.mock.calls[0][0];
    expect(out).toContain("当前模型：`m2`");
    expect(out).toContain("`low` · 低");
    expect(out).toContain("`medium` · 中");
    expect(out).toContain("`high` · 高（当前会话）");
    expect(out).toContain("/effort low|medium|high|max");
  });

  it("/effort list (subcommand) lists efforts", async () => {
    expect(await invoke(h, cmd("effort", { subcommand: "list" }))).toBe(true);
    expect(h.gatewayClient.listModels).toHaveBeenCalled();
  });

  it("/effort <level> updates the current session config", async () => {
    expect(await invoke(h, cmd("effort", { args: ["medium"] }))).toBe(true);
    expect(h.gatewayClient.updateSessionConfig).toHaveBeenCalledWith("conv-1", {
      reasoningEffort: "medium",
    });
    expect(h.sendText.mock.calls[0][0]).toContain("medium");
  });

  it("/effort rejects unsupported levels for the current model", async () => {
    expect(await invoke(h, cmd("effort", { args: ["max"] }))).toBe(true);
    expect(h.gatewayClient.updateSessionConfig).not.toHaveBeenCalled();
    expect(h.sendText.mock.calls[0][0]).toContain("当前模型支持的推理级别");
  });

  it("/history with no messages sends empty notice", async () => {
    expect(await invoke(h, cmd("history"))).toBe(true);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0][0]).toContain("暂无");
  });

  it("/history sends header then one message per entry", async () => {
    h.gatewayClient.listMessages = vi.fn(async () => [
      { role: "user", parts: [{ type: "text", text: "q" }] } as any,
      { role: "assistant", parts: [{ type: "text", text: "a" }] } as any,
    ]);
    expect(await invoke(h, cmd("history"))).toBe(true);
    expect(h.sendText).toHaveBeenCalledTimes(3);
    expect(h.sendText.mock.calls[0][0]).toContain("会话历史");
    expect(h.sendText.mock.calls[1][0]).toContain("👤 q");
    expect(h.sendText.mock.calls[2][0]).toContain("🤖 a");
  });
});
