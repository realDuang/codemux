import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

import { mimeToFileExtension } from "../../../../shared/image-limits";
import type {
  AgentMode,
  AuthMethod,
  CodexServiceTier,
  CommandInvokeResult,
  EngineCapabilities,
  EngineCommand,
  EngineInfo,
  EngineStatus,
  EngineType,
  MessagePromptContent,
  ModelListResult,
  PermissionReply,
  ReasoningEffort,
  ReasoningPart,
  ToolPart,
  UnifiedMessage,
  UnifiedModelInfo,
  UnifiedPermission,
  UnifiedProject,
  UnifiedQuestion,
  UnifiedSession,
  ImportableSession,
} from "../../../../src/types/unified";
import { isCodexServiceTier } from "../../../../src/types/unified";
import { EngineAdapter, type MessageBuffer } from "../engine-adapter";
import { CODEMUX_IDENTITY_PROMPT } from "../identity-prompt";
import { timeId } from "../../utils/id-gen";
import { codexLog } from "../../services/logger";
import { CodexJsonRpcClient } from "./jsonrpc-client";
import type { CodexDesktopOwnerRuntime, CodexOwnerRequestMethod, NativeOwnedThreadState } from "./desktop-owner";
import { DESKTOP_CATALOG_METHODS, DESKTOP_CATALOG_NOTIFICATION_METHODS, type DesktopCatalogClient } from "./desktop-catalog";
import { verifyCodexRolloutPath } from "./desktop-rollout-path";
import {
  CODEX_FALLBACK_MODEL,
  CODEX_MODES,
  type CodexApprovalPolicy,
  type CodexConfigRequirements,
  type CodexSandboxMode,
  type CodexSandboxPolicy,
  buildStartupArgs,
  clampApprovalPolicy,
  clampSandboxMode,
  clampSandboxPolicy,
  fromCodexEffort,
  modeToApprovalPolicy,
  modeToSandboxMode,
  modeToSandboxPolicy,
  normalizeDirectory,
  resolveCodexCliPath,
  resolveCodexCliVersion,
  sandboxModeFromPolicy,
  toCodexEffort,
} from "./config";
import {
  appendPlanDelta,
  appendTextDelta,
  applyTurnMetadata,
  applyTurnUsage,
  completeToolPart,
  convertApprovalToPermission,
  convertThreadToMessages,
  convertUserInputToQuestion,
  createStepFinish,
  createSystemNotice,
  createToolPart,
  createUserMessage,
  finalizeBufferToMessage,
  formatTurnPlanMarkdown,
  normalizeCodexReasoningText,
  replacePlanText,
  upsertPart,
} from "./converters";

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const START_TIMEOUT_MS = 120_000;
const DEFAULT_MODE_ID = "default";
const MAX_IMAGE_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const STORED_THREAD_PAGE_SIZE = 100;
const STORED_THREAD_MAX_PAGES = 20;

/**
 * Read the `model_provider` field from `~/.codex/config.toml`.
 * Uses simple line parsing to avoid a TOML dependency.
 */
function readCodexModelProvider(): string | undefined {
  try {
    const configPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
    if (!existsSync(configPath)) return undefined;
    const content = readFileSync(configPath, "utf-8");
    // Match top-level `model_provider = "..."` (before any [section] header)
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) break; // entered a section
      const match = trimmed.match(/^model_provider\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } catch (err) {
    codexLog.warn("[Codex] Failed to read ~/.codex/config.toml:", err);
  }
  return undefined;
}

type CodexTurnInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

interface CodexMessageOptions {
  mode?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort | null;
  serviceTier?: CodexServiceTier | null;
  directory?: string;
  /** Used only by an explicitly created Desktop owner runtime. */
  ownerAdmission?: "start" | "steer";
  nativeOverrides?: Record<string, unknown>;
  onAdmitted?: (result: unknown) => void;
  onAdmissionFailed?: (error: Error) => void;
}

interface ThreadInfo {
  threadId: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  title?: string;
  loaded: boolean;
}

interface SendResolver {
  resolve: (msg: UnifiedMessage) => void;
  reject: (err: Error) => void;
}

interface QueuedMessage {
  input: CodexTurnInput[];
  userMessage: UnifiedMessage;
  tempDirs: string[];
  options?: CodexMessageOptions;
  resolver: SendResolver;
}

interface PendingPermission {
  requestId: number | string;
  sessionId: string;
  method: string;
  params: unknown;
  permission: UnifiedPermission;
}

interface PendingQuestion {
  requestId: number | string;
  sessionId: string;
  params: unknown;
  question: UnifiedQuestion;
}

interface SkillEntry {
  name: string;
  description: string;
  path: string;
  scope?: string;
  enabled: boolean;
}

interface ThreadResponse {
  thread?: {
    id?: string;
    cwd?: string;
    createdAt?: number | string;
    updatedAt?: number | string;
    name?: string | null;
    preview?: string;
    projectId?: string | null;
  };
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxPolicy;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  collaborationMode?: Record<string, unknown>;
  permissions?: string | null;
}

interface TurnResponse {
  turn?: {
    id?: string;
    status?: string;
  };
  turnId?: string;
}

interface CodexReasoningItemState {
  partId: string;
  summary: Map<number, string>;
  content: Map<number, string>;
  completed: boolean;
}

export type StoredCodexThreadAvailability = "active" | "archived" | "missing";
export type StoredCodexThreadMetadata = Record<string, unknown> & { id: string };

export class CodexAdapter extends EngineAdapter {
  readonly engineType: EngineType = "codex";
  private readonly desktopCatalogAdmissions = new Map<string, number>();
  private readonly desktopRuntimeAdmissions = new Set<string>();

  private client: CodexJsonRpcClient | null = null;
  private status: EngineStatus = "stopped";
  private cliPath: string | undefined;
  private version: string | undefined;
  private lastError: string | undefined;
  private authenticated: boolean | undefined;
  private authMessage: string | undefined;
  private authType: "chatgpt" | "apiKey" | undefined;
  private startPromise: Promise<void> | null = null;

  private sessionToThread = new Map<string, string>();
  private threadToSession = new Map<string, string>();
  private threads = new Map<string, ThreadInfo>();

  private messageBuffers = new Map<string, MessageBuffer>();
  private reasoningItems = new WeakMap<MessageBuffer, Map<string, CodexReasoningItemState>>();
  private messageHistory = new Map<string, UnifiedMessage[]>();
  private turnResolvers = new Map<string, SendResolver[]>();
  private messageQueues = new Map<string, QueuedMessage[]>();
  private activeTurnIds = new Map<string, string>();
  private activeToolParts = new Map<string, ToolPart>();
  private activeTempDirs = new Map<string, string[]>();

  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();

  private sessionModes = new Map<string, string>();
  private sessionModels = new Map<string, string>();
  private sessionReasoningEfforts = new Map<string, ReasoningEffort>();
  private sessionServiceTiers = new Map<string, CodexServiceTier>();
  private sessionDirectories = new Map<string, string>();
  private nativeSessionSettings = new Map<string, Record<string, unknown>>();
  private desktopOwnerRuntimeEnabled = false;
  private desktopOwnerSessions = new Set<string>();
  private desktopOwnerListeners = new Set<(sessionId: string) => void>();
  private desktopCatalogListeners = new Set<(method: string, params: unknown) => void>();

  private currentModelId: string = CODEX_FALLBACK_MODEL;
  private currentMode: string = DEFAULT_MODE_ID;
  private cachedModels: UnifiedModelInfo[] = [];
  private configRequirements: CodexConfigRequirements | null = null;

  private skillsByDirectory = new Map<string, EngineCommand[]>();
  private skillEntriesByDirectory = new Map<string, Map<string, SkillEntry>>();

  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    if (this.status === "running" && this.client?.running) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.setStatus("starting");

