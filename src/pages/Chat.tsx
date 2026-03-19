import {
  createEffect,
  createSignal,
  createMemo,
  Show,
  For,
  onMount,
  onCleanup,
  batch,
} from "solid-js";
import { Auth } from "../lib/auth";
import { useNavigate } from "@solidjs/router";
import { gateway } from "../lib/gateway-api";
import { logger } from "../lib/logger";
import { isElectron } from "../lib/platform";
import { sessionStore, setSessionStore, type SessionInfo, setSendingFor } from "../stores/session";
import {
  messageStore,
  setMessageStore,
  type QueuedMessage,
} from "../stores/message";
import { MessageList } from "../components/MessageList";
import { PromptInput } from "../components/PromptInput";
import { SessionSidebar } from "../components/SessionSidebar";
import { HideProjectModal } from "../components/HideProjectModal";
import { AddProjectModal } from "../components/AddProjectModal";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion, UnifiedSession, UnifiedProject, AgentMode, EngineType, SessionActivityStatus } from "../types/unified";
import { useI18n, formatMessage } from "../lib/i18n";
import { isDefaultTitle } from "../lib/session-utils";
import { formatTokenCount, formatCostWithUnit, getEngineBadge } from "../components/share/common";
import { getSetting, saveSetting } from "../lib/settings";

import { InputAreaQuestion } from "../components/InputAreaQuestion";
import { InputAreaPermission } from "../components/InputAreaPermission";
import { TodoDock } from "../components/TodoDock";

import { configStore, setConfigStore, getSelectedModelForEngine, restoreEngineModelSelections, isEngineEnabled, restoreEnabledEngines, getDefaultEngineType, restoreDefaultEngine } from "../stores/config";

