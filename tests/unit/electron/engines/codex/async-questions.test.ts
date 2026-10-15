import { describe, expect, it } from "vitest";
import { buildCodexAsyncQuestionReply, convertCodexAsyncQuestion, formatCodexAsyncQuestionReplies, getCodexAsyncQuestions, getPendingCodexAsyncQuestionGroups, parseCodexAsyncQuestionReplies } from "../../../../../electron/main/engines/codex/async-questions";

const firstReply = {
  questionItemId: '["request_user_input_async","call-native",0]',
  question: "Which target?", answer: "First",
};
const envelope = `<send_user_message_question_reply>\n${JSON.stringify([firstReply])}\n</send_user_message_question_reply>`;

describe("getCodexAsyncQuestions", () => {
  it("retains native indices and text while ignoring unsupported question data", () => {
    expect(getCodexAsyncQuestions({
      type: "agentMessage", id: "call-native",
      questions: [
        { title: " ", options: ["Unused"] },
        { title: " Which target? ", options: [" First ", "Second", 7] },
        { title: "Any details?" },
      ],
    })).toEqual([
      { id: '["request_user_input_async","call-native",1]', sourceItemId: "call-native", questionIndex: 1, title: " Which target? ", options: [" First ", "Second"] },
      { id: '["request_user_input_async","call-native",2]', sourceItemId: "call-native", questionIndex: 2, title: "Any details?", options: [] },
    ]);
    expect(getCodexAsyncQuestions({ type: "userMessage", id: "user", questions: [{ title: "Literal question" }] })).toEqual([]);
    expect(getCodexAsyncQuestions({ type: "agentMessage", questions: [{ title: "Missing identity" }] })).toEqual([]);
  });
});

describe("parseCodexAsyncQuestionReplies", () => {
  it("recognizes complete native replies from strings and single text blocks", () => {
    expect(parseCodexAsyncQuestionReplies(`\n${envelope}\n`)).toEqual([firstReply]);
    expect(parseCodexAsyncQuestionReplies([{ type: "text", text: envelope }])).toEqual([firstReply]);
    expect(parseCodexAsyncQuestionReplies(`<send_user_message_question_reply>${JSON.stringify(firstReply)}</send_user_message_question_reply>`)).toEqual([firstReply]);
  });

  it.each([
    `Example: ${envelope}`,
    `\`\`\`xml\n${envelope}\n\`\`\``,
    `> ${envelope}`,
    `${envelope}\nMore text`,
    JSON.stringify(envelope),
    [{ type: "text", text: envelope }, { type: "image", url: "local-image" }],
    [{ type: "text", text: envelope }, { type: "text", text: "More text" }],
    `<send_user_message_question_reply>[]</send_user_message_question_reply>`,
    `<send_user_message_question_reply>{bad JSON}</send_user_message_question_reply>`,
  ].map((input) => ({ input })))("preserves quoted, mixed, or malformed input as ordinary text", ({ input }) => {
    expect(parseCodexAsyncQuestionReplies(input)).toBeUndefined();
  });

  it.each([
    { ...firstReply, questionItemId: "call-native" },
    { ...firstReply, questionItemId: '["other","call-native",0]' },
    { ...firstReply, questionItemId: '["request_user_input_async","",0]' },
    { ...firstReply, questionItemId: '["request_user_input_async","call-native",-1]' },
    { ...firstReply, questionItemId: '["request_user_input_async","call-native",0.5]' },
    { ...firstReply, questionItemId: '["request_user_input_async","call-native",0,"extra"]' },
    { ...firstReply, question: 7 },
    { ...firstReply, answer: null },
  ])("rejects an entire batch with an invalid reply", (invalid) => {
    const input = `<send_user_message_question_reply>${JSON.stringify([firstReply, invalid])}</send_user_message_question_reply>`;
    expect(parseCodexAsyncQuestionReplies(input)).toBeUndefined();
  });
});