    try {
      this.cliPath = resolveCodexCliPath();
      if (!this.cliPath) {
        throw new Error("Codex CLI not found. Install `codex` and ensure it is in PATH.");
      }

      this.version = resolveCodexCliVersion(this.cliPath);

      await this.spawnAndInitialize();
      await this.refreshRuntimeMetadata();

      this.startSessionCleanup();
      this.setStatus("running");
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : "Failed to start Codex adapter.";
      throw this.failStart(message);
    }
  }

  async stop(): Promise<void> {
    this.desktopRuntimeAdmissions.clear();
    this.stopSessionCleanup();
    this.rejectPendingInteractions("Adapter stopped");
    this.rejectQueuedMessages("Adapter stopped");
    this.failAllInFlight("Adapter stopped");

    if (this.client) {
      try {
        await this.client.stop();
      } catch (error) {
        codexLog.warn("Failed to stop Codex client cleanly:", error);
      }
      this.client = null;
    }

    this.activeTurnIds.clear();
    this.activeToolParts.clear();
    this.cleanupActiveTempDirs();

    this.setStatus("stopped");
  }

  async healthCheck(): Promise<boolean> {
    return this.status === "running" && this.client?.running === true;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  /** A revocable metadata-only facade; it cannot acquire or execute a thread. */
  createDesktopCatalogClient(): DesktopCatalogClient {
    let active = true;
    const admitted = new Set<string>();
    const subscriptions = new Set<(method: string, params: unknown) => void>();
    const assertActive = () => { if (!active) throw new Error("Codex catalog metadata access has stopped"); };
    return {
      admitThread: (threadId) => {
        assertActive();
        if (!threadId.trim()) throw new Error("A native thread ID is required for catalog admission");
        if (admitted.has(threadId)) return;
        admitted.add(threadId);
        this.desktopCatalogAdmissions.set(threadId, (this.desktopCatalogAdmissions.get(threadId) ?? 0) + 1);
      },
      request: async (method, params) => {
        assertActive();
        if (!(DESKTOP_CATALOG_METHODS as readonly string[]).includes(method)) throw new Error("Unsupported Codex catalog metadata method");
        if (method === "thread/read" && params.includeTurns !== false) throw new Error("Catalog reads must omit turn bodies");
        if (method === "thread/list" && params.useStateDbOnly !== true) throw new Error("Catalog reads require the state database without scan-and-repair");
        await this.start();
        assertActive();
        if (!this.client?.running) throw new Error("Codex metadata client is not running");
        return this.client.request(method, params);
      },
      subscribe: (listener) => {
        assertActive();
        subscriptions.add(listener);
        this.desktopCatalogListeners.add(listener);
        return () => { subscriptions.delete(listener); this.desktopCatalogListeners.delete(listener); };
      },
      dispose: () => {
        active = false;
        for (const threadId of admitted) {
          const remaining = (this.desktopCatalogAdmissions.get(threadId) ?? 1) - 1;
          if (remaining > 0) this.desktopCatalogAdmissions.set(threadId, remaining);
          else this.desktopCatalogAdmissions.delete(threadId);
        }
        admitted.clear();
        for (const listener of subscriptions) this.desktopCatalogListeners.delete(listener);
        subscriptions.clear();
      },
    };
  }

  createDesktopOwnerRuntime(): CodexDesktopOwnerRuntime {
    this.desktopOwnerRuntimeEnabled = true;
    const retained = new Set<string>();
    return {
      readThread: async (sessionId) => {
        this.requireDesktopOwnerThread(sessionId);
        retained.add(sessionId);
        this.desktopOwnerSessions.add(sessionId);
        return this.readDesktopOwnerThread(sessionId);
      },
      readMetadata: (sessionId) => this.readStoredThreadMetadata(this.requireDesktopOwnerThread(sessionId)),
      request: (sessionId, method, params) => this.requestDesktopOwner(sessionId, method, params),
      respond: (sessionId, requestId, result) => this.respondDesktopOwner(sessionId, requestId, result),
      updateSettings: (sessionId, settings, options) => this.updateDesktopOwnerSettings(sessionId, settings, options),
      subscribe: (listener) => {
        this.desktopOwnerListeners.add(listener);
        return () => {
          this.desktopOwnerListeners.delete(listener);
          for (const sessionId of retained) this.desktopOwnerSessions.delete(sessionId);
          retained.clear();
        };
      },
    };
  }

  private requireDesktopOwnerThread(sessionId: string): string {
    const threadId = this.sessionToThread.get(sessionId);
    if (!this.client?.running || !threadId || !this.threads.get(threadId)?.loaded) {
      throw new Error("Desktop owner requests require a thread already loaded in this Codex adapter");
    }
    return threadId;
  }

  private desktopOwnerSettings(sessionId: string): Record<string, unknown> {
    const previous = this.nativeSessionSettings.get(sessionId) ?? {};
    const mode = this.sessionModes.get(sessionId) ?? this.currentMode;
    const model = this.sessionModels.get(sessionId) ?? (typeof previous.model === "string" ? previous.model : this.currentModelId);
    const effort = Object.prototype.hasOwnProperty.call(previous, "effort") ? previous.effort
      : this.sessionReasoningEfforts.has(sessionId) ? toCodexEffort(this.sessionReasoningEfforts.get(sessionId)!) : null;
    const directory = this.sessionDirectories.get(sessionId) ?? "";
    return {
      ...previous, model, effort, cwd: directory,
      serviceTier: this.sessionServiceTiers.get(sessionId) ?? previous.serviceTier ?? null,
      approvalPolicy: previous.approvalPolicy ?? clampApprovalPolicy(modeToApprovalPolicy(mode), this.configRequirements),
      sandboxPolicy: previous.sandboxPolicy ?? clampSandboxPolicy(modeToSandboxPolicy(mode, directory), this.configRequirements),
      collaborationMode: previous.collaborationMode ?? {
        mode, settings: { model, reasoning_effort: effort, developer_instructions: null },
      },
    };
  }

  private async readDesktopOwnerThread(sessionId: string): Promise<NativeOwnedThreadState> {
    const threadId = this.requireDesktopOwnerThread(sessionId);
    let response: Record<string, unknown>;
    try {
      response = asRecord(await this.client!.request("thread/read", { threadId, includeTurns: true }));
    } catch (error) {
      // Legacy threads only acquire a persisted turn history on their first user
      // message. The app-server still provides authoritative metadata beforehand.
      if (!(error instanceof Error) || !error.message.includes("is not materialized yet; includeTurns is unavailable before first user message")) throw error;
      response = asRecord(await this.client!.request("thread/read", { threadId, includeTurns: false }));
    }
    const thread = asRecord(response.thread);
    if (thread.id !== threadId) throw new Error("Native Codex thread/read returned a different thread");
    const settings = this.desktopOwnerSettings(sessionId);
    return {
      thread,
      model: String(settings.model),
      modelProvider: typeof thread.modelProvider === "string" ? thread.modelProvider
        : typeof settings.modelProvider === "string" ? settings.modelProvider : readCodexModelProvider(),
      reasoningEffort: typeof settings.effort === "string" ? settings.effort : null,
      collaborationMode: asRecord(settings.collaborationMode),
      serviceTier: typeof settings.serviceTier === "string" ? settings.serviceTier : null,
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: settings.sandboxPolicy,
      permissions: typeof settings.permissions === "string" ? settings.permissions : undefined,
      requests: [
        ...[...this.pendingPermissions.values()].filter((pending) => pending.sessionId === sessionId)
          .map((pending) => ({ id: pending.requestId, method: pending.method, params: asRecord(pending.params) })),
        ...[...this.pendingQuestions.values()].filter((pending) => pending.sessionId === sessionId)
          .map((pending) => ({ id: pending.requestId, method: "item/tool/requestUserInput", params: asRecord(pending.params) })),
      ],
    };
  }

  private async readStoredThreadMetadata(threadId: string): Promise<StoredCodexThreadMetadata> {
    if (!this.client?.running) throw new Error("Codex metadata client is not running");
    const response = asRecord(await this.client.request("thread/read", { threadId, includeTurns: false }));
    const thread = asRecord(response.thread);
    if (thread.id !== threadId) throw new Error("Native Codex metadata returned a different thread");
    return thread as StoredCodexThreadMetadata;
  }

  private async requireUnarchivedStoredThread(threadId: string, directory: unknown): Promise<void> {
    if (!await this.findStoredThreadInList(threadId, false, directory)
      && !(this.isAdmittedDesktopThread(threadId) && await this.storedThreadAvailability(threadId, directory) === "active")) {
      throw new Error("The Codex thread is not in the verified unarchived list");
    }
  }

  private async findStoredThreadInList(threadId: string, archived: boolean, directory?: unknown): Promise<StoredCodexThreadMetadata | undefined> {
    if (!this.client?.running) throw new Error("Codex metadata client is not running");
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < STORED_THREAD_MAX_PAGES; page += 1) {
      const response = asRecord(await this.client.request("thread/list", {
        cursor,
        limit: STORED_THREAD_PAGE_SIZE,
        sortKey: "updated_at",
        archived,
        modelProviders: null,
        sourceKinds: [],
        useStateDbOnly: true,
        ...(typeof directory === "string" && directory ? { cwd: directory } : {}),
      }));
      if (!Array.isArray(response.data)) throw new Error(`Codex returned an invalid ${archived ? "archived" : "unarchived"} thread list`);
      const match = response.data.find((entry) => asRecord(entry).id === threadId);
      if (match) return asRecord(match) as StoredCodexThreadMetadata;
      if (response.nextCursor == null) return undefined;
      if (typeof response.nextCursor !== "string" || !response.nextCursor || seen.has(response.nextCursor)) {
        throw new Error("Codex returned an invalid or repeated thread-list cursor");
      }
      cursor = response.nextCursor;
      seen.add(cursor);
    }
    throw new Error("Stored Codex thread verification exceeded its pagination limit");
  }

  private async storedThreadAvailability(threadId: string, directory?: unknown): Promise<StoredCodexThreadAvailability> {
    const [active, archived] = await Promise.all([
      this.findStoredThreadInList(threadId, false, directory),
      this.findStoredThreadInList(threadId, true, directory),
    ]);
    if (active && archived) throw new Error("Codex returned conflicting active and archived thread records");
    if (!active && !archived && this.isAdmittedDesktopThread(threadId)) {
      const metadata = await this.readStoredThreadMetadata(threadId);
      // Admission and a verified native rollout path are both required. A
      // readable arbitrary UUID alone must never bypass catalog presence checks.
      const availability = await verifyCodexRolloutPath(threadId, metadata);
      return this.isAdmittedDesktopThread(threadId) ? availability ?? "missing" : "missing";
    }
    return active ? "active" : archived ? "archived" : "missing";
  }

  private isAdmittedDesktopThread(threadId: string): boolean {
    return this.desktopCatalogAdmissions.has(threadId) || this.desktopRuntimeAdmissions.has(threadId);
  }

  private async requestDesktopOwner(sessionId: string, method: CodexOwnerRequestMethod, params: Record<string, unknown>): Promise<unknown> {
    const threadId = this.requireDesktopOwnerThread(sessionId);
    if (params.threadId !== threadId) throw new Error("Desktop owner request targets another thread");
    if (method === "thread/compact/start") {
      const result = await this.client!.request(method, { threadId });
      this.notifyDesktopOwnerState(sessionId);
      return result;
    }
    if (method === "turn/interrupt") {
      const turnId = this.activeTurnIds.get(sessionId);
      if (!turnId || params.turnId !== turnId) throw new Error("Desktop interrupt does not match the active turn");
      const result = await this.client!.request(method, { threadId, turnId });
      if (this.activeTurnIds.get(sessionId) === turnId) {
        this.rejectQueuedMessagesForSession(sessionId, "Cancelled");
        this.rejectPendingForSession(sessionId, "Cancelled");
        this.failActiveTurn(sessionId, "Cancelled", false);
      }
      this.notifyDesktopOwnerState(sessionId);
      return result;
    }
    if (method !== "turn/start" && method !== "turn/steer") throw new Error("Unsupported Desktop owner request");
    if (method === "turn/start" && this.hasActiveTurn(sessionId)) throw new Error("A Codex turn is already active; use steer instead of start");
    if (method === "turn/steer" && (!this.activeTurnIds.has(sessionId) || params.expectedTurnId !== this.activeTurnIds.get(sessionId))) {
      throw new Error("Desktop steer does not match the active turn");
    }
    const input = parseDesktopOwnerInput(params.input);
    const text = input.flatMap((item) => item.type === "text" ? [item.text] : item.type === "skill" ? [`$${item.name}`] : []).join("\n");
    const userMessage = createUserMessage(sessionId, text);
    const overrides = pickDesktopOwnerSettings(params, true);
    const settings = method === "turn/start" ? { ...this.desktopOwnerSettings(sessionId), ...overrides } : overrides;
    if (method === "turn/start") {
      const collaboration = asRecord(settings.collaborationMode);
      const requestedCollaboration = asRecord(asRecord(overrides.collaborationMode).settings);
      if (typeof overrides.model !== "string" && typeof requestedCollaboration.model === "string") settings.model = requestedCollaboration.model;
      if (!Object.prototype.hasOwnProperty.call(overrides, "effort") && Object.prototype.hasOwnProperty.call(requestedCollaboration, "reasoning_effort")) settings.effort = requestedCollaboration.reasoning_effort;
      settings.collaborationMode = {
        ...collaboration,
        settings: { ...asRecord(collaboration.settings), model: settings.model, reasoning_effort: settings.effort },
      };
    }
    return new Promise((resolve, reject) => {
      const options: CodexMessageOptions = {
        ownerAdmission: method === "turn/start" ? "start" : "steer",
        directory: typeof settings.cwd === "string" ? normalizeDirectory(settings.cwd) : this.sessionDirectories.get(sessionId),
        modelId: typeof settings.model === "string" ? settings.model : undefined,
        nativeOverrides: pickDesktopOwnerSettings(settings, true),
        onAdmitted: (result) => {
          if (method === "turn/start") this.commitDesktopOwnerSettings(sessionId, settings);
          this.notifyDesktopOwnerState(sessionId);
          resolve(result);
        },
        onAdmissionFailed: reject,
      };
      const completion = method === "turn/start"
        ? this.startPreparedTurn(sessionId, input, userMessage, [], options, false)
        : this.steerTurn(sessionId, input, userMessage, [], options);
      // The IPC reply acknowledges admission; the existing notification handlers
      // continue to own the full turn and its completion/error bookkeeping.
      void completion.catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async updateDesktopOwnerSettings(sessionId: string, patch: Record<string, unknown>, options: {
    activeTurnId?: string;
    condition?: Record<string, unknown>;
  }): Promise<boolean> {
    this.requireDesktopOwnerThread(sessionId);
    if (options.activeTurnId != null) throw new Error("Changing permissions of an active Codex turn is not supported by this owner");
    const unsupported = Object.keys(patch).find((key) => patch[key] !== undefined && !DESKTOP_OWNER_SETTING_KEYS.has(key));
    if (unsupported) throw new Error(`Unsupported Desktop owner setting: ${unsupported}`);
    const previous = this.desktopOwnerSettings(sessionId);
    if (options.condition?.ifModelEquals != null && options.condition.ifModelEquals !== previous.model) return false;
    if (options.condition && Object.prototype.hasOwnProperty.call(options.condition, "ifEffortEquals") && options.condition.ifEffortEquals !== previous.effort) return false;
    const settings = { ...previous, ...pickDesktopOwnerSettings(patch) };
    const collaboration = asRecord(settings.collaborationMode);
    const mode = typeof collaboration.mode === "string" ? collaboration.mode : this.sessionModes.get(sessionId) ?? this.currentMode;
    if (!CODEX_MODES.some((candidate) => candidate.id === mode)) throw new Error("Unsupported Codex collaboration mode");
    const collaborationSettings = asRecord(collaboration.settings);
    if (patch.collaborationMode != null) {
      if (typeof collaborationSettings.model === "string") settings.model = collaborationSettings.model;
      if (Object.prototype.hasOwnProperty.call(collaborationSettings, "reasoning_effort")) settings.effort = collaborationSettings.reasoning_effort;
    }
    settings.collaborationMode = { ...collaboration, mode, settings: { ...collaborationSettings, model: settings.model, reasoning_effort: settings.effort } };
    this.commitDesktopOwnerSettings(sessionId, settings);
    this.notifyDesktopOwnerState(sessionId);
    return true;
  }

  private commitDesktopOwnerSettings(sessionId: string, settings: Record<string, unknown>): void {
    this.nativeSessionSettings.set(sessionId, {
      modelProvider: this.nativeSessionSettings.get(sessionId)?.modelProvider,
      ...pickDesktopOwnerSettings(settings),
    });
    if (typeof settings.model === "string") this.sessionModels.set(sessionId, settings.model);
    const mode = asRecord(settings.collaborationMode).mode;
    if (typeof mode === "string") this.sessionModes.set(sessionId, mode);
    if (typeof settings.cwd === "string") this.sessionDirectories.set(sessionId, normalizeDirectory(settings.cwd));
    const effort = typeof settings.effort === "string" ? fromCodexEffort(settings.effort) : undefined;
    if (effort) this.sessionReasoningEfforts.set(sessionId, effort); else this.sessionReasoningEfforts.delete(sessionId);
    if (isCodexServiceTier(settings.serviceTier)) this.sessionServiceTiers.set(sessionId, settings.serviceTier); else this.sessionServiceTiers.delete(sessionId);
  }

  private async respondDesktopOwner(sessionId: string, requestId: string | number, result: unknown): Promise<void> {
    this.requireDesktopOwnerThread(sessionId);
    const key = String(requestId);
    const permission = this.pendingPermissions.get(key);
    const question = this.pendingQuestions.get(key);
    const pending = permission ?? question;
    if (!pending || pending.sessionId !== sessionId) throw new Error("Desktop response does not match a pending request in this session");
    this.client!.respond(pending.requestId, result);
    if (permission) {
      this.pendingPermissions.delete(key);
      this.emit("permission.replied", { permissionId: key, optionId: "resolved" });
    } else {
      this.pendingQuestions.delete(key);
      const answers = asRecord(asRecord(result).answers);
      this.emit("question.replied", { questionId: key, answers: Object.values(answers).map((answer) => {
        const values = asRecord(answer).answers;
        return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
      }) });
    }
    this.touchThread(sessionId);
    this.notifyDesktopOwnerState(sessionId);
  }

  private notifyDesktopOwnerState(sessionId: string): void {
    for (const listener of this.desktopOwnerListeners) {
      try { listener(sessionId); } catch (error) { codexLog.warn("Desktop owner state listener failed:", error); }
    }
  }

  getInfo(): EngineInfo {
    return {
      type: this.engineType,
      name: "Codex",
      version: this.version,
      status: this.status,
      capabilities: this.getCapabilities(),
      authMethods: this.getAuthMethods(),
      authenticated: this.authenticated,
      authMessage: this.authMessage,
      errorMessage: this.status === "error" ? this.lastError : undefined,
    };
  }

  getCapabilities(): EngineCapabilities {
    return {
      reasoningEffortOptions: ["low", "medium", "high", "max", "ultra"],
      providerModelHierarchy: false,
      dynamicModes: true,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: true,
      loadSession: true,
      listSessions: true,
      hideArchivedSessions: true,
      modelSwitchable: true,
      customModelInput: true,
      messageEnqueue: true,
      slashCommands: true,
      fastModeSupported: this.authenticated === true,
      availableModes: this.getModes(),
    };
  }

  getAuthMethods(): AuthMethod[] {
    return [{
      id: "openai",
      name: "OpenAI",
      description: "Use Codex's existing OpenAI login or API key configuration.",
    }];
  }

  hasSession(sessionId: string): boolean {
    return this.sessionToThread.has(sessionId) && this.client?.running === true;
  }

  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    const sessions: UnifiedSession[] = [];

    for (const [sessionId, threadId] of this.sessionToThread) {
      const thread = this.threads.get(threadId);
      if (!thread) continue;
      if (directory && normalizeDirectory(directory) !== thread.directory) continue;

      sessions.push({
        id: sessionId,
        engineType: this.engineType,
        directory: thread.directory,
        title: thread.title,
        time: {
          created: thread.createdAt,
          updated: thread.updatedAt,
        },
        engineMeta: { codexThreadId: threadId },
      });
    }

    return sessions;
  }

  async createSession(directory: string, meta?: Record<string, unknown>): Promise<UnifiedSession> {
    const strictOwnerRestore = meta?.codexDesktopOwner === "codemux";
    const existingThreadId = resolveThreadId(undefined, meta);
    if (strictOwnerRestore && !existingThreadId) throw new Error("CodeMux-owned restoration requires the original Codex thread ID");
    await this.start();

    let normalizedDirectory = normalizeDirectory(directory);
    let threadResponse: ThreadResponse;
    if (strictOwnerRestore && existingThreadId) {
      threadResponse = await this.resumeThread(existingThreadId, normalizedDirectory, true);
      if (threadResponse.thread?.id !== existingThreadId) throw new Error("CodeMux-owned restoration changed the original Codex thread ID");
      normalizedDirectory = normalizeDirectory(threadResponse.thread.cwd ?? threadResponse.cwd ?? normalizedDirectory);
    } else if (existingThreadId) {
      if (await this.getStoredThreadAvailability(existingThreadId) === "archived") {
        throw Object.assign(new Error("Archived Codex conversations are not available in CodeMux."), { code: "CODEX_THREAD_ARCHIVED" });
      }
      try {
        threadResponse = await this.resumeThread(existingThreadId, normalizedDirectory);
      } catch (error) {
        codexLog.warn(`Failed to resume Codex thread ${existingThreadId}, starting a new one instead:`, error);
        threadResponse = await this.startThread(normalizedDirectory);
      }
    } else {
      threadResponse = typeof meta?.catalogProjectId === "string"
        ? await this.startThread(normalizedDirectory, meta.catalogProjectId)
        : await this.startThread(normalizedDirectory);
    }

    const threadId = threadResponse.thread?.id;
    if (!threadId) {
      throw new Error("Codex did not return a thread ID");
    }

    const sessionId = toEngineSessionId(threadId);
    if (this.desktopOwnerRuntimeEnabled && (!existingThreadId || strictOwnerRestore)) this.desktopRuntimeAdmissions.add(threadId);
    this.registerThread(sessionId, threadId, normalizedDirectory, threadResponse.thread?.name ?? undefined, true, threadResponse.thread?.createdAt, threadResponse.thread?.updatedAt);
    this.nativeSessionSettings.set(sessionId, {
      model: threadResponse.model ?? this.currentModelId,
      modelProvider: threadResponse.modelProvider,
      effort: threadResponse.reasoningEffort ?? null,
      serviceTier: threadResponse.serviceTier ?? null,
      approvalPolicy: threadResponse.approvalPolicy,
      sandboxPolicy: threadResponse.sandbox,
      collaborationMode: threadResponse.collaborationMode,
      permissions: threadResponse.permissions,
      cwd: threadResponse.cwd ?? normalizedDirectory,
    });

    const restoredMode = strictOwnerRestore ? threadResponse.collaborationMode?.mode : undefined;
    if (typeof restoredMode === "string") {
      this.sessionModes.set(sessionId, restoredMode);
    } else if (!this.sessionModes.has(sessionId)) {
      this.sessionModes.set(sessionId, this.currentMode);
    }
    if (!this.sessionDirectories.has(sessionId)) {
      this.sessionDirectories.set(sessionId, normalizedDirectory);
    }
    if (threadResponse.model) {
      this.sessionModels.set(sessionId, threadResponse.model);
      this.currentModelId = threadResponse.model;
    }
    if (threadResponse.reasoningEffort) {
      const effort = fromCodexEffort(threadResponse.reasoningEffort);
      if (effort) this.sessionReasoningEfforts.set(sessionId, effort);
    }
    if (threadResponse.serviceTier === "fast" || threadResponse.serviceTier === "flex") {
      this.sessionServiceTiers.set(sessionId, threadResponse.serviceTier);
    }

    if (threadResponse.thread?.name) {
      setTimeout(() => {
        this.emit("session.updated", {
          session: {
            id: sessionId,
            engineType: this.engineType,
            title: threadResponse.thread?.name ?? undefined,
          },
        });
      }, 0);
    }

    this.refreshCommandsForDirectory(normalizedDirectory).catch((error) => {
      codexLog.warn(`Failed to refresh skills for ${normalizedDirectory}:`, error);
    });

    const catalogContext = typeof meta?.catalogSourceId === "string" || typeof meta?.catalogProjectId === "string";
    const actualProjectId = threadResponse.thread?.projectId;
    const hasActualProject = catalogContext && (typeof actualProjectId === "string" || actualProjectId === null);
    return {
      id: sessionId,
      engineType: this.engineType,
      directory: normalizedDirectory,
      ...(hasActualProject ? { projectId: actualProjectId } : {}),
      title: threadResponse.thread?.name ?? undefined,
      time: {
        created: toMillis(threadResponse.thread?.createdAt, Date.now()),
        updated: toMillis(threadResponse.thread?.updatedAt, Date.now()),
      },
      engineMeta: {
        codexThreadId: threadId,
        ...(typeof meta?.catalogSourceId === "string" ? { catalogSourceId: meta.catalogSourceId } : {}),
        ...(hasActualProject ? { catalogProjectId: actualProjectId } : {}),
      },
    };
  }

  async getSession(sessionId: string): Promise<UnifiedSession | null> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return null;
    const thread = this.threads.get(threadId);
    if (!thread) return null;

    return {
      id: sessionId,
      engineType: this.engineType,
      directory: thread.directory,
      title: thread.title,
      time: {
        created: thread.createdAt,
        updated: thread.updatedAt,
      },
      engineMeta: { codexThreadId: threadId },
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId && this.client?.running) {
      try {
        await this.client.request("thread/unsubscribe", { threadId });
      } catch (error) {
        codexLog.warn(`Failed to unsubscribe thread ${threadId}:`, error);
      }
    }

    this.clearSessionState(sessionId);
  }

  /** Push a renamed title to the Codex app-server via thread/name/set RPC. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId || !this.client?.running) return;
    try {
      await this.client.request("thread/name/set", {
        threadId,
        name: title,
      });
      const thread = this.threads.get(threadId);
      if (thread) {
        thread.title = title || undefined;
        thread.updatedAt = Date.now();
      }
    } catch (error) {
      codexLog.warn(`Failed to set Codex thread name for ${threadId}:`, error);
    }
  }

  /** Renames persisted metadata without loading, resuming, or changing its owner. */
  async renameStoredThread(threadId: string, title: string): Promise<void> {
    if (!threadId.trim() || !title.trim()) throw new Error("A Codex thread ID and non-empty title are required");
    await this.start();
    const before = await this.readStoredThreadMetadata(threadId);
    await this.requireUnarchivedStoredThread(threadId, before.cwd);
    await this.client!.request("thread/name/set", { threadId, name: title });
    const after = await this.readStoredThreadMetadata(threadId);
    if (after.name !== title) throw new Error("Codex accepted the rename but the stored title did not match");
    // A concurrent archive must not be turned into an unarchive by the caller's
    // subsequent UI refresh. Report success only after this second verification.
    await this.requireUnarchivedStoredThread(threadId, after.cwd);
  }

  /** Checks both native indexes without resuming a thread or acquiring its writer. */
  async getStoredThreadAvailability(threadId: string): Promise<StoredCodexThreadAvailability> {
    if (!threadId.trim()) throw new Error("A Codex thread ID is required");
    await this.start();
    let directory: unknown;
    try {
      directory = (await this.readStoredThreadMetadata(threadId)).cwd;
    } catch (error) {
      // This is the native metadata response for a missing/non-materialized ID.
      // Still check both bounded indexes before concluding that storage is absent.
      if (!(error instanceof Error) || error.message !== `thread not loaded: ${threadId} (code: -32600)`) throw error;
    }
    return this.storedThreadAvailability(threadId, directory);
  }

  /** Internal lifecycle checks may read archives; client history reads can exclude them. */
  async readStoredThread(threadId: string, options: { activeOnly?: boolean } = {}): Promise<{ thread: StoredCodexThreadMetadata; archived: boolean }> {
    if (!threadId.trim()) throw new Error("A Codex thread ID is required");
    await this.start();
    if (!this.client?.running) throw new Error("Codex metadata client is not running");
    const checkAvailability = (availability: StoredCodexThreadAvailability) => {
      if (availability === "missing") throw new Error("The Codex thread is missing from native storage");
      if (options.activeOnly && availability === "archived") {
        throw Object.assign(new Error("Archived Codex conversations are not available in CodeMux."), { code: "CODEX_THREAD_ARCHIVED" });
      }
    };
    // Do not hydrate an archived transcript merely to discover its archive flag.
    if (options.activeOnly) checkAvailability(await this.getStoredThreadAvailability(threadId));
    let response: Record<string, unknown>;
    try { response = asRecord(await this.client.request("thread/read", { threadId, includeTurns: true })); }
    catch (error) {
      if (!this.isAdmittedDesktopThread(threadId) || !(error instanceof Error)
        || error.message !== `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message (code: -32600)`) throw error;
      response = asRecord(await this.client.request("thread/read", { threadId, includeTurns: false }));
    }
    const thread = asRecord(response.thread);
    if (thread.id !== threadId) throw new Error("Native Codex history returned a different thread");
    const availability = await this.storedThreadAvailability(threadId, thread.cwd);
    checkAvailability(availability);
    return { thread: thread as StoredCodexThreadMetadata, archived: availability === "archived" };
  }

  /** Archives only native storage; never fabricates an IPC fact to release an owner. */
  async archiveStoredThread(threadId: string): Promise<StoredCodexThreadMetadata> {
    if (!threadId.trim()) throw new Error("A Codex thread ID is required");
    await this.start();
    const before = await this.readStoredThreadMetadata(threadId);
    const availability = await this.storedThreadAvailability(threadId, before.cwd);
    if (availability === "archived") return before;
    if (availability !== "active") throw new Error("The Codex thread is missing from native storage");
    // A foreign active writer is rejected by the native API. Propagate that
    // failure without stopping it, retrying, or announcing a false archive.
    await this.client!.request("thread/archive", { threadId });
    const after = await this.readStoredThreadMetadata(threadId);
    if (await this.storedThreadAvailability(threadId, after.cwd) !== "archived") throw new Error("Codex archive was not confirmed by native storage");
    return after;
  }

  /** Restores an archived record without resuming its conversation. */
  async unarchiveStoredThread(threadId: string): Promise<StoredCodexThreadMetadata> {
    if (!threadId.trim()) throw new Error("A Codex thread ID is required");
    await this.start();
    const before = await this.readStoredThreadMetadata(threadId);
    const availability = await this.storedThreadAvailability(threadId, before.cwd);
    if (availability === "active") return before;
    if (availability !== "archived") throw new Error("The Codex thread is missing from native storage");
    await this.client!.request("thread/unarchive", { threadId });
    const after = await this.readStoredThreadMetadata(threadId);
    if (await this.storedThreadAvailability(threadId, after.cwd) !== "active") throw new Error("Codex restore was not confirmed by native storage");
    return after;
  }

  async sendMessage(
    sessionId: string,
    content: MessagePromptContent[],
    options?: CodexMessageOptions,
  ): Promise<UnifiedMessage> {
    const prepared = this.buildPromptInput(content);
    const userMessage = createUserMessage(sessionId, prepared.displayText, Date.now(), prepared.images);
    const directory = normalizeDirectory(options?.directory ?? this.sessionDirectories.get(sessionId) ?? this.threads.get(this.sessionToThread.get(sessionId) ?? "")?.directory ?? "");
    if (!directory) {
      this.cleanupTempDirs(prepared.tempDirs);
      throw new Error(`No working directory found for Codex session ${sessionId}`);
    }

    this.sessionDirectories.set(sessionId, directory);

    if (this.hasActiveTurn(sessionId)) {
      if (this.canSteer(sessionId, options, directory)) {
        return this.steerTurn(sessionId, prepared.input, userMessage, prepared.tempDirs, options);
      }

      return this.enqueueMessage(sessionId, prepared.input, userMessage, prepared.tempDirs, options);
    }

    return this.startPreparedTurn(sessionId, prepared.input, userMessage, prepared.tempDirs, options, false);
  }

  async cancelMessage(sessionId: string, directory?: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    const turnId = this.activeTurnIds.get(sessionId);
    if (threadId && turnId && this.client?.running) {
      try {
        await this.client.request("turn/interrupt", { threadId, turnId });
      } catch (error) {
        codexLog.warn(`Failed to interrupt turn ${turnId}:`, error);
      }
    }

    this.failActiveTurn(sessionId, "Cancelled", false);
    this.rejectQueuedMessagesForSession(sessionId, "Cancelled");
    this.rejectPendingForSession(sessionId, "Cancelled");

    if (directory) {
      this.sessionDirectories.set(sessionId, normalizeDirectory(directory));
    }
  }

  async listMessages(sessionId: string): Promise<UnifiedMessage[]> {
    return [...(this.messageHistory.get(sessionId) ?? [])];
  }

  async listHistoricalSessions(limit: number): Promise<ImportableSession[]> {
    try {
      await this.start();
    } catch {
      return [];
    }

    if (!this.client?.running) return [];

    const sessions: ImportableSession[] = [];
    let cursor: string | null | undefined;

    do {
      const response = asRecord(await this.client.request("thread/list", {
        cursor,
        limit: limit > 0 ? Math.min(limit, 100) : 100,
        sortKey: "updated_at",
        archived: false,
      }));

      const data = Array.isArray(response.data) ? response.data : [];
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;

      for (const entry of data) {
        const thread = asRecord(entry);
        const threadId = typeof thread.id === "string" ? thread.id : undefined;
        if (!threadId) continue;

        sessions.push({
          engineSessionId: toEngineSessionId(threadId),
          title:
            (typeof thread.name === "string" && thread.name) ||
            (typeof thread.preview === "string" && thread.preview) ||
            "Codex Thread",
          directory: typeof thread.cwd === "string" ? normalizeDirectory(thread.cwd) : "",
          createdAt: toMillis(thread.createdAt, 0),
          updatedAt: toMillis(thread.updatedAt, toMillis(thread.createdAt, 0)),
          alreadyImported: this.threadToSession.has(threadId),
          engineMeta: { codexThreadId: threadId },
        });

        if (limit > 0 && sessions.length >= limit) {
          return sessions.slice(0, limit);
        }
      }
    } while (cursor);

    return sessions;
  }

  async getHistoricalMessages(
    engineSessionId: string,
    directory: string,
    engineMeta?: Record<string, unknown>,
  ): Promise<UnifiedMessage[]> {
    try {
      await this.start();
    } catch {
      return [];
    }

    if (!this.client?.running) return [];

    const threadId = resolveThreadId(engineSessionId, engineMeta);
    if (!threadId) return [];

    try {
      const response = await this.readStoredThread(threadId, { activeOnly: true });

      return convertThreadToMessages(engineSessionId, response as any, normalizeDirectory(directory));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "CODEX_THREAD_ARCHIVED") throw error;
      codexLog.warn(`Failed to read Codex thread ${threadId}:`, error);
      return [];
    }
  }

  async listModels(): Promise<ModelListResult> {
    try {
      await this.start();
      await this.refreshModelCache();
    } catch (error) {
      codexLog.warn("Failed to refresh Codex model list:", error);
    }

    return {
      models: this.cachedModels,
      currentModelId: this.currentModelId,
    };
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.sessionModels.set(sessionId, modelId);
    this.currentModelId = modelId;
  }

  getModes(): AgentMode[] {
    return CODEX_MODES;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.sessionModes.set(sessionId, modeId);
    this.currentMode = modeId;
  }

  override async setReasoningEffort(sessionId: string, effort: ReasoningEffort | null): Promise<void> {
    if (effort == null) {
      this.sessionReasoningEfforts.delete(sessionId);
      return;
    }
    this.sessionReasoningEfforts.set(sessionId, effort);
  }

  override getReasoningEffort(sessionId: string): ReasoningEffort | null {
    return this.sessionReasoningEfforts.get(sessionId) ?? null;
  }

  async replyPermission(permissionId: string, reply: PermissionReply, _sessionId?: string): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return;

    this.pendingPermissions.delete(permissionId);

    if (!this.client?.running) {
      throw new Error("Codex client is not running");
    }

    switch (pending.method) {
      case "item/commandExecution/requestApproval":
        this.client.respond(pending.requestId, {
          decision: mapCommandApprovalDecision(reply.optionId),
        });
        break;
      case "item/fileChange/requestApproval":
        this.client.respond(pending.requestId, {
          decision: mapFileApprovalDecision(reply.optionId),
        });
        break;
      case "item/permissions/requestApproval": {
        const params = asRecord(pending.params);
        const granted = reply.optionId === "allow_once" || reply.optionId === "allow_always"
          ? asRecord(params.permissions)
          : {};
        this.client.respond(pending.requestId, {
          permissions: granted,
          scope: reply.optionId === "allow_always" ? "session" : "turn",
        });
        break;
      }
      case "execCommandApproval":
        this.client.respond(pending.requestId, {
          decision: mapLegacyReviewDecision(reply.optionId),
        });
        break;
      case "applyPatchApproval":
        this.client.respond(pending.requestId, {
          decision: mapLegacyReviewDecision(reply.optionId),
        });
        break;
      default:
        this.client.respondError(pending.requestId, -32601, `Unsupported approval request: ${pending.method}`);
        break;
    }

    this.touchThread(pending.sessionId);
    this.emit("permission.replied", { permissionId, optionId: reply.optionId });
  }

  async replyQuestion(questionId: string, answers: string[][], _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;

    this.pendingQuestions.delete(questionId);

    if (!this.client?.running) {
      throw new Error("Codex client is not running");
    }

    const params = asRecord(pending.params);
    const questionDefs = Array.isArray(params.questions) ? params.questions : [];
    const responseAnswers: Record<string, { answers: string[] }> = {};

    questionDefs.forEach((question, index) => {
      const questionRecord = asRecord(question);
      const questionIdValue = typeof questionRecord.id === "string" ? questionRecord.id : `q${index}`;
      responseAnswers[questionIdValue] = {
        answers: answers[index] ?? [],
      };
    });

    this.client.respond(pending.requestId, { answers: responseAnswers });
    this.touchThread(pending.sessionId);
    this.emit("question.replied", { questionId, answers });
  }

  async rejectQuestion(questionId: string, _sessionId?: string): Promise<void> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    this.pendingQuestions.delete(questionId);

    if (this.client?.running) {
      this.client.respondError(pending.requestId, -32000, "User rejected the prompt");
    }
  }

  getPendingQuestions(sessionId?: string): UnifiedQuestion[] {
    return CodexAdapter.filterPending(
      this.pendingQuestions, sessionId, (p) => p.question, (p) => p.question.sessionId,
    );
  }

  getPendingPermissions(sessionId?: string): UnifiedPermission[] {
    return CodexAdapter.filterPending(
      this.pendingPermissions, sessionId, (p) => p.permission, (p) => p.permission.sessionId,
    );
  }

  async listProjects(): Promise<UnifiedProject[]> {
    return [];
  }

  override async listCommands(sessionId?: string, directory?: string): Promise<EngineCommand[]> {
    const normalizedDirectory = normalizeDirectory(
      directory ??
      (sessionId ? this.sessionDirectories.get(sessionId) : undefined) ??
      "",
    );

    if (!normalizedDirectory) {
      return [];
    }

    try {
      await this.start();
      return await this.refreshCommandsForDirectory(normalizedDirectory);
    } catch (error) {
      codexLog.warn(`Failed to load Codex skills for ${normalizedDirectory}:`, error);
      return this.skillsByDirectory.get(normalizedDirectory) ?? [];
    }
  }

  override async invokeCommand(
    sessionId: string,
    commandName: string,
    args: string,
    options?: { mode?: string; modelId?: string; reasoningEffort?: ReasoningEffort | null; serviceTier?: CodexServiceTier | null; directory?: string },
  ): Promise<CommandInvokeResult> {
    const directory = normalizeDirectory(
      options?.directory ??
      this.sessionDirectories.get(sessionId) ??
      this.threads.get(this.sessionToThread.get(sessionId) ?? "")?.directory ??
      "",
    );

    if (!directory) {
      return { handledAsCommand: false };
    }

    const commands = await this.listCommands(sessionId, directory);
    if (commands.length === 0) {
      return { handledAsCommand: false };
    }

    const skills = this.skillEntriesByDirectory.get(directory);
    const skill = skills?.get(commandName);
    if (!skill?.enabled) {
      return { handledAsCommand: false };
    }

    const displayText = `/${commandName}${args ? ` ${args}` : ""}`;
    const userMessage = createUserMessage(sessionId, displayText);
    const input: CodexTurnInput[] = [
      { type: "skill", name: skill.name, path: skill.path },
      ...(args.trim() ? [{ type: "text" as const, text: args, text_elements: [] as unknown[] }] : []),
    ];

    const message = await this.startPreparedTurn(
      sessionId,
      input,
      userMessage,
      [],
      { ...options, directory },
      false,
    );

    return {
      handledAsCommand: true,
      message,
    };
  }

  private async spawnAndInitialize(): Promise<void> {
    if (!this.cliPath) throw new Error("Codex CLI path is not resolved");

    const client = new CodexJsonRpcClient({
      cliPath: this.cliPath,
      args: buildStartupArgs(),
    });

    client.on("notification", (method, params) => this.handleNotification(method, params));
    client.on("request", (id, method, params) => this.handleServerRequest(id, method, params));
    client.on("error", (error) => {
      codexLog.error("Codex client error:", error);
      this.lastError = error.message;
    });
    client.on("exit", (code, signal) => {
      codexLog.warn(`Codex process exited (code=${code}, signal=${signal})`);
      this.client = null;
      this.setStatus("error", `Codex process exited (code=${code}, signal=${signal})`);
      this.rejectPendingInteractions("Codex process exited");
      this.rejectQueuedMessages("Codex process exited");
      this.failAllInFlight("Codex process exited");
      this.activeTurnIds.clear();
      this.activeToolParts.clear();
      this.cleanupActiveTempDirs();
      for (const thread of this.threads.values()) {
        thread.loaded = false;
      }
    });

    try {
      await client.start();
      await client.request("initialize", {
        clientInfo: {
          name: "codemux",
          title: "CodeMux",
          version: process.env.npm_package_version ?? "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      client.notify("initialized");

      this.client = client;
    } catch (error) {
      try {
        await client.stop();
      } catch (stopError) {
        codexLog.warn("Failed to stop partially initialized Codex client:", stopError);
      }
      throw error;
    }
  }

  private async refreshRuntimeMetadata(): Promise<void> {
    await Promise.allSettled([
      this.refreshConfigRequirements(),
      this.refreshModelCache(),
      this.refreshAuthStatus(),
    ]);

    // If account/read reports unauthenticated but models are available
    // (e.g. custom model_provider in config.toml), treat as authenticated.
    if (!this.authenticated && this.cachedModels.length > 0) {
      this.authenticated = true;
      this.authMessage = readCodexModelProvider() ?? "Authenticated";
    }
  }

  private async refreshConfigRequirements(): Promise<void> {
    if (!this.client?.running) return;

    const response = asRecord(await this.client.request("configRequirements/read"));
    const requirements = asRecord(response.requirements);
    this.configRequirements = Object.keys(requirements).length > 0
      ? {
          allowedApprovalPolicies: Array.isArray(requirements.allowedApprovalPolicies)
            ? requirements.allowedApprovalPolicies.filter((value): value is CodexApprovalPolicy => typeof value === "string")
            : null,
          allowedSandboxModes: Array.isArray(requirements.allowedSandboxModes)
            ? requirements.allowedSandboxModes.filter((value): value is CodexSandboxMode => typeof value === "string")
            : null,
        }
      : null;
  }

  private async refreshAuthStatus(): Promise<void> {
    if (!this.client?.running) return;

    try {
      const response = asRecord(await this.client.request("account/read", { refreshToken: false }));
      const account = asRecord(response.account);
      const requiresOpenaiAuth = response.requiresOpenaiAuth === true;

      if (Object.keys(account).length === 0) {
        this.authenticated = false;
        this.authType = undefined;
        this.authMessage = requiresOpenaiAuth ? "OpenAI authentication required" : "Not authenticated";
        return;
      }

      this.authenticated = true;
      if (account.type === "chatgpt" && typeof account.email === "string") {
        this.authType = "chatgpt";
        this.authMessage = account.email;
        return;
      }
      if (account.type === "apiKey") {
        this.authType = "apiKey";
        this.authMessage = "API key";
        return;
      }

      this.authType = undefined;
      this.authMessage = "Authenticated";
    } catch (error) {
      codexLog.warn("Failed to read Codex auth status:", error);
    }
  }

  private async refreshModelCache(): Promise<void> {
    if (!this.client?.running) {
      this.ensureFallbackModels();
      return;
    }

    const models: UnifiedModelInfo[] = [];
    let cursor: string | null | undefined;

    do {
      const response = asRecord(await this.client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      }));

      const data = Array.isArray(response.data) ? response.data : [];
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;

      for (const entry of data) {
        const model = asRecord(entry);
        const modelId = typeof model.model === "string"
          ? model.model
          : typeof model.id === "string"
            ? model.id
            : undefined;
        if (!modelId) continue;

        const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
            .map((value) => asRecord(value))
            .map((value) => typeof value.reasoningEffort === "string" ? fromCodexEffort(value.reasoningEffort) : undefined)
            .filter((value): value is ReasoningEffort => value !== undefined)
          : undefined;
        const defaultReasoningEffort = typeof model.defaultReasoningEffort === "string"
          ? fromCodexEffort(model.defaultReasoningEffort)
          : undefined;

        models.push({
          modelId,
          name: typeof model.displayName === "string" && model.displayName ? model.displayName : modelId,
          description: typeof model.description === "string" ? model.description : undefined,
          engineType: this.engineType,
          capabilities: {
            attachment: Array.isArray(model.inputModalities) && model.inputModalities.includes("image"),
            reasoning: Boolean(supportedReasoningEfforts && supportedReasoningEfforts.length > 0),
            supportedReasoningEfforts,
            defaultReasoningEffort,
          },
          meta: {
            hidden: model.hidden === true,
            isDefault: model.isDefault === true,
            upgrade: typeof model.upgrade === "string" ? model.upgrade : undefined,
          },
        });

        if (model.isDefault === true) {
          this.currentModelId = modelId;
        }
      }
    } while (cursor);

    if (models.length === 0) {
      this.ensureFallbackModels();
      return;
    }

    this.cachedModels = models;
  }

  private ensureFallbackModels(): void {
    if (this.cachedModels.length > 0) return;
    this.cachedModels = [{
      modelId: CODEX_FALLBACK_MODEL,
      name: CODEX_FALLBACK_MODEL,
      engineType: this.engineType,
      capabilities: {
        reasoning: true,
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
        defaultReasoningEffort: "medium",
      },
    }];
  }

  private async refreshCommandsForDirectory(directory: string): Promise<EngineCommand[]> {
    if (!this.client?.running) return this.skillsByDirectory.get(directory) ?? [];

    const response = asRecord(await this.client.request("skills/list", {
      cwds: [directory],
      forceReload: false,
    }));
    const data = Array.isArray(response.data) ? response.data : [];
    const entry = data
      .map((item) => asRecord(item))
      .find((item) => normalizeDirectory(String(item.cwd ?? "")) === directory)
      ?? data.map((item) => asRecord(item))[0];

    const skills = Array.isArray(entry?.skills) ? entry.skills : [];
    const nextCommands: EngineCommand[] = [];
    const nextSkillEntries = new Map<string, SkillEntry>();

    for (const skillValue of skills) {
      const skill = asRecord(skillValue);
      const skillInterface = asRecord(skill.interface);
      const name = typeof skill.name === "string" ? skill.name : undefined;
      const path = typeof skill.path === "string" ? skill.path : undefined;
      if (!name || !path) continue;

      const description =
        (typeof skillInterface.shortDescription === "string" && skillInterface.shortDescription) ||
        (typeof skill.shortDescription === "string" && skill.shortDescription) ||
        (typeof skill.description === "string" && skill.description) ||
        "";
      const enabled = skill.enabled !== false;

      nextCommands.push({
        name,
        description,
        source: typeof skill.scope === "string" ? skill.scope : undefined,
        userInvocable: enabled,
      });
      nextSkillEntries.set(name, {
        name,
        description,
        path,
        scope: typeof skill.scope === "string" ? skill.scope : undefined,
        enabled,
      });
    }

    const previous = this.skillsByDirectory.get(directory) ?? [];
    this.skillsByDirectory.set(directory, nextCommands);
    this.skillEntriesByDirectory.set(directory, nextSkillEntries);

    if (JSON.stringify(previous) !== JSON.stringify(nextCommands)) {
      this.emit("commands.changed", {
        engineType: this.engineType,
        commands: nextCommands,
      });
    }

    return nextCommands;
  }

  private handleNotification(method: string, params: unknown): void {
    if (DESKTOP_CATALOG_NOTIFICATION_METHODS.has(method)) {
      for (const listener of this.desktopCatalogListeners) {
        try { listener(method, params); }
        catch { codexLog.warn("A Codex catalog notification observer failed"); }
      }
    }
    const data = asRecord(params);
    const threadId = extractThreadId(method, data);
    const resolvedRequestSession = method === "serverRequest/resolved"
      ? this.pendingPermissions.get(String(data.requestId))?.sessionId ?? this.pendingQuestions.get(String(data.requestId))?.sessionId
      : undefined;
    const sessionId = threadId ? this.threadToSession.get(threadId) : resolvedRequestSession;

    try {
      switch (method) {
        case "thread/started":
          this.handleThreadStarted(data);
          return;
        case "thread/name/updated":
          if (sessionId) this.handleThreadNameUpdated(sessionId, data);
          return;
        case "thread/status/changed":
          if (threadId) this.handleThreadStatusChanged(threadId, data);
          return;
        case "thread/closed":
          if (threadId) this.handleThreadClosed(threadId);
          return;
        case "thread/tokenUsage/updated":
          if (sessionId) this.handleTokenUsageUpdated(sessionId, data);
          return;
        case "turn/started":
          if (sessionId) this.handleTurnStarted(sessionId, data);
          return;
        case "turn/completed":
          if (sessionId) this.handleTurnCompleted(sessionId, data);
          return;
        case "turn/diff/updated":
          if (sessionId) this.handleTurnDiffUpdated(sessionId, data);
          return;
        case "turn/plan/updated":
          if (sessionId) this.handleTurnPlanUpdated(sessionId, data);
          return;
        case "item/started":
          if (sessionId) this.handleItemStarted(sessionId, data);
          return;
        case "item/completed":
          if (sessionId) this.handleItemCompleted(sessionId, data);
          return;
        case "item/agentMessage/delta":
          if (sessionId) this.handleAgentMessageDelta(sessionId, data);
          return;
        case "item/plan/delta":
          if (sessionId) this.handlePlanDelta(sessionId, data);
          return;
        case "item/reasoning/textDelta":
          if (sessionId) this.handleReasoningDelta(sessionId, data, "content");
          return;
        case "item/reasoning/summaryTextDelta":
          if (sessionId) this.handleReasoningDelta(sessionId, data, "summary");
          return;
        case "item/commandExecution/outputDelta":
          if (sessionId) this.handleToolOutputDelta(sessionId, data);
          return;
        case "item/fileChange/outputDelta":
          if (sessionId) this.handleFileChangeDelta(sessionId, data);
          return;
        case "item/mcpToolCall/progress":
          if (sessionId) this.handleMcpProgress(sessionId, data);
          return;
        case "serverRequest/resolved":
          this.handleServerRequestResolved(data);
          return;
        case "skills/changed":
          this.handleSkillsChanged();
          return;
        case "model/rerouted":
          if (sessionId) this.handleModelRerouted(sessionId, data);
          return;
        case "thread/compacted":
          if (sessionId) this.handleContextCompacted(sessionId);
          return;
        case "error":
          if (sessionId) this.handleTurnError(sessionId, data);
          return;
        default:
          codexLog.debug(`Unhandled Codex notification: ${method}`);
          return;
      }
    } finally {
      if (sessionId) this.notifyDesktopOwnerState(sessionId);
    }
  }

  private handleThreadStarted(data: Record<string, unknown>): void {
    const thread = asRecord(data.thread);
    const threadId = typeof thread.id === "string" ? thread.id : undefined;
    if (!threadId) return;

    const sessionId = this.threadToSession.get(threadId);
    if (!sessionId) return;

    this.registerThread(
      sessionId,
      threadId,
      normalizeDirectory(typeof thread.cwd === "string" ? thread.cwd : this.sessionDirectories.get(sessionId) ?? ""),
      typeof thread.name === "string" ? thread.name : undefined,
      true,
      typeof thread.createdAt === "string" || typeof thread.createdAt === "number" ? thread.createdAt : undefined,
      typeof thread.updatedAt === "string" || typeof thread.updatedAt === "number" ? thread.updatedAt : undefined,
    );
  }

  private handleThreadNameUpdated(sessionId: string, data: Record<string, unknown>): void {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return;
    const thread = this.threads.get(threadId);
    if (!thread) return;

    const title = typeof data.threadName === "string" && data.threadName ? data.threadName : undefined;
    thread.title = title;
    thread.updatedAt = Date.now();

    this.emit("session.updated", {
      session: {
        id: sessionId,
        engineType: this.engineType,
        title,
      },
    });
  }

  private handleThreadStatusChanged(threadId: string, data: Record<string, unknown>): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.loaded = true;
    thread.updatedAt = Date.now();

    const status = asRecord(data.status);
    if (status.type === "notLoaded") {
      thread.loaded = false;
    }
  }

  private handleThreadClosed(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.loaded = false;
  }

  private handleTokenUsageUpdated(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    applyTurnUsage(buffer, data.tokenUsage);
  }

  private handleTurnStarted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const turn = asRecord(data.turn);
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    if (!turnId) return;

    buffer.activeTurnId = turnId;
    this.activeTurnIds.set(sessionId, turnId);
    this.touchThread(sessionId);
  }

  private handleTurnCompleted(sessionId: string, data: Record<string, unknown>): void {
    const turn = asRecord(data.turn);
    const status = typeof turn.status === "string" ? turn.status : "completed";

    if (status === "failed") {
      this.failActiveTurn(sessionId, normalizeTurnError(turn.error) ?? "Turn failed", false);
      return;
    }
    if (status === "interrupted") {
      this.failActiveTurn(sessionId, "Cancelled", false);
      return;
    }

    const buffer = this.messageBuffers.get(sessionId) ?? this.ensureBuffer(sessionId);
    applyTurnMetadata(buffer, turn);
    buffer.activeTurnId = typeof turn.id === "string" ? turn.id : buffer.activeTurnId;

    const message = finalizeBufferToMessage(buffer);
    this.appendMessageToHistory(sessionId, message);
    this.emit("message.updated", { sessionId, message });
    this.resolveTurnResolvers(sessionId, message);
    this.finishTurn(sessionId);
    this.processNextQueuedMessage(sessionId);
  }

  private handleTurnDiffUpdated(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    if (typeof data.diff !== "string") return;
    buffer.engineMeta = {
      ...(buffer.engineMeta ?? {}),
      turnDiff: data.diff,
    };
  }

  private handleTurnPlanUpdated(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const plan = Array.isArray(data.plan)
      ? data.plan.map((step) => asRecord(step))
      : [];
    const markdown = formatTurnPlanMarkdown(
      typeof data.explanation === "string" ? data.explanation : null,
      plan.map((step) => ({
        step: typeof step.step === "string" ? step.step : undefined,
        status: typeof step.status === "string" ? step.status : undefined,
      })),
    );

    const part = replacePlanText(buffer, markdown);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handleItemStarted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const item = asRecord(data.item);
    const itemType = typeof item.type === "string" ? item.type : "unknown";

    switch (itemType) {
      case "contextCompaction": {
        const notice = createSystemNotice(buffer, "compact", "notice:context_compressed");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "enteredReviewMode": {
        const notice = createSystemNotice(buffer, "info", "Entered review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "exitedReviewMode": {
        const notice = createSystemNotice(buffer, "info", "Exited review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "agentMessage":
      case "plan":
      case "userMessage":
      case "hookPrompt":
        return;
      case "reasoning":
        this.getReasoningItem(buffer, item);
        return;
      default:
        break;
    }

    const callId = typeof item.id === "string" ? item.id : timeId("call");
    if (this.activeToolParts.has(callId)) return;

    const { stepStart, toolPart } = createToolPart(buffer, callId, itemType, this.itemToToolParams(item));
    this.activeToolParts.set(callId, toolPart);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepStart });
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
  }

  private handleItemCompleted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const item = asRecord(data.item);
    const itemType = typeof item.type === "string" ? item.type : "unknown";

    switch (itemType) {
      case "agentMessage": {
        const text = typeof item.text === "string" ? item.text : "";
        if (text) {
          const part = this.replaceTextPart(buffer, text);
          this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
        }
        return;
      }
      case "reasoning": {
        const state = this.getReasoningItem(buffer, item);
        const summary = normalizeCodexReasoningText(item.summary, []) ? item.summary : this.reasoningBlocks(state.summary);
        const content = normalizeCodexReasoningText([], item.content) ? item.content : this.reasoningBlocks(state.content);
        state.completed = true;
        const text = normalizeCodexReasoningText(summary, content);
        if (text) {
          const part = this.replaceReasoningPart(buffer, state, text);
          this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
        }
        return;
      }
      case "plan": {
        const text = typeof item.text === "string" ? item.text : "";
        const part = replacePlanText(buffer, text.startsWith("#") ? text : `## Plan\n\n${text}`.trimEnd());
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
        return;
      }
      case "contextCompaction": {
        const notice = createSystemNotice(buffer, "compact", "notice:context_compressed");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "enteredReviewMode": {
        const notice = createSystemNotice(buffer, "info", typeof item.review === "string" && item.review ? `Entered review mode: ${item.review}` : "Entered review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      case "exitedReviewMode": {
        const notice = createSystemNotice(buffer, "info", typeof item.review === "string" && item.review ? `Exited review mode: ${item.review}` : "Exited review mode");
        this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
        return;
      }
      default:
        break;
    }

    const callId = typeof item.id === "string" ? item.id : "";
    let toolPart = callId ? this.activeToolParts.get(callId) : undefined;
    if (!toolPart) {
      const synthetic = createToolPart(buffer, callId || timeId("call"), itemType, this.itemToToolParams(item));
      toolPart = synthetic.toolPart;
      this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: synthetic.stepStart });
      this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
    }

    completeToolPart(
      toolPart,
      this.itemToToolOutput(item),
      normalizeItemToolError(item),
      this.itemToToolMetadata(item),
    );
    if (callId) this.activeToolParts.delete(callId);

    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: toolPart });
    const stepFinish = createStepFinish(buffer);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: stepFinish });
  }

  private handleAgentMessageDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;
    const part = appendTextDelta(buffer, delta);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handlePlanDelta(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;
    const part = appendPlanDelta(buffer, delta);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handleReasoningDelta(
    sessionId: string,
    data: Record<string, unknown>,
    channel: "summary" | "content" = "summary",
  ): void {
    const buffer = this.ensureBuffer(sessionId);
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;
    const state = this.getReasoningItem(buffer, data);
    if (state.completed) return;
    const nativeIndex = data[channel === "summary" ? "summaryIndex" : "contentIndex"];
    const index = typeof nativeIndex === "number" && Number.isInteger(nativeIndex) && nativeIndex >= 0 ? nativeIndex : 0;
    const blocks = state[channel];
    blocks.set(index, `${blocks.get(index) ?? ""}${delta}`);
    // Summary and content describe the same item; keep their deltas separate while streaming.
    const summary = normalizeCodexReasoningText(this.reasoningBlocks(state.summary), []);
    const text = summary || normalizeCodexReasoningText([], this.reasoningBlocks(state.content));
    if (!text) return;
    const part = this.replaceReasoningPart(buffer, state, text);
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part });
  }

  private handleToolOutputDelta(sessionId: string, data: Record<string, unknown>): void {
    const itemId = typeof data.itemId === "string" ? data.itemId : "";
    const toolPart = this.activeToolParts.get(itemId);
    if (!toolPart || toolPart.state.status !== "running") return;
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;

    const input = toolPart.state.input as Record<string, unknown>;
    input._output = `${typeof input._output === "string" ? input._output : ""}${delta}`;
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
  }

  private handleFileChangeDelta(sessionId: string, data: Record<string, unknown>): void {
    const itemId = typeof data.itemId === "string" ? data.itemId : "";
    const toolPart = this.activeToolParts.get(itemId);
    if (!toolPart) return;
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return;

    toolPart.diff = `${toolPart.diff ?? ""}${delta}`;
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
  }

  private handleMcpProgress(sessionId: string, data: Record<string, unknown>): void {
    const itemId = typeof data.itemId === "string" ? data.itemId : "";
    const toolPart = this.activeToolParts.get(itemId);
    if (!toolPart || toolPart.state.status !== "running") return;
    const message = typeof data.message === "string" ? data.message : "";
    if (!message) return;

    const input = toolPart.state.input as Record<string, unknown>;
    input._output = `${typeof input._output === "string" ? input._output : ""}${input._output ? "\n" : ""}${message}`;
    this.emit("message.part.updated", { sessionId, messageId: toolPart.messageId, part: toolPart });
  }

  private handleServerRequestResolved(data: Record<string, unknown>): void {
    const requestId = String(data.requestId ?? "");
    if (!requestId) return;
    this.pendingPermissions.delete(requestId);
    this.pendingQuestions.delete(requestId);
  }

  private handleSkillsChanged(): void {
    for (const directory of this.skillsByDirectory.keys()) {
      this.refreshCommandsForDirectory(directory).catch((error) => {
        codexLog.warn(`Failed to refresh skills for ${directory}:`, error);
      });
    }
  }

  private handleModelRerouted(sessionId: string, data: Record<string, unknown>): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    if (typeof data.toModel === "string" && data.toModel) {
      buffer.modelId = data.toModel;
    }
  }

  private handleContextCompacted(sessionId: string): void {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer) return;
    const notice = createSystemNotice(buffer, "compact", "notice:context_compressed");
    this.emit("message.part.updated", { sessionId, messageId: buffer.messageId, part: notice });
  }

  private handleTurnError(sessionId: string, data: Record<string, unknown>): void {
    if (this.desktopOwnerSessions.has(sessionId) && data.willRetry === true) {
      // A retry notification is not a terminal turn; followers must remain able
      // to steer or interrupt the same running ModelHub request.
      return;
    }
    const error = normalizeTurnError(data.error) ?? "Turn failed";
    this.failActiveTurn(sessionId, error, false);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const requestId = String(id);
    const sessionId = this.resolveSessionIdForRequest(method, params);

    if (!sessionId) {
      this.client?.respondError(id, -32000, `Cannot resolve session for server request ${method}`);
      return;
    }

    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
        case "item/permissions/requestApproval":
        case "execCommandApproval":
        case "applyPatchApproval": {
          const permission = convertApprovalToPermission(sessionId, requestId, method, params);
          this.pendingPermissions.set(requestId, { requestId: id, sessionId, method, params, permission });
          this.emit("permission.asked", { permission });
          return;
        }
        case "item/tool/requestUserInput": {
          const question = convertUserInputToQuestion(sessionId, requestId, params);
          this.pendingQuestions.set(requestId, { requestId: id, sessionId, params, question });
          this.emit("question.asked", { question });
          return;
        }
        default:
          this.client?.respondError(id, -32601, `CodeMux does not support ${method}`);
      }
    } finally {
      if (sessionId) this.notifyDesktopOwnerState(sessionId);
    }
  }

  private resolveSessionIdForRequest(method: string, params: unknown): string | undefined {
    const data = asRecord(params);

    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      const conversationId = typeof data.conversationId === "string" ? data.conversationId : undefined;
      return conversationId ? this.threadToSession.get(conversationId) ?? toEngineSessionId(conversationId) : undefined;
    }

    const threadId = typeof data.threadId === "string" ? data.threadId : undefined;
    if (!threadId) return undefined;
    return this.threadToSession.get(threadId) ?? toEngineSessionId(threadId);
  }

  private buildPromptInput(content: MessagePromptContent[]): { input: CodexTurnInput[]; tempDirs: string[]; displayText: string; images: MessagePromptContent[] } {
    const text = content
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
    const images = content.filter((item): item is { type: "image"; data: string; mimeType?: string } => item.type === "image" && typeof item.data === "string");

    if (!text && images.length === 0) {
      throw new Error("Message content cannot be empty");
    }

    const input: CodexTurnInput[] = [];
    const tempDirs: string[] = [];

    try {
      if (text) {
        input.push({ type: "text", text, text_elements: [] });
      }

      for (const image of images) {
        const decoded = Buffer.from(image.data, "base64");
        if (decoded.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
          throw new Error(`Image attachment exceeds the maximum supported size of ${MAX_IMAGE_ATTACHMENT_BYTES} bytes`);
        }

        let tempDir: string | null = null;
        try {
          tempDir = mkdtempSync(join(tmpdir(), "codemux-codex-img-"));
          const extension = mimeToFileExtension(image.mimeType ?? "image/png");
          const tempPath = join(tempDir, `image.${extension}`);
          writeFileSync(tempPath, decoded);
          tempDirs.push(tempDir);
          input.push({ type: "localImage", path: tempPath });
        } catch (error) {
          if (tempDir) {
            this.cleanupTempDirs([tempDir]);
          }
          const message = error instanceof Error && error.message ? error.message : String(error);
          throw new Error(`Failed to prepare image attachment: ${message}`, { cause: error });
        }
      }

      return {
        input,
        tempDirs,
        displayText: text,
        images,
      };
    } catch (error) {
      this.cleanupTempDirs(tempDirs);
      throw error;
    }
  }

  private async startPreparedTurn(
    sessionId: string,
    input: CodexTurnInput[],
    userMessage: UnifiedMessage,
    tempDirs: string[],
    options: CodexMessageOptions | undefined,
    emitQueuedConsumed: boolean,
  ): Promise<UnifiedMessage> {
    const directory = normalizeDirectory(options?.directory ?? this.sessionDirectories.get(sessionId) ?? this.threads.get(this.sessionToThread.get(sessionId) ?? "")?.directory ?? "");
    const threadId = options?.ownerAdmission
      ? this.requireDesktopOwnerThread(sessionId)
      : await this.ensureThreadLoaded(sessionId, directory);
    if (options?.ownerAdmission && this.hasActiveTurn(sessionId)) {
      throw new Error("A Codex turn is already active; use steer instead of start");
    }
    const modeId = options?.mode ?? this.sessionModes.get(sessionId) ?? this.currentMode;
    const modelId = options?.modelId ?? this.sessionModels.get(sessionId) ?? this.currentModelId;
    const reasoningEffort = options?.reasoningEffort ?? this.sessionReasoningEfforts.get(sessionId) ?? null;
    const hasExplicitServiceTier = options != null && Object.prototype.hasOwnProperty.call(options, "serviceTier");
    const serviceTier = hasExplicitServiceTier
      ? (options!.serviceTier ?? null)
      : (this.sessionServiceTiers.get(sessionId) ?? null);
    if (hasExplicitServiceTier) {
      if (serviceTier && isCodexServiceTier(serviceTier)) {
        this.sessionServiceTiers.set(sessionId, serviceTier);
      } else {
        this.sessionServiceTiers.delete(sessionId);
      }
    }
    const approvalPolicy = clampApprovalPolicy(modeToApprovalPolicy(modeId), this.configRequirements);
    const sandboxPolicy = clampSandboxPolicy(modeToSandboxPolicy(modeId, directory), this.configRequirements);

    const buffer = this.createMessageBuffer(sessionId, directory, threadId);
    this.messageBuffers.set(sessionId, buffer);
    this.activeTempDirs.set(sessionId, [...tempDirs]);

    if (emitQueuedConsumed) {
      this.emit("message.queued.consumed", { sessionId, messageId: userMessage.id });
    }
    this.appendMessageToHistory(sessionId, userMessage);
    this.emit("message.updated", { sessionId, message: userMessage });

    return new Promise<UnifiedMessage>((resolve, reject) => {
      this.pushTurnResolver(sessionId, { resolve, reject });
      this.touchThread(sessionId);

      void this.client!.request("turn/start", {
        threadId,
        input,
        cwd: directory,
        approvalPolicy,
        sandboxPolicy,
        model: modelId,
        effort: reasoningEffort ? toCodexEffort(reasoningEffort) : undefined,
        ...(serviceTier ? { serviceTier } : {}),
        collaborationMode: {
          mode: modeId,
          settings: {
            model: modelId,
            reasoning_effort: reasoningEffort ? toCodexEffort(reasoningEffort) : null,
            developer_instructions: null,
          },
        },
        ...options?.nativeOverrides,
      }, START_TIMEOUT_MS)
        .then((response) => {
          const result = asRecord(response) as TurnResponse;
          const turnId = typeof result.turn?.id === "string"
            ? result.turn.id
            : typeof result.turnId === "string"
              ? result.turnId
              : undefined;
          if (turnId && (!options?.ownerAdmission || this.messageBuffers.get(sessionId) === buffer)) {
            this.activeTurnIds.set(sessionId, turnId);
            buffer.activeTurnId = turnId;
          }
          buffer.modelId = modelId;
          buffer.reasoningEffort = reasoningEffort ?? undefined;
          options?.onAdmitted?.(response);
        })
        .catch((error) => {
          options?.onAdmissionFailed?.(error instanceof Error ? error : new Error(String(error)));
          codexLog.error(`Failed to start turn for ${sessionId}:`, error);
          this.failActiveTurn(sessionId, error instanceof Error ? error.message : String(error), false);
        });
    });
  }

  private async steerTurn(
    sessionId: string,
    input: CodexTurnInput[],
    userMessage: UnifiedMessage,
    tempDirs: string[],
    options: CodexMessageOptions | undefined,
  ): Promise<UnifiedMessage> {
    const threadId = this.sessionToThread.get(sessionId);
    const activeTurnId = this.activeTurnIds.get(sessionId);
    if (!threadId || !activeTurnId || !this.client?.running) {
      if (options?.ownerAdmission) throw new Error("No active Codex turn to steer");
      return this.enqueueMessage(sessionId, input, userMessage, tempDirs, options);
    }

    try {
      const response = await this.client.request("turn/steer", {
        threadId,
        input,
        expectedTurnId: activeTurnId,
        ...options?.nativeOverrides,
      }, START_TIMEOUT_MS);

      this.appendMessageToHistory(sessionId, userMessage);
      this.emit("message.updated", { sessionId, message: userMessage });
      const existing = this.activeTempDirs.get(sessionId) ?? [];
      this.activeTempDirs.set(sessionId, [...existing, ...tempDirs]);
      this.touchThread(sessionId);
      options?.onAdmitted?.(response);

      if (options?.ownerAdmission && this.activeTurnIds.get(sessionId) !== activeTurnId) {
        const completed = [...(this.messageHistory.get(sessionId) ?? [])].reverse().find((message) => message.role === "assistant");
        if (completed) return completed;
        throw new Error("The steered Codex turn ended before its admission response");
      }

      return new Promise<UnifiedMessage>((resolve, reject) => {
        this.pushTurnResolver(sessionId, { resolve, reject });
      });
    } catch (error) {
      if (options?.ownerAdmission) {
        this.cleanupTempDirs(tempDirs);
        options.onAdmissionFailed?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      codexLog.warn(`turn/steer failed for ${sessionId}, falling back to queue:`, error);
      return this.enqueueMessage(sessionId, input, userMessage, tempDirs, options);
    }
  }

  private async enqueueMessage(
    sessionId: string,
    input: CodexTurnInput[],
    userMessage: UnifiedMessage,
    tempDirs: string[],
    options: CodexMessageOptions | undefined,
  ): Promise<UnifiedMessage> {
    return new Promise<UnifiedMessage>((resolve, reject) => {
      const queue = this.messageQueues.get(sessionId) ?? [];
      queue.push({
        input,
        userMessage,
        tempDirs,
        options,
        resolver: { resolve, reject },
      });
      this.messageQueues.set(sessionId, queue);

      this.emit("message.queued", {
        sessionId,
        messageId: userMessage.id,
        queuePosition: queue.length,
      });
    });
  }

  private async processNextQueuedMessage(sessionId: string): Promise<void> {
    if (this.hasActiveTurn(sessionId)) return;

    const queue = this.messageQueues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) {
      this.messageQueues.delete(sessionId);
    }

    try {
      const message = await this.startPreparedTurn(
        sessionId,
        next.input,
        next.userMessage,
        next.tempDirs,
        next.options,
        true,
      );
      next.resolver.resolve(message);
    } catch (error) {
      this.cleanupTempDirs(next.tempDirs);
      next.resolver.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private createMessageBuffer(sessionId: string, directory: string, threadId: string): MessageBuffer {
    return {
      messageId: timeId("msg"),
      sessionId,
      parts: [],
      textAccumulator: "",
      textPartId: null,
      reasoningAccumulator: "",
      reasoningPartId: null,
      planAccumulator: undefined,
      planPartId: null,
      startTime: Date.now(),
      workingDirectory: directory,
      activeTurnId: this.activeTurnIds.get(sessionId),
      engineMeta: { codexThreadId: threadId },
    };
  }

  private ensureBuffer(sessionId: string): MessageBuffer {
    const existing = this.messageBuffers.get(sessionId);
    if (existing) return existing;

    const threadId = this.sessionToThread.get(sessionId) ?? resolveThreadId(sessionId);
    const directory = this.sessionDirectories.get(sessionId) ?? this.threads.get(threadId ?? "")?.directory ?? ".";
    const buffer = this.createMessageBuffer(sessionId, directory, threadId ?? "");
    this.messageBuffers.set(sessionId, buffer);
    return buffer;
  }

  private replaceTextPart(buffer: MessageBuffer, text: string) {
    buffer.textAccumulator = text;
    buffer.leadingTrimmed = true;
    if (!buffer.textPartId) buffer.textPartId = timeId("part");
    const part = {
      id: buffer.textPartId,
      messageId: buffer.messageId,
      sessionId: buffer.sessionId,
      type: "text" as const,
      text,
    };
    upsertPart(buffer.parts, part);
    return part;
  }

  private getReasoningItem(buffer: MessageBuffer, data: Record<string, unknown>): CodexReasoningItemState {
    let items = this.reasoningItems.get(buffer);
    if (!items) {
      items = new Map();
      this.reasoningItems.set(buffer, items);
    }
    const itemId = typeof data.itemId === "string" ? data.itemId : typeof data.id === "string" ? data.id : "";
    let state = items.get(itemId);
    if (!state) {
      state = { partId: timeId("part"), summary: new Map(), content: new Map(), completed: false };
      items.set(itemId, state);
    }
    return state;
  }

  private reasoningBlocks(blocks: Map<number, string>): string[] {
    return [...blocks.entries()].sort(([left], [right]) => left - right).map(([, text]) => text);
  }

  private replaceReasoningPart(buffer: MessageBuffer, state: CodexReasoningItemState, text: string): ReasoningPart {
    const part: ReasoningPart = {
      id: state.partId,
      messageId: buffer.messageId,
      sessionId: buffer.sessionId,
      type: "reasoning",
      text,
    };
    upsertPart(buffer.parts, part);
    return part;
  }

  private itemToToolParams(item: Record<string, unknown>): Record<string, unknown> {
    const type = typeof item.type === "string" ? item.type : "unknown";
    switch (type) {
      case "commandExecution":
        return {
          command: item.command,
          cwd: item.cwd,
          commandActions: item.commandActions,
        };
      case "fileChange":
        return { changes: item.changes };
      case "mcpToolCall":
        return { server: item.server, tool: item.tool, arguments: item.arguments };
      case "dynamicToolCall":
        return { tool: item.tool, arguments: item.arguments };
      case "collabAgentToolCall":
        return {
          tool: item.tool,
          prompt: item.prompt,
          description: typeof item.tool === "string" ? `Delegating via ${item.tool}` : "Delegating task",
        };
      case "webSearch":
        return { query: item.query, action: item.action };
      case "imageView":
        return { path: item.path };
      case "imageGeneration":
        return { description: item.revisedPrompt ?? "Generating image", savedPath: item.savedPath };
      default:
        return {};
    }
  }

  private itemToToolOutput(item: Record<string, unknown>): unknown {
    const type = typeof item.type === "string" ? item.type : "unknown";
    switch (type) {
      case "commandExecution":
        return item.aggregatedOutput ?? "";
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return changes
          .map((change) => asRecord(change))
          .map((change) => typeof change.path === "string" ? change.path : "")
          .filter(Boolean)
          .join("\n");
      }
      case "mcpToolCall":
        return item.result ?? "";
      case "dynamicToolCall":
        return item.contentItems ?? item.result ?? "";
      case "collabAgentToolCall":
        return { receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates };
      case "webSearch":
        return item.query ?? "";
      case "imageView":
        return item.path ?? "";
      case "imageGeneration":
        return item.savedPath ?? item.result ?? "";
      default:
        return "";
    }
  }

  private itemToToolMetadata(item: Record<string, unknown>): Record<string, unknown> | undefined {
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const diff = changes
        .map((change) => asRecord(change))
        .map((change) => typeof change.diff === "string" ? change.diff : "")
        .filter(Boolean)
        .join("\n");
      return diff ? { diff } : undefined;
    }
    return undefined;
  }

  private async startThread(directory: string, projectId?: string): Promise<ThreadResponse> {
    const modeId = this.currentMode;
    const approvalPolicy = clampApprovalPolicy(modeToApprovalPolicy(modeId), this.configRequirements);
    const sandboxMode = clampSandboxMode(modeToSandboxMode(modeId), this.configRequirements);
    const response = asRecord(await this.client!.request("thread/start", {
      cwd: directory,
      model: this.currentModelId,
      approvalPolicy,
      sandbox: sandboxMode,
      baseInstructions: CODEMUX_IDENTITY_PROMPT,
      serviceName: "codemux",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...(projectId !== undefined ? { projectId } : {}),
      // Codex 0.154 defaults to paginated history, whose direct app-server read
      // methods are not implemented in this runtime. Keep this explicit choice
      // confined to the private Desktop owner runtime; ordinary Codex is unchanged.
      ...(this.desktopOwnerRuntimeEnabled ? { historyMode: "legacy" } : {}),
    })) as ThreadResponse;

    return response;
  }

  private async resumeThread(threadId: string, directory: string, preserveSettings = false): Promise<ThreadResponse> {
    if (preserveSettings) {
      // A persisted CodeMux owner must resume the same native context. Applying
      // today's defaults here can change its model family or permission profile.
      return asRecord(await this.client!.request("thread/resume", {
        threadId,
        persistExtendedHistory: true,
      })) as ThreadResponse;
    }
    const sessionId = toEngineSessionId(threadId);
    const modeId = this.sessionModes.get(sessionId) ?? this.currentMode;
    const approvalPolicy = clampApprovalPolicy(modeToApprovalPolicy(modeId), this.configRequirements);
    const sandboxMode = clampSandboxMode(modeToSandboxMode(modeId), this.configRequirements);
    const modelId = this.sessionModels.get(sessionId) ?? this.currentModelId;
    const serviceTier = this.sessionServiceTiers.get(sessionId);

    const response = asRecord(await this.client!.request("thread/resume", {
      threadId,
      cwd: directory,
      model: modelId,
      approvalPolicy,
      sandbox: sandboxMode,
      baseInstructions: CODEMUX_IDENTITY_PROMPT,
      persistExtendedHistory: true,
      ...(serviceTier ? { serviceTier } : {}),
    })) as ThreadResponse;

    return response;
  }

  private async ensureThreadLoaded(sessionId: string, directory: string): Promise<string> {
    if (!this.client?.running) {
      throw new Error("Codex client is not running");
    }

    const threadId = this.sessionToThread.get(sessionId) ?? resolveThreadId(sessionId);
    if (!threadId) {
      throw new Error(`No Codex thread found for session ${sessionId}`);
    }

    const thread = this.threads.get(threadId);
    if (thread?.loaded) {
      return threadId;
    }

    const response = await this.resumeThread(threadId, directory);
    this.registerThread(
      sessionId,
      threadId,
      directory,
      response.thread?.name ?? thread?.title,
      true,
      response.thread?.createdAt ?? thread?.createdAt,
      response.thread?.updatedAt ?? thread?.updatedAt,
    );
    return threadId;
  }

  private pushTurnResolver(sessionId: string, resolver: SendResolver): void {
    const resolvers = this.turnResolvers.get(sessionId) ?? [];
    resolvers.push(resolver);
    this.turnResolvers.set(sessionId, resolvers);
  }

  private resolveTurnResolvers(sessionId: string, message: UnifiedMessage): void {
    const resolvers = this.turnResolvers.get(sessionId) ?? [];
    this.turnResolvers.delete(sessionId);
    for (const resolver of resolvers) {
      resolver.resolve(message);
    }
  }

  private rejectQueuedMessages(reason: string): void {
    for (const [sessionId] of this.messageQueues) {
      this.rejectQueuedMessagesForSession(sessionId, reason);
    }
  }

  private rejectQueuedMessagesForSession(sessionId: string, reason: string): void {
    const queue = this.messageQueues.get(sessionId);
    if (!queue) return;
    this.messageQueues.delete(sessionId);
    for (const queued of queue) {
      this.cleanupTempDirs(queued.tempDirs);
      queued.resolver.reject(new Error(reason));
    }
  }

  private rejectPendingInteractions(reason: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      this.respondToDroppedPermission(pending, reason);
      this.emit("permission.replied", { permissionId: id, optionId: "reject_once" });
      codexLog.debug(`Dropped pending permission ${id}: ${reason}`);
      void pending;
    }
    for (const [id, pending] of this.pendingQuestions) {
      this.pendingQuestions.delete(id);
      this.respondToDroppedQuestion(pending, reason);
      codexLog.debug(`Dropped pending question ${id}: ${reason}`);
    }
  }

  private rejectPendingForSession(sessionId: string, reason: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(id);
      this.respondToDroppedPermission(pending, reason);
      this.emit("permission.replied", { permissionId: id, optionId: "reject_once" });
      codexLog.debug(`Dropped pending permission ${id}: ${reason}`);
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingQuestions.delete(id);
      this.respondToDroppedQuestion(pending, reason);
      codexLog.debug(`Dropped pending question ${id}: ${reason}`);
    }
  }

  private respondToDroppedPermission(pending: PendingPermission, reason: string): void {
    if (!this.client?.running) return;

    try {
      switch (pending.method) {
        case "item/commandExecution/requestApproval":
          this.client.respond(pending.requestId, { decision: "decline" });
          return;
        case "item/fileChange/requestApproval":
          this.client.respond(pending.requestId, { decision: "decline" });
          return;
        case "item/permissions/requestApproval":
          this.client.respond(pending.requestId, { permissions: {}, scope: "turn" });
          return;
        case "execCommandApproval":
        case "applyPatchApproval":
          this.client.respond(pending.requestId, { decision: "denied" });
          return;
        default:
          this.client.respondError(pending.requestId, -32000, reason);
      }
    } catch (error) {
      codexLog.warn(`Failed to reject pending permission ${String(pending.requestId)}:`, error);
    }
  }

  private respondToDroppedQuestion(pending: PendingQuestion, reason: string): void {
    if (!this.client?.running) return;

    try {
      this.client.respondError(pending.requestId, -32000, reason);
    } catch (error) {
      codexLog.warn(`Failed to reject pending question ${String(pending.requestId)}:`, error);
    }
  }

  private failAllInFlight(errorMessage: string): void {
    for (const sessionId of this.messageBuffers.keys()) {
      this.failActiveTurn(sessionId, errorMessage, false);
    }
  }

  private failActiveTurn(sessionId: string, errorMessage: string, staleSession: boolean): void {
    const buffer = this.messageBuffers.get(sessionId) ?? this.ensureBuffer(sessionId);
    buffer.error = errorMessage;
    const message: UnifiedMessage = {
      ...finalizeBufferToMessage(buffer),
      staleSession,
    };

    this.appendMessageToHistory(sessionId, message);
    this.emit("message.updated", { sessionId, message });
    this.resolveTurnResolvers(sessionId, message);
    this.finishTurn(sessionId);
    void this.processNextQueuedMessage(sessionId);
  }

  private finishTurn(sessionId: string): void {
    this.messageBuffers.delete(sessionId);
    this.activeTurnIds.delete(sessionId);

    const tempDirs = this.activeTempDirs.get(sessionId);
    if (tempDirs) {
      this.cleanupTempDirs(tempDirs);
      this.activeTempDirs.delete(sessionId);
    }
  }

  private hasActiveTurn(sessionId: string): boolean {
    return this.activeTurnIds.has(sessionId) || this.messageBuffers.has(sessionId) || (this.turnResolvers.get(sessionId)?.length ?? 0) > 0;
  }

  private canSteer(
    sessionId: string,
    options: {
      mode?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      directory?: string;
    } | undefined,
    directory: string,
  ): boolean {
    const requestedMode = options?.mode ?? this.sessionModes.get(sessionId) ?? this.currentMode;
    const requestedModel = options?.modelId ?? this.sessionModels.get(sessionId) ?? this.currentModelId;
    const requestedEffort = options?.reasoningEffort ?? this.sessionReasoningEfforts.get(sessionId) ?? null;
    const requestedTier = options?.serviceTier ?? this.sessionServiceTiers.get(sessionId) ?? null;
    const sessionDirectory = normalizeDirectory(this.sessionDirectories.get(sessionId) ?? directory);

    return requestedMode === (this.sessionModes.get(sessionId) ?? this.currentMode)
      && requestedModel === (this.sessionModels.get(sessionId) ?? this.currentModelId)
      && requestedEffort === (this.sessionReasoningEfforts.get(sessionId) ?? null)
      && requestedTier === (this.sessionServiceTiers.get(sessionId) ?? null)
      && directory === sessionDirectory;
  }

  private registerThread(
    sessionId: string,
    threadId: string,
    directory: string,
    title: string | undefined,
    loaded: boolean,
    createdAt?: string | number,
    updatedAt?: string | number,
  ): void {
    const normalizedDirectory = normalizeDirectory(directory);
    this.sessionToThread.set(sessionId, threadId);
    this.threadToSession.set(threadId, sessionId);
    this.sessionDirectories.set(sessionId, normalizedDirectory);

    const existing = this.threads.get(threadId);
    const now = Date.now();
    this.threads.set(threadId, {
      threadId,
      directory: normalizedDirectory,
      createdAt: toMillis(createdAt, existing?.createdAt ?? now),
      updatedAt: toMillis(updatedAt, existing?.updatedAt ?? now),
      lastUsedAt: now,
      title: title ?? existing?.title,
      loaded,
    });
  }

  private touchThread(sessionId: string): void {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return;
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.lastUsedAt = Date.now();
    thread.updatedAt = Date.now();
  }

  private clearSessionState(sessionId: string): void {
    this.nativeSessionSettings.delete(sessionId);
    this.desktopOwnerSessions.delete(sessionId);
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId) {
      this.threadToSession.delete(threadId);
      this.threads.delete(threadId);
    }

    this.sessionToThread.delete(sessionId);
    this.messageBuffers.delete(sessionId);
    this.messageHistory.delete(sessionId);
    this.turnResolvers.delete(sessionId);
    this.activeTurnIds.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionModels.delete(sessionId);
    this.sessionReasoningEfforts.delete(sessionId);
    this.sessionServiceTiers.delete(sessionId);
    this.sessionDirectories.delete(sessionId);
    this.rejectQueuedMessagesForSession(sessionId, "Session deleted");
    this.rejectPendingForSession(sessionId, "Session deleted");

    const tempDirs = this.activeTempDirs.get(sessionId);
    if (tempDirs) {
      this.cleanupTempDirs(tempDirs);
      this.activeTempDirs.delete(sessionId);
    }
  }

  private appendMessageToHistory(sessionId: string, message: UnifiedMessage): void {
    const history = this.messageHistory.get(sessionId) ?? [];
    history.push(message);
    this.messageHistory.set(sessionId, history);
  }

  private startSessionCleanup(): void {
    if (this.cleanupIntervalId) return;
    this.cleanupIntervalId = setInterval(() => {
      void this.cleanupIdleThreads();
    }, 60_000);
  }

  private stopSessionCleanup(): void {
    if (!this.cleanupIntervalId) return;
    clearInterval(this.cleanupIntervalId);
    this.cleanupIntervalId = null;
  }

  private async cleanupIdleThreads(): Promise<void> {
    if (!this.client?.running) return;
    const now = Date.now();

    for (const [threadId, thread] of this.threads) {
      if (!thread.loaded) continue;
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) continue;
      if (this.desktopOwnerSessions.has(sessionId)) continue;
      if (this.hasActiveTurn(sessionId)) continue;
      if ((this.messageQueues.get(sessionId)?.length ?? 0) > 0) continue;
      if (now - thread.lastUsedAt < SESSION_IDLE_TIMEOUT_MS) continue;

      try {
        await this.client.request("thread/unsubscribe", { threadId });
        thread.loaded = false;
      } catch (error) {
        codexLog.warn(`Failed to unsubscribe idle Codex thread ${threadId}:`, error);
      }
    }
  }

  private cleanupTempDirs(tempDirs: string[]): void {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  private cleanupActiveTempDirs(): void {
    for (const dirs of this.activeTempDirs.values()) {
      this.cleanupTempDirs(dirs);
    }
    this.activeTempDirs.clear();
  }

  private setStatus(status: EngineStatus, error?: string): void {
    this.status = status;
    this.lastError = status === "error" ? error : undefined;
    this.emit("status.changed", {
      engineType: this.engineType,
      status,
      error,
    });
  }

  private failStart(message: string): Error {
    this.setStatus("error", message);
    return new Error(message);
  }
}

