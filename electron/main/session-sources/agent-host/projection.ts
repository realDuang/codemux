import { createHash } from "node:crypto";
import type {
  ChatInputAnswer, ChatInputRequest, ChatState, ToolCallState, StringOrMarkdown,
} from "@microsoft/agent-host-protocol";
import type { EngineType, UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion, SessionActivityStatus } from "../../../../src/types/unified";
import { inferToolKind, normalizeToolName } from "../../../../src/types/tool-mapping";
import { SESSION_FLAGS, type Wire } from "./wire";

export const isAgentHostSession = (id: string) => id.startsWith("ahp:");
export const nativeChatId = (source: string, chat: string) => `ahp:v1:${Buffer.from(JSON.stringify([source, chat])).toString("base64url")}`;
export const scopedId = (sessionId: string, ...parts: string[]) =>
  `ahp-${createHash("sha256").update(JSON.stringify([sessionId, ...parts])).digest("hex")}`;
export const text = (value: StringOrMarkdown | undefined) => typeof value === "string" ? value : value?.markdown ?? "";

export function activity(status: number): SessionActivityStatus {
  if ((status & SESSION_FLAGS.waiting) === SESSION_FLAGS.waiting) return "waiting";
  if (status & SESSION_FLAGS.active) return "running";
  if (status & SESSION_FLAGS.error) return "error";
  return "idle";
}

function input(tool: ToolCallState): unknown {
  const raw = "toolInput" in tool ? tool.toolInput : "partialInput" in tool ? tool.partialInput : undefined;
  if (typeof raw !== "string") return raw ?? {};
  try { return JSON.parse(raw); } catch { return { command: raw }; }
}

export type TurnProjectionCache = Map<string, { turn: object; directory: string; messages: UnifiedMessage[] }>;

export function projectChat(id: string, chat: ChatState, directory: string, engineType: EngineType, cache?: TurnProjectionCache): UnifiedMessage[] {
  const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])];
  if (cache) {
    const present = new Set(turns.map(turn => turn.id));
    for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
  }
  return turns.flatMap(turn => {
    const previous = cache?.get(turn.id);
    if (previous?.turn === turn && previous.directory === directory) return previous.messages;
    const created = Date.parse(turn.startedAt ?? chat.modifiedAt) || 0;
    const completed = "state" in turn;
    const end = created + ("duration" in turn ? turn.duration ?? 0 : 0);
    const userId = scopedId(id, turn.id, "user");
    const assistantId = scopedId(id, turn.id, "assistant");
    const userParts: UnifiedPart[] = [{
      type: "text", id: `${userId}-text`, sessionId: id, messageId: userId, text: turn.message.text,
    }];
    for (const [index, attachment] of (turn.message.attachments ?? []).entries()) {
      if (attachment.type === "embeddedResource" && /^image\/(png|jpeg|gif|webp)$/.test(attachment.contentType)) {
        userParts.push({ type: "file", id: `${userId}-image-${index}`, sessionId: id, messageId: userId,
          mime: attachment.contentType, url: `data:${attachment.contentType};base64,${attachment.data}`, filename: attachment.label });
      }
    }
    let error: string | undefined;
    const parts: UnifiedPart[] = [];
    for (const [order, part] of turn.responseParts.entries()) {
      const base = { sessionId: id, messageId: assistantId, order,
        id: scopedId(id, turn.id, part.kind === "toolCall" ? part.toolCall.toolCallId : "id" in part ? part.id : String(order)) };
      if (part.kind === "markdown") parts.push({ ...base, type: "text", text: part.content, completed });
      else if (part.kind === "reasoning") parts.push({ ...base, type: "reasoning", text: part.content });
      else if (part.kind === "systemNotification") parts.push({ ...base, type: "system-notice", noticeType: "info", text: text(part.content) });
      else if (part.kind === "contentRef") parts.push({ ...base, type: "system-notice", noticeType: "info", text: part.uri });
      else if (part.kind === "error") error = part.error.message;
      else if (part.kind === "toolCall") {
        const tool = part.toolCall;
        const toolInput = input(tool);
        const timing = { start: created, end, duration: Math.max(0, end - created) };
        const output = "content" in tool ? (tool.content ?? []).map(content =>
          content.type === "text" ? content.text : content.type === "terminal" ? content.result?.preview ?? content.title
            : content.type === "resource" ? content.uri : "").filter(Boolean).join("\n") : "";
        parts.push({ ...base, type: "tool", callId: tool.toolCallId, originalTool: tool.toolName,
          normalizedTool: normalizeToolName(engineType, tool.toolName), kind: inferToolKind(undefined, normalizeToolName(engineType, tool.toolName)),
          title: tool.displayName || tool.toolName,
          state: tool.status === "completed" ? (tool.success
            ? { status: "completed", input: toolInput, output, time: timing }
            : { status: "error", input: toolInput, output, error: tool.error?.message ?? text(tool.pastTenseMessage), time: timing })
            : tool.status === "cancelled" ? { status: "error", input: toolInput, error: text(tool.reasonMessage) || tool.reason, time: timing }
              : tool.status === "streaming" || tool.status === "pending-confirmation" ? { status: "pending", input: toolInput }
                : { status: "running", input: toolInput, time: { start: created } },
        });
      }
    }
    const messages = [
      { id: userId, sessionId: id, role: "user", parts: userParts, time: { created, completed: created }, workingDirectory: directory },
      { id: assistantId, sessionId: id, role: "assistant", parts, time: { created, ...(completed ? { completed: end } : {}) },
        workingDirectory: directory, modelId: turn.usage?.model ?? turn.message.model?.id, error,
        ...(turn.usage ? { tokens: { input: turn.usage.inputTokens ?? 0, output: turn.usage.outputTokens ?? 0,
          cache: { read: turn.usage.cacheReadTokens ?? 0, write: 0 } } } : {}) },
    ] satisfies UnifiedMessage[];
    cache?.set(turn.id, { turn, directory, messages });
    return messages;
  });
}

