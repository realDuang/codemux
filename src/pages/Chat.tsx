import {
  createEffect,
  createSignal,
  createMemo,
  onCleanup,
  Show,
  For,
  onMount,
} from "solid-js";
import { Auth } from "../lib/auth";
import { useNavigate } from "@solidjs/router";
import { gateway } from "../lib/gateway-api";
import { logger } from "../lib/logger";
import { isElectron } from "../lib/platform";
import { sessionStore, setSessionStore, type SessionInfo } from "../stores/session";
import {
  messageStore,
  setMessageStore,
} from "../stores/message";
import { MessageList } from "../components/MessageList";
import { PromptInput } from "../components/PromptInput";
import { SessionSidebar } from "../components/SessionSidebar";
import { HideProjectModal } from "../components/HideProjectModal";
import { AddProjectModal } from "../components/AddProjectModal";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion, UnifiedSession, UnifiedProject, AgentMode, EngineType, SessionActivityStatus } from "../types/unified";
import { useI18n } from "../lib/i18n";
import { ProjectStore } from "../lib/project-store";
import { configStore, setConfigStore } from "../stores/config";

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

const DEFAULT_TITLE_PATTERN = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_PATTERN.test(title);
}

function toSessionInfo(s: UnifiedSession, projectID?: string): SessionInfo {
  return {
    id: s.id,
    engineType: s.engineType,
    title: s.title || "",
    directory: s.directory || "",
    projectID: projectID ?? (s.engineMeta?.projectID as string) ?? undefined,
    parentID: s.parentId,
    createdAt: new Date(s.time.created).toISOString(),
    updatedAt: new Date(s.time.updated).toISOString(),
    summary: s.engineMeta?.summary as SessionInfo["summary"] | undefined,
  };
}

