import { describe, expect, it } from "vitest";
import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";

import { getClaudeReasoningCapabilities } from "../../../../../electron/main/engines/claude/index";

describe("getClaudeReasoningCapabilities", () => {
  it("filters invalid effort levels and picks a supported default", () => {
    const capabilities = getClaudeReasoningCapabilities({
      supportsEffort: true,
      supportedEffortLevels: ["high", "turbo", "max"] as any,
    } as ClaudeModelInfo);

    expect(capabilities).toEqual({
      reasoning: true,
      supportedReasoningEfforts: ["high", "max"],
      defaultReasoningEffort: "high",
    });
  });

  it("falls back to the full effort set when the SDK omits supported levels", () => {
    const capabilities = getClaudeReasoningCapabilities({
      supportsEffort: true,
      supportedEffortLevels: undefined,
    } as ClaudeModelInfo);

    expect(capabilities).toEqual({
      reasoning: true,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "medium",
    });
  });
});
