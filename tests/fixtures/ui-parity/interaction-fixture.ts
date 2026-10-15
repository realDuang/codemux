import {
  buildCodexAsyncQuestionReply,
  convertCodexAsyncQuestion,
  formatCodexAsyncQuestionReplies,
  getCodexAsyncQuestions,
  parseCodexAsyncQuestionReplies,
  type CodexAsyncQuestion,
} from "../../../electron/main/engines/codex/async-questions";
import { convertApprovalToPermission, convertUserInputToQuestion } from "../../../electron/main/engines/codex/converters";
import type { GatewayNotification, UnifiedMessage, UnifiedPermission, UnifiedQuestion, UnifiedSession } from "../../../src/types/unified";

export interface FixtureGatewayRequest {
  type?: string;
  requestId?: string;
  token?: string;
  payload?: Record<string, unknown>;
}

interface InteractionFixtureOptions {
  session: UnifiedSession;
  emit: (notification: GatewayNotification) => void;
  publishReceipt: (message: UnifiedMessage) => Promise<void>;
}

interface PendingQuestion {
  question: UnifiedQuestion;
  kind: "async" | "blocking";
  turnId: string;
  definitions?: CodexAsyncQuestion[];
  blockingIds?: string[];
}

interface SubmittedAnswer {
  kind: "async" | "blocking";
  questionId: string;
  answers: string[][];
  questionItemIds?: string[];
  envelopeValidated?: boolean;
  nativeResponse?: { answers: Record<string, { answers: string[] }> };
}

