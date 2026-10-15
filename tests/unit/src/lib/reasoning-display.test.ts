import { describe, expect, it } from "vitest";
import { getReasoningBody, getReasoningDisplayText, getReasoningDuration } from "../../../../src/lib/reasoning-display";

describe("getReasoningBody", () => {
  it("hides a leading summary title during streaming without showing partial bold syntax", () => {
    expect(getReasoningBody("  **Inspecting the", true)).toBe("");
    expect(getReasoningBody("**Inspecting the code**", true)).toBe("");
    expect(getReasoningBody("**Inspecting the code**\n\nChecking the adapter.", true))
      .toBe("Checking the adapter.");
  });

  it("retains later headings and emphasis when a summary completes", () => {
    const content = "**Inspecting the code**\n\nChecking **only** the adapter.\n\n## More context\n\nDetails.";
    expect(getReasoningBody(content, false))
      .toBe("Checking **only** the adapter.\n\n## More context\n\nDetails.");
  });

  it.each([
    "# Inspecting the code\n\nDetails.",
    "  ## Inspecting `the code`\n\nDetails.",
    "Inspecting the code\n===================\n\nDetails.",
    "__Inspecting the code__\n\nDetails.",
    "\r\n\r\n\r\n\r\n# Inspecting the code\r\n\r\nDetails.",
  ])("removes the first completed Markdown heading using its parsed block", (content) => {
    expect(getReasoningBody(content, false)).toBe("Details.");
  });

  it("preserves ordinary prose and headings that are not the first block", () => {
    const content = "Checking the adapter.\n\n## Further checks\n\nDetails.";
    expect(getReasoningBody(content, false)).toBe(content);
    expect(getReasoningBody("# Visible while streaming\n\nDetails.", true))
      .toBe("# Visible while streaming\n\nDetails.");
    expect(getReasoningBody("\n  Unchanged plain summary.", false)).toBe("\n  Unchanged plain summary.");
  });

  it("has no expandable body for a title-only completed summary", () => {
    expect(getReasoningBody("**Inspecting the code**", false)).toBe("");
    expect(getReasoningBody("## Inspecting the code", false)).toBe("");
  });
});

describe("getReasoningDuration", () => {
  it("uses only a valid authoritative completed interval", () => {
    expect(getReasoningDuration({ start: 1_000, end: 4_250 })).toBe(3_250);
    for (const time of [undefined, { start: 1_000 }, { start: 0, end: 4_000 },
      { start: 2_000, end: 1_000 }, { start: 2_000, end: 2_000 }, { start: Number.NaN, end: 4_000 }]) {
      expect(getReasoningDuration(time)).toBeUndefined();
    }
  });
});


describe("getReasoningDisplayText", () => {
  const part = (text: string) => ({ id: "reason", messageId: "message", sessionId: "session", type: "reasoning" as const, text });

  it.each(["**Do not run destructive commands.** Continue reading.", "## Reuse the existing token", "**Unfinished emphasis"])("preserves unmarked engine reasoning: %s", (text) => {
    expect(getReasoningDisplayText(part(text), true)).toBe(text);
    expect(getReasoningDisplayText(part(text), false)).toBe(text);
  });

  it("uses heading rules only for an explicitly normalized summary", () => {
    const summary = { ...part("**Inspecting**\n\nKeep the body."), summaryFormat: "heading-prefixed" as const };
    expect(getReasoningDisplayText(summary, true)).toBe("Keep the body.");
    expect(getReasoningDisplayText(summary, false)).toBe("Keep the body.");
  });
});
