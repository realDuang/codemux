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
import { sessionStore, setSessionStore } from "../stores/session";
import {
  messageStore,
  setMessageStore,
} from "../stores/message";
import { MessageList } from "../components/MessageList";
import { PromptInput } from "../components/PromptInput";
import { SessionSidebar } from "../components/SessionSidebar";
import { ModelSelector } from "../components/ModelSelector";
import { MessageV2 } from "../types/opencode";

export default function Chat() {
  const navigate = useNavigate();
  const [sending, setSending] = createSignal(false);
  const [messagesRef, setMessagesRef] = createSignal<HTMLDivElement>();
  const [loadingMessages, setLoadingMessages] = createSignal(false);
  // 初始化时从 localStorage 读取保存的模型
  const [currentSessionModel, setCurrentSessionModel] = createSignal<{
    providerID: string;
    modelID: string;
  } | null>(client.getDefaultModel());

  // Mobile Sidebar State
  const [isSidebarOpen, setIsSidebarOpen] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(window.innerWidth < 768);

  const handleModelChange = (providerID: string, modelID: string) => {
    console.log("[Chat] Model changed to:", { providerID, modelID });
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

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen());
  };

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

  // 加载指定会话的消息
  const loadSessionMessages = async (sessionId: string) => {
    console.log("[LoadMessages] Loading messages for session:", sessionId);
    setLoadingMessages(true);

    const messages = await client.getMessages(sessionId);
    console.log("[LoadMessages] Loaded messages:", messages);

    // 按照 opencode desktop 的方式：分别存储 message info 和 parts
    const messageInfos: MessageV2.Info[] = [];

    for (const msg of messages) {
      // API 返回的格式是 { info: {...}, parts: [...] }
      const msgInfo = (msg as any).info || msg;
      const msgParts = (msg as any).parts || [];

      // 存储 message info（不包含 parts）
      messageInfos.push(msgInfo);

      // 单独存储 parts，按 id 排序
      const sortedParts = msgParts.slice().sort((a: any, b: any) =>
        a.id.localeCompare(b.id)
      );
      setMessageStore("part", msgInfo.id, sortedParts);
    }

    // 存储所有 messages，按 id 排序
    const sortedMessages = messageInfos.slice().sort((a, b) =>
      a.id.localeCompare(b.id)
    );
    setMessageStore("message", sessionId, sortedMessages);

    setLoadingMessages(false);
    setTimeout(scrollToBottom, 100);
  };

  const initializeSession = async () => {
    console.log("[Init] Starting session initialization");
    setSessionStore({ loading: true });

    const sessions = await client.listSessions();
    console.log("[Init] Loaded sessions:", sessions);

    // 处理会话列表，将时间戳转换为 ISO 字符串
    const processedSessions = sessions.map((s) => ({
      id: s.id,
      title: s.title || "新会话",
      directory: s.directory || "",
      parentID: s.parentID,
      createdAt: new Date(s.time.created).toISOString(),
      updatedAt: new Date(s.time.updated).toISOString(),
      summary: s.summary,
    }));

    let currentSession = processedSessions[0];
    if (!currentSession) {
      console.log("[Init] No sessions found, creating new one");
      const newSession = await client.createSession("新会话");
      currentSession = {
        id: newSession.id,
        title: newSession.title || "新会话",
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

    await loadSessionMessages(currentSession.id);
  };

  // 切换会话
  const handleSelectSession = async (sessionId: string) => {
    console.log("[SelectSession] Switching to session:", sessionId);
    setSessionStore("current", sessionId);
    if (isMobile()) {
      setIsSidebarOpen(false); // Close sidebar on mobile selection
    }

    // 如果该会话的消息还没加载过，则加载
    if (!messageStore.message[sessionId]) {
      await loadSessionMessages(sessionId);
    } else {
      setTimeout(scrollToBottom, 100);
    }
  };

  // 新建会话
  const handleNewSession = async () => {
    console.log("[NewSession] Creating new session");
    const newSession = await client.createSession("新会话");
    console.log("[NewSession] Created:", newSession);

    const processedSession = {
      id: newSession.id,
      title: newSession.title || "新会话",
      directory: newSession.directory || "",
      parentID: newSession.parentID,
      createdAt: new Date(newSession.time.created).toISOString(),
      updatedAt: new Date(newSession.time.updated).toISOString(),
      summary: newSession.summary,
    };

    setSessionStore("list", (list) => [processedSession, ...list]);
    setSessionStore("current", processedSession.id);
    if (isMobile()) {
      setIsSidebarOpen(false); // Close sidebar on mobile
    }

    // 初始化空消息数组
    setMessageStore("message", processedSession.id, []);
    setTimeout(scrollToBottom, 100);
  };

  // 删除会话
  const handleDeleteSession = async (sessionId: string) => {
    console.log("[DeleteSession] Deleting session:", sessionId);

    await client.deleteSession(sessionId);

    // 从列表中移除
    setSessionStore("list", (list) => list.filter((s) => s.id !== sessionId));

    // 如果删除的是当前会话，切换到第一个会话
    if (sessionStore.current === sessionId) {
      const remaining = sessionStore.list.filter((s) => s.id !== sessionId);
      if (remaining.length > 0) {
        await handleSelectSession(remaining[0].id);
      } else {
        // 没有会话了，创建一个新的
        await handleNewSession();
      }
    }
  };

  const handleSSEEvent = (event: { type: string; data: any }) => {
    // console.log("[SSE] Event received:", event.type, event.data); // Reduce noise

    const sessionId = sessionStore.current;
    if (!sessionId) return;

    // 按照 opencode desktop 的实现处理事件
    if (event.type === "message.part.updated") {
      const part = event.data as MessageV2.Part;
      const messageId = part.messageID;

      // 获取或初始化 parts 数组
      const parts = messageStore.part[messageId] || [];

      // 使用二分查找找到插入/更新位置（保持按 id 排序）
      const index = binarySearch(parts, part.id, (p) => p.id);

      if (index.found) {
        // 更新现有 part
        setMessageStore("part", messageId, index.index, part);
      } else {
        // 插入新 part（保持排序）
        // 如果该 messageId 的 parts 数组不存在，先初始化
        if (!messageStore.part[messageId]) {
          setMessageStore("part", messageId, [part]);
        } else {
          setMessageStore("part", messageId, (draft) => {
            const newParts = [...draft];
            newParts.splice(index.index, 0, part);
            return newParts;
          });
        }
      }

      setTimeout(scrollToBottom, 0);
    }

    if (event.type === "message.updated") {
      const msgInfo = event.data as MessageV2.Info;

      // 获取或初始化 messages 数组
      const messages = messageStore.message[sessionId] || [];

      // 使用二分查找找到插入/更新位置
      const index = binarySearch(messages, msgInfo.id, (m) => m.id);

      if (index.found) {
        // 更新现有 message
        setMessageStore("message", sessionId, index.index, msgInfo);
      } else {
        // 插入新 message（保持排序）
        // 如果该 sessionId 的 messages 数组不存在，先初始化
        if (!messageStore.message[sessionId]) {
          setMessageStore("message", sessionId, [msgInfo]);
        } else {
          setMessageStore("message", sessionId, (draft) => {
            const newMessages = [...draft];
            newMessages.splice(index.index, 0, msgInfo);
            return newMessages;
          });
        }
      }
    }

    if (event.type === "session.updated") {
      const updated = event.data;
      setSessionStore("list", (list) =>
        list.map((s) =>
          s.id === updated.id
            ? {
              ...s,
              id: updated.id,
              title: updated.title || "新会话",
              directory: updated.directory || s.directory || "",
              createdAt: new Date(updated.time.created).toISOString(),
              updatedAt: new Date(updated.time.updated).toISOString(),
            }
            : s,
        ),
      );
    }
  };

  // 二分查找辅助函数（与 opencode desktop 一致）
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

  const handleSendMessage = async (text: string, mode?: "build" | "plan") => {
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
      parts: [],  // Info 不包含 parts
    };

    const tempPart: MessageV2.Part = {
      id: tempPartId,
      messageID: tempMessageId,
      sessionID: sessionId,
      type: "text",
      text,
    };

    // 按照 opencode desktop 的方式存储
    const messages = messageStore.message[sessionId] || [];

    // 插入消息（保持排序）
    const msgIndex = binarySearch(messages, tempMessageId, (m) => m.id);
    if (!msgIndex.found) {
      setMessageStore("message", sessionId, (draft) => {
        const newMessages = [...draft];
        newMessages.splice(msgIndex.index, 0, tempMessageInfo);
        return newMessages;
      });
    }

    // 插入 part
    setMessageStore("part", tempMessageId, [tempPart]);
    setTimeout(scrollToBottom, 0);

    const model = currentSessionModel();
    await client.sendMessage(sessionId, text, {
      mode,
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
            />
          </Show>
        </div>

        {/* User Actions Footer in Sidebar */}
        <div class="p-3 border-t border-gray-200 dark:border-zinc-800 space-y-1 bg-gray-50 dark:bg-zinc-950">
          <button
            onClick={() => navigate("/remote")}
            class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-sm hover:shadow"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>
            远程访问
          </button>
          <button
            onClick={() => navigate("/settings")}
            class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-white rounded-lg transition-all shadow-sm hover:shadow"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
            设置
          </button>
          <button
            onClick={handleLogout}
            class="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" /></svg>
            退出登录
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
              {sessionStore.list.find(s => s.id === sessionStore.current)?.title || "OpenCode Remote"}
            </h1>
          </div>
          <div class="flex items-center gap-2">
            <ModelSelector onModelChange={handleModelChange} />
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
                          开始新的对话
                        </h2>
                        <p class="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto">
                          选择一个模型，在下方输入框中输入任何问题开始聊天。
                        </p>
                      </div>
                    }
                  >
                    <MessageList sessionID={sessionStore.current!} />
                  </Show>
                </div>
              </div>

              {/* Input Area */}
              <div class="p-4 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-sm border-t border-gray-100 dark:border-zinc-800">
                <div class="max-w-3xl mx-auto w-full">
                  <PromptInput onSend={handleSendMessage} disabled={sending()} />
                  <div class="mt-2 text-center">
                    <p class="text-[10px] text-gray-400 dark:text-gray-600">
                      AI 生成的内容可能不准确，请核实重要信息。
                    </p>
                  </div>
                </div>
              </div>
            </Show>
          </Show>
        </main>
      </div>
    </div>
  );
}