export function createCodexDesktopOwnerRuntime(adapter: CodexAdapter): CodexDesktopOwnerRuntime {
  return adapter.createDesktopOwnerRuntime();
}

const DESKTOP_OWNER_SETTING_KEYS = new Set([
  "model", "effort", "cwd", "serviceTier", "collaborationMode", "approvalPolicy", "approvalsReviewer",
  "sandboxPolicy", "permissions", "multiAgentMode", "personality", "summary", "outputSchema",
]);

function pickDesktopOwnerSettings(value: Record<string, unknown>, includeTurnFields = false): Record<string, unknown> {
  const keys = [
    ...DESKTOP_OWNER_SETTING_KEYS,
    ...(includeTurnFields ? ["clientUserMessageId", "additionalContext", "responsesapiClientMetadata"] : []),
  ];
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined).map((key) => [key, value[key]]));
}

function parseDesktopOwnerInput(value: unknown): CodexTurnInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Desktop owner input must be a non-empty array");
  return value.map((entry): CodexTurnInput => {
    const item = asRecord(entry);
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text, text_elements: Array.isArray(item.text_elements) ? item.text_elements : [] };
    }
    if (item.type === "image" && typeof item.url === "string") {
      const data = /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]*)$/.exec(item.url);
      if (!data) throw new Error("Desktop owner images must be data URLs");
      if (Buffer.byteLength(data[1], "base64") > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error("Desktop owner image attachment is too large");
      return { type: "image", url: item.url };
    }
    if (item.type === "localImage" && typeof item.path === "string" && item.path) return { type: "localImage", path: item.path };
    if (item.type === "skill" && typeof item.name === "string" && typeof item.path === "string") return { type: "skill", name: item.name, path: item.path };
    throw new Error(`Unsupported Desktop owner input type: ${String(item.type)}`);
  });
}

