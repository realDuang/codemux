import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../electron/main/services/logger", () => ({
  copilotLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../../../electron/main/engines/copilot/config", () => ({
  DEFAULT_MODES: [],
  readConfigModel: vi.fn(() => undefined),
  resolvePlatformCli: vi.fn(() => undefined),
}));

import { CopilotSdkAdapter } from "../../../../../electron/main/engines/copilot/index";

describe("CopilotSdkAdapter reasoning effort", () => {
  let adapter: CopilotSdkAdapter;
  let mockSession: { rpc: { model: { switchTo: ReturnType<typeof vi.fn> } } };
  let mockClient: {
    getState: ReturnType<typeof vi.fn>;
    resumeSession: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new CopilotSdkAdapter();
    mockSession = {
      rpc: {
        model: {
          switchTo: vi.fn(),
        },
      },
    };
    mockClient = {
      getState: vi.fn(() => "connected"),
      resumeSession: vi.fn(async () => mockSession),
      createSession: vi.fn(async () => mockSession),
    };

    (adapter as any).status = "running";
    (adapter as any).client = mockClient;
    (adapter as any).subscribeToSessionEvents = vi.fn();
  });

  it("includes reasoning effort in resume session config", async () => {
    (adapter as any).currentModelId = "gpt-5.4";
    (adapter as any).sessionReasoningEfforts.set("session-1", "max");

    await (adapter as any).ensureActiveSession("session-1", "/repo");

    expect(mockClient.resumeSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        workingDirectory: "/repo",
      }),
    );
  });

  it("includes reasoning effort in create session config after resume miss", async () => {
    mockClient.resumeSession.mockRejectedValueOnce(new Error("Session not found"));
    (adapter as any).currentModelId = "gpt-5.4";
    (adapter as any).sessionReasoningEfforts.set("session-2", "high");

    await (adapter as any).ensureActiveSession("session-2", "/repo");

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        reasoningEffort: "high",
        workingDirectory: "/repo",
      }),
    );
  });

  it("clears the live session reasoning effort override when set to null", async () => {
    (adapter as any).currentModelId = "gpt-5.4";
    (adapter as any).activeSessions.set("session-1", mockSession);

    await adapter.setReasoningEffort("session-1", "max");
    expect(mockSession.rpc.model.switchTo).toHaveBeenLastCalledWith({
      modelId: "gpt-5.4",
      reasoningEffort: "xhigh",
    });

    await adapter.setReasoningEffort("session-1", null);

    expect((adapter as any).sessionReasoningEfforts.has("session-1")).toBe(false);
    expect(mockSession.rpc.model.switchTo).toHaveBeenLastCalledWith({
      modelId: "gpt-5.4",
    });
  });
});
