// ============================================================================
// Mock Engine Adapter — In-memory fake engine for E2E testing
// Implements all abstract methods with canned responses and in-memory storage.
// ============================================================================

import { EngineAdapter } from "./engine-adapter";

// Monotonically increasing ID generator — ensures messages sort in creation
// order when the store uses string-comparison sorting (alphabetical by id).
let _idCounter = 0;
function orderedId(prefix = "mock"): string {
  return `${prefix}-${String(++_idCounter).padStart(12, "0")}`;
}
import type {
  EngineType,
  EngineStatus,
  EngineCapabilities,
  EngineInfo,
  AuthMethod,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  ModelListResult,
  UnifiedProject,
  AgentMode,
  MessagePromptContent,
  PermissionReply,
  TextPart,
} from "../../../src/types/unified";

export interface MockAdapterOptions {
  engineType: EngineType;
  name?: string;
}

/**
 * A fully in-memory engine adapter for E2E and integration testing.
 * All data is stored in Maps/arrays, no external processes or I/O.
 */
export class MockEngineAdapter extends EngineAdapter {
  readonly engineType: EngineType;
  private readonly adapterName: string;

  private status: EngineStatus = "stopped";
  private sessions: Map<string, UnifiedSession> = new Map();
  private messages: Map<string, UnifiedMessage[]> = new Map();
  private sessionModels: Map<string, string> = new Map();
  private sessionModes: Map<string, string> = new Map();
  private currentMode: string = "agent";
  private slowResponseDelay: number = 0;
  private pendingAbort: Map<string, AbortController> = new Map();

  constructor(options: MockAdapterOptions) {
    super();
    this.engineType = options.engineType;
    this.adapterName = options.name ?? `Mock ${options.engineType}`;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.status = "starting";
    this.emit("status.changed", {
      engineType: this.engineType,
      status: "starting",
    });
    this.status = "running";
    this.emit("status.changed", {
      engineType: this.engineType,
      status: "running",
    });
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    this.emit("status.changed", {
      engineType: this.engineType,
      status: "stopped",
    });
  }