// Binary search helper (consistent with opencode desktop)
function binarySearch<T>(
  arr: T[],
  target: string,
  getId: (item: T) => string,
): { found: boolean; index: number } {
  let left = 0;
  let right = arr.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midId = getId(arr[mid]);

    if (midId === target) {
      return { found: true, index: mid };
    } else if (midId < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return { found: false, index: left };
}

function toSessionInfo(s: UnifiedSession, projectID?: string): SessionInfo {
  return {
    id: s.id,
    engineType: s.engineType,
    title: s.title || "",
    directory: s.directory || "",
    projectID: projectID ?? s.projectId ?? undefined,
    createdAt: new Date(s.time.created).toISOString(),
    updatedAt: new Date(s.time.updated).toISOString(),
  };
}

export default function Chat() {
  const { t } = useI18n();
  const navigate = useNavigate();
  // Per-session sending state lives in sessionStore.sendingMap (persists across navigations).
  const sending = createMemo(() => {
    const sid = sessionStore.current;
    return sid ? (sessionStore.sendingMap[sid] ?? false) : false;
  });

  // Track the latest todo part per session — avoids O(N×M) full scan in currentTodos memo.
  // Updated in handlePartUpdated (O(1) check) and handleMessageUpdated (O(K) scan of incoming parts).
  const [todoPartRef, setTodoPartRef] = createSignal<{
    sessionId: string;
    messageId: string;
    partId: string;
  } | null>(null);

  // Track sessions that completed while user was viewing another session
  const [unreadSessions, setUnreadSessions] = createSignal<Set<string>>(new Set());
  let prevSendingMap: Record<string, boolean> = {};
  createEffect(() => {
    const currentMap = { ...sessionStore.sendingMap };
    const currentSession = sessionStore.current;
    for (const [sessionId, wasSending] of Object.entries(prevSendingMap)) {
      if (wasSending && !currentMap[sessionId] && sessionId !== currentSession) {
        setUnreadSessions((prev) => {
          const next = new Set(prev);
          next.add(sessionId);
          return next;
        });
      }
    }
    prevSendingMap = { ...currentMap };
  });

  // Compute activity status for a single session (called on-demand, not a global memo)
  const getSessionStatus = (sid: string): SessionActivityStatus => {
    const pendingPerms = messageStore.permission[sid];
    if (pendingPerms && pendingPerms.length > 0) return "waiting";
    const pendingQuestions = messageStore.question[sid];
    if (pendingQuestions && pendingQuestions.length > 0) return "waiting";
    if (sessionStore.sendingMap[sid]) return "running";
    const messages = messageStore.message[sid];
    if (messages && messages.length > 0) {
      let lastAssistant: UnifiedMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m.role === "assistant") {
          lastAssistant = m;
          break;
        }
      }
      if (lastAssistant?.error) {
        return lastAssistant.error === "Cancelled" ? "cancelled" : "error";
      }
    }
    if (unreadSessions().has(sid)) return "completed";
    return "idle";
  };
  const [messagesRef, setMessagesRef] = createSignal<HTMLDivElement>();
  const [loadingMessages, setLoadingMessages] = createSignal(false);
  // Whether user has scrolled away from the bottom. When true, auto-scroll
  // during streaming is suppressed so the user can read earlier content.
  const [userScrolledUp, setUserScrolledUp] = createSignal(false);

  // Current session's pending permissions and questions (for input area replacement)
  const currentPermissions = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return [];
    return messageStore.permission[sid] || [];
  });
  const currentQuestions = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return [];
    return messageStore.question[sid] || [];
  });

  // Extract latest todos from the most recent TodoWrite tool part in the current session.
  // All adapters normalize input.todos to [{ content, status }] arrays before reaching here.
  //
  // Performance: uses todoPartRef signal (updated in handlePartUpdated / handleMessageUpdated)
  // for O(1) lookup instead of O(N×M) full scan of all messages × parts per frame.
  const currentTodos = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return [];
    const ref = todoPartRef();
    if (!ref || ref.sessionId !== sid) return [];
    const parts = messageStore.part[ref.messageId];
    if (!parts) return [];
    const part = parts.find(p => p.id === ref.partId);
    if (!part || part.type !== "tool") return [];
    const tp = part as any;
    const status = tp.state?.status;
    if (status !== "completed" && status !== "running") return [];
    const todos = tp.state?.input?.todos;
    if (Array.isArray(todos) && todos.length > 0) {
      return todos as Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
      }>;
    }
    return [];
  });

  const getDisplayTitle = (title: string): string => {
    if (!title || isDefaultTitle(title)) {
      return t().sidebar.newSession;
    }
    return title;
  };

  // When the active session changes, scan once for the latest todo part.
  // This runs only on session switch (O(N×M) once), not on every streaming frame.
  createEffect(() => {
    const sid = sessionStore.current;
    if (!sid) {
      setTodoPartRef(null);
      return;
    }
    const messages = messageStore.message[sid] || [];
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const msg = messages[mi];
      if (msg.role !== "assistant") continue;
      const parts = messageStore.part[msg.id] || [];
      for (let pi = parts.length - 1; pi >= 0; pi--) {
        const p = parts[pi];
        if (p.type === "tool" && (p as any).normalizedTool === "todo") {
          setTodoPartRef({ sessionId: sid, messageId: msg.id, partId: p.id });
          return;
        }
      }
    }
    // No todo part found for this session
    setTodoPartRef(null);
  });

  // Agent mode state - default to "build" matching OpenCode's default
  const [currentAgent, setCurrentAgent] = createSignal<AgentMode>({ id: "build", label: "Build" });

  // Track whether the component has been disposed (cleaned up) to suppress
  // errors from async operations that complete after gateway.destroy().
  let disposed = false;

  // Derive the engine type of the currently selected session
  const currentEngineType = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return getDefaultEngineType();
    const session = sessionStore.list.find(s => s.id === sid);
    return session?.engineType || getDefaultEngineType();
  });

  // Engine badge for title bar
  const currentEngineBadge = createMemo(() =>
    getEngineBadge(currentEngineType()) ?? { label: currentEngineType(), class: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400" }
  );

  // Whether the current engine supports enqueuing messages while busy
  const canEnqueue = createMemo(() => {
    const engineInfo = configStore.engines.find(e => e.type === currentEngineType());
    return engineInfo?.capabilities?.messageEnqueue ?? false;
  });

  // Number of messages waiting in the queue for the current session
  const queueCount = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return 0;
    return (messageStore.queued[sid] || []).length;
  });

  // Queued messages for the current session (for preview rendering)
  const currentQueuedMessages = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return [];
    return messageStore.queued[sid] || [];
  });

  // Aggregate token usage across all assistant messages in the current session
  const sessionUsage = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return null;
    const messages = messageStore.message[sid] ?? [];
    let input = 0, output = 0, cost = 0;
    let hasTokens = false, hasCost = false;
    let costUnit: "usd" | "premium_requests" | undefined;
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.tokens) continue;
      hasTokens = true;
      input += msg.tokens.input ?? 0;
      output += msg.tokens.output ?? 0;
      if (msg.cost != null) { cost += msg.cost; hasCost = true; costUnit = msg.costUnit; }
    }
    return hasTokens ? { input, output, cost: hasCost ? cost : undefined, costUnit } : null;
  });

  // Keep currentAgent in sync: whenever the engine type changes or engine
  // capabilities are refreshed (e.g. ACP modes populated after createSession),
  // reset to the first available mode if the current one doesn't belong to
  // the active engine.
  createEffect(() => {
    const engineType = currentEngineType();
    const engineInfo = configStore.engines.find(e => e.type === engineType);
    const availableModes = engineInfo?.capabilities?.availableModes;
    if (availableModes && availableModes.length > 0) {
      const cur = currentAgent();
      if (!availableModes.some(m => m.id === cur.id)) {
        setCurrentAgent(availableModes[0]);
      }
    }
  });

  // Mobile Sidebar State
  const [isSidebarOpen, setIsSidebarOpen] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(window.innerWidth < 768);
  // Desktop sidebar collapse (icon-only mode)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = createSignal(false);
  const [refreshingSessions, setRefreshingSessions] = createSignal(false);

  // Send validation error (auto-clears after 3s)
  const [sendError, setSendError] = createSignal<string | null>(null);
  let sendErrorTimer: ReturnType<typeof setTimeout> | undefined;
  const showSendError = (msg: string) => {
    clearTimeout(sendErrorTimer);
    setSendError(msg);
    sendErrorTimer = setTimeout(() => setSendError(null), 3000);
  };
  onCleanup(() => clearTimeout(sendErrorTimer));

  const [deleteProjectInfo, setDeleteProjectInfo] = createSignal<{
    projectID: string;
    projectName: string;
    sessionCount: number;
  } | null>(null);

  const [showAddProjectModal, setShowAddProjectModal] = createSignal(false);

  // WebSocket connection status
  const [wsConnected, setWsConnected] = createSignal(true);

  // Track if this is a local access (Electron or localhost web)
  const [isLocalAccess, setIsLocalAccess] = createSignal(isElectron());

  const handleLogout = () => {
    Auth.logout();
    navigate("/", { replace: true });
  };

  // ── Scroll helpers ──────────────────────────────────────────────

  const scrollToBottom = () => {
    const el = messagesRef();
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Stabilized scroll-to-bottom for session entry. After the initial scroll,
  // CSS content-visibility may cause layout shifts as items become visible,
  // changing scrollHeight. This retries via rAF a few times until the scroll
  // position stabilizes, avoiding a visual gap at the end.
  let stableScrollRafId: number | null = null;
  const scrollToBottomStable = () => {
    const el = messagesRef();
    if (!el) return;
    el.scrollTop = el.scrollHeight;

    let retries = 0;
    const recheck = () => {
      if (retries >= 5) return;
      retries++;
      stableScrollRafId = requestAnimationFrame(() => {
        stableScrollRafId = null;
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
          el.scrollTop = el.scrollHeight;
          recheck();
        }
      });
    };
    recheck();
  };
  onCleanup(() => {
    if (stableScrollRafId !== null) {
      cancelAnimationFrame(stableScrollRafId);
    }
  });

  // Debounced scrollToBottom for high-frequency part updates —
  // coalesces multiple calls within the same frame into one.
  let scrollRafId: number | null = null;
  const scheduleScrollToBottom = () => {
    if (scrollRafId === null) {
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        scrollToBottom();
      });
    }
  };
  onCleanup(() => {
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
    }
  });

  const isNearBottom = () => {
    const el = messagesRef();
    if (!el) return true;
    const threshold = 80;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  let scrollRafPending = false;
  let scrollRafId2: number | null = null;
  const handleScroll = () => {
    if (scrollRafPending) return;
    scrollRafPending = true;
    scrollRafId2 = requestAnimationFrame(() => {
      scrollRafPending = false;
      setUserScrolledUp(!isNearBottom());
    });
  };
  onCleanup(() => {
    if (scrollRafId2 !== null) {
      cancelAnimationFrame(scrollRafId2);
    }
  });

  const toggleSidebar = () => setIsSidebarOpen((prev) => !prev);
  const toggleSidebarCollapse = () => setIsSidebarCollapsed((prev) => !prev);

  onMount(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth >= 768) {
        setIsSidebarOpen(false); // Reset sidebar state on desktop
      }
    };
    window.addEventListener('resize', handleResize);
    onCleanup(() => window.removeEventListener('resize', handleResize));
  });

  // Load messages for specific session
  const loadSessionMessages = async (sessionId: string) => {
    const t0 = performance.now();
    logger.debug("[LoadMessages] Loading messages for session:", sessionId);
    setLoadingMessages(true);

    try {
      const messages = await gateway.listMessages(sessionId);
      const t1 = performance.now();
      logger.debug(`[LoadMessages] RPC took ${(t1 - t0).toFixed(0)}ms, got ${messages.length} messages`);

      // If user switched away while we were loading, still cache the data
      // but don't flip loadingMessages — the new session's load owns that.
      const isStale = sessionStore.current !== sessionId;

      // Store parts separately, sorted by id (in-place — API returns fresh arrays)
      for (const msg of messages) {
        const parts = msg.parts || [];
        parts.sort((a, b) => a.id.localeCompare(b.id));
        setMessageStore("part", msg.id, parts);
      }

      // Store all messages, sorted by creation time (ascending).
      // Engine message IDs use different formats (UUID for OpenCode, timeId for others),
      // so lexicographic ID sort would break chronological ordering.
      messages.sort((a, b) => a.time.created - b.time.created);
      setMessageStore("message", sessionId, messages);
      const t2 = performance.now();
      logger.debug(`[LoadMessages] Store update took ${(t2 - t1).toFixed(0)}ms, total ${(t2 - t0).toFixed(0)}ms`);
    } catch (error) {
      if (!disposed) {
        logger.error("[LoadMessages] Failed to load messages:", error);
      }
    } finally {
      setLoadingMessages(false);
      setTimeout(() => scrollToBottomStable(), 100);
    }
    };

  // Generation counter to discard stale background loads when initializeSession
  let initGeneration = 0;

  const initializeSession = async () => {
    const gen = ++initGeneration;
    logger.debug("[Init] Starting session initialization");
    setSessionStore({ initError: null });

    try {
      if (!isElectron()) {
        const localAccess = await Auth.isLocalAccess();
        setIsLocalAccess(localAccess);
      }

      const isValidToken = await Auth.checkDeviceToken();
      if (!isValidToken) {
        logger.debug("[Init] Device token invalid or revoked, redirecting to entry");
        Auth.clearAuth();
        navigate("/", { replace: true });
        return;
      }

      // Build notification handlers for this mount's closures
      const handlers = {
        onConnected: () => {
          logger.debug("[Gateway] Connected/reconnected");
          setWsConnected(true);
          // If we were in error state, re-initialize on reconnect
          if (sessionStore.initError) {
            initializeSession();
          }
        },
        onDisconnected: (reason: string) => {
          logger.warn("[Gateway] Disconnected:", reason);
          setWsConnected(false);
        },
        onPartUpdated: handlePartUpdated,
        onPartsBatch: handlePartsBatch,
        onMessageUpdated: handleMessageUpdated,
        onSessionUpdated: handleSessionUpdated,
        onSessionCreated: handleSessionCreated,
        onPermissionAsked: handlePermissionAsked,
        onPermissionReplied: handlePermissionReplied,
        onQuestionAsked: handleQuestionAsked,
        onQuestionReplied: handleQuestionReplied,
        onEngineStatusChanged: (engineType: EngineType, status: string, error?: string) => {
          setConfigStore("engines", (engines) =>
            engines.map(e => e.type === engineType ? { ...e, status: status as any } : e)
          );
        },
        onMessageQueued: (sessionId: string, _messageId: string, _queuePosition: number) => {
          logger.debug("[WS] message.queued for session:", sessionId);
        },
        onMessageQueuedConsumed: (sessionId: string, _messageId: string) => {
          logger.debug("[WS] message.queued.consumed for session:", sessionId);
          const queued = messageStore.queued[sessionId];
          if (queued && queued.length > 0) {
            setMessageStore("queued", sessionId, (draft) => draft.slice(1));
          }
        },
      };

      // If gateway is already initialized (remount after navigation),
      // just update handlers to point to this mount's closures — no need
      // to reconnect or reload data.
      if (gateway.isInitialized) {
        gateway.setHandlers(handlers);
        logger.debug("[Init] Gateway already initialized, handlers updated (remount)");
        return;
      }

      setSessionStore({ loading: true });

      // First-time initialization: connect gateway and load data
      await gateway.init(handlers);

      // Load available engines (blocking — needed for UI/Settings before we can proceed)
      try {
        const engines = await gateway.listEngines();
        setConfigStore("engines", engines);
        restoreEnabledEngines();
        restoreDefaultEngine();
        const runningEngine = engines.find(e => e.status === "running" && isEngineEnabled(e.type));
        if (runningEngine) {
          setConfigStore("currentEngineType", runningEngine.type);
        }

        // Load model lists for all running + enabled engines so Settings can show them
        const runningEnginesForModels = engines.filter(e => e.status === "running" && isEngineEnabled(e.type));
        await Promise.all(runningEnginesForModels.map(async (engine) => {
          try {
            const modelResult = await gateway.listModels(engine.type);
            if (modelResult.models.length > 0) {
              setConfigStore("engineModels", engine.type, modelResult.models);
            }
          } catch {
            // Non-critical: some engines may not support model listing yet
          }
        }));
        restoreEngineModelSelections();
      } catch (err) {
        logger.warn("[Init] Failed to load engines:", err);
      }

      // Engine + model loading complete — unblock UI immediately.
      // Sidebar will render (possibly empty) while projects/sessions load in background.
      setSessionStore({ loading: false, current: null });

      // --- Background: load projects & sessions without blocking the UI ---

      // Fire-and-forget — errors are logged, not surfaced as initError
      (async () => {
        // Load all projects and sessions from ConversationStore (single call each)
        try {
          const [allProjects, allSessions] = await Promise.all([
            gateway.listAllProjects(),
            gateway.listAllSessions(),
          ]);

          if (gen !== initGeneration || disposed) return;

          setSessionStore("projects", allProjects);

          // Filter sessions to valid directories only
          const validDirectories = new Set(allProjects.map(p => p.directory));
          const normDir = (d: string) => d.replaceAll("\\", "/");
          const filteredSessions = allSessions.filter(s =>
            s.directory && validDirectories.has(normDir(s.directory))
          );

          const sessionInfos = filteredSessions.map(s => {
            const nd = normDir(s.directory);
            const project = allProjects.find(p => p.directory === nd);
            return toSessionInfo(s, project?.id);
          });

          setSessionStore("list", sessionInfos);

          // Restore last selected session from previous app launch
          const lastSessionId = getSetting<string>("lastSessionId");
          if (lastSessionId && sessionInfos.some(s => s.id === lastSessionId)) {
            const lastSession = sessionInfos.find(s => s.id === lastSessionId)!;

            // Expand only the project containing this session (collapse others)
            const expandState: Record<string, boolean> = {};
            if (lastSession.projectID) {
              expandState[lastSession.projectID] = true;
            }
            setSessionStore("projectExpanded", expandState);

            // Set engine type so sidebar tab switches correctly
            if (lastSession.engineType) {
              setConfigStore("currentEngineType", lastSession.engineType);
            }

            // Select the session and load its messages
            setSessionStore("current", lastSessionId);
            try {
              await loadSessionMessages(lastSessionId);
            } catch (err) {
              logger.warn("[Init] Failed to load last session messages:", err);
            }
          }
        } catch (err) {
          if (!disposed) logger.error("[Init] Failed to load projects/sessions:", err);
        }
      })();
    } catch (error) {
      if (disposed) return;
      logger.error("[Init] Session initialization failed:", error);
      const msg = error instanceof Error ? error.message : String(error);
      setSessionStore({ loading: false, initError: msg });
    }
  };

  // Switch session — guarded against rapid re-entry so parallel requests
  // don't pile up and flood the main thread when they all resolve at once.
  let switchGeneration = 0;
  const handleSelectSession = async (sessionId: string) => {
    const gen = ++switchGeneration;
    logger.debug("[SelectSession] Switching to session:", sessionId);
    setSessionStore("current", sessionId);
    setSessionStore("initError", null);

    // Clear unread status when user switches to this session
    setUnreadSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });

    // Update currentEngineType for model selector
    const session = sessionStore.list.find(s => s.id === sessionId);
    if (session?.engineType) {
      setConfigStore("currentEngineType", session.engineType);
    }

    // Only reset mode when current mode is incompatible with the engine
    const engineInfo = configStore.engines.find(e => e.type === (session?.engineType || configStore.currentEngineType));
    const availableModes = engineInfo?.capabilities?.availableModes;
    if (availableModes && availableModes.length > 0) {
      const cur = currentAgent();
      if (!availableModes.some(m => m.id === cur.id)) {
        setCurrentAgent(availableModes[0]);
      }
    }

    if (isMobile()) {
      setIsSidebarOpen(false);
    }

    if (!messageStore.message[sessionId]) {
      await loadSessionMessages(sessionId);
    } else {
      setTimeout(() => scrollToBottomStable(), 100);
    }

    // Stale check: if the user has already switched to another session
    // while we were awaiting, skip the rest to avoid useless work.
    if (gen !== switchGeneration) return;

    // Persist last selected session for restore on next app launch
    saveSetting("lastSessionId", sessionId);
  };

  // New session
  const handleNewSession = async (directory?: string, explicitEngineType?: EngineType) => {
    logger.debug("[NewSession] Creating new session in directory:", directory, "engineType:", explicitEngineType);

    try {
      const dir = directory || sessionStore.projects[0]?.directory || ".";
      // Use explicitly-passed engineType when available, otherwise use global default engine.
      const engineType = explicitEngineType || getDefaultEngineType();
      const newSession = await gateway.createSession(engineType, dir);
      logger.debug("[NewSession] Created:", newSession);

      // Match project by directory (projects are engine-agnostic now).
      const project = sessionStore.projects.find(p => p.directory === dir);
      const projectID = project?.id || undefined;
      const processedSession = toSessionInfo(newSession, projectID);

      const existingSession = sessionStore.list.find(s => s.id === processedSession.id);
      if (!existingSession) {
        setSessionStore("list", (list) => [processedSession, ...list]);
      } else if (!existingSession.projectID && processedSession.projectID) {
        setSessionStore("list", (list) =>
          list.map(s => s.id === processedSession.id ? { ...s, projectID: processedSession.projectID } : s)
        );
      }
      setSessionStore("current", processedSession.id);
      setSessionStore("initError", null);
      setConfigStore("currentEngineType", engineType as import("../types/unified").EngineType);
      if (isMobile()) {
        setIsSidebarOpen(false);
      }

      setMessageStore("message", processedSession.id, []);
      setTimeout(() => scrollToBottomStable(), 100);

      // Refresh engine capabilities (ACP engines populate modes only after createSession)
      try {
        const engines = await gateway.listEngines();
        setConfigStore("engines", engines);

        // Auto-select first available mode for the new engine
        const engineInfo = engines.find(e => e.type === engineType);
        const availableModes = engineInfo?.capabilities?.availableModes;
        if (availableModes && availableModes.length > 0) {
          setCurrentAgent(availableModes[0]);
        }
      } catch {
        // Non-critical: mode list may be stale but won't block
      }
    } catch (error) {
      logger.error("[NewSession] Failed to create session:", error);
    }
  };

  // Delete session
  const handleDeleteSession = async (sessionId: string) => {
    logger.debug("[DeleteSession] Deleting session:", sessionId);

    try {
      await gateway.deleteSession(sessionId);

      // Clean up messageStore to prevent memory leaks.
      // Without this, part/message/expanded/stepsLoaded entries accumulate
      // indefinitely as sessions are created and deleted.
      const messages = messageStore.message[sessionId] || [];
      for (const msg of messages) {
        // Clean up per-part state (expanded is keyed by partId, not messageId)
        const parts = messageStore.part[msg.id] || [];
        for (const part of parts) {
          if (part?.id) {
            setMessageStore("expanded", part.id, undefined as any);
          }
        }
        // Clean up steps expanded state (keyed as "steps-${messageId}")
        setMessageStore("expanded", `steps-${msg.id}`, undefined as any);
        setMessageStore("part", msg.id, undefined as any);
        setMessageStore("stepsLoaded", msg.id, undefined as any);
      }
      setMessageStore("message", sessionId, undefined as any);
      setMessageStore("permission", sessionId, undefined as any);
      setMessageStore("question", sessionId, undefined as any);
      setMessageStore("queued", sessionId, undefined as any);

      // Clear todoPartRef if it points to the deleted session
      const ref = todoPartRef();
      if (ref && ref.sessionId === sessionId) {
        setTodoPartRef(null);
      }

      // Remove from list
      setSessionStore("list", (list) => list.filter((s) => s.id !== sessionId));

      // If current session was deleted, just clear it — don't auto-switch
      if (sessionStore.current === sessionId) {
        setSessionStore("current", null);
      }
    } catch (error) {
      logger.error("[DeleteSession] Failed to delete session:", error);
    }
  };

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    logger.debug("[RenameSession] Renaming session:", sessionId, newTitle);
    try {
      // Update frontend store immediately for responsiveness
      setSessionStore("list", (list) =>
        list.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
      // Persist to backend SessionStore
      await gateway.renameSession(sessionId, newTitle);
    } catch (error) {
      logger.error("[RenameSession] Failed:", error);
    }
  };

  const handleRefreshSessions = async () => {
    if (refreshingSessions()) return;
    setRefreshingSessions(true);
    logger.debug("[RefreshSessions] Refreshing session list");
    const minSpinnerDelay = new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const [allProjects, allSessions] = await Promise.all([
        gateway.listAllProjects(),
        gateway.listAllSessions(),
      ]);
      setSessionStore("projects", allProjects);
      const validDirectories = new Set(allProjects.map(p => p.directory));
      const normDir = (d: string) => d.replaceAll("\\", "/");
      const filteredSessions = allSessions.filter(s =>
        s.directory && validDirectories.has(normDir(s.directory))
      );
      // Build index for O(1) project lookup by directory
      const projectIndex = new Map<string, UnifiedProject>();
      for (const p of allProjects) {
        projectIndex.set(p.directory, p);
      }
      const sessionInfos = filteredSessions.map(s => {
        const project = projectIndex.get(normDir(s.directory));
        return toSessionInfo(s, project?.id);
      });
      setSessionStore("list", sessionInfos);
    } catch (error) {
      logger.error("[RefreshSessions] Failed:", error);
    } finally {
      await minSpinnerDelay;
      setRefreshingSessions(false);
    }
  };

  const handleHideProject = async () => {
    const info = deleteProjectInfo();
    if (!info) return;

    logger.debug("[DeleteProjectSessions] Deleting all sessions for project:", info.projectID);

    try {
      const sessionsToDelete = sessionStore.list.filter(
        (s) => s.projectID === info.projectID
      );

      const currentSessionWillBeDeleted = sessionStore.current &&
        sessionsToDelete.some(s => s.id === sessionStore.current);

      for (const session of sessionsToDelete) {
        await gateway.deleteSession(session.id);
        // Clean up messageStore for each deleted session
        const messages = messageStore.message[session.id] || [];
        for (const msg of messages) {
          // Clean up per-part state (expanded is keyed by partId, not messageId)
          const parts = messageStore.part[msg.id] || [];
          for (const part of parts) {
            if (part?.id) {
              setMessageStore("expanded", part.id, undefined as any);
            }
          }
          // Clean up steps expanded state (keyed as "steps-${messageId}")
          setMessageStore("expanded", `steps-${msg.id}`, undefined as any);
          setMessageStore("part", msg.id, undefined as any);
          setMessageStore("stepsLoaded", msg.id, undefined as any);
        }
        setMessageStore("message", session.id, undefined as any);
        setMessageStore("permission", session.id, undefined as any);
        setMessageStore("question", session.id, undefined as any);
        setMessageStore("queued", session.id, undefined as any);
      }

      setSessionStore("list", (list) =>
        list.filter((s) => s.projectID !== info.projectID)
      );

      if (currentSessionWillBeDeleted) {
        setSessionStore("current", null);
      }
    } catch (error) {
      logger.error("[DeleteProjectSessions] Failed:", error);
    } finally {
      setDeleteProjectInfo(null);
    }
  };

  const handleAddProject = async (directory: string) => {
    const resolvedEngineType = getDefaultEngineType() as EngineType;
    logger.debug("[AddProject] Initializing project for directory:", directory);

    try {
      // Creating a session in the directory will trigger project initialization
      const newSession = await gateway.createSession(resolvedEngineType, directory);
      logger.debug("[AddProject] Session created:", newSession);

      // Refresh projects list
      const projects = await gateway.listProjects(resolvedEngineType);
      let project = projects.find((p: UnifiedProject) => p.directory === directory);

      // For engines that don't support listing projects,
      // construct a project entry from the session info
      if (!project && newSession) {
        const normalizedDir = directory.replaceAll("\\", "/");
        const projectID = newSession.projectId || `dir-${normalizedDir}`;
        const dirName = directory.split(/[/\\]/).filter(Boolean).pop() || directory;
        project = {
          id: projectID,
          directory,
          name: dirName,
        };
      }

      if (project) {
        const existingProject = sessionStore.projects.find(p => p.id === project!.id);
        if (!existingProject) {
          setSessionStore("projects", (ps) => [...ps, project!]);
        }
      }

      const processedSession = toSessionInfo(newSession, newSession.projectId || project?.id || undefined);

      const existingSession = sessionStore.list.find(s => s.id === newSession.id);
      if (!existingSession) {
        setSessionStore("list", (list) => [processedSession, ...list]);
      } else if (!existingSession.projectID && processedSession.projectID) {
        // Session was added by notification handler before project was resolved — fix the link
        setSessionStore("list", (list) =>
          list.map(s => s.id === newSession.id ? { ...s, projectID: processedSession.projectID } : s)
        );
      }

      await handleSelectSession(newSession.id);
    } catch (error) {
      logger.error("[AddProject] Failed to add project:", error);
    }
  };

  const handlePermissionRespond = async (
    sessionID: string,
    permissionID: string,
    reply: string,
  ) => {
    logger.debug("[Permission] Responding:", { sessionID, permissionID, reply });

    try {
      await gateway.replyPermission(permissionID, reply);

      // Optimistically remove from queue
      const existing = messageStore.permission[sessionID] || [];
      setMessageStore("permission", sessionID, existing.filter(p => p.id !== permissionID));
    } catch (error) {
      logger.error("[Permission] Failed to respond:", error);
    }
  };

  // --- Gateway notification handlers ---

  const handlePartUpdated = (_sessionId: string, part: UnifiedPart) => {
    const messageId = part.messageId;
    const sessionId = part.sessionId;

    batch(() => {
      // If this part's message doesn't exist yet in the message store,
      // create a placeholder assistant message so parts can render during streaming.
      // This is critical for ACP engines (Copilot) where sendMessage blocks until
      // session/prompt completes, but parts arrive via notifications in the meantime.
      if (sessionId && messageId) {
        const messages = messageStore.message[sessionId] || [];
        const msgExists = messages.some(m => m.id === messageId);
        if (!msgExists) {
          const placeholder: UnifiedMessage = {
            id: messageId,
            sessionId,
            role: "assistant",
            time: { created: Date.now() },
            parts: [],
          };
          // Streaming placeholders are always for the current (latest) turn — append to end.
          // binarySearch by ID would misplace them when engine IDs (e.g. UUID) sort
          // before user temp IDs ("msg-temp-...") in lexicographic order.
          if (!messageStore.message[sessionId]) {
            setMessageStore("message", sessionId, [placeholder]);
          } else {
            setMessageStore("message", sessionId, (draft) => [...draft, placeholder]);
          }
        }
      }

      const parts = messageStore.part[messageId] || [];
      const index = binarySearch(parts, part.id, (p) => p.id);

      if (index.found) {
        setMessageStore("part", messageId, index.index, part);
      } else if (!messageStore.part[messageId]) {
        setMessageStore("part", messageId, [part]);
      } else {
        setMessageStore("part", messageId, (draft) => {
          const newParts = [...draft];
          newParts.splice(index.index, 0, part);
          return newParts;
        });
      }
      // Mark steps as loaded for streaming messages so lazy-load won't re-fetch
      if (!messageStore.stepsLoaded[messageId]) {
        setMessageStore("stepsLoaded", messageId, true);
      }

      // Track todo parts for O(1) lookup in currentTodos memo
      if (part.type === "tool" && (part as any).normalizedTool === "todo" && sessionId) {
        setTodoPartRef({ sessionId, messageId, partId: part.id });
      }
    });

    if (!userScrolledUp()) scheduleScrollToBottom();
  };

  /**
   * Handle a batch of parts for the same messageId in a single reactive update.
   * Called by GatewayClient when multiple distinct parts (e.g. tool parts with
   * unique IDs) arrive in the same animation frame. Instead of N separate
   * handlePartUpdated calls (each triggering full reactive cascading), this
   * merges all parts into one store mutation → one reactive propagation.
   */
  const handlePartsBatch = (_sessionId: string, messageId: string, parts: UnifiedPart[]) => {
    if (parts.length === 0) return;

    const sessionId = parts[0].sessionId;

    batch(() => {
      // 1. Ensure placeholder message exists (once, not per-part)
      if (sessionId && messageId) {
        const messages = messageStore.message[sessionId] || [];
        const msgExists = messages.some(m => m.id === messageId);
        if (!msgExists) {
          const placeholder: UnifiedMessage = {
            id: messageId,
            sessionId,
            role: "assistant",
            time: { created: Date.now() },
            parts: [],
          };
          if (!messageStore.message[sessionId]) {
            setMessageStore("message", sessionId, [placeholder]);
          } else {
            setMessageStore("message", sessionId, (draft) => [...draft, placeholder]);
          }
        }
      }

      // 2. Merge all incoming parts into the parts array in ONE mutation.
      //    Build the final array once, avoiding N intermediate array copies.
      const existingParts = messageStore.part[messageId] || [];
      const merged = [...existingParts];

      for (const part of parts) {
        const { found, index } = binarySearch(merged, part.id, (p) => p.id);
        if (found) {
          merged[index] = part;
        } else {
          merged.splice(index, 0, part);
        }
      }

      // Single store mutation for all parts
      setMessageStore("part", messageId, merged);

      // 3. Mark steps as loaded once
      if (!messageStore.stepsLoaded[messageId]) {
        setMessageStore("stepsLoaded", messageId, true);
      }

      // 4. Track todo parts — check all incoming parts
      for (const part of parts) {
        if (part.type === "tool" && (part as any).normalizedTool === "todo" && sessionId) {
          setTodoPartRef({ sessionId, messageId, partId: part.id });
        }
      }
    });

    if (!userScrolledUp()) scheduleScrollToBottom();
  };

  const handleMessageUpdated = (_sessionId: string, msgInfo: UnifiedMessage) => {
    const targetSessionId = msgInfo.sessionId;

    batch(() => {
      if (msgInfo.role === "user") {
        const currentMessages = messageStore.message[targetSessionId] || [];
        const tempMessages = currentMessages.filter(m => m.id.startsWith("msg-temp-"));

        if (tempMessages.length > 0) {
          // Collect temp parts before deleting — if the real message has no parts
          // (OpenCode often sends user message.updated without parts), we migrate
          // the optimistic parts to the real message ID so the user bubble stays visible.
          const hasMsgParts = msgInfo.parts && msgInfo.parts.length > 0;
          if (!hasMsgParts) {
            for (const tempMsg of tempMessages) {
              const tempParts = messageStore.part[tempMsg.id];
              if (tempParts && tempParts.length > 0) {
                // Re-key temp parts to use the real message ID
                const migrated = tempParts.map(p => ({
                  ...p,
                  id: p.id.replace(/^part-temp-/, `part-migrated-`),
                  messageId: msgInfo.id,
                }));
                setMessageStore("part", msgInfo.id, migrated);
                break; // only need one temp message's parts
              }
            }
          }

          setMessageStore("message", targetSessionId, (draft) =>
            draft.filter(m => !m.id.startsWith("msg-temp-"))
          );
          tempMessages.forEach(tempMsg => {
            setMessageStore("part", tempMsg.id, undefined as any);
          });
        }
      }

      // Store parts from the incoming message (critical for ACP engines
      // which emit full messages with parts via message.updated).
      // If we already have parts from streaming part.updated events,
      // prefer those since they may have more up-to-date state.
      if (msgInfo.parts && msgInfo.parts.length > 0) {
        const existingParts = messageStore.part[msgInfo.id];
        if (!existingParts || existingParts.length === 0) {
          // Sort in-place — msgInfo.parts is from the incoming event, safe to mutate
          msgInfo.parts.sort((a, b) => a.id.localeCompare(b.id));
          setMessageStore("part", msgInfo.id, msgInfo.parts);
        } else {
          // Merge: use existing streaming parts as base, add any new parts
          // from the final message that weren't received via streaming
          const existingIds = new Set(existingParts.map(p => p.id));
          const newParts = msgInfo.parts.filter(p => !existingIds.has(p.id));
          if (newParts.length > 0) {
            // Single concat + in-place sort (avoids spread + sort creating 2 arrays)
            const merged = existingParts.concat(newParts);
            merged.sort((a, b) => a.id.localeCompare(b.id));
            setMessageStore("part", msgInfo.id, merged);
          }
        }

        // Track todo parts from bulk message updates (ACP engines)
        if (targetSessionId) {
          for (let i = msgInfo.parts.length - 1; i >= 0; i--) {
            const p = msgInfo.parts[i];
            if (p.type === "tool" && (p as any).normalizedTool === "todo") {
              setTodoPartRef({ sessionId: targetSessionId, messageId: msgInfo.id, partId: p.id });
              break;
            }
          }
        }
      }

      const messages = messageStore.message[targetSessionId] || [];
      const existingIdx = messages.findIndex(m => m.id === msgInfo.id);

      if (existingIdx >= 0) {
        // Update existing message in place
        setMessageStore("message", targetSessionId, existingIdx, msgInfo);
      } else if (!messageStore.message[targetSessionId]) {
        setMessageStore("message", targetSessionId, [msgInfo]);
      } else {
        // New message — append to end (incoming messages are always for the current turn)
        setMessageStore("message", targetSessionId, (draft) => [...draft, msgInfo]);
      }

      // Auto-clear sending state when assistant message is finalized (completed or errored).
      // This is the authoritative signal that the engine is done — more reliable than
      // waiting for the sendMessage RPC to resolve (which can happen prematurely in
      // multi-step agent loops like OpenCode).
      // But DON'T clear if there are still queued messages — the engine will continue
      // processing them, and we need to keep the sending state active.
      if (
        msgInfo.role === "assistant" &&
        (msgInfo.time.completed || msgInfo.error) &&
        sessionStore.sendingMap[targetSessionId]
      ) {
        const queued = messageStore.queued[targetSessionId];
        if (!queued || queued.length === 0) {
          setSendingFor(targetSessionId, false);
        }
      }
    });
  };

  const handleSessionUpdated = (updated: UnifiedSession) => {
    logger.debug("[WS] session.updated received:", updated);
    setSessionStore("list", (list) =>
      list.map((s) =>
        s.id === updated.id
          ? {
              ...s,
              title: updated.title || s.title,
              directory: updated.directory || s.directory || "",
              ...(updated.time && {
                createdAt: new Date(updated.time.created).toISOString(),
                updatedAt: new Date(updated.time.updated).toISOString(),
              }),
            }
          : s,
      ),
    );
  };

  const handleSessionCreated = (created: UnifiedSession) => {
    logger.debug("[WS] session.created received:", created);
    // Only add if not already in the list (avoid duplicates from local creation)
    const exists = sessionStore.list.some((s) => s.id === created.id);
    if (exists) return;

    // Find matching project by directory
    const project = sessionStore.projects.find(
      (p) => p.directory === created.directory,
    );

    setSessionStore("list", (list) => [toSessionInfo(created, project?.id), ...list]);
  };

  const handlePermissionAsked = (permission: UnifiedPermission) => {
    logger.debug("[WS] Permission asked:", permission);
    const existing = messageStore.permission[permission.sessionId] || [];
    if (!existing.find((p) => p.id === permission.id)) {
      setMessageStore("permission", permission.sessionId, [...existing, permission]);
    }
  };

  const handlePermissionReplied = (permissionId: string, _optionId: string) => {
    logger.debug("[WS] Permission replied:", permissionId);
    // Find and remove permission from all sessions
    for (const [sessionId, perms] of Object.entries(messageStore.permission)) {
      if (!perms) continue;
      const filtered = perms.filter((p) => p.id !== permissionId);
      if (filtered.length !== perms.length) {
        setMessageStore("permission", sessionId, filtered);
        break;
      }
    }
  };

  const handleQuestionAsked = (question: UnifiedQuestion) => {
    logger.debug("[WS] Question asked:", question);
    const existing = messageStore.question[question.sessionId] || [];
    if (!existing.find((q) => q.id === question.id)) {
      setMessageStore("question", question.sessionId, [...existing, question]);
    }
  };

  const handleQuestionReplied = (questionId: string, _answers: string[][]) => {
    logger.debug("[WS] Question replied:", questionId);
    // Find and remove question from all sessions
    for (const [sessionId, qs] of Object.entries(messageStore.question)) {
      if (!qs) continue;
      const filtered = qs.filter((q) => q.id !== questionId);
      if (filtered.length !== qs.length) {
        setMessageStore("question", sessionId, filtered);
        break;
      }
    }
  };

  const handleQuestionRespond = async (
    sessionID: string,
    questionID: string,
    answers: string[][],
  ) => {
    logger.debug("[Question] Responding:", { sessionID, questionID, answers });

    try {
      await gateway.replyQuestion(questionID, answers);

      // Optimistically remove from queue
      const existing = messageStore.question[sessionID] || [];
      setMessageStore("question", sessionID, existing.filter(q => q.id !== questionID));
    } catch (error) {
      logger.error("[Question] Failed to respond:", error);
    }
  };

  const handleQuestionDismiss = async (
    sessionID: string,
    questionID: string,
  ) => {
    logger.debug("[Question] Dismissing:", { sessionID, questionID });

    try {
      await gateway.rejectQuestion(questionID);

      // Optimistically remove from queue
      const existing = messageStore.question[sessionID] || [];
      setMessageStore("question", sessionID, existing.filter(q => q.id !== questionID));
    } catch (error) {
      logger.error("[Question] Failed to dismiss:", error);
    }
  };

  // Continue after interruption — re-send with current agent mode
  const handleContinue = (_sessionID: string) => {
    if (sending()) return;
    handleSendMessage("Continue where you left off.", currentAgent());
  };

  const handleSendMessage = async (text: string, agent: AgentMode) => {
    const sessionId = sessionStore.current;
    if (!sessionId) return;

    // Allow sending when idle, or when generating if engine supports enqueue
    const isBusy = sending();
    if (isBusy && !canEnqueue()) return;

    // Validate mode and model before sending
    if (!agent?.id) {
      showSendError(t().chat.noModeError);
      return;
    }
    const modelId = getSelectedModelForEngine(currentEngineType());
    if (!modelId) {
      showSendError(t().chat.noModelError);
      return;
    }

    setSendingFor(sessionId, true);

    const tempMessageId = `msg-temp-${Date.now()}`;
    const tempPartId = `part-temp-${Date.now()}`;

    // --- Enqueue path: fire-and-forget ---
    // When the engine is busy and supports enqueue, we must NOT await the RPC.
    // The RPC blocks until the engine finishes ALL work (including previously
    // queued messages), which would prevent the user from sending message #3
    // while #2's RPC is pending.
    //
    // Instead of creating a temp user message (which would steal the isWorking
    // indicator from the currently processing turn), we store the message in
    // the queued store. It will be rendered as a preview above the input area.
    // The actual user message bubble is created when the adapter starts processing
    // (triggered by message.updated or message.queued.consumed).
    if (isBusy) {
      const queuedMsg: QueuedMessage = {
        id: tempMessageId,
        text,
        enqueuedAt: Date.now(),
      };

      // Add to queued store
      const existingQueued = messageStore.queued[sessionId] || [];
      setMessageStore("queued", sessionId, [...existingQueued, queuedMsg]);

      gateway.sendMessage(sessionId, text, {
        mode: agent.id,
        modelId,
      }).catch((error) => {
        logger.error("[SendMessage] Failed to enqueue message:", error);
        // Remove from queued store on failure
        setMessageStore("queued", sessionId, (draft) =>
          draft.filter((m) => m.id !== tempMessageId),
        );
      });
      return;
    }

    // --- Normal path: create temp user message and await the RPC ---
    const tempMessageInfo: UnifiedMessage = {
      id: tempMessageId,
      sessionId: sessionId,
      role: "user",
      time: {
        created: Date.now(),
      },
      parts: [],
    };

    const tempPart: UnifiedPart = {
      id: tempPartId,
      messageId: tempMessageId,
      sessionId: sessionId,
      type: "text",
      text,
    } as UnifiedPart;

    const messages = messageStore.message[sessionId] || [];

    // User temp messages are always the newest — append to end.
    // Don't use binarySearch here: engine message IDs (e.g. UUID from OpenCode)
    // may sort before "msg-temp-" in lexicographic order, causing the user message
    // to land after all assistant messages and breaking turn grouping.
    const tempExists = messages.some(m => m.id === tempMessageId);
    if (!tempExists) {
      setMessageStore("message", sessionId, (draft) => [...draft, tempMessageInfo]);
    }

    setMessageStore("part", tempMessageId, [tempPart]);
    setUserScrolledUp(false);
    setTimeout(() => scrollToBottom(), 0);

    try {
      await gateway.sendMessage(sessionId, text, {
        mode: agent.id,
        modelId,
      });
      // sendMessage RPC resolved — the engine considers the prompt handled.
      // However, in multi-step agent loops (e.g. OpenCode), the RPC may resolve
      // after an intermediate step while the agent continues working. Check whether
      // the latest assistant message is truly finalized before clearing the sending
      // state. If it's not, handleMessageUpdated will clear it when the final
      // message.updated arrives with time.completed or error.
      const msgs = messageStore.message[sessionId] || [];
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      if (!lastAssistant || lastAssistant.time.completed || lastAssistant.error) {
        setSendingFor(sessionId, false);
      }
    } catch (error) {
      logger.error("[SendMessage] Failed to send message:", error);
      // Remove the optimistic temp message on failure
      setMessageStore("message", sessionId, (draft) =>
        draft.filter((m) => m.id !== tempMessageId),
      );
      setMessageStore("part", tempMessageId, undefined as any);
      setSendingFor(sessionId, false);
    }
  };

  const handleCancelMessage = async () => {
    const sessionId = sessionStore.current;
    if (!sessionId) return;
    try {
      await gateway.cancelMessage(sessionId);
    } catch (error) {
      logger.error("[CancelMessage] Failed:", error);
    }
    // Clear any queued messages — cancel stops everything
    setMessageStore("queued", sessionId, []);
    setSendingFor(sessionId, false);
  };

  const currentSessionTitle = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return "";
    const session = sessionStore.list.find(s => s.id === sid);
    return session?.title || "";
  });

  createEffect(() => {
    initializeSession();

    onCleanup(() => {
      disposed = true;
      // Gateway stays alive across navigations — handlers are updated on remount.
      // Only mark disposed to guard in-flight async operations from this mount.
    });
  });

  return (
    <div class="flex h-screen bg-gray-50/50 dark:bg-zinc-950 font-sans text-gray-900 dark:text-gray-100 overflow-hidden relative">

      {/* Mobile Sidebar Overlay */}
      <Show when={isMobile() && isSidebarOpen()}>
        <div
          class="absolute inset-0 bg-black/50 z-20 backdrop-blur-xs"
          onClick={toggleSidebar}
        />
      </Show>

      {/* Sidebar - Desktop: Static, Mobile: Drawer */}
      <aside
        class={`
          fixed md:static inset-y-0 left-0 z-30 ${isSidebarCollapsed() ? "md:w-14" : "w-72"} bg-gray-50 dark:bg-zinc-950 border-r border-gray-200 dark:border-zinc-800 transform transition-[width,transform] duration-300 ease-in-out flex flex-col justify-between electron-safe-top
          ${isSidebarOpen() ? "translate-x-0 w-72" : "-translate-x-full md:translate-x-0"}
        `}
      >
        {/* Sidebar Collapse Toggle (desktop only) */}
        <div class="hidden md:flex items-center justify-between px-2 pt-2 pb-1 border-b border-gray-200 dark:border-zinc-800">
          <Show when={!isSidebarCollapsed()}>
            <span class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1">{t().sidebar.sessions}</span>
          </Show>
          <div class="flex items-center gap-0.5">
            <Show when={!isSidebarCollapsed()}>
              <button
                onClick={handleRefreshSessions}
                disabled={refreshingSessions()}
                class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-md transition-colors flex-shrink-0 disabled:opacity-50"
                title={t().sidebar.refreshSessions}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={refreshingSessions() ? "animate-spin" : ""}>
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
              </button>
            </Show>
            <button
              onClick={toggleSidebarCollapse}
              class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-md transition-colors flex-shrink-0"
              title={isSidebarCollapsed() ? t().sidebar.expandSidebar : t().sidebar.collapseSidebar}
              aria-label={isSidebarCollapsed() ? t().sidebar.expandSidebar : t().sidebar.collapseSidebar}
              aria-expanded={!isSidebarCollapsed()}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
                {isSidebarCollapsed() ? <path d="m14 9 3 3-3 3" /> : <path d="m14 9-3 3 3 3" />}
              </svg>
            </button>
          </div>
        </div>
        <div class="relative flex flex-col h-full overflow-hidden">
          <Show when={!sessionStore.loading}>
            <SessionSidebar
              sessions={sessionStore.list}
              projects={sessionStore.projects}
              currentSessionId={sessionStore.current}
              getSessionStatus={getSessionStatus}
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onDeleteProjectSessions={(projectID, projectName, sessionCount) =>
                setDeleteProjectInfo({ projectID, projectName, sessionCount })
              }
              onAddProject={() => setShowAddProjectModal(true)}
              showAddProject={isLocalAccess()}
              collapsed={isSidebarCollapsed() && !isMobile()}
            />
          </Show>
          <Show when={refreshingSessions()}>
            <div class="absolute inset-0 bg-gray-50/60 dark:bg-zinc-950/60 backdrop-blur-[1px] z-10 flex items-center justify-center transition-opacity">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-gray-400 dark:text-gray-500">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            </div>
          </Show>
        </div>

        {/* User Actions Footer in Sidebar */}
        <div class={`${isSidebarCollapsed() && !isMobile() ? "px-1 py-2" : "p-3"} border-t border-gray-200 dark:border-zinc-800 space-y-1 bg-gray-50 dark:bg-zinc-950`}>
          <Show when={isLocalAccess()}>
            <button
              onClick={() => navigate("/")}
              class={`w-full flex items-center ${isSidebarCollapsed() && !isMobile() ? "justify-center p-2" : "gap-3 px-3 py-2"} text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-xs hover:shadow-sm`}
              title={t().chat.remoteAccess}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>
              <Show when={!isSidebarCollapsed() || isMobile()}>
                {t().chat.remoteAccess}
              </Show>
            </button>
          </Show>
          <button
            onClick={() => navigate("/settings")}
            class={`w-full flex items-center ${isSidebarCollapsed() && !isMobile() ? "justify-center p-2" : "gap-3 px-3 py-2"} text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-xs hover:shadow-sm`}
            title={t().chat.settings}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
            <Show when={!isSidebarCollapsed() || isMobile()}>
              {t().chat.settings}
            </Show>
          </button>
          <button
            onClick={handleLogout}
            class={`w-full flex items-center ${isSidebarCollapsed() && !isMobile() ? "justify-center p-2" : "gap-3 px-3 py-2"} text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors`}
            title={t().chat.logout}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" /></svg>
            <Show when={!isSidebarCollapsed() || isMobile()}>
              {t().chat.logout}
            </Show>
          </button>
        </div>
      </aside>

      {/* Main Chat Area */}
      <div class="flex-1 flex flex-col overflow-hidden min-w-0 bg-white dark:bg-zinc-900 electron-safe-top">

        {/* Header */}
        <header class="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-zinc-800/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xs sticky top-0 z-10 electron-drag-region">
          <div class="flex items-center gap-3 min-w-0 electron-no-drag">
            <button
              onClick={toggleSidebar}
              class="md:hidden p-2 -ml-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-zinc-800 rounded-lg transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="18" y2="18" /></svg>
            </button>
            <h1 class="text-base font-semibold text-gray-900 dark:text-white truncate">
              {getDisplayTitle(currentSessionTitle())}
            </h1>
            {/* Engine Badge */}
            <Show when={sessionStore.current}>
              <span class={`shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full ${currentEngineBadge().class}`}>
                {currentEngineBadge().label}
              </span>
            </Show>
            {/* Agent Mode Indicator */}
            <span class={`shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full ${
              currentAgent().id === "plan"
                ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
            }`}>
              {currentAgent().label}
            </span>
          </div>
          <Show when={!wsConnected()}>
            <div class="flex items-center gap-1.5 px-2 py-1 rounded-full bg-red-50 dark:bg-red-900/20 electron-no-drag">
              <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span class="text-[11px] font-medium text-red-600 dark:text-red-400">Disconnected</span>
            </div>
          </Show>
        </header>

        {/* Message List */}
        <main class="flex-1 flex flex-col overflow-hidden relative">
          <Show
            when={!sessionStore.initError}
            fallback={
              <div class="flex-1 flex items-center justify-center">
                <div class="flex flex-col items-center gap-4 text-center px-6 max-w-md">
                  <div class="w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center text-red-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  </div>
                  <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
                    {t().chat.initFailed}
                  </h3>
                  <p class="text-sm text-gray-500 dark:text-gray-400">{sessionStore.initError}</p>
                  <button
                    onClick={() => {
                      setSessionStore({ loading: true, initError: null });
                      initializeSession();
                    }}
                    class="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {t().chat.retry}
                  </button>
                </div>
              </div>
            }
          >
          <Show
            when={!sessionStore.loading}
            fallback={
              <div class="flex-1 flex items-center justify-center">
                <div class="flex flex-col items-center gap-3 text-gray-400">
                  <div class="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                </div>
              </div>
            }
          >
          <Show
            when={sessionStore.current}
            fallback={
              <div class="flex-1 flex items-center justify-center">
                <div class="flex flex-col items-center gap-4 text-center px-6">
                  <div class="w-16 h-16 bg-gray-100 dark:bg-zinc-800 rounded-2xl flex items-center justify-center text-gray-400 dark:text-gray-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2v5Z" /><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" /></svg>
                  </div>
                  <h2 class="text-xl font-semibold text-gray-900 dark:text-white">
                    {t().chat.noSessionSelected}
                  </h2>
                  <p class="text-sm text-gray-500 dark:text-gray-400 max-w-xs">
                    {t().chat.noSessionSelectedDesc}
                  </p>
                </div>
              </div>
            }
          >
            {/* Scroll container is ALWAYS in the DOM so the virtualizer
                maintains a stable reference to getScrollElement(). The loading
                overlay is rendered on top without destroying the scroll div. */}
              <div ref={setMessagesRef} onScroll={handleScroll} class="flex-1 overflow-y-auto px-4 md:px-6" style={{ position: "relative" }}>
                {/* Loading overlay — covers scroll area during message load */}
                <Show when={loadingMessages()}>
                  <div class="absolute inset-0 flex items-center justify-center z-10 bg-white/80 dark:bg-zinc-900/80">
                    <div class="flex flex-col items-center gap-3 text-gray-400">
                      <div class="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                    </div>
                  </div>
                </Show>
                <div class="max-w-4xl mx-auto w-full py-6">
                  <Show
                    when={sessionStore.current && messageStore.message[sessionStore.current]?.length > 0}
                    fallback={
                      <div class="flex flex-col items-center justify-center h-[50vh] text-center px-4">
                        <div class="w-16 h-16 bg-gray-100 dark:bg-zinc-800 rounded-2xl flex items-center justify-center mb-6 text-gray-400 dark:text-gray-500">
                          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2v5Z" /><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" /></svg>
                        </div>
                        <h2 class="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                          {t().chat.startConversation}
                        </h2>
                        <p class="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto">
                          {t().chat.startConversationDesc}
                        </p>
                      </div>
                    }
                  >
                    <MessageList sessionID={sessionStore.current!} isWorking={sending()} scrollContainerRef={messagesRef} onPermissionRespond={handlePermissionRespond} onQuestionRespond={handleQuestionRespond} onQuestionDismiss={handleQuestionDismiss} onContinue={handleContinue} />
                  </Show>
                </div>
              </div>

              {/* Input Area */}
              <div class="p-4 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xs border-t border-gray-100 dark:border-zinc-800 relative z-20">
                <div class="max-w-4xl mx-auto w-full">
                  {/* TodoDock — persistent task list above input */}
                  <Show when={currentTodos().length > 0}>
                    <TodoDock todos={currentTodos()} isWorking={sending()} />
                  </Show>

                  {/* Permission prompt replaces input when permissions are pending */}
                  <Show when={currentPermissions().length > 0}>
                    <div class="space-y-3">
                      <For each={currentPermissions()}>
                        {(perm) => (
                          <InputAreaPermission
                            permission={perm}
                            onRespond={handlePermissionRespond}
                          />
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Question prompt replaces input when questions are pending */}
                  <Show when={currentPermissions().length === 0 && currentQuestions().length > 0}>
                    <div class="space-y-3">
                      <For each={currentQuestions()}>
                        {(question) => (
                          <InputAreaQuestion
                            question={question}
                            onRespond={handleQuestionRespond}
                            onDismiss={handleQuestionDismiss}
                          />
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Normal input when no permissions or questions pending */}
                  <Show when={currentPermissions().length === 0 && currentQuestions().length === 0}>
                    <Show when={sendError()}>
                      <div class="mb-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                        {sendError()}
                      </div>
                    </Show>

                    {/* Queued messages preview — shows what messages are waiting */}
                    <Show when={currentQueuedMessages().length > 0}>
                      <div class="mb-2 flex flex-col gap-1">
                        <For each={currentQueuedMessages()}>
                          {(queuedMsg) => (
                            <div class="flex items-center gap-2 px-3 py-1.5 text-xs bg-amber-50/80 dark:bg-amber-900/15 border border-amber-200/50 dark:border-amber-700/30 rounded-lg text-amber-700 dark:text-amber-400">
                              <span class="w-1.5 h-1.5 rounded-full bg-amber-400 dark:bg-amber-500 animate-pulse flex-shrink-0" />
                              <span class="truncate flex-1">{queuedMsg.text}</span>
                              <span class="text-amber-500/60 dark:text-amber-500/40 flex-shrink-0">{t().chat.queued}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <PromptInput
                      onSend={handleSendMessage}
                      onCancel={handleCancelMessage}
                      isGenerating={sending()}
                      canEnqueue={canEnqueue()}
                      queueCount={queueCount()}
                      currentAgent={currentAgent()}
                      onAgentChange={setCurrentAgent}
                      availableModes={configStore.engines.find(e => e.type === currentEngineType())?.capabilities?.availableModes}
                      disabled={!sessionStore.current}
                    />
                  </Show>
                  <div class="mt-2 text-center">
                    <p class="text-[10px] text-gray-400 dark:text-gray-600 tabular-nums">
                      <Show when={sessionUsage()} fallback={t().chat.disclaimer}>
                        {(u) => (
                          <>
                            <span>{formatMessage(t().tokenUsage.sessionSummary, { input: formatTokenCount(u().input), output: formatTokenCount(u().output) })}</span>
                            <Show when={u().cost != null}>
                              <span class="text-gray-300 dark:text-gray-700"> · </span>
                              <span>{formatCostWithUnit(u().cost!, u().costUnit, t)}</span>
                            </Show>
                          </>
                        )}
                      </Show>
                    </p>
                  </div>
                </div>
              </div>
          </Show>
          </Show>
          </Show>
        </main>
      </div>

      <HideProjectModal
        isOpen={deleteProjectInfo() !== null}
        projectName={deleteProjectInfo()?.projectName || ""}
        sessionCount={deleteProjectInfo()?.sessionCount || 0}
        onClose={() => setDeleteProjectInfo(null)}
        onConfirm={handleHideProject}
      />

      <AddProjectModal
        isOpen={showAddProjectModal()}
        onClose={() => setShowAddProjectModal(false)}
        onAdd={handleAddProject}
      />
    </div>
  );
}