export default function Chat() {
  const { t } = useI18n();
  const navigate = useNavigate();
  // Per-session sending state: one session generating shouldn't block others
  const [sendingMap, setSendingMap] = createSignal<Record<string, boolean>>({});
  const sending = createMemo(() => {
    const sid = sessionStore.current;
    return sid ? (sendingMap()[sid] ?? false) : false;
  });
  const setSendingFor = (sessionId: string, value: boolean) => {
    setSendingMap((prev) => ({ ...prev, [sessionId]: value }));
  };

  // Track sessions that completed while user was viewing another session
  const [unreadSessions, setUnreadSessions] = createSignal<Set<string>>(new Set());
  let prevSendingMap: Record<string, boolean> = {};
  createEffect(() => {
    const currentMap = sendingMap();
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

  // Compute activity status for each session
  const sessionStatusMap = createMemo((): Record<string, SessionActivityStatus> => {
    const map: Record<string, SessionActivityStatus> = {};
    const currentSending = sendingMap();
    const unread = unreadSessions();
    for (const session of sessionStore.list) {
      const sid = session.id;
      // Priority: waiting > running > error > completed > idle
      const pendingPerms = messageStore.permission[sid];
      if (pendingPerms && pendingPerms.length > 0) {
        map[sid] = "waiting";
        continue;
      }
      const pendingQuestions = messageStore.question[sid];
      if (pendingQuestions && pendingQuestions.length > 0) {
        map[sid] = "waiting";
        continue;
      }
      if (currentSending[sid]) {
        map[sid] = "running";
        continue;
      }
      const messages = messageStore.message[sid];
      if (messages && messages.length > 0) {
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.error) {
          map[sid] = "error";
          continue;
        }
      }
      if (unread.has(sid)) {
        map[sid] = "completed";
        continue;
      }
      map[sid] = "idle";
    }
    return map;
  });
  const [messagesRef, setMessagesRef] = createSignal<HTMLDivElement>();
  const [loadingMessages, setLoadingMessages] = createSignal(false);
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

  const getDisplayTitle = (title: string): string => {
    if (!title || isDefaultTitle(title)) {
      return t().sidebar.newSession;
    }
    return title;
  };

  const [currentSessionModel, setCurrentSessionModel] = createSignal<{
    providerID: string;
    modelID: string;
  } | null>(null);
  
  // Agent mode state - default to "build" matching OpenCode's default
  const [currentAgent, setCurrentAgent] = createSignal<AgentMode>({ id: "build", label: "Build" });

  // Track whether the component has been disposed (cleaned up) to suppress
  // errors from async operations that complete after gateway.destroy().
  let disposed = false;

  // Derive the engine type of the currently selected session
  const currentEngineType = createMemo(() => {
    const sid = sessionStore.current;
    if (!sid) return configStore.currentEngineType || "opencode";
    const session = sessionStore.list.find(s => s.id === sid);
    return session?.engineType || configStore.currentEngineType || "opencode";
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

  const handleModelChange = (providerID: string, modelID: string) => {
    logger.debug("[Chat] Model changed to:", { providerID, modelID });
    setCurrentSessionModel({ providerID, modelID });
  };

  const handleLogout = () => {
    Auth.logout();
    navigate("/", { replace: true });
  };

  const scrollToBottom = (force?: boolean) => {
    const el = messagesRef();
    if (el) {
      if (force || !userScrolledUp()) {
        el.scrollTop = el.scrollHeight;
      }
    }
  };

  const isNearBottom = () => {
    const el = messagesRef();
    if (!el) return true;
    const threshold = 80;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  const handleScroll = () => {
    setUserScrolledUp(!isNearBottom());
  };

  const toggleSidebar = () => setIsSidebarOpen((prev) => !prev);

  // Window Resize Listener for Mobile State
  createEffect(() => {
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
    logger.debug("[LoadMessages] Loading messages for session:", sessionId);
    setLoadingMessages(true);

    try {
      const messages = await gateway.listMessages(sessionId);
      logger.debug("[LoadMessages] Loaded messages:", messages);

      // Store parts separately, sorted by id
      for (const msg of messages) {
        const sortedParts = (msg.parts || []).slice().sort((a, b) =>
          a.id.localeCompare(b.id)
        );
        setMessageStore("part", msg.id, sortedParts);
      }

      // Store all messages, sorted by id
      const sortedMessages = messages.slice().sort((a, b) =>
        a.id.localeCompare(b.id)
      );
      setMessageStore("message", sessionId, sortedMessages);
    } catch (error) {
      if (!disposed) {
        logger.error("[LoadMessages] Failed to load messages:", error);
      }
    } finally {
      setLoadingMessages(false);
      setTimeout(() => scrollToBottom(true), 100);
    }
  };

  const initializeSession = async () => {
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

      setSessionStore({ loading: true });

      // Initialize gateway connection with notification handlers
      await gateway.init({
        onConnected: () => {
          logger.debug("[Gateway] Connected/reconnected");
          setWsConnected(true);
          // If we were in error state, re-initialize on reconnect
          if (sessionStore.initError) {
            initializeSession();
          }
        },
        onDisconnected: (reason) => {
          logger.warn("[Gateway] Disconnected:", reason);
          setWsConnected(false);
        },
        onPartUpdated: handlePartUpdated,
        onMessageUpdated: handleMessageUpdated,
        onSessionUpdated: handleSessionUpdated,
        onPermissionAsked: handlePermissionAsked,
        onPermissionReplied: handlePermissionReplied,
        onQuestionAsked: handleQuestionAsked,
        onQuestionReplied: handleQuestionReplied,
        onEngineStatusChanged: (engineType, status, error) => {
          setConfigStore("engines", (engines) =>
            engines.map(e => e.type === engineType ? { ...e, status: status as any } : e)
          );
        },
      });

      // Load available engines
      try {
        const engines = await gateway.listEngines();
        setConfigStore("engines", engines);
        const runningEngine = engines.find(e => e.status === "running");
        if (runningEngine) {
          setConfigStore("currentEngineType", runningEngine.type);
        }
      } catch (err) {
        logger.warn("[Init] Failed to load engines:", err);
      }

      const projects = await gateway.listProjects("opencode");
      logger.debug("[Init] Loaded projects:", projects);

      // Load projects from other running engines
      const runningEngines = configStore.engines.filter(e => e.status === "running" && e.type !== "opencode");
      for (const engine of runningEngines) {
        try {
          const engineProjects = await gateway.listProjects(engine.type);
          projects.push(...engineProjects);
        } catch (err) {
          logger.warn(`[Init] Failed to load projects for engine ${engine.type}:`, err);
        }
      }

      // Auto-hide global and invalid projects
      for (const p of projects) {
        if (!p.directory || p.directory === "/") {
          ProjectStore.hide(p.id);
        }
      }

      const hiddenIds = ProjectStore.getHiddenIds();
      logger.debug("[Init] Hidden project IDs:", hiddenIds);

      const validProjects = projects.filter((p: UnifiedProject) => {
        const isHidden = ProjectStore.isHidden(p.id);
        logger.debug(`[Init] Project ${p.id} (${p.directory}) isHidden: ${isHidden}`);
        return !isHidden;
      });

      // Load all sessions from all running engines
      const sessions = await gateway.listSessions("opencode");
      for (const engine of runningEngines) {
        try {
          const engineSessions = await gateway.listSessions(engine.type);
          sessions.push(...engineSessions);
        } catch (err) {
          logger.warn(`[Init] Failed to load sessions for engine ${engine.type}:`, err);
        }
      }
      logger.debug("[Init] Loaded sessions:", sessions);

      // Filter sessions to valid project directories
      const validDirectories = new Set(validProjects.map((p: UnifiedProject) => p.directory));
      logger.debug("[Init] Valid directories:", [...validDirectories]);
      const droppedSessions = sessions.filter((s: UnifiedSession) => !validDirectories.has(s.directory));
      if (droppedSessions.length > 0) {
        logger.warn("[Init] Sessions filtered out (directory not in valid projects):",
          droppedSessions.map(s => ({ id: s.id, dir: s.directory, engine: s.engineType })));
      }
      const filteredSessions = sessions.filter((s: UnifiedSession) => validDirectories.has(s.directory));

      const processedSessions: SessionInfo[] = filteredSessions.map((s: UnifiedSession) => {
        // For ACP sessions without projectID, resolve via directory matching
        let projectID = (s.engineMeta?.projectID as string) || undefined;
        if (!projectID) {
          const matchingProject = validProjects.find(p => p.directory === s.directory && p.engineType === s.engineType);
          if (matchingProject) {
            projectID = matchingProject.id;
          }
        }
        return toSessionInfo(s, projectID);
      });

      processedSessions.sort((a: SessionInfo, b: SessionInfo) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );

      const currentSession = processedSessions[0] ?? null;

      // Merge with existing sessions: keep sessions already in list that weren't
      // returned by backend (e.g. Copilot doesn't persist completed sessions in
      // session/list RPC). Backend-returned sessions take priority for updates.
      const existingList = sessionStore.list;
      const mergedMap = new Map<string, SessionInfo>();
      // Start with existing sessions
      for (const s of existingList) {
        mergedMap.set(s.id, s);
      }
      // Override/add with freshly loaded sessions
      for (const s of processedSessions) {
        mergedMap.set(s.id, s);
      }
      const mergedSessions = [...mergedMap.values()].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );

      setSessionStore({
        list: mergedSessions,
        projects: validProjects,
        current: currentSession?.id ?? null,
        loading: false,
      });

      if (currentSession) {
        await loadSessionMessages(currentSession.id);

        // Refresh model list after session init — ACP engines only populate
        // models/currentModelId after createSession or loadSession, so the
        // ModelSelector's initial listModels call may have returned empty.
        const initEngineType = currentSession.engineType || configStore.currentEngineType || "opencode";
        try {
          const modelResult = await gateway.listModels(initEngineType);
          if (modelResult.models.length > 0) {
            setConfigStore("models", modelResult.models);
          }
          if (modelResult.currentModelId) {
            setConfigStore("currentModelID", modelResult.currentModelId);
          }
        } catch {
          // Non-critical
        }
      }
    } catch (error) {
      if (disposed) return;
      logger.error("[Init] Session initialization failed:", error);
      const msg = error instanceof Error ? error.message : String(error);
      setSessionStore({ loading: false, initError: msg });
    }
  };

  // Switch session
  const handleSelectSession = async (sessionId: string) => {
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

    // Auto-select first available mode for the engine
    const engineInfo = configStore.engines.find(e => e.type === (session?.engineType || configStore.currentEngineType));
    const availableModes = engineInfo?.capabilities?.availableModes;
    if (availableModes && availableModes.length > 0) {
      setCurrentAgent(availableModes[0]);
    }

    if (isMobile()) {
      setIsSidebarOpen(false);
    }

    if (!messageStore.message[sessionId]) {
      await loadSessionMessages(sessionId);
    } else {
      setTimeout(() => scrollToBottom(true), 100);
    }

    // Refresh model list — ACP adapters populate models/currentModelId
    // after loadSession, so we need to re-fetch after messages are loaded.
    const switchEngineType = session?.engineType || configStore.currentEngineType || "opencode";
    try {
      const modelResult = await gateway.listModels(switchEngineType);
      if (modelResult.models.length > 0) {
        setConfigStore("models", modelResult.models);
      }
      if (modelResult.currentModelId) {
        setConfigStore("currentModelID", modelResult.currentModelId);
      }
    } catch {
      // Non-critical
    }
  };

  // New session
  const handleNewSession = async (directory?: string, explicitEngineType?: EngineType) => {
    logger.debug("[NewSession] Creating new session in directory:", directory, "engineType:", explicitEngineType);

    try {
      const dir = directory || sessionStore.projects[0]?.directory || ".";
      // Use explicitly-passed engineType (from sidebar "+" button) when available,
      // otherwise resolve from project binding or global default.
      const engineType = explicitEngineType || configStore.currentEngineType || "opencode";
      const newSession = await gateway.createSession(engineType, dir);
      logger.debug("[NewSession] Created:", newSession);

      // Match project by both directory AND engine type to avoid cross-engine mismatch
      // (same directory can exist under both OC and Copilot engines).
      const project = sessionStore.projects.find(p => p.directory === dir && p.engineType === engineType)
        || sessionStore.projects.find(p => p.directory === dir);
      const projectID = project?.id || undefined;
      const processedSession = toSessionInfo(newSession, projectID);

      setSessionStore("list", (list) => [processedSession, ...list]);
      setSessionStore("current", processedSession.id);
      setSessionStore("initError", null);
      setConfigStore("currentEngineType", engineType as import("../types/unified").EngineType);
      if (isMobile()) {
        setIsSidebarOpen(false);
      }

      setMessageStore("message", processedSession.id, []);
      setTimeout(() => scrollToBottom(true), 100);

      // Refresh engine capabilities (ACP engines populate modes/models only after createSession)
      try {
        const engines = await gateway.listEngines();
        setConfigStore("engines", engines);

        // Auto-select first available mode for the new engine
        const engineInfo = engines.find(e => e.type === engineType);
        const availableModes = engineInfo?.capabilities?.availableModes;
        if (availableModes && availableModes.length > 0) {
          setCurrentAgent(availableModes[0]);
        }

        // Refresh model list (ACP adapter now has models populated from createSession)
        const modelResult = await gateway.listModels(engineType);
        if (modelResult.models.length > 0) {
          setConfigStore("models", modelResult.models);
        }
        // Propagate engine's current model so ModelSelector picks it up
        if (modelResult.currentModelId) {
          setConfigStore("currentModelID", modelResult.currentModelId);
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

      // Remove from list
      setSessionStore("list", (list) => list.filter((s) => s.id !== sessionId));

      // If current session deleted, switch to first available session
      if (sessionStore.current === sessionId) {
        const remaining = sessionStore.list.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          await handleSelectSession(remaining[0].id);
        } else {
          // No sessions left, create a new one
          await handleNewSession();
        }
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

  const handleHideProject = async () => {
    const info = deleteProjectInfo();
    if (!info) return;

    logger.debug("[HideProject] Hiding project and deleting sessions:", info.projectID);
    logger.debug("[HideProject] Hidden IDs before:", ProjectStore.getHiddenIds());

    try {
      const sessionsToDelete = sessionStore.list.filter(
        (s) => s.projectID === info.projectID
      );

      const currentSessionWillBeDeleted = sessionStore.current &&
        sessionsToDelete.some(s => s.id === sessionStore.current);

      for (const session of sessionsToDelete) {
        await gateway.deleteSession(session.id);
      }

      ProjectStore.hide(info.projectID);
      logger.debug("[HideProject] Hidden IDs after:", ProjectStore.getHiddenIds());

      setSessionStore("list", (list) =>
        list.filter((s) => s.projectID !== info.projectID)
      );
      setSessionStore("projects", (projects) =>
        projects.filter((p) => p.id !== info.projectID)
      );

      if (currentSessionWillBeDeleted) {
        const remainingSessions = sessionStore.list;
        if (remainingSessions.length > 0) {
          await handleSelectSession(remainingSessions[0].id);
        } else {
          await handleNewSession();
        }
      }
    } catch (error) {
      logger.error("[HideProject] Failed to hide project:", error);
    } finally {
      setDeleteProjectInfo(null);
    }
  };

  const handleAddProject = async (directory: string, engineType: EngineType = "opencode") => {
    logger.debug("[AddProject] Initializing project for directory:", directory);

    try {
      // Creating a session in the directory will trigger project initialization in OpenCode
      const newSession = await gateway.createSession(engineType, directory);
      logger.debug("[AddProject] Session created:", newSession);

      // Refresh projects list
      const projects = await gateway.listProjects(engineType);
      let project = projects.find((p: UnifiedProject) => p.directory === directory);

      // For ACP-based engines (e.g. copilot) that don't support listing projects,
      // construct a project entry from the session info
      if (!project && newSession) {
        const projectID = (newSession.engineMeta?.projectID as string) || `${engineType}-${directory}`;
        const dirName = directory.split(/[/\\]/).filter(Boolean).pop() || directory;
        project = {
          id: projectID,
          directory,
          name: dirName,
          engineType,
        };
      }

      if (project) {
        ProjectStore.add(project.id, directory);

        const existingProject = sessionStore.projects.find(p => p.id === project!.id);
        if (!existingProject) {
          setSessionStore("projects", (ps) => [...ps, project!]);
        }
      }

      const processedSession = toSessionInfo(newSession, (newSession.engineMeta?.projectID as string) || project?.id || undefined);

      const existingSession = sessionStore.list.find(s => s.id === newSession.id);
      if (!existingSession) {
        setSessionStore("list", (list) => [processedSession, ...list]);
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
        const idx = binarySearch(messages, messageId, (m) => m.id);
        if (!messageStore.message[sessionId]) {
          setMessageStore("message", sessionId, [placeholder]);
        } else {
          setMessageStore("message", sessionId, (draft) => {
            const newMessages = [...draft];
            newMessages.splice(idx.index, 0, placeholder);
            return newMessages;
          });
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
    setTimeout(scrollToBottom, 0);
  };

  const handleMessageUpdated = (_sessionId: string, msgInfo: UnifiedMessage) => {
    const targetSessionId = msgInfo.sessionId;

    if (msgInfo.role === "user") {
      const currentMessages = messageStore.message[targetSessionId] || [];
      const tempMessages = currentMessages.filter(m => m.id.startsWith("msg-temp-"));

      if (tempMessages.length > 0) {
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
        const sortedParts = msgInfo.parts.slice().sort((a, b) =>
          a.id.localeCompare(b.id)
        );
        setMessageStore("part", msgInfo.id, sortedParts);
      } else {
        // Merge: use existing streaming parts as base, add any new parts
        // from the final message that weren't received via streaming
        const existingIds = new Set(existingParts.map(p => p.id));
        const newParts = msgInfo.parts.filter(p => !existingIds.has(p.id));
        if (newParts.length > 0) {
          const merged = [...existingParts, ...newParts].sort((a, b) =>
            a.id.localeCompare(b.id)
          );
          setMessageStore("part", msgInfo.id, merged);
        }
      }
    }

    const messages = messageStore.message[targetSessionId] || [];
    const index = binarySearch(messages, msgInfo.id, (m) => m.id);

    if (index.found) {
      setMessageStore("message", targetSessionId, index.index, msgInfo);
    } else if (!messageStore.message[targetSessionId]) {
      setMessageStore("message", targetSessionId, [msgInfo]);
    } else {
      setMessageStore("message", targetSessionId, (draft) => {
        const newMessages = [...draft];
        newMessages.splice(index.index, 0, msgInfo);
        return newMessages;
      });
    }
  };

  const handleSessionUpdated = (updated: UnifiedSession) => {
    logger.debug("[WS] session.updated received:", updated);
    setSessionStore("list", (list) =>
      list.map((s) =>
        s.id === updated.id
          ? {
              ...s,
              title: updated.title || "",
              directory: updated.directory || s.directory || "",
              createdAt: new Date(updated.time.created).toISOString(),
              updatedAt: new Date(updated.time.updated).toISOString(),
            }
          : s,
      ),
    );
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

  const handleSendMessage = async (text: string, agent: AgentMode) => {
    const sessionId = sessionStore.current;
    if (!sessionId || sending()) return;

    setSendingFor(sessionId, true);

    const tempMessageId = `msg-temp-${Date.now()}`;
    const tempPartId = `part-temp-${Date.now()}`;

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

    const msgIndex = binarySearch(messages, tempMessageId, (m) => m.id);
    if (!msgIndex.found) {
      setMessageStore("message", sessionId, (draft) => {
        const newMessages = [...draft];
        newMessages.splice(msgIndex.index, 0, tempMessageInfo);
        return newMessages;
      });
    }

    setMessageStore("part", tempMessageId, [tempPart]);
    setUserScrolledUp(false);
    setTimeout(() => scrollToBottom(true), 0);

    try {
      const model = currentSessionModel();
      await gateway.sendMessage(sessionId, text, {
        mode: agent.id,
        modelId: model?.modelID || undefined,
      });
    } catch (error) {
      logger.error("[SendMessage] Failed to send message:", error);
      // Remove the optimistic temp message on failure
      setMessageStore("message", sessionId, (draft) =>
        draft.filter((m) => m.id !== tempMessageId),
      );
      setMessageStore("part", tempMessageId, undefined as any);
    } finally {
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
    setSendingFor(sessionId, false);
  };

  createEffect(() => {
    initializeSession();

    onCleanup(() => {
      disposed = true;
      gateway.destroy();
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
          fixed md:static inset-y-0 left-0 z-30 w-72 bg-gray-50 dark:bg-zinc-950 border-r border-gray-200 dark:border-zinc-800 transform transition-transform duration-300 ease-in-out flex flex-col justify-between electron-safe-top
          ${isSidebarOpen() ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        <div class="flex flex-col h-full overflow-hidden">
          <Show when={!sessionStore.loading}>
            <SessionSidebar
              sessions={sessionStore.list}
              projects={sessionStore.projects}
              currentSessionId={sessionStore.current}
              getSessionStatus={(sessionId: string) => sessionStatusMap()[sessionId] || "idle"}
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onDeleteProjectSessions={(projectID, projectName, sessionCount) =>
                setDeleteProjectInfo({ projectID, projectName, sessionCount })
              }
              onAddProject={() => setShowAddProjectModal(true)}
              showAddProject={isLocalAccess()}
            />
          </Show>
        </div>

        {/* User Actions Footer in Sidebar */}
        <div class="p-3 border-t border-gray-200 dark:border-zinc-800 space-y-1 bg-gray-50 dark:bg-zinc-950">
          <Show when={isLocalAccess()}>
            <button
              onClick={() => navigate("/")}
              class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-xs hover:shadow-sm"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>
              {t().chat.remoteAccess}
            </button>
          </Show>
          <button
            onClick={() => navigate("/settings")}
            class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-xs hover:shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
            {t().chat.settings}
          </button>
          <button
            onClick={handleLogout}
            class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" /></svg>
            {t().chat.logout}
          </button>
        </div>
      </aside>

      {/* Main Chat Area */}
      <div class="flex-1 flex flex-col overflow-hidden min-w-0 bg-white dark:bg-zinc-900 electron-safe-top">

        {/* Header */}
        <header class="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-zinc-800/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xs sticky top-0 z-10 electron-drag-region">
          <div class="flex items-center gap-3 electron-no-drag">
            <button
              onClick={toggleSidebar}
              class="md:hidden p-2 -ml-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-zinc-800 rounded-lg transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="18" y2="18" /></svg>
            </button>
            <h1 class="text-base font-semibold text-gray-900 dark:text-white truncate">
              {getDisplayTitle(sessionStore.list.find(s => s.id === sessionStore.current)?.title || "")}
            </h1>
            {/* Agent Mode Indicator */}
            <span class={`px-2 py-0.5 text-[10px] font-medium rounded-full ${
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
            <Show
              when={!loadingMessages()}
              fallback={
                <div class="flex-1 flex items-center justify-center">
                  <div class="flex flex-col items-center gap-3 text-gray-400">
                    <div class="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                  </div>
                </div>
              }
            >
              <div ref={setMessagesRef} onScroll={handleScroll} class="flex-1 overflow-y-auto px-4 md:px-6 scroll-smooth">
                <div class="max-w-3xl mx-auto w-full py-6">
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
                    <MessageList sessionID={sessionStore.current!} isWorking={sending()} onPermissionRespond={handlePermissionRespond} onQuestionRespond={handleQuestionRespond} onQuestionDismiss={handleQuestionDismiss} />
                  </Show>
                </div>
              </div>

              {/* Input Area */}
              <div class="p-4 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xs border-t border-gray-100 dark:border-zinc-800 relative z-20">
                <div class="max-w-3xl mx-auto w-full">
                  {/* Permission prompt replaces input when permissions are pending */}
                  <Show when={currentPermissions().length > 0}>
                    <div class="space-y-3">
                      <For each={currentPermissions()}>
                        {(perm) => (
                          <div class="rounded-xl border border-amber-200 dark:border-amber-700/50 bg-amber-50/80 dark:bg-amber-950/30 p-4">
                            <div class="flex items-center gap-2 mb-3">
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-600 dark:text-amber-400">
                                <path d="M12 9v4" /><path d="M12 17h.01" /><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                              </svg>
                              <span class="text-sm font-medium text-amber-800 dark:text-amber-300">{t().permission.waitingApproval}</span>
                            </div>
                            <p class="text-sm text-amber-700 dark:text-amber-400 mb-1">{perm.title}</p>
                            <Show when={perm.patterns && perm.patterns.length > 0}>
                              <p class="text-xs text-amber-600/70 dark:text-amber-500/70 mb-3 font-mono">{perm.patterns?.join(", ")}</p>
                            </Show>
                            <div class="flex items-center gap-2 mt-3">
                              <For each={perm.options?.length > 0 ? perm.options : [
                                { id: "reject", label: t().permission.deny, type: "reject" },
                                { id: "always", label: t().permission.allowAlways, type: "accept_always" },
                                { id: "once", label: t().permission.allowOnce, type: "accept_once" },
                              ]}>
                                {(opt) => (
                                  <button
                                    type="button"
                                    class={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                                      opt.type.includes("reject")
                                        ? "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50"
                                        : opt.type.includes("always")
                                          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-900/50"
                                          : "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
                                    }`}
                                    onClick={() => handlePermissionRespond(perm.sessionId, perm.id, opt.id)}
                                  >
                                    {opt.label || (opt.type.includes("reject") ? t().permission.deny : opt.type.includes("always") ? t().permission.allowAlways : t().permission.allowOnce)}
                                  </button>
                                )}
                              </For>
                            </div>
                          </div>
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
                    <PromptInput
                      onSend={handleSendMessage}
                      onCancel={handleCancelMessage}
                      isGenerating={sending()}
                      currentAgent={currentAgent()}
                      onAgentChange={setCurrentAgent}
                      onModelChange={handleModelChange}
                      engineType={currentEngineType()}
                      availableModes={configStore.engines.find(e => e.type === currentEngineType())?.capabilities?.availableModes}
                      disabled={!sessionStore.current}
                    />
                  </Show>
                  <div class="mt-2 text-center">
                    <p class="text-[10px] text-gray-400 dark:text-gray-600">
                      {t().chat.disclaimer}
                    </p>
                  </div>
                </div>
              </div>
            </Show>
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

// --- InputAreaQuestion: replaces PromptInput when questions are pending ---

interface InputAreaQuestionProps {
  question: UnifiedQuestion;
  onRespond: (sessionID: string, questionID: string, answers: string[][]) => void;
  onDismiss: (sessionID: string, questionID: string) => void;
}

function InputAreaQuestion(props: InputAreaQuestionProps) {
  const { t } = useI18n();

  // Each question in the array gets its own selection state
  // selections[i] = array of selected option labels for question i
  const [selections, setSelections] = createSignal<string[][]>(
    props.question.questions.map(() => []),
  );

  // Custom text input per question
  const [customInputs, setCustomInputs] = createSignal<string[]>(
    props.question.questions.map(() => ""),
  );

  const toggleOption = (qIndex: number, label: string, multiple: boolean) => {
    setSelections((prev) => {
      const updated = [...prev];
      const current = [...(updated[qIndex] || [])];

      if (multiple) {
        const idx = current.indexOf(label);
        if (idx >= 0) {
          current.splice(idx, 1);
        } else {
          current.push(label);
        }
      } else {
        // Single select: toggle or replace
        if (current.length === 1 && current[0] === label) {
          updated[qIndex] = [];
          return updated;
        }
        updated[qIndex] = [label];
        return updated;
      }

      updated[qIndex] = current;
      return updated;
    });
  };

  const setCustomInput = (qIndex: number, value: string) => {
    setCustomInputs((prev) => {
      const updated = [...prev];
      updated[qIndex] = value;
      return updated;
    });
  };

  const handleSubmit = () => {
    // Build answers: for each question, combine selected options + custom input
    const answers = props.question.questions.map((_, i) => {
      const selected = selections()[i] || [];
      const custom = customInputs()[i]?.trim();
      if (custom) {
        return [...selected, custom];
      }
      return [...selected];
    });
    props.onRespond(props.question.sessionId, props.question.id, answers);
  };

  const handleDismiss = () => {
    props.onDismiss(props.question.sessionId, props.question.id);
  };

  const hasAnyAnswer = () => {
    return props.question.questions.some((_, i) => {
      const selected = selections()[i] || [];
      const custom = customInputs()[i]?.trim();
      return selected.length > 0 || (custom && custom.length > 0);
    });
  };

  return (
    <div class="rounded-xl border border-indigo-200 dark:border-indigo-700/50 bg-indigo-50/80 dark:bg-indigo-950/30 p-4">
      <div class="flex items-center gap-2 mb-3">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-indigo-600 dark:text-indigo-400">
          <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />
        </svg>
        <span class="text-sm font-medium text-indigo-800 dark:text-indigo-300">{t().question.waitingAnswer}</span>
      </div>

      <For each={props.question.questions}>
        {(qInfo, qIndex) => (
          <div class={qIndex() > 0 ? "mt-4 pt-4 border-t border-indigo-200/50 dark:border-indigo-700/30" : ""}>
            {/* Header + Question */}
            <div class="mb-2">
              <span class="inline-block text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-900/40 rounded px-1.5 py-0.5 mr-2">
                {qInfo.header}
              </span>
              <span class="text-sm text-indigo-800 dark:text-indigo-200">{qInfo.question}</span>
            </div>

            {/* Options as selectable chips */}
            <div class="flex flex-wrap gap-2 mb-2">
              <For each={qInfo.options}>
                {(opt) => {
                  const isSelected = () => (selections()[qIndex()] || []).includes(opt.label);
                  return (
                    <button
                      type="button"
                      class={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                        isSelected()
                          ? "bg-indigo-600 text-white dark:bg-indigo-500"
                          : "bg-white text-indigo-700 border border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700/50 dark:hover:bg-indigo-900/50"
                      }`}
                      onClick={() => toggleOption(qIndex(), opt.label, qInfo.multiple ?? false)}
                      title={opt.description}
                    >
                      {opt.label}
                    </button>
                  );
                }}
              </For>
            </div>

            {/* Custom text input (shown when custom !== false) */}
            <Show when={qInfo.custom !== false}>
              <input
                type="text"
                class="w-full px-3 py-1.5 rounded-lg text-sm border border-indigo-200 dark:border-indigo-700/50 bg-white dark:bg-indigo-950/50 text-indigo-800 dark:text-indigo-200 placeholder-indigo-400/60 dark:placeholder-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:focus:ring-indigo-500"
                placeholder={t().question.customPlaceholder}
                value={customInputs()[qIndex()] || ""}
                onInput={(e) => setCustomInput(qIndex(), e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hasAnyAnswer()) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
            </Show>
          </div>
        )}
      </For>

      {/* Action buttons */}
      <div class="flex items-center gap-2 mt-3">
        <button
          type="button"
          class="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors"
          onClick={handleDismiss}
        >
          {t().question.dismiss}
        </button>
        <button
          type="button"
          class={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            hasAnyAnswer()
              ? "bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
              : "bg-indigo-200 text-indigo-400 cursor-not-allowed dark:bg-indigo-900/30 dark:text-indigo-600"
          }`}
          onClick={handleSubmit}
          disabled={!hasAnyAnswer()}
        >
          {t().question.submit}
        </button>
      </div>
    </div>
  );
}