function toEngineSessionId(threadId: string): string {
  return threadId.startsWith("codex_") ? threadId : `codex_${threadId}`;
}

function resolveThreadId(engineSessionId?: string, engineMeta?: Record<string, unknown>): string | undefined {
  if (engineMeta?.codexThreadId && typeof engineMeta.codexThreadId === "string") {
    return engineMeta.codexThreadId;
  }
  if (!engineSessionId) return undefined;
  return engineSessionId.startsWith("codex_") ? engineSessionId.slice("codex_".length) : engineSessionId;
}

function extractThreadId(method: string, data: Record<string, unknown>): string | undefined {
  if (typeof data.threadId === "string") return data.threadId;
  if (method === "thread/started") {
    const thread = asRecord(data.thread);
    return typeof thread.id === "string" ? thread.id : undefined;
  }
  return undefined;
}

function mapCommandApprovalDecision(optionId: string): string {
  switch (optionId) {
    case "allow_always":
      return "acceptForSession";
    case "reject_once":
      return "decline";
    case "allow_once":
    default:
      return "accept";
  }
}

function mapFileApprovalDecision(optionId: string): string {
  switch (optionId) {
    case "allow_always":
      return "acceptForSession";
    case "reject_once":
      return "decline";
    case "allow_once":
    default:
      return "accept";
  }
}

function mapLegacyReviewDecision(optionId: string): string {
  switch (optionId) {
    case "allow_always":
      return "approved_for_session";
    case "reject_once":
      return "denied";
    case "allow_once":
    default:
      return "approved";
  }
}

function normalizeTurnError(error: unknown): string | undefined {
  if (typeof error === "string" && error) return error;
  if (!error || typeof error !== "object") return undefined;

  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : undefined;
  const details = typeof record.additionalDetails === "string" ? record.additionalDetails : undefined;
  if (message && details) return `${message}\n\n${details}`;
  return message;
}

function normalizeItemToolError(item: Record<string, unknown>): string | undefined {
  const explicit = normalizeTurnError(item.error);
  if (explicit) return explicit;
  if (typeof item.exitCode === "number" && item.exitCode !== 0) {
    return `Exit code: ${item.exitCode}`;
  }
  if (item.status === "failed" || item.status === "declined") {
    return typeof item.result === "string" && item.result ? item.result : "Tool failed";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function toMillis(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
