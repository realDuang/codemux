import { describe, expect, it } from "vitest";
import {
  getPermissionTargets,
  getQuestionContext,
} from "../../../../src/components/input-area-context";

describe("input-area context helpers", () => {
  it("collects compact permission targets from patterns and raw input", () => {
    const targets = getPermissionTargets({
      patterns: ["src/**/*.ts", "README.md"],
      rawInput: {
        fileChanges: {
          "src/app.ts": { diff: "@@ -1 +1 @@" },
        },
        permissions: {
          fileSystem: {
            read: ["docs/guide.md"],
          },
        },
      },
      metadata: {
        grantRoot: "/repo",
      },
    });

    expect(targets).toEqual([
      "src/**/*.ts",
      "README.md",
      "docs/guide.md",
      "src/app.ts",
      "/repo",
    ]);
  });

  it("returns related tool and progress details for question prompts", () => {
    expect(getQuestionContext({
      toolCallId: "tool-plan-7",
      questions: [
        { header: "Plan Review", question: "Approve the plan?", options: [] },
        { header: "Follow-up", question: "Anything else?", options: [] },
      ],
    }, 0)).toEqual({
      toolCallId: "tool-plan-7",
      isMultiQuestion: true,
      current: 1,
      total: 2,
    });
  });
});