/** Synthetic interactions only; no provider, native owner, or command is invoked. */
export function createInteractionFixture({ session, emit, publishReceipt }: InteractionFixtureOptions) {
  const questions = new Map<string, PendingQuestion>();
  const permissions = new Map<string, UnifiedPermission>();
  const submittedAnswers: SubmittedAnswer[] = [];
  const permissionDecisions: { permissionId: string; optionId: string; decision: string; executed: false }[] = [];
  const dismissals: { questionId: string; kind: "async" | "blocking"; interrupted: boolean }[] = [];
  let sequence = 0;
  let interruptions = 0;
  let cancelRequests = 0;

  const ask = (pending: PendingQuestion) => {
    questions.set(pending.question.id, pending);
    emit({ type: "question.asked", payload: { question: pending.question } });
  };
  const settle = (questionId: string, answers: string[][]) => {
    questions.delete(questionId);
    emit({ type: "question.replied", payload: { questionId, answers } });
  };
  const receipt = async (text: string) => {
    const id = `${session.id}:interaction-receipt:${++sequence}`;
    const now = Date.now();
    await publishReceipt({
      id, sessionId: session.id, role: "assistant", workingDirectory: session.directory,
      time: { created: now, completed: now },
      parts: [{ id: `${id}:text`, messageId: id, sessionId: session.id, type: "text", text, phase: "final", completed: true }],
    });
  };

  return {
    sessionId: session.id,

    create(kind: string | null) {
      if (kind !== "async" && kind !== "blocking" && kind !== "permission") {
        throw new Error("Choose an interaction kind: async, blocking, or permission.");
      }
      const id = `${session.id}:interaction:${++sequence}`;
      const turnId = `${id}:turn`;
      if (kind === "async") {
        const definitions = getCodexAsyncQuestions({
          type: "agentMessage", id: `${id}:agent-message`,
          questions: [
            { title: "Which fixture target should the preview use?", options: ["Local", "Remote"] },
            { title: "Add a short fixture note.", options: [] },
          ],
        });
        const question = convertCodexAsyncQuestion(session.id, turnId, definitions, "codex-desktop");
        ask({ question, kind, turnId, definitions });
        return { kind, questionId: question.id };
      }
      if (kind === "blocking") {
        const params = {
          itemId: `${id}:tool`, questions: [{
            id: "fixture_output", header: "Fixture output", question: "Which fixture output should be shown?",
            options: [{ label: "Summary", description: "Show the short fixture summary." }, { label: "Details", description: "Show the fixture details." }],
          }],
        };
        const question = { ...convertUserInputToQuestion(session.id, id, params), engineType: "codex-desktop" as const, dismissStopsTurn: true };
        ask({ question, kind, turnId, blockingIds: params.questions.map((item) => item.id) });
        return { kind, questionId: question.id };
      }
      const permission = {
        ...convertApprovalToPermission(session.id, id, "item/commandExecution/requestApproval", {
          itemId: `${id}:command`, command: "printf UI_PARITY_PERMISSION",
          reason: "Record a synthetic permission decision. The fixture does not execute this command.",
          availableDecisions: ["accept", "decline"],
        }), engineType: "codex-desktop" as const,
      };
      permissions.set(permission.id, permission);
      emit({ type: "permission.asked", payload: { permission } });
      return { kind, permissionId: permission.id };
    },

    async handleRequest(request: FixtureGatewayRequest, authenticated: boolean): Promise<unknown | undefined> {
      const payload = request.payload ?? {};
      if (authenticated && request.type === "message.cancel" && payload.sessionId === session.id) cancelRequests++;
      const questionId = typeof payload.questionId === "string" ? payload.questionId : "";
      const permissionId = typeof payload.permissionId === "string" ? payload.permissionId : "";
      const pending = ["question.reply", "question.reject"].includes(request.type ?? "") ? questions.get(questionId) : undefined;
      const permission = request.type === "permission.reply" ? permissions.get(permissionId) : undefined;
      const listing = request.type === "pending.list" && payload.sessionId === session.id;
      // Unknown requests continue through the fixture's normal upstream bridge.
      if (!listing && !pending && !permission) return undefined;
      if (!authenticated) throw new Error("Fixture authentication is required.");
      if (payload.sessionId !== undefined && payload.sessionId !== session.id) {
        throw new Error("The interaction belongs to another fixture session.");
      }
      if (listing) return { questions: [...questions.values()].map((item) => item.question), permissions: [...permissions.values()] };
      if (permission) {
        const optionId = payload.optionId;
        if (typeof optionId !== "string" || !permission.options.some((option) => option.id === optionId)) {
          throw new Error("Choose one of the pending fixture permission options.");
        }
        permissions.delete(permissionId);
        permissionDecisions.push({ permissionId, optionId, decision: optionId === "allow_once" ? "accept" : "decline", executed: false });
        emit({ type: "permission.replied", payload: { permissionId, optionId } });
        return { success: true };
      }
      if (!pending) return undefined;
      if (request.type === "question.reject") {
        const interrupted = pending.kind === "blocking";
        dismissals.push({ questionId, kind: pending.kind, interrupted });
        if (interrupted) interruptions++;
        settle(questionId, []);
        return { success: true };
      }
      const answers = readAnswers(payload.answers, pending.question.questions.length);
      if (pending.kind === "async") {
        const definitions = pending.definitions!;
        const envelope = buildCodexAsyncQuestionReply(definitions, answers);
        const parsed = parseCodexAsyncQuestionReplies(envelope.text);
        if (!parsed || JSON.stringify(parsed) !== JSON.stringify(envelope.replies)) {
          throw new Error("The fixture async reply envelope did not round-trip.");
        }
        const answeredIds = new Set(parsed.map((reply) => reply.questionItemId));
        submittedAnswers.push({ kind: "async", questionId, answers, questionItemIds: [...answeredIds], envelopeValidated: true });
        settle(questionId, answers);
        const remaining = definitions.filter((definition) => !answeredIds.has(definition.id));
        if (remaining.length > 0) ask({
          ...pending, definitions: remaining,
          question: convertCodexAsyncQuestion(session.id, pending.turnId, remaining, "codex-desktop"),
        });
        await receipt(`Fixture answer received.\n\n${formatCodexAsyncQuestionReplies(parsed)}`);
      } else {
        const nativeResponse = { answers: Object.fromEntries((pending.blockingIds ?? []).map((id, index) => [id, { answers: answers[index] ?? [] }])) };
        submittedAnswers.push({ kind: "blocking", questionId, answers, nativeResponse });
        settle(questionId, answers);
        await receipt(`Fixture answer received.\n\n${answers.flat().join("\n")}`);
      }
      return { success: true };
    },

    state() {
      return {
        sessionId: session.id, pendingQuestionIds: [...questions.keys()], pendingPermissionIds: [...permissions.keys()],
        submittedAnswers, permissionDecisions, dismissals, interruptions, cancelRequests,
      };
    },

    reset() {
      for (const questionId of questions.keys()) settle(questionId, []);
      for (const permissionId of permissions.keys()) emit({ type: "permission.replied", payload: { permissionId, optionId: "reject_once" } });
      permissions.clear();
      submittedAnswers.length = 0;
      permissionDecisions.length = 0;
      dismissals.length = 0;
      interruptions = 0;
      cancelRequests = 0;
    },
  };
}

function readAnswers(value: unknown, questionCount: number): string[][] {
  if (!Array.isArray(value) || value.length > questionCount
    || value.some((answer) => !Array.isArray(answer) || answer.some((item) => typeof item !== "string"))) {
    throw new Error("The fixture answers do not match the pending questions.");
  }
  return value.map((answer: string[]) => [...answer]);
}
