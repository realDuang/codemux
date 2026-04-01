import { describe, expect, it, vi } from "vitest";

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  CopilotSession: vi.fn(),
}));

vi.mock("../../../../../electron/main/services/logger", () => ({
  copilotLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/engines/copilot/config", () => ({
  DEFAULT_MODES: [],
  readConfigModel: vi.fn(() => "gpt-5.4"),
  resolvePlatformCli: vi.fn(() => "copilot.exe"),
}));

import { CopilotSdkAdapter } from "../../../../../electron/main/engines/copilot/index";

describe("CopilotSdkAdapter", () => {
  it("does not reapply ~/.copilot/config.json model when listing models", async () => {
    const adapter = new CopilotSdkAdapter();
    const listModels = vi.fn(async () => [
      {
        id: "claude-opus-4.6-1m",
        name: "Claude Opus 4.6 (1M context)(Internal only)",
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
    ]);

    (adapter as any).status = "running";
    (adapter as any).client = { listModels };
    (adapter as any).currentModelId = "claude-opus-4.6-1m";

    const result = await adapter.listModels();

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(result.currentModelId).toBe("claude-opus-4.6-1m");
    expect((adapter as any).currentModelId).toBe("claude-opus-4.6-1m");
    expect(result.models.map((model) => model.modelId)).toEqual([
      "claude-opus-4.6-1m",
      "gpt-5.4",
    ]);
  });
});
