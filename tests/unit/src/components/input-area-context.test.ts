import { describe, expect, it } from "vitest";
import {
  getQuestionContext,
} from "../../../../src/components/input-area-context";

describe("input-area context helpers", () => {
  it("returns progress details for question prompts", () => {
    expect(getQuestionContext({
      questions: [
        { header: "Plan Review", question: "Approve the plan?", options: [] },
        { header: "Follow-up", question: "Anything else?", options: [] },
      ],
    }, 0)).toEqual({
      isMultiQuestion: true,
      current: 1,
      total: 2,
    });
  });
});
