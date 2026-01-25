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
import { worktreeClient } from "../lib/worktree-client";
import { logger } from "../lib/logger";
import { sessionStore, setSessionStore, SessionInfo } from "../stores/session";
import {
  messageStore,
  setMessageStore,
} from "../stores/message";
import { MessageList } from "../components/MessageList";
import { PromptInput } from "../components/PromptInput";
import { SessionSidebar } from "../components/SessionSidebar";
import { NewSessionDialog } from "../components/NewSessionDialog";
import { MergeDialog, PushDialog, AbandonDialog } from "../components/WorktreeDialogs";
import { MessageV2, Permission, Session } from "../types/opencode";
import { useI18n } from "../lib/i18n";
import { AgentMode } from "../components/PromptInput";

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
  const [isLocalHost, setIsLocalHost] = createSignal(false);

  // Worktree dialog state
  const [newSessionDialogOpen, setNewSessionDialogOpen] = createSignal(false);
  const [mergeDialogOpen, setMergeDialogOpen] = createSignal(false);
  const [pushDialogOpen, setPushDialogOpen] = createSignal(false);
  const [abandonDialogOpen, setAbandonDialogOpen] = createSignal(false);
  const [selectedWorktreeSession, setSelectedWorktreeSession] = createSignal<SessionInfo | null>(null);

  const handleModelChange = (providerID: string, modelID: string) => {
    logger.debug("[Chat] Model changed to:", { providerID, modelID });
    setCurrentSessionModel({ providerID, modelID });
  };

  const handleLogout = () => {
    Auth.logout();
    navigate("/login", { replace: true });
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
    
    // Verify device token is still valid before proceeding
    const isValidToken = await Auth.checkDeviceToken();
    if (!isValidToken) {
      logger.debug("[Init] Device token invalid or revoked, redirecting to login");
      Auth.clearAuth();
      navigate("/login", { replace: true });
      return;
    }
    
    setSessionStore({ loading: true });

    const sessions = await client.listSessions();
    logger.debug("[Init] Loaded sessions:", sessions);

    // Process session list, convert timestamps to ISO strings
    const processedSessions = sessions.map((s) => ({
      id: s.id,
      title: s.title || "",
      directory: s.directory || "",
      parentID: s.parentID,
      createdAt: new Date(s.time.created).toISOString(),
      updatedAt: new Date(s.time.updated).toISOString(),
      summary: s.summary,
    }));

    // Sort by updatedAt descending (newest first)
    processedSessions.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    // Select the most recently updated session as default
    let currentSession = processedSessions[0];
    if (!currentSession) {
      logger.debug("[Init] No sessions found, creating new one");
      const newSession = await client.createSession();
      currentSession = {
        id: newSession.id,
        title: newSession.title || "",
        directory: newSession.directory || "",
        parentID: newSession.parentID,
        createdAt: new Date(newSession.time.created).toISOString(),
        updatedAt: new Date(newSession.time.updated).toISOString(),
        summary: newSession.summary,
      };
      processedSessions.push(currentSession);
    }

    setSessionStore({
      list: processedSessions,
      current: currentSession.id,
      loading: false,
    });

    if (currentSession.directory) {
      worktreeClient.cleanup(currentSession.directory).catch((err) => {
        logger.debug("[Init] Worktree cleanup failed (non-critical):", err);
      });
    }

    await loadSessionMessages(currentSession.id);
  };

  // Switch session
  const handleSelectSession = async (sessionId: string) => {
    logger.debug("[SelectSession] Switching to session:", sessionId);
    setSessionStore("current", sessionId);
    if (isMobile()) {
      setIsSidebarOpen(false); // Close sidebar on mobile selection
    }

    // If messages for this session are not loaded yet, load them
    if (!messageStore.message[sessionId]) {
      await loadSessionMessages(sessionId);
    } else {
      setTimeout(scrollToBottom, 100);
    }
  };

  const handleNewSession = () => {
    setNewSessionDialogOpen(true);
  };

  const handleCreateSession = async (options: {
    title: string;
    isolated: boolean;
    branchName?: string;
  }) => {
    logger.debug("[CreateSession] Creating session with options:", options);

    const newSession = await client.createSession(options.title);
    logger.debug("[CreateSession] Created:", newSession);

    const processedSession: SessionInfo = {
      id: newSession.id,
      title: newSession.title || options.title,
      directory: newSession.directory || "",
      parentID: newSession.parentID,
      createdAt: new Date(newSession.time.created).toISOString(),
      updatedAt: new Date(newSession.time.updated).toISOString(),
      summary: newSession.summary,
    };

    if (options.isolated && options.branchName && processedSession.directory) {
      try {
        const worktreeInfo = await worktreeClient.create(
          processedSession.directory,
          options.branchName,
          processedSession.id
        );
        processedSession.worktree = worktreeInfo;
        logger.debug("[CreateSession] Worktree created:", worktreeInfo);
      } catch (error) {
        logger.error("[CreateSession] Failed to create worktree:", error);
      }
    }

    setSessionStore("list", (list) => [processedSession, ...list]);
    setSessionStore("current", processedSession.id);
    setNewSessionDialogOpen(false);

    if (isMobile()) {
      setIsSidebarOpen(false);
    }

    setMessageStore("message", processedSession.id, []);
    setTimeout(scrollToBottom, 100);
  };

  const handleWorktreeMerge = (session: SessionInfo) => {
    setSelectedWorktreeSession(session);
    setMergeDialogOpen(true);
  };

  const handleWorktreePush = (session: SessionInfo) => {
    setSelectedWorktreeSession(session);
    setPushDialogOpen(true);
  };

  const handleWorktreeAbandon = (session: SessionInfo) => {
    setSelectedWorktreeSession(session);
    setAbandonDialogOpen(true);
  };

  const handleMergeConfirm = async (commitMessage: string) => {
    const session = selectedWorktreeSession();
    if (!session?.worktree?.path || !session.directory) return;

    await worktreeClient.merge(session.worktree.path, session.directory, {
      squash: true,
      commitMessage,
    });

    setSessionStore("list", (list) =>
      list.map((s) =>
        s.id === session.id ? { ...s, worktree: undefined } : s
      )
    );
    setMergeDialogOpen(false);
    setSelectedWorktreeSession(null);
    logger.debug("[Worktree] Merged and cleaned up:", session.id);
  };

  const handlePushConfirm = async (newBranchName?: string) => {
    const session = selectedWorktreeSession();
    if (!session?.worktree?.path) return;

    const result = await worktreeClient.push(session.worktree.path, newBranchName);
    logger.debug("[Worktree] Pushed to remote:", result.remoteBranch);

    setPushDialogOpen(false);
    setSelectedWorktreeSession(null);
  };

  const handleAbandonConfirm = async () => {
    const session = selectedWorktreeSession();
    if (!session?.worktree?.path || !session.directory) return;

    await worktreeClient.abandon(session.worktree.path, session.directory);

    setSessionStore("list", (list) =>
      list.map((s) =>
        s.id === session.id ? { ...s, worktree: undefined } : s
      )
    );
    setAbandonDialogOpen(false);
    setSelectedWorktreeSession(null);
    logger.debug("[Worktree] Abandoned:", session.id);
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
    Auth.isLocalAccess().then(setIsLocalHost);

    const cleanup = client.connectSSE(handleSSEEvent);
    onCleanup(cleanup);
  });

  return (
    <div class="flex h-screen bg-gray-50/50 dark:bg-zinc-950 font-sans text-gray-900 dark:text-gray-100 overflow-hidden relative">

      {/* Mobile Sidebar Overlay */}
      <Show when={isMobile() && isSidebarOpen()}>
        <div
          class="absolute inset-0 bg-black/50 z-20 backdrop-blur-sm"
          onClick={toggleSidebar}
        />
      </Show>

      {/* Sidebar - Desktop: Static, Mobile: Drawer */}
      <aside
        class={`
          fixed md:static inset-y-0 left-0 z-30 w-72 bg-gray-50 dark:bg-zinc-950 border-r border-gray-200 dark:border-zinc-800 transform transition-transform duration-300 ease-in-out flex flex-col justify-between
          ${isSidebarOpen() ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        <div class="flex flex-col h-full overflow-hidden">
          <Show when={!sessionStore.loading}>
            <SessionSidebar
              sessions={sessionStore.list}
              currentSessionId={sessionStore.current}
              onSelectSession={handleSelectSession}
              onNewSession={handleNewSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onWorktreeMerge={handleWorktreeMerge}
              onWorktreePush={handleWorktreePush}
              onWorktreeAbandon={handleWorktreeAbandon}
            />
          </Show>
        </div>

        {/* User Actions Footer in Sidebar */}
        <div class="p-3 border-t border-gray-200 dark:border-zinc-800 space-y-1 bg-gray-50 dark:bg-zinc-950">
          <Show when={isLocalHost()}>
            <button
              onClick={() => navigate("/")}
              class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-sm hover:shadow"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>
              {t().chat.remoteAccess}
            </button>
          </Show>
          <button
            onClick={() => navigate("/settings")}
            class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-sm hover:shadow"
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
      <div class="flex-1 flex flex-col overflow-hidden min-w-0 bg-white dark:bg-zinc-900">

        {/* Header */}
        <header class="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-zinc-800/50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-10">
          <div class="flex items-center gap-3">
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
              <div class="p-4 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-sm border-t border-gray-100 dark:border-zinc-800 relative z-20">
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

      <NewSessionDialog
        isOpen={newSessionDialogOpen()}
        projectPath={sessionStore.list.find((s) => s.id === sessionStore.current)?.directory || ""}
        onClose={() => setNewSessionDialogOpen(false)}
        onCreate={handleCreateSession}
      />

      <MergeDialog
        isOpen={mergeDialogOpen()}
        worktree={selectedWorktreeSession()?.worktree || null}
        onClose={() => {
          setMergeDialogOpen(false);
          setSelectedWorktreeSession(null);
        }}
        onMerge={handleMergeConfirm}
      />

      <PushDialog
        isOpen={pushDialogOpen()}
        worktree={selectedWorktreeSession()?.worktree || null}
        onClose={() => {
          setPushDialogOpen(false);
          setSelectedWorktreeSession(null);
        }}
        onPush={handlePushConfirm}
      />

      <AbandonDialog
        isOpen={abandonDialogOpen()}
        worktree={selectedWorktreeSession()?.worktree || null}
        onClose={() => {
          setAbandonDialogOpen(false);
          setSelectedWorktreeSession(null);
        }}
        onAbandon={handleAbandonConfirm}
      />
    </div>
  );
}

