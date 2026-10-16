import type { TextPart, UnifiedQuestion } from "../../../../src/types/unified";
import { Lexer, type Token, type Tokens } from "marked";

export interface CodexAsyncQuestion {
  id: string;
  sourceItemId: string;
  questionIndex: number;
  title: string;
  options: string[];
}

export interface CodexAsyncQuestionReply {
  questionItemId: string;
  question: string;
  answer: string;
}

const REPLY_START = "<send_user_message_question_reply>";
const REPLY_END = "</send_user_message_question_reply>";

export function getCodexAsyncQuestions(item: unknown): CodexAsyncQuestion[] {
  const value = asRecord(item);
  if (value?.type !== "agentMessage" || !isNonemptyString(value.id) || !Array.isArray(value.questions)) return [];
  const sourceItemId = value.id;
  return value.questions.flatMap((entry, questionIndex) => {
    const question = asRecord(entry);
    if (!isNonemptyString(question?.title)) return [];
    return [{
      id: JSON.stringify(["request_user_input_async", sourceItemId, questionIndex]),
      sourceItemId, questionIndex, title: question.title,
      options: Array.isArray(question.options) ? question.options.filter((option): option is string => typeof option === "string") : [],
    }];
  });
}

export function parseCodexAsyncQuestionReplies(input: unknown): CodexAsyncQuestionReply[] | undefined {
  if (Array.isArray(input)) {
    if (input.length !== 1) return undefined;
    const block = asRecord(input[0]);
    input = block?.type === "text" ? block.text : undefined;
  }
  if (typeof input !== "string") return undefined;
  const text = input.trim();
  if (!text.startsWith(REPLY_START) || !text.endsWith(REPLY_END)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(REPLY_START.length, -REPLY_END.length));
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (entries.length === 0) return undefined;
    const replies: CodexAsyncQuestionReply[] = [];
    for (const entry of entries) {
      const reply = asRecord(entry);
      if (!reply || !isQuestionId(reply.questionItemId) || typeof reply.question !== "string" || typeof reply.answer !== "string") return undefined;
      replies.push({ questionItemId: reply.questionItemId, question: reply.question, answer: reply.answer });
    }
    return replies;
  } catch {
    return undefined;
  }
}

export function getPendingCodexAsyncQuestionGroups(turn: unknown): CodexAsyncQuestion[][] {
  const value = asRecord(turn);
  if (value?.status !== "inProgress" || !isNonemptyString(value.turnId ?? value.id) || !Array.isArray(value.items)) return [];
  const groups = value.items.map(getCodexAsyncQuestions);
  const knownIds = new Set(groups.flatMap((group) => group.map((question) => question.id)));
  const answered = new Set<string>();
  for (const entry of value.items) {
    const item = asRecord(entry);
    const input = item?.type === "userMessage" ? item.content
      : item?.type === "steeringUserMessage" && item.status === "accepted" ? item.input : undefined;
    const replies = parseCodexAsyncQuestionReplies(input);
    if (!replies?.every((reply) => knownIds.has(reply.questionItemId))) continue;
    for (const reply of replies) answered.add(reply.questionItemId);
  }
  return groups.flatMap((group) => {
    const pending = group.filter((question) => !answered.has(question.id));
    return pending.length > 0 ? [pending] : [];
  });
}

export function buildCodexAsyncQuestionReply(
  questions: readonly CodexAsyncQuestion[],
  answers: string[][],
): { text: string; replies: CodexAsyncQuestionReply[] } {
  if (!Array.isArray(answers) || answers.length > questions.length
    || answers.some((answer) => !Array.isArray(answer) || answer.some((value) => typeof value !== "string"))) {
    throw new Error("The async question answers do not match the pending questions.");
  }
  const replies = questions.flatMap((question, index): CodexAsyncQuestionReply[] => {
    const answer = (answers[index] ?? []).map((value) => value.trim()).filter(Boolean).join("\n");
    return answer ? [{ questionItemId: question.id, question: question.title, answer }] : [];
  });
  if (replies.length === 0) throw new Error("At least one non-empty answer is required.");
  return { text: `${REPLY_START}\n${JSON.stringify(replies)}\n${REPLY_END}`, replies };
}

export function convertCodexAsyncQuestion(
  sessionId: string,
  turnId: string,
  questions: CodexAsyncQuestion[],
  engineType: "codex" | "codex-desktop",
  hostId = "local",
): UnifiedQuestion {
  return {
    id: `codex-async-question:${JSON.stringify([engineType, hostId, sessionId, turnId, questions.map((question) => question.id)])}`,
    sessionId, engineType, toolCallId: questions[0]?.sourceItemId, dismissStopsTurn: false,
    questions: questions.map((question) => ({
      question: question.title, header: question.title.slice(0, 30),
      options: question.options.map((label) => ({ label, description: "" })),
      custom: true, multiple: false,
    })),
    metadata: { codexAsyncQuestions: questions, codexTurnId: turnId },
  };
}

export function formatCodexAsyncQuestionReplies(replies: readonly CodexAsyncQuestionReply[]): string {
  return replies.map((reply) => `${reply.question}\n\n${reply.answer}`).join("\n\n");
}

/** Native standalone receipts remain readable even after their question turn is paginated away. */
export function projectCodexAsyncQuestionReply(
  input: unknown,
): Pick<TextPart, "displayText" | "questionReplies"> | undefined {
  const replies = parseCodexAsyncQuestionReplies(input);
  if (!replies) return;
  return {
    displayText: formatCodexAsyncQuestionReplies(replies),
    questionReplies: replies.map(({ question, answer }) => {
      const summary = questionSummary(question);
      return { question, answer, ...(summary !== question ? { summary } : {}) };
    }),
  };
}

function questionSummary(markdown: string): string {
  const plain = (tokens: readonly Token[]): string => tokens.map(token => {
    if (token.type === "space" || token.type === "br" || token.type === "hr") return " ";
    if (token.type === "list") return token.items.map((item: Tokens.ListItem) => plain(item.tokens)).join(" ");
    if (token.type === "table") return [token.header, ...token.rows].flat().map(cell => plain(cell.tokens)).join(" ");
    if (token.type === "html") return token.text.replace(/<[^>]*>/g, "");
    if ("tokens" in token && Array.isArray(token.tokens)) {
      const text = plain(token.tokens);
      return token.type === "paragraph" || token.type === "heading" || token.type === "blockquote" ? `${text} ` : text;
    }
    return "text" in token && typeof token.text === "string" ? token.text : "";
  }).join("");
  return plain(Lexer.lex(markdown)).replace(/\s+/g, " ").trim();
}

function isQuestionId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const tuple: unknown = JSON.parse(value);
    return Array.isArray(tuple) && tuple.length === 3 && tuple[0] === "request_user_input_async"
      && isNonemptyString(tuple[1]) && Number.isSafeInteger(tuple[2]) && tuple[2] >= 0;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
