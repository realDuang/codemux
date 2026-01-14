import { For, Show, createSignal } from "solid-js";
import { SessionInfo } from "../stores/session";
import { configStore } from "../stores/config";
import { Config } from "../types/opencode";

interface SessionSidebarProps {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (modelID?: string, providerID?: string) => void;
  onDeleteSession: (sessionId: string) => void;
}

export function SessionSidebar(props: SessionSidebarProps) {
  const [showModelDialog, setShowModelDialog] = createSignal(false);
  const [selectedProvider, setSelectedProvider] = createSignal<string>("");
  const [selectedModel, setSelectedModel] = createSignal<string>("");

  // 过滤出已连接的 providers 和 models
  const connectedProviders = () => {
    // 获取已连接的 provider IDs
    const connectedIDs = new Set(configStore.connectedProviderIDs);

    return configStore.providers
      .filter((provider) => {
        // 只保留已连接（有认证）的 providers
        return connectedIDs.has(provider.id);
      })
      .filter((provider) => {
        // 确保 provider 至少有一个可用模型
        return Object.keys(provider.models).length > 0;
      });
  };

  const handleNewSessionClick = () => {
    const providers = connectedProviders();
    if (providers.length === 0) {
      alert("没有可用的已连接模型，请先在设置中配置服务器");
      return;
    }

    // 默认选择第一个 provider 和第一个 model
    const firstProvider = providers[0];
    const firstModelID = Object.keys(firstProvider.models)[0];
    setSelectedProvider(firstProvider.id);
    setSelectedModel(firstModelID);
    setShowModelDialog(true);
  };

  const handleCreateSession = () => {
    const providerID = selectedProvider();
    const modelID = selectedModel();
    if (providerID && modelID) {
      props.onNewSession(modelID, providerID);
      setShowModelDialog(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "刚刚";
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;

    return date.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
    });
  };

  return (
    <>
      <div class="w-full md:w-64 bg-gray-50 dark:bg-zinc-950 border-r border-gray-200 dark:border-zinc-800 flex flex-col h-full">
        {/* 头部 */}
        <div class="p-3 border-b border-gray-200 dark:border-zinc-800 flex items-center h-14 bg-gray-50/50 dark:bg-zinc-950/50 backdrop-blur-sm">
           <button
            onClick={handleNewSessionClick}
            class="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg text-sm font-medium transition-colors shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            新建会话
          </button>
        </div>

        {/* 会话列表 */}
        <div class="flex-1 overflow-y-auto px-2 py-2">
           <div class="text-xs font-semibold text-gray-500 dark:text-gray-400 px-3 py-2 mb-1 uppercase tracking-wider">
              历史会话
           </div>
          <Show
            when={props.sessions.length > 0}
            fallback={
              <div class="p-8 text-center">
                 <div class="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-100 dark:bg-zinc-800 mb-3 text-gray-400">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                 </div>
                 <p class="text-sm text-gray-500 dark:text-gray-400">暂无会话</p>
              </div>
            }
          >
            <For each={props.sessions}>
              {(session) => {
                const isActive = () => session.id === props.currentSessionId;

                return (
                  <div
                    class={`group relative px-3 py-2.5 mb-1 rounded-lg cursor-pointer transition-all duration-200 border border-transparent ${
                      isActive()
                        ? "bg-white dark:bg-zinc-800 border-gray-200 dark:border-zinc-700 shadow-sm"
                        : "hover:bg-gray-100 dark:hover:bg-zinc-900"
                    }`}
                    onClick={() => props.onSelectSession(session.id)}
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex-1 min-w-0 pr-6 relative">
                        <div
                          class={`text-sm font-medium truncate ${
                            isActive()
                              ? "text-gray-900 dark:text-gray-100"
                              : "text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-200"
                          }`}
                        >
                          {session.title || "未命名会话"}
                        </div>
                        <div class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 font-medium">
                          {formatDate(session.updatedAt)}
                        </div>
                      </div>

                      {/* 删除按钮 */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm("确定要删除这个会话吗？")) {
                            props.onDeleteSession(session.id);
                          }
                        }}
                        class="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all"
                        title="删除会话"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg" 
                          width="14" 
                          height="14" 
                          viewBox="0 0 24 24" 
                          fill="none" 
                          stroke="currentColor" 
                          stroke-width="2" 
                          stroke-linecap="round" 
                          stroke-linejoin="round"
                        >
                          <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </div>

      {/* 模型选择对话框 */}
      <Show when={showModelDialog()}>
        <div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div class="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-gray-200 dark:border-zinc-800 w-full max-w-md overflow-hidden transform transition-all scale-100 opacity-100">
            <div class="px-5 py-4 border-b border-gray-100 dark:border-zinc-800">
              <h2 class="text-lg font-semibold text-gray-800 dark:text-white">
                选择模型
              </h2>
            </div>

            <div class="p-2 max-h-[60vh] overflow-y-auto">
              <Show
                when={connectedProviders().length > 0}
                fallback={
                  <div class="p-8 text-center">
                    <p class="text-gray-500 dark:text-gray-400 mb-4">没有可用的已连接模型</p>
                    <a href="/settings" class="text-blue-600 hover:underline text-sm">前往设置添加模型</a>
                  </div>
                }
              >
                <For each={connectedProviders()}>
                  {(provider) => (
                    <div class="mb-2 last:mb-0">
                      <div class="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider sticky top-0 bg-white dark:bg-zinc-900 z-10">
                        {provider.name}
                      </div>
                      <div class="space-y-1 px-2">
                        <For each={Object.values(provider.models)}>
                          {(model) => (
                            <label 
                              class={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all border ${
                                selectedProvider() === provider.id && selectedModel() === model.id
                                  ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
                                  : "hover:bg-gray-50 dark:hover:bg-zinc-800 border-transparent"
                              }`}
                            >
                              <div class="pt-1">
                                <input
                                  type="radio"
                                  name="model"
                                  checked={
                                    selectedProvider() === provider.id &&
                                    selectedModel() === model.id
                                  }
                                  onChange={() => {
                                    setSelectedProvider(provider.id);
                                    setSelectedModel(model.id);
                                  }}
                                  class="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                                />
                              </div>
                              <div class="flex-1">
                                <div class={`font-medium text-sm ${
                                   selectedProvider() === provider.id && selectedModel() === model.id
                                    ? "text-blue-700 dark:text-blue-300" 
                                    : "text-gray-700 dark:text-gray-300"
                                }`}>
                                  {model.name}
                                </div>
                                <div class="flex items-center gap-2 mt-1">
                                   <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400">
                                      {(model.limit.context / 1000).toFixed(0)}k
                                   </span>
                                   <Show when={model.capabilities.reasoning}>
                                      <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400">
                                        推理
                                      </span>
                                   </Show>
                                </div>
                              </div>
                            </label>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <div class="p-4 border-t border-gray-100 dark:border-zinc-800 flex gap-3 bg-gray-50/50 dark:bg-zinc-900/50">
              <button
                onClick={() => setShowModelDialog(false)}
                class="flex-1 px-4 py-2.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreateSession}
                class="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors shadow-sm"
              >
                开始对话
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
