import type { UnifiedQuestion } from "../types/unified";

export interface QuestionContextInfo {
  isMultiQuestion: boolean;
  current: number;
  total: number;
}

export function getQuestionContext(
  question: Pick<UnifiedQuestion, "questions">,
  pageIndex: number,
): QuestionContextInfo {
  return {
    isMultiQuestion: question.questions.length > 1,
    current: Math.min(pageIndex + 1, Math.max(question.questions.length, 1)),
    total: Math.max(question.questions.length, 1),
  };
}
