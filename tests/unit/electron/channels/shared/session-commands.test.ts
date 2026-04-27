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
    setMode: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
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
      setMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      listModels: vi.fn(async () => ({
        models: [
          { modelId: "m1", name: "Model One" },
          { modelId: "m2", name: "Model Two" },
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

  it("/mode without args shows available modes", async () => {
    expect(await invoke(h, cmd("mode"))).toBe(true);
    const out = h.sendText.mock.calls[0][0];
    expect(out).toContain("模式列表");
    expect(out).toContain("`agent`");
    expect(out).toContain("`plan`");
    expect(out).toContain("`build`");
    expect(out).toContain("/mode agent");
    expect(out).not.toContain("<agent");
    expect(h.gatewayClient.setMode).not.toHaveBeenCalled();
  });

  it("/mode plan calls setMode and confirms", async () => {
    expect(await invoke(h, cmd("mode", { args: ["plan"] }))).toBe(true);
    expect(h.gatewayClient.setMode).toHaveBeenCalledWith({
      sessionId: "conv-1",
      modeId: "plan",
    });
    expect(h.sendText.mock.calls[0][0]).toContain("plan");
  });

  it("/model with no args lists models", async () => {
    expect(await invoke(h, cmd("model"))).toBe(true);
    expect(h.gatewayClient.listModels).toHaveBeenCalledWith("claude");
    const out = h.sendText.mock.calls[0][0];
    expect(out).toContain("Model One");
    expect(out).toContain("`m1`");
    expect(out).toContain("（当前）");
    expect(out).toContain("Model Two");
    expect(out).toContain("`m2`");
    expect(out).toContain("/model model-id");
  });

  it("/model list (subcommand) lists models", async () => {
    expect(await invoke(h, cmd("model", { subcommand: "list" }))).toBe(true);
    expect(h.gatewayClient.listModels).toHaveBeenCalled();
  });

  it("/model <id> calls setModel", async () => {
    expect(await invoke(h, cmd("model", { args: ["gpt-4o"] }))).toBe(true);
    expect(h.gatewayClient.setModel).toHaveBeenCalledWith({
      sessionId: "conv-1",
      modelId: "gpt-4o",
    });
    expect(h.sendText.mock.calls[0][0]).toContain("gpt-4o");
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