  async healthCheck(): Promise<boolean> {
    return this.status === "running";
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: this.adapterName,
      version: "1.0.0-mock",
      status: this.status,
      capabilities: this.getCapabilities(),
      authMethods: this.getAuthMethods(),
    };
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: false,
      dynamicModes: true,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: false,
      loadSession: true,
      listSessions: true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    const all = Array.from(this.sessions.values());
    if (directory) {
      return all.filter((s) => s.directory === directory);
    }
    return all;
  }

  async createSession(directory: string): Promise<UnifiedSession> {
    const now = Date.now();
    const session: UnifiedSession = {
      id: orderedId(),
      engineType: this.engineType,
      directory,
      title: "New Session",
      time: { created: now, updated: now },
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.emit("session.created", { session });
    return session;
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    this.sessionModels.delete(sessionId);
    this.sessionModes.delete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: { mode?: string; modelId?: string },
  ): Promise<UnifiedMessage> {
    const now = Date.now();
    const userText =
      content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n") || "";

    // Store the user message
    const userMessage: UnifiedMessage = {
      id: orderedId(),
      sessionId,
      role: "user",
      time: { created: now, completed: now },
      parts: [
        {
          id: orderedId(),
          messageId: "", // filled below
          sessionId,
          type: "text",
          text: userText,
        } as TextPart,
      ],
      modelId: options?.modelId ?? "mock/test-model",
      mode: options?.mode,
    };
    userMessage.parts[0].messageId = userMessage.id;

    const sessionMessages = this.messages.get(sessionId) ?? [];
    sessionMessages.push(userMessage);
    this.messages.set(sessionId, sessionMessages);

    // Generate the canned assistant response
    const responseText = this.generateResponse(userText);
    const assistantMessageId = orderedId();
    const partId = orderedId();

    const textPart: TextPart = {
      id: partId,
      messageId: assistantMessageId,
      sessionId,
      type: "text",
      text: responseText,
    };

    const assistantMessage: UnifiedMessage = {
      id: assistantMessageId,
      sessionId,
      role: "assistant",
      time: { created: now + 1, completed: now + 10 },
      parts: [textPart],
      tokens: { input: userText.length, output: responseText.length },
      cost: 0,
      modelId: options?.modelId ?? "mock/test-model",
      mode: options?.mode,
    };

    sessionMessages.push(assistantMessage);

    // Update session timestamp and title
    const session = this.sessions.get(sessionId);
    if (session) {
      session.time.updated = now + 10;
      if (session.title === "New Session" && userText.length > 0) {
        session.title = userText.slice(0, 50);
      }
    }

    // --- Slow response mode: delay completion so cancel can be tested ---
    if (this.slowResponseDelay > 0) {
      // Emit user message and an in-progress assistant message immediately
      setTimeout(() => {
        if (session) {
          this.emit("session.updated", { session });
        }
        this.emit("message.updated", { sessionId, message: userMessage });
        // Emit assistant message without completed time to indicate "generating"
        const inProgressMessage: UnifiedMessage = {
          ...assistantMessage,
          time: { created: now + 1 },
          parts: [{
            ...textPart,
            text: "",
          } as TextPart],
        };
        this.emit("message.updated", { sessionId, message: inProgressMessage });
      }, 10);

      // Wait for delay or cancellation
      const abortController = new AbortController();
      this.pendingAbort.set(sessionId, abortController);

      return new Promise<UnifiedMessage>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingAbort.delete(sessionId);
          // Emit the completed response
          this.emit("message.part.updated", {
            sessionId,
            messageId: assistantMessageId,
            part: textPart as UnifiedPart,
          });
          this.emit("message.updated", { sessionId, message: assistantMessage });
          resolve(assistantMessage);
        }, this.slowResponseDelay);

        abortController.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          this.pendingAbort.delete(sessionId);
          // Emit cancelled message
          const cancelledMessage: UnifiedMessage = {
            ...assistantMessage,
            time: { created: now + 1, completed: Date.now() },
            error: "Cancelled",
            parts: [],
          };
          this.emit("message.updated", { sessionId, message: cancelledMessage });
          resolve(cancelledMessage);
        });
      });
    }

    // --- Instant response (default) ---

    // Defer event emission so the RPC response reaches the client before
    // broadcast notifications.  Without this, the gateway broadcasts
    // message.part.updated / message.updated *before* it sends the RPC
    // response for message.send, causing a race condition where the
    // frontend may not yet have the session context ready to process
    // the notifications.
    setTimeout(() => {
      if (session) {
        this.emit("session.updated", { session });
      }
      this.emit("message.updated", {
        sessionId,
        message: userMessage,
      });
      this.emit("message.part.updated", {
        sessionId,
        messageId: assistantMessageId,
        part: textPart as UnifiedPart,
      });
      this.emit("message.updated", {
        sessionId,
        message: assistantMessage,
      });
    }, 10);

    return assistantMessage;
  }

  async cancelMessage(sessionId: string): Promise<void> {
    const controller = this.pendingAbort.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return this.messages.get(sessionId) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  async listModels(): Promise<ModelListResult> {
    return { models: [
      {
        modelId: "mock/test-model",
        name: "Test Model",
        engineType: this.engineType,
        description: "A mock model for testing purposes",
      },
      {
        modelId: "mock/fast-model",
        name: "Fast Model",
        engineType: this.engineType,
        description: "A fast mock model for testing purposes",
      },
    ] };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.sessionModels.set(sessionId, modelId);
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------

  getModes(): AgentMode[] {
    return [
      { id: "agent", label: "Agent", description: "Full agent mode" },
      { id: "plan", label: "Plan", description: "Planning mode" },
    ];
  }

  getMode(sessionId: string): string {
    return this.sessionModes.get(sessionId) ?? this.currentMode;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.sessionModes.set(sessionId, modeId);
    this.currentMode = modeId;
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  async replyPermission(
    permissionId: string,
    reply: PermissionReply,
  ): Promise<void> {
    this.emit("permission.replied", {
      permissionId,
      optionId: reply.optionId,
    });
  }

  async replyQuestion(_questionId: string, _answers: string[][]): Promise<void> {
    // no-op for mock
  }

  async rejectQuestion(_questionId: string): Promise<void> {
    // no-op for mock
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  async listProjects(): Promise<UnifiedProject[]> {
    // Derive projects from unique directories in sessions
    const directorySet = new Map<string, UnifiedProject>();
    for (const session of Array.from(this.sessions.values())) {
      if (!directorySet.has(session.directory)) {
        const dirName = session.directory.split(/[\\/]/).pop() ?? session.directory;
        directorySet.set(session.directory, {
          id: `project-${this.engineType}-${session.directory.replace(/[^a-zA-Z0-9]/g, "-")}`,
          directory: session.directory,
          name: dirName,
          engineType: this.engineType,
        });
      }
    }
    return Array.from(directorySet.values());
  }

  // ---------------------------------------------------------------------------
  // Test Helpers
  // ---------------------------------------------------------------------------

  /**
   * Pre-populate a session and its messages for testing.
   * The session is added to the store and messages are associated with it.
   */
  seedSession(session: UnifiedSession, messages: UnifiedMessage[] = []): void {
    this.sessions.set(session.id, session);
    this.messages.set(session.id, [...messages]);
  }

  /**
   * Enable slow response mode for testing cancellation.
   * When delayMs > 0, sendMessage waits before emitting the final response,
   * allowing cancelMessage to abort mid-generation.
   */
  setSlowMode(delayMs: number): void {
    this.slowResponseDelay = delayMs;
  }

  /**
   * Clear all in-memory data and reset status to stopped.
   */
  reset(): void {
    this.sessions.clear();
    this.messages.clear();
    this.sessionModels.clear();
    this.sessionModes.clear();
    this.currentMode = "agent";
    this.slowResponseDelay = 0;
    for (const controller of this.pendingAbort.values()) {
      controller.abort();
    }
    this.pendingAbort.clear();
    this.status = "stopped";
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Generate a canned response based on user input.
   * Handles simple math expressions and falls back to echo.
   */
  private generateResponse(userText: string): string {
    const trimmed = userText.trim();

    // Try to evaluate simple math expressions (e.g., "2+2", "10 * 3", "100 / 4")
    const mathMatch = trimmed.match(
      /^(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)$/,
    );
    if (mathMatch) {
      const a = parseFloat(mathMatch[1]);
      const op = mathMatch[2];
      const b = parseFloat(mathMatch[3]);
      let result: number;
      switch (op) {
        case "+":
          result = a + b;
          break;
        case "-":
          result = a - b;
          break;
        case "*":
          result = a * b;
          break;
        case "/":
          result = b !== 0 ? a / b : NaN;
          break;
        default:
          result = NaN;
      }
      if (!isNaN(result)) {
        return `The answer is ${result}`;
      }
    }

    if (!trimmed) {
      return "This is a mock response to an empty message.";
    }

    return `This is a mock response to: ${trimmed}`;
  }
}
