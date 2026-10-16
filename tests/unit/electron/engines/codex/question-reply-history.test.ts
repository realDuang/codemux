import { describe, expect, it } from "vitest";
import { convertDesktopConversation } from "../../../../../electron/main/engines/codex/desktop-state";
import { convertThreadToMessages } from "../../../../../electron/main/engines/codex/converters";
import { projectCodexAsyncQuestionReply } from "../../../../../electron/main/engines/codex/async-questions";

const questionId = JSON.stringify(["request_user_input_async", "call_iE8krfBHuPeQOoL2a695L3Nj", 0]);
const question = "Is the application responsive now?";
const answer = "It is noticeably smoother";
const receipt = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questionId, question, answer }])}\n</send_user_message_question_reply>`;
const ask = { id: "call_iE8krfBHuPeQOoL2a695L3Nj", type: "agentMessage", text: "Please verify the update.", questions: [{ title: question, options: [answer] }] };
const reply = { id: "reply-after-completion", type: "userMessage", content: [{ type: "text", text: receipt }] };

describe("Codex question replies across turns", () => {
  it("shows a plain question summary while retaining its original Markdown", () => {
    const question = "Open [the **shared chat**](codex://threads/example)\n  and reply `OK`.";
    const input = `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: questionId, question, answer: "**Done**" }])}</send_user_message_question_reply>`;
    expect(projectCodexAsyncQuestionReply(input)?.questionReplies).toEqual([{
      question, answer: "**Done**", summary: "Open the shared chat and reply OK.",
    }]);
  });
  it("keeps a reply sent after the question turn as a readable user response", () => {
    const result = convertDesktopConversation({
      id: "thread", hostId: "local", cwd: "/repo", createdAt: 1, updatedAt: 3, resumeState: "resumed", requests: [],
      turns: [
        { turnId: "ask-turn", status: "completed", turnStartedAtMs: 1, items: [ask] },
        { turnId: "reply-turn", status: "completed", turnStartedAtMs: 2, items: [reply, { id: "final", type: "agentMessage", phase: "final_answer", text: "Confirmed." }] },
      ],
    });
    const message = result.messages.find(item => item.engineMeta?.codexItemId === reply.id)!;
    expect(message.role).toBe("user");
    expect(message.parts).toEqual([expect.objectContaining({
      type: "text", text: receipt, displayText: `${question}\n\n${answer}`, questionReplies: [{ question, answer }],
    })]);
    expect(result.questions).toEqual([]);
  });

  it("projects the same cross-turn receipt in CLI history without changing its native identity", () => {
    const result = convertThreadToMessages("thread", { thread: {
      id: "thread", createdAt: 1, cwd: "/repo", turns: [
        { id: "ask-turn", status: "completed", items: [ask] },
        { id: "reply-turn", status: "completed", items: [reply, { id: "final", type: "agentMessage", text: "Confirmed." }] },
      ],
    } });
    const message = result.find(item => item.role === "user")!;
    expect(message.id).toContain(reply.id);
    expect(message.parts[0]).toMatchObject({
      type: "text", text: receipt, displayText: `${question}\n\n${answer}`, questionReplies: [{ question, answer }],
    });
  });

  it("keeps a standalone native receipt readable when its question is absent", () => {
    const result = convertDesktopConversation({
      id: "thread", hostId: "local", cwd: "/repo", createdAt: 1, updatedAt: 3, resumeState: "resumed", requests: [],
      turns: [
        { turnId: "example-turn", status: "completed", items: [reply] },
      ],
    });
    const part = result.messages[0].parts[0];
    expect(result.messages[0].role).toBe("user");
    expect(part).toMatchObject({ type: "text", text: receipt, questionReplies: [{ question, answer }] });
    expect(result.questions).toEqual([]);
  });

  it.each([`Example: ${receipt}`, `\`\`\`xml\n${receipt}\n\`\`\``, "<send_user_message_question_reply>{bad JSON}</send_user_message_question_reply>"])(
    "preserves quoted or malformed receipt text", text => {
      const result = convertDesktopConversation({
        id: "thread", hostId: "local", cwd: "/repo", resumeState: "resumed", requests: [],
        turns: [{ turnId: "literal", status: "completed", items: [{ ...reply, content: [{ type: "text", text }] }] }],
      });
      const part = result.messages[0].parts[0];
      expect(part).toMatchObject({ type: "text", text });
      expect(part).not.toHaveProperty("questionReplies");
      expect(part).not.toHaveProperty("displayText");
    },
  );
});
