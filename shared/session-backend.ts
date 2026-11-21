import type {
  CodexServiceTier, EngineCatalogSnapshot, ReasoningEffort, UnifiedMessage,
  UnifiedPart, UnifiedPermission, UnifiedQuestion, UnifiedSession,
} from "../src/types/unified";

export interface SendMessageOptions {
  clientMessageId?: string;
  mode?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort | null;
  serviceTier?: CodexServiceTier | null;
  directory?: string;
}

/** Normalized conversation events shared by engine adapters and session sources. */
export interface SessionBackendEvents {
  "catalog.updated": (snapshot: EngineCatalogSnapshot) => void;
  "message.part.updated": (data: { sessionId: string; messageId: string; part: UnifiedPart }) => void;
  "message.updated": (data: { sessionId: string; message: UnifiedMessage }) => void;
  "message.removed": (data: { sessionId: string; messageId: string }) => void;
  "session.updated": (data: { session: Partial<UnifiedSession> & Pick<UnifiedSession, "id" | "engineType"> }) => void;
  "session.created": (data: { session: UnifiedSession }) => void;
  "session.removed": (data: { sessionId: string }) => void;
  "permission.asked": (data: { permission: UnifiedPermission }) => void;
  "permission.replied": (data: { permissionId: string; optionId: string }) => void;
  "question.asked": (data: { question: UnifiedQuestion }) => void;
  "question.replied": (data: { questionId: string; answers: string[][] }) => void;
  "message.queued": (data: { sessionId: string; messageId: string; queuePosition: number; clientMessageId?: string }) => void;
  "message.queued.consumed": (data: { sessionId: string; messageId: string; clientMessageId?: string }) => void;
}
