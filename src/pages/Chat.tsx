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
import { client } from "../lib/opencode-client";
import { logger } from "../lib/logger";
import { isElectron } from "../lib/platform";
import { sessionStore, setSessionStore } from "../stores/session";
import {
  messageStore,
  setMessageStore,
} from "../stores/message";
import { MessageList } from "../components/MessageList";
import { PromptInput } from "../components/PromptInput";
import { SessionSidebar } from "../components/SessionSidebar";
import { HideProjectModal } from "../components/HideProjectModal";
import { AddProjectModal } from "../components/AddProjectModal";
import { MessageV2, Permission, Session } from "../types/opencode";
import { useI18n } from "../lib/i18n";
import { AgentMode } from "../components/PromptInput";
import { ProjectStore } from "../lib/project-store";

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
  } | null>(client.getDefaultModel());
  
  // Agent mode state - default to "build" matching OpenCode's default
  const [currentAgent, setCurrentAgent] = createSignal<AgentMode>("build");

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

    const messages = await client.getMessages(sessionId);
    logger.debug("[LoadMessages] Loaded messages:", messages);

    // Follow opencode desktop pattern: store message info and parts separately
    const messageInfos: MessageV2.Info[] = [];

    for (const msg of messages) {
      // API returns format { info: {...}, parts: [...] }
      const msgInfo = (msg as any).info || msg;
      const msgParts = (msg as any).parts || [];

      // Store message info (without parts)
      messageInfos.push(msgInfo);

      // Store parts separately, sorted by id
      const sortedParts = msgParts.slice().sort((a: any, b: any) =>
        a.id.localeCompare(b.id)
      );
      setMessageStore("part", msgInfo.id, sortedParts);
    }

    // Store all messages, sorted by id
    const sortedMessages = messageInfos.slice().sort((a, b) =>
      a.id.localeCompare(b.id)
    );
    setMessageStore("message", sessionId, sortedMessages);

    setLoadingMessages(false);
    setTimeout(scrollToBottom, 100);
  };

  const initializeSession = async () => {
    logger.debug("[Init] Starting session initialization");

    try {
      // Check if this is local access (for showing remote access button)
      if (!isElectron()) {
        const localAccess = await Auth.isLocalAccess();
        setIsLocalAccess(localAccess);
      }

      // Initialize the OpenCode client with correct URL
      await client.initialize();

      const isValidToken = await Auth.checkDeviceToken();
      if (!isValidToken) {
        logger.debug("[Init] Device token invalid or revoked, redirecting to entry");
        Auth.clearAuth();
        navigate("/", { replace: true });
        return;
      }

      setSessionStore({ loading: true });

      const projects = await client.listProjects();
      logger.debug("[Init] Loaded projects:", projects);

      // Auto-hide global and invalid projects
      for (const p of projects) {
        if (!p.worktree || p.worktree === "/") {
          ProjectStore.hide(p.id);
        }
      }

      const hiddenIds = ProjectStore.getHiddenIds();
      logger.debug("[Init] Hidden project IDs:", hiddenIds);

      const validProjects = projects.filter((p) => {
        const isHidden = ProjectStore.isHidden(p.id);
        logger.debug(`[Init] Project ${p.id} (${p.worktree}) isHidden: ${isHidden}`);
        return !isHidden;
      });
      const sessionPromises = validProjects.map((p) =>
        client.listSessionsForDirectory(p.worktree).catch((err) => {
          logger.error(`[Init] Failed to load sessions for ${p.worktree}:`, err);
          return [] as Session.Info[];
        })
      );
      const sessionArrays = await Promise.all(sessionPromises);
      const sessions = sessionArrays.flat();
      logger.debug("[Init] Loaded sessions:", sessions);

      const processedSessions = sessions.map((s) => ({
        id: s.id,
        title: s.title || "",
        directory: s.directory || "",
        projectID: s.projectID,
        parentID: s.parentID,
        createdAt: new Date(s.time.created).toISOString(),
        updatedAt: new Date(s.time.updated).toISOString(),
        summary: s.summary,
      }));

      processedSessions.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );

      let currentSession = processedSessions[0];
      if (!currentSession) {
        logger.debug("[Init] No sessions found, creating new one");
        const newSession = await client.createSession();
        currentSession = {
          id: newSession.id,
          title: newSession.title || "",
          directory: newSession.directory || "",
          projectID: newSession.projectID,
          parentID: newSession.parentID,
          createdAt: new Date(newSession.time.created).toISOString(),
          updatedAt: new Date(newSession.time.updated).toISOString(),
          summary: newSession.summary,
        };
        processedSessions.push(currentSession);
      }

      // Set directory context for API requests
      if (currentSession.directory) {
        client.setDirectory(currentSession.directory);
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
      setSessionStore({ loading: false });
    }
  };

  // Switch session
  const handleSelectSession = async (sessionId: string) => {
    logger.debug("[SelectSession] Switching to session:", sessionId);
    setSessionStore("current", sessionId);
    
    const session = sessionStore.list.find(s => s.id === sessionId);
    if (session?.directory) {
      client.setDirectory(session.directory);
    }
    
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
    
    const newSession = directory 
      ? await client.createSessionInDirectory(directory)
      : await client.createSession();
    logger.debug("[NewSession] Created:", newSession);

    if (newSession.directory) {
      client.setDirectory(newSession.directory);
    }

    const processedSession = {
      id: newSession.id,
      title: newSession.title || "",
      directory: newSession.directory || "",
      projectID: newSession.projectID,
      parentID: newSession.parentID,
      createdAt: new Date(newSession.time.created).toISOString(),
      updatedAt: new Date(newSession.time.updated).toISOString(),
      summary: newSession.summary,
    };

    setSessionStore("list", (list) => [processedSession, ...list]);
    setSessionStore("current", processedSession.id);
    if (isMobile()) {
      setIsSidebarOpen(false);
    }

    setMessageStore("message", processedSession.id, []);
    setTimeout(scrollToBottom, 100);
  };

  // Delete session
  const handleDeleteSession = async (sessionId: string) => {
    logger.debug("[DeleteSession] Deleting session:", sessionId);

    await client.deleteSession(sessionId);

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
  };

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    logger.debug("[RenameSession] Renaming session:", sessionId, newTitle);
    try {
      await client.updateSession(sessionId, { title: newTitle });
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

    const sessionsToDelete = sessionStore.list.filter(
      (s) => s.projectID === info.projectID
    );
    
    const currentSessionWillBeDeleted = sessionStore.current && 
      sessionsToDelete.some(s => s.id === sessionStore.current);
    
    for (const session of sessionsToDelete) {
      await client.deleteSession(session.id);
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
    
    setDeleteProjectInfo(null);
  };

  const handleAddProject = async (directory: string) => {
    logger.debug("[AddProject] Initializing project for directory:", directory);
    
    const { project, session } = await client.initializeProject(directory);
    logger.debug("[AddProject] Project initialized:", project, "Session:", session);
    
    ProjectStore.add(project.id, directory);
    
    const existingProject = sessionStore.projects.find(p => p.id === project.id);
    if (!existingProject) {
      setSessionStore("projects", (projects) => [...projects, project]);
    }
    
    if (session) {
      const processedSession = {
        id: session.id,
        title: session.title || "",
        directory: session.directory || "",
        projectID: session.projectID,
        parentID: session.parentID,
        createdAt: new Date(session.time.created).toISOString(),
        updatedAt: new Date(session.time.updated).toISOString(),
        summary: session.summary,
      };
      
      const existingSession = sessionStore.list.find(s => s.id === session.id);
      if (!existingSession) {
        setSessionStore("list", (list) => [processedSession, ...list]);
      }
      
      await handleSelectSession(session.id);
    }
  };

  const handlePermissionRespond = async (
    sessionID: string,
    permissionID: string,
    reply: Permission.Reply,
  ) => {
    logger.debug("[Permission] Responding:", { sessionID, permissionID, reply });
    
    try {
      await client.respondToPermission(permissionID, reply);
      
      // Optimistically remove from queue (SSE will also send permission.replied)
      const existing = messageStore.permission[sessionID] || [];
      setMessageStore("permission", sessionID, existing.filter(p => p.id !== permissionID));
    } catch (error) {
      logger.error("[Permission] Failed to respond:", error);
    }
  };

  const handleSSEEvent = (event: { type: string; data: any }) => {
    const sessionId = sessionStore.current;
    if (!sessionId) return;

    switch (event.type) {
      case "message.part.updated": {
        const part = event.data as MessageV2.Part;
        const messageId = part.messageID;
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
        break;
      }

      case "message.updated": {
        const msgInfo = event.data as MessageV2.Info;
        const targetSessionId = msgInfo.sessionID;
        
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
        break;
      }

      case "session.updated": {
        const updated = event.data;
        logger.debug("[SSE] session.updated received:", updated);
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
        break;
      }

      case "permission.asked": {
        const permission = event.data as Permission.Request;
        logger.debug("[SSE] Permission asked:", permission);
        const existing = messageStore.permission[permission.sessionID] || [];
        if (!existing.find((p) => p.id === permission.id)) {
          setMessageStore("permission", permission.sessionID, [...existing, permission]);
        }
        break;
      }

      case "permission.replied": {
        const { sessionID, requestID } = event.data as { sessionID: string; requestID: string };
        logger.debug("[SSE] Permission replied:", requestID);
        const existing = messageStore.permission[sessionID] || [];
        setMessageStore("permission", sessionID, existing.filter((p) => p.id !== requestID));
        break;
      }
    }
  };

  const handleSendMessage = async (text: string, agent: AgentMode) => {
    const sessionId = sessionStore.current;
    if (!sessionId || sending()) return;

    setSending(true);

    const tempMessageId = `msg-temp-${Date.now()}`;
    const tempPartId = `part-temp-${Date.now()}`;

    const tempMessageInfo: MessageV2.Info = {
      id: tempMessageId,
      sessionID: sessionId,
      role: "user",
      time: {
        created: Date.now(),
      },
      parts: [],
    };

    const tempPart: MessageV2.Part = {
      id: tempPartId,
      messageID: tempMessageId,
      sessionID: sessionId,
      type: "text",
      text,
    };

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

    const model = currentSessionModel();
    await client.sendMessage(sessionId, text, {
      agent,
      modelID: model?.modelID,
      providerID: model?.providerID,
    });
    setSending(false);
  };

  createEffect(() => {
    initializeSession();

    const cleanup = client.connectSSE(handleSSEEvent);
    onCleanup(cleanup);
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
              currentAgent() === "plan"
                ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
            }`}>
              {currentAgent() === "plan" ? t().prompt.plan : t().prompt.build}
            </span>
          </div>
        </header>

        {/* Message List */}
        <main class="flex-1 flex flex-col overflow-hidden relative">
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