export interface PermissionRoute { permission: UnifiedPermission; turnId: string; tool: ToolCallState }
export interface QuestionRoute { question: UnifiedQuestion; turnId: string; request: ChatInputRequest }

export function projectInputs(id: string, chat: ChatState, engineType: EngineType): { permissions: PermissionRoute[]; questions: QuestionRoute[] } {
  const permissions: PermissionRoute[] = [];
  const questions: QuestionRoute[] = [];
  if (!chat.activeTurn) return { permissions, questions };
  const turnId = chat.activeTurn.id;
  for (const part of chat.activeTurn.responseParts) {
    if (part.kind === "toolCall" && (part.toolCall.status === "pending-confirmation" || part.toolCall.status === "pending-result-confirmation")) {
      const tool = part.toolCall;
      const options = tool.status === "pending-confirmation" ? tool.options : undefined;
      const rawInput = input(tool);
      const normalizedTool = normalizeToolName(engineType, tool.toolName);
      permissions.push({ turnId, tool, permission: {
        id: scopedId(id, turnId, tool.toolCallId, tool.status), sessionId: id, engineType,
        toolCallId: tool.toolCallId, toolName: normalizedTool,
        title: text(tool.invocationMessage) || tool.displayName, kind: inferToolKind(undefined, normalizedTool), rawInput,
        details: rawInput && typeof rawInput === "object" ? Object.entries(rawInput).map(([label, value]) => ({
          label, value: typeof value === "string" ? value : JSON.stringify(value), mono: true,
        })) : [],
        options: options?.length ? options.map(option => ({
          id: option.id, label: option.label, type: option.kind === "approve" ? "allow_once" : "reject_once",
        })) : [{ id: "allow", label: "", type: "allow_once" }, { id: "deny", label: "", type: "reject_once" }],
      } });
    } else if (part.kind === "inputRequest" && !part.response) {
      const request = part.request;
      let externalUrl: string | undefined;
      try {
        const url = new URL(request.url ?? "");
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) externalUrl = url.href;
      } catch { /* Non-URL elicitation. */ }
      questions.push({ turnId, request, question: {
        id: scopedId(id, turnId, request.id), sessionId: id, engineType, externalUrl, dismissStopsTurn: false,
        message: request.message,
        questions: (request.questions ?? []).map(question => ({
          question: question.message, header: question.title ?? question.message.slice(0, 30),
          options: "options" in question ? question.options.map(option => ({ label: option.label, description: option.description ?? "" }))
            : question.kind === "boolean" ? [{ label: "true", description: "" }, { label: "false", description: "" }] : [],
          multiple: question.kind === "multi-select",
          custom: "allowFreeformInput" in question ? question.allowFreeformInput === true : question.kind !== "boolean",
          preserveWhitespace: question.kind === "text", allowEmptyAnswer: question.required !== true,
        })),
      } });
    }
  }
  return { permissions, questions };
}

export function inputAnswers(request: ChatInputRequest, answers: string[][]): Record<string, Wire<ChatInputAnswer>> {
  const questions = request.questions ?? [];
  if (answers.length !== questions.length) throw new Error("Answer every question before submitting.");
  return Object.fromEntries(questions.map((question, index) => {
    const values = answers[index];
    if (!values.length) {
      if (question.required) throw new Error("A required answer is missing.");
      return [question.id, { state: "skipped" }];
    }
    let value: Wire<Extract<ChatInputAnswer, { value: unknown }>["value"]>;
    if (question.kind === "single-select" || question.kind === "multi-select") {
      const selected: string[] = [], freeform: string[] = [];
      for (const label of values) {
        const matches = question.options.filter(option => option.label === label);
        if (matches.length > 1) throw new Error("Ambiguous option labels. Answer this question in VS Code.");
        if (matches.length) selected.push(matches[0].id);
        else if (question.allowFreeformInput) freeform.push(label);
        else throw new Error("The selected answer is no longer available.");
      }
      if (question.kind === "single-select") {
        if (values.length !== 1) throw new Error("Select one answer.");
        value = { kind: "selected", value: selected[0] ?? "", ...(freeform.length ? { freeformValues: freeform } : {}) };
      } else {
        if (values.length < (question.min ?? 0) || values.length > (question.max ?? Infinity)) throw new Error("Invalid number of selections.");
        value = { kind: "selected-many", value: selected, ...(freeform.length ? { freeformValues: freeform } : {}) };
      }
    } else {
      if (values.length !== 1) throw new Error("Enter one answer.");
      const raw = values[0];
      if (question.kind === "boolean") {
        if (raw !== "true" && raw !== "false") throw new Error("Select true or false.");
        value = { kind: "boolean", value: raw === "true" };
      } else if (question.kind === "number" || question.kind === "integer") {
        const number = Number(raw);
        if (!raw.trim() || !Number.isFinite(number) || (question.kind === "integer" && !Number.isInteger(number))
          || number < (question.min ?? -Infinity) || number > (question.max ?? Infinity)) throw new Error("Enter a number within the requested range.");
        value = { kind: "number", value: number };
      } else {
        if (raw.length < (question.min ?? 0) || raw.length > (question.max ?? Infinity)) throw new Error("The answer length is outside the requested range.");
        value = { kind: "text", value: raw };
      }
    }
    return [question.id, { state: "submitted", value }];
  }));
}
