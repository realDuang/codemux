import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setReasoningEffort: vi.fn(),
  getEffectiveReasoningEffortForEngine: vi.fn(),
  notify: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../../src/lib/gateway-api", () => ({
  gateway: {
    setReasoningEffort: mocks.setReasoningEffort,
  },
}));

vi.mock("../../../../src/stores/config", () => ({
  getEffectiveReasoningEffortForEngine: mocks.getEffectiveReasoningEffortForEngine,
}));

vi.mock("../../../../src/lib/notifications", () => ({
  notify: mocks.notify,
}));

vi.mock("../../../../src/lib/logger", () => ({
  logger: {
    warn: mocks.warn,
  },
}));

import { syncReasoningEffortForSend } from "../../../../src/lib/reasoning-effort-sync";

describe("syncReasoningEffortForSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs the effective reasoning effort for the target session", async () => {
    mocks.getEffectiveReasoningEffortForEngine.mockReturnValue("high");

    await syncReasoningEffortForSend("session-1", "copilot" as any, "warning");

    expect(mocks.getEffectiveReasoningEffortForEngine).toHaveBeenCalledWith("copilot");
    expect(mocks.setReasoningEffort).toHaveBeenCalledWith("session-1", "high");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("passes null through when there is no effective reasoning effort", async () => {
    mocks.getEffectiveReasoningEffortForEngine.mockReturnValue(null);

    await syncReasoningEffortForSend("session-1", "claude" as any, "warning");

    expect(mocks.setReasoningEffort).toHaveBeenCalledWith("session-1", null);
  });

  it("warns the user and does not throw when effort sync fails", async () => {
    const error = new Error("sync failed");
    mocks.getEffectiveReasoningEffortForEngine.mockReturnValue("max");
    mocks.setReasoningEffort.mockRejectedValue(error);

    await expect(
      syncReasoningEffortForSend("session-1", "copilot" as any, "effort warning"),
    ).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledWith(
      "[SendMessage] Failed to sync reasoning effort before send:",
      error,
    );
    expect(mocks.notify).toHaveBeenCalledWith("effort warning", "warning", 5000);
  });
});