describe("getPendingCodexAsyncQuestionGroups", () => {
  it.each(["userMessage", "steeringUserMessage"])("keeps questions pending when a %s receipt mixes known and unknown identities", (type) => {
    const ask = { type: "agentMessage", id: "call-native", questions: [{ title: "Which target?" }] };
    const unknownReply = { ...firstReply, questionItemId: '["request_user_input_async","another-turn-call",0]' };
    const text = `<send_user_message_question_reply>${JSON.stringify([firstReply, unknownReply])}</send_user_message_question_reply>`;
    const input = [{ type: "text", text }];
    const reply = type === "userMessage" ? { type, content: input } : { type, status: "accepted", input };
    expect(getPendingCodexAsyncQuestionGroups({ turnId: "turn-native", status: "inProgress", items: [ask, reply] }))
      .toEqual([[{ id: firstReply.questionItemId, sourceItemId: "call-native", questionIndex: 0, title: "Which target?", options: [] }]]);
  });

  it("removes accepted same-turn replies while preserving pending and failed submissions", () => {
    const secondReply = { ...firstReply, questionItemId: '["request_user_input_async","call-native",1]' };
    const secondEnvelope = `<send_user_message_question_reply>${JSON.stringify(secondReply)}</send_user_message_question_reply>`;
    const thirdReply = { ...firstReply, questionItemId: '["request_user_input_async","call-native",2]' };
    const thirdEnvelope = `<send_user_message_question_reply>${JSON.stringify(thirdReply)}</send_user_message_question_reply>`;
    const items = [
      { type: "agentMessage", id: "call-native", questions: [{ title: "First?" }, { title: "Second?" }, { title: "Third?" }] },
      { type: "agentMessage", id: "other-call", questions: [{ title: "Separate call?" }] },
      { type: "steeringUserMessage", status: "accepted", input: [{ type: "text", text: envelope }] },
      { type: "userMessage", content: [{ type: "text", text: secondEnvelope }] },
      ...["pending", "failed", undefined].map((status) => ({
        type: "steeringUserMessage", status,
        input: [{ type: "text", text: thirdEnvelope }],
      })),
    ];
    expect(getPendingCodexAsyncQuestionGroups({ turnId: "turn-native", status: "inProgress", items })
      .map((group) => group.map((question) => question.id))).toEqual([
      ['["request_user_input_async","call-native",2]'],
      ['["request_user_input_async","other-call",0]'],
    ]);
    expect(getPendingCodexAsyncQuestionGroups({ id: "turn-native", status: "inProgress", items: items.slice(0, 1) })[0]).toHaveLength(3);
    expect(getPendingCodexAsyncQuestionGroups({ turnId: "turn-native", status: "completed", items })).toEqual([]);
    expect(getPendingCodexAsyncQuestionGroups({ status: "inProgress", items })).toEqual([]);
  });
});

describe("buildCodexAsyncQuestionReply", () => {
  const questions = getCodexAsyncQuestions({
    type: "agentMessage", id: "call-native",
    questions: [{ title: " Which target? " }, { title: "Optional?" }, { title: "Details?" }],
  });

  it("submits nonempty answers with their original question identities", () => {
    const result = buildCodexAsyncQuestionReply(questions, [[" First ", " Details "], ["  "], [" Last "]]);
    expect(result.replies).toEqual([
      { ...firstReply, question: " Which target? ", answer: "First\nDetails" },
      { questionItemId: '["request_user_input_async","call-native",2]', question: "Details?", answer: "Last" },
    ]);
    expect(parseCodexAsyncQuestionReplies(result.text)).toEqual(result.replies);
    expect(buildCodexAsyncQuestionReply(questions, [["First"]]).replies).toHaveLength(1);
  });

  it.each([
    [], [[], [" "], []], [["First"], [], [], ["Unexpected"]], [[7]], [null], "First",
  ].map((answers) => ({ answers })))("rejects empty, extra, or malformed answers without creating a reply", ({ answers }) => {
    expect(() => buildCodexAsyncQuestionReply(questions, answers as string[][])).toThrow(/answer/i);
  });
});

describe("convertCodexAsyncQuestion", () => {
  it("exposes native options with local dismissal and collision-free identity", () => {
    const questions = getCodexAsyncQuestions({ type: "agentMessage", id: "call-native", questions: [{ title: "Which target?", options: [" First ", "Second"] }] });
    const converted = convertCodexAsyncQuestion("thread-native", "turn-native", questions, "codex-desktop");
    expect(converted).toEqual({
      id: 'codex-async-question:["codex-desktop","local","thread-native","turn-native",["[\\"request_user_input_async\\",\\"call-native\\",0]"]]',
      sessionId: "thread-native", engineType: "codex-desktop", toolCallId: "call-native", dismissStopsTurn: false,
      questions: [{ question: "Which target?", header: "Which target?", options: [{ label: " First ", description: "" }, { label: "Second", description: "" }], custom: true, multiple: false }],
      metadata: { codexAsyncQuestions: questions, codexTurnId: "turn-native" },
    });
    expect(convertCodexAsyncQuestion("thread-native", "turn-native", questions, "codex").id).not.toBe(converted.id);
    expect(convertCodexAsyncQuestion("thread-native", "turn-native", questions, "codex-desktop", "remote").id).not.toBe(converted.id);
  });
});

describe("formatCodexAsyncQuestionReplies", () => {
  it("displays the questions and answers without the transport wrapper", () => {
    expect(formatCodexAsyncQuestionReplies([firstReply, { ...firstReply, question: "Details?", answer: "Line one\nLine two" }]))
      .toBe("Which target?\n\nFirst\n\nDetails?\n\nLine one\nLine two");
  });
});
