import {
  createEffect,
  createSignal,
  createMemo,
  onCleanup,
  Show,
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
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedSession, UnifiedProject, AgentMode, EngineType } from "../types/unified";
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

export default function Chat() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [sending, setSending] = createSignal(false);
  const [messagesRef, setMessagesRef] = createSignal<HTMLDivElement>();
  const [loadingMessages, setLoadingMessages] = createSignal(false);

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

  // Mobile Sidebar State
  const [isSidebarOpen, setIsSidebarOpen] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(window.innerWidth < 768);

  const [deleteProjectInfo, setDeleteProjectInfo] = createSignal<{
    projectID: string;
    projectName: string;
    sessionCount: number;
  } | null>(null);

  const [showAddProjectModal, setShowAddProjectModal] = createSignal(false);

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

  const scrollToBottom = () => {
    const el = messagesRef();
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
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
      logger.error("[LoadMessages] Failed to load messages:", error);
    } finally {
      setLoadingMessages(false);
      setTimeout(scrollToBottom, 100);
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
          // If we were in error state, re-initialize on reconnect
          if (sessionStore.initError) {
            initializeSession();
          }
        },
        onDisconnected: (reason) => {
          logger.warn("[Gateway] Disconnected:", reason);
        },
        onPartUpdated: handlePartUpdated,
        onMessageUpdated: handleMessageUpdated,
        onSessionUpdated: handleSessionUpdated,
        onPermissionAsked: handlePermissionAsked,
        onPermissionReplied: handlePermissionReplied,
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

      // Load all sessions for this engine
      const sessions = await gateway.listSessions("opencode");
      logger.debug("[Init] Loaded sessions:", sessions);

      // Filter sessions to valid project directories
      const validDirectories = new Set(validProjects.map((p: UnifiedProject) => p.directory));
      const filteredSessions = sessions.filter((s: UnifiedSession) => validDirectories.has(s.directory));

      const processedSessions: SessionInfo[] = filteredSessions.map((s: UnifiedSession) => ({
        id: s.id,
        title: s.title || "",
        directory: s.directory || "",
        projectID: (s.engineMeta?.projectID as string) || undefined,
        parentID: s.parentId,
        createdAt: new Date(s.time.created).toISOString(),
        updatedAt: new Date(s.time.updated).toISOString(),
        summary: s.engineMeta?.summary as SessionInfo["summary"] | undefined,
      }));

      processedSessions.sort((a: SessionInfo, b: SessionInfo) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );

      let currentSession = processedSessions[0];
      if (!currentSession) {
        logger.debug("[Init] No sessions found, creating new one");
        const defaultDir = validProjects[0]?.directory || ".";
        const newSession = await gateway.createSession("opencode", defaultDir);
        currentSession = {
          id: newSession.id,
          title: newSession.title || "",
          directory: newSession.directory || "",
          projectID: (newSession.engineMeta?.projectID as string) || undefined,
          parentID: newSession.parentId,
          createdAt: new Date(newSession.time.created).toISOString(),
          updatedAt: new Date(newSession.time.updated).toISOString(),
          summary: newSession.engineMeta?.summary as SessionInfo["summary"] | undefined,
        };
        processedSessions.push(currentSession);
      }

      setSessionStore({
        list: processedSessions,
        projects: validProjects,
        current: currentSession.id,
        loading: false,
      });

      await loadSessionMessages(currentSession.id);
    } catch (error) {
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

    if (isMobile()) {
      setIsSidebarOpen(false);
    }

    if (!messageStore.message[sessionId]) {
      await loadSessionMessages(sessionId);
    } else {
      setTimeout(scrollToBottom, 100);
    }
  };

  // New session
  const handleNewSession = async (directory?: string) => {
    logger.debug("[NewSession] Creating new session in directory:", directory);

    try {
      const dir = directory || sessionStore.projects[0]?.directory || ".";
      const newSession = await gateway.createSession("opencode", dir);
      logger.debug("[NewSession] Created:", newSession);

      const processedSession: SessionInfo = {
        id: newSession.id,
        title: newSession.title || "",
        directory: newSession.directory || "",
        projectID: (newSession.engineMeta?.projectID as string) || undefined,
        parentID: newSession.parentId,
        createdAt: new Date(newSession.time.created).toISOString(),
        updatedAt: new Date(newSession.time.updated).toISOString(),
        summary: newSession.engineMeta?.summary as SessionInfo["summary"] | undefined,
      };

      setSessionStore("list", (list) => [processedSession, ...list]);
      setSessionStore("current", processedSession.id);
      setSessionStore("initError", null);
      if (isMobile()) {
        setIsSidebarOpen(false);
      }

      setMessageStore("message", processedSession.id, []);
      setTimeout(scrollToBottom, 100);
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
      // TODO: Add session.update to gateway protocol
      setSessionStore("list", (list) =>
        list.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
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
      const project = projects.find((p: UnifiedProject) => p.directory === directory);

      if (project) {
        ProjectStore.add(project.id, directory);

        const existingProject = sessionStore.projects.find(p => p.id === project.id);
        if (!existingProject) {
          setSessionStore("projects", (ps) => [...ps, project]);
        }
      }

      const processedSession: SessionInfo = {
        id: newSession.id,
        title: newSession.title || "",
        directory: newSession.directory || "",
        projectID: (newSession.engineMeta?.projectID as string) || undefined,
        parentID: newSession.parentId,
        createdAt: new Date(newSession.time.created).toISOString(),
        updatedAt: new Date(newSession.time.updated).toISOString(),
        summary: newSession.engineMeta?.summary as SessionInfo["summary"] | undefined,
      };

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

  const handleSendMessage = async (text: string, agent: AgentMode) => {
    const sessionId = sessionStore.current;
    if (!sessionId || sending()) return;

    setSending(true);

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
    setTimeout(scrollToBottom, 0);

    try {
      const model = currentSessionModel();
      await gateway.sendMessage(sessionId, text, {
        mode: agent.id,
        modelId: model?.modelID,
      });
    } catch (error) {
      logger.error("[SendMessage] Failed to send message:", error);
    } finally {
      setSending(false);
    }
  };

  createEffect(() => {
    initializeSession();

    onCleanup(() => {
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
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onDeleteProjectSessions={(projectID, projectName, sessionCount) =>
                setDeleteProjectInfo({ projectID, projectName, sessionCount })
              }
              onAddProject={() => setShowAddProjectModal(true)}
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
            when={!sessionStore.loading && sessionStore.current}
            fallback={
              <div class="flex-1 flex items-center justify-center">
                <div class="flex flex-col items-center gap-3 text-gray-400">
                  <div class="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
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
              <div ref={setMessagesRef} class="flex-1 overflow-y-auto px-4 md:px-6 scroll-smooth">
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
                    <MessageList sessionID={sessionStore.current!} isWorking={sending()} onPermissionRespond={handlePermissionRespond} />
                  </Show>
                </div>
              </div>

              {/* Input Area */}
              <div class="p-4 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xs border-t border-gray-100 dark:border-zinc-800 relative z-20">
                <div class="max-w-3xl mx-auto w-full">
                  <PromptInput
                    onSend={handleSendMessage}
                    disabled={sending()}
                    currentAgent={currentAgent()}
                    onAgentChange={setCurrentAgent}
                    onModelChange={handleModelChange}
                    availableModes={configStore.engines.find(e => e.type === (configStore.currentEngineType ?? "opencode"))?.capabilities?.availableModes}
                  />
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

