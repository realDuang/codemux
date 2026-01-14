import { createEffect, createSignal, Show, For, createMemo } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { client } from "../lib/opencode-client";
import { configStore, setConfigStore } from "../stores/config";
import { Config } from "../types/opencode";

export default function Settings() {
  const navigate = useNavigate();
  const [selectedProviderID, setSelectedProviderID] = createSignal<string>("");
  const [selectedModelID, setSelectedModelID] = createSignal<string>("");
  const [saving, setSaving] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const loadConfig = async () => {
    console.log("[Settings] Loading providers from OpenCode API");
    setConfigStore("loading", true);

    try {
      const providerData = await client.getProviders();
      console.log("[Settings] Loaded providers:", providerData);

      setConfigStore("providers", providerData.all);

      // 从localStorage读取默认设置
      const defaultModel = client.getDefaultModel();
      if (defaultModel) {
        setSelectedProviderID(defaultModel.providerID);
        setSelectedModelID(defaultModel.modelID);
        setConfigStore("currentProviderID", defaultModel.providerID);
        setConfigStore("currentModelID", defaultModel.modelID);
      } else if (providerData.all.length > 0) {
        // 如果没有保存的设置，使用第一个provider的第一个模型
        const firstProvider = providerData.all[0];
        const firstModelKey = Object.keys(firstProvider.models)[0];
        if (firstModelKey) {
          setSelectedProviderID(firstProvider.id);
          setSelectedModelID(firstModelKey);
        }
      }

      setConfigStore("loading", false);
    } catch (error) {
      console.error("[Settings] Failed to load providers:", error);
      setConfigStore("loading", false);
      setSaveStatus({
        type: "error",
        message: "无法加载Provider列表，请确保OpenCode服务正在运行",
      });
    }
  };

  const handleProviderChange = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    const providerId = target.value;
    console.log("[Settings] Provider changed to:", providerId);
    setSelectedProviderID(providerId);

    // 当provider改变时，自动选择该provider的第一个模型
    const provider = configStore.providers.find((p) => p.id === providerId);
    if (provider) {
      const firstModelKey = Object.keys(provider.models)[0];
      if (firstModelKey) {
        setSelectedModelID(firstModelKey);
      }
    }
  };

  const handleModelChange = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    setSelectedModelID(target.value);
  };

  const handleSave = async () => {
    console.log("[Settings] Saving configuration");
    setSaving(true);
    setSaveStatus(null);

    try {
      const providerID = selectedProviderID();
      const modelID = selectedModelID();

      console.log("[Settings] Saving default model:", {
        providerID,
        modelID,
      });

      // 保存到localStorage
      client.setDefaultModel(providerID, modelID);

      setConfigStore("currentProviderID", providerID);
      setConfigStore("currentModelID", modelID);

      setSaveStatus({ type: "success", message: "设置保存成功" });

      // 1.5秒后返回聊天页面
      setTimeout(() => {
        navigate("/chat");
      }, 1500);
    } catch (error) {
      console.error("[Settings] Failed to save config:", error);
      setSaveStatus({ type: "error", message: "保存失败，请重试" });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    navigate("/chat");
  };

  createEffect(() => {
    loadConfig();
  });

  // 获取当前选中provider及其模型列表
  const currentProvider = createMemo(() => {
    return configStore.providers.find((p) => p.id === selectedProviderID());
  });

  const availableModels = createMemo(() => {
    const provider = currentProvider();
    if (!provider) return [];
    return Object.values(provider.models);
  });

  // 获取模型的显示名称
  const getModelLabel = (model: Config.Model) => {
    const info = [];
    if (model.capabilities.reasoning) info.push("推理");
    if (model.limit.context) {
      info.push(`${(model.limit.context / 1000).toFixed(0)}K`);
    }
    return `${model.name} ${info.length > 0 ? `(${info.join(", ")})` : ""}`;
  };

  return (
    <div class="flex h-screen bg-gray-50 dark:bg-zinc-900">
      <div class="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header class="flex items-center justify-between px-6 py-4 bg-white dark:bg-zinc-800 border-b dark:border-zinc-700">
          <div class="flex items-center gap-4">
            <button
              onClick={handleCancel}
              class="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
            >
              ← 返回
            </button>
            <h1 class="text-xl font-bold text-gray-800 dark:text-white">
              模型设置
            </h1>
          </div>
        </header>

        {/* Main Content */}
        <main class="flex-1 overflow-y-auto">
          <div class="max-w-2xl mx-auto px-6 py-8">
            <Show
              when={!configStore.loading}
              fallback={
                <div class="flex items-center justify-center py-12">
                  <div class="text-gray-600 dark:text-gray-400">
                    加载配置中...
                  </div>
                </div>
              }
            >
              <Show
                when={configStore.providers.length > 0}
                fallback={
                  <div class="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
                    <h3 class="text-yellow-800 dark:text-yellow-200 font-semibold mb-2">
                      无可用Provider
                    </h3>
                    <p class="text-yellow-700 dark:text-yellow-300 text-sm">
                      请确保OpenCode服务正常运行，并且已经配置了至少一个AI服务提供商。
                    </p>
                  </div>
                }
              >
                {/* Provider Selection */}
                <div class="bg-white dark:bg-zinc-800 rounded-lg shadow-sm border dark:border-zinc-700 p-6 mb-6">
                  <label class="block">
                    <span class="text-lg font-semibold text-gray-800 dark:text-white mb-2 block">
                      AI服务提供商
                    </span>
                    <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
                      选择你要使用的AI服务提供商（新会话将使用此设置）
                    </p>

                    <select
                      value={selectedProviderID()}
                      onChange={handleProviderChange}
                      class="w-full px-4 py-3 bg-white dark:bg-zinc-900 border border-gray-300 dark:border-zinc-600 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                    >
                      <option value="" disabled>
                        请选择Provider...
                      </option>
                      <For each={configStore.providers}>
                        {(provider) => (
                          <option value={provider.id}>
                            {provider.name} ({Object.keys(provider.models).length}{" "}
                            个模型)
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                </div>

                {/* Model Selection */}
                <Show when={selectedProviderID() && currentProvider()}>
                  <div class="bg-white dark:bg-zinc-800 rounded-lg shadow-sm border dark:border-zinc-700 p-6 mb-6">
                    <label class="block">
                      <span class="text-lg font-semibold text-gray-800 dark:text-white mb-2 block">
                        AI模型
                      </span>
                      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
                        选择具体的AI模型（新会话将使用此模型）
                      </p>

                      <Show
                        when={availableModels().length > 0}
                        fallback={
                          <div class="text-gray-600 dark:text-gray-400 text-center py-4">
                            该Provider暂无可用模型
                          </div>
                        }
                      >
                        <select
                          value={selectedModelID()}
                          onChange={handleModelChange}
                          class="w-full px-4 py-3 bg-white dark:bg-zinc-900 border border-gray-300 dark:border-zinc-600 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        >
                          <option value="" disabled>
                            请选择模型...
                          </option>
                          <For each={availableModels()}>
                            {(model) => (
                              <option value={model.id}>
                                {getModelLabel(model)}
                              </option>
                            )}
                          </For>
                        </select>

                        {/* Model Details */}
                        <Show when={selectedModelID()}>
                          {(() => {
                            const model = availableModels().find(
                              (m) => m.id === selectedModelID(),
                            );
                            if (!model) return null;

                            return (
                              <div class="mt-4 p-4 bg-gray-50 dark:bg-zinc-900 rounded-lg text-sm">
                                <div class="grid grid-cols-2 gap-3">
                                  <div>
                                    <span class="text-gray-500 dark:text-gray-400">
                                      上下文:
                                    </span>
                                    <span class="ml-2 text-gray-900 dark:text-white font-medium">
                                      {(model.limit.context / 1000).toFixed(0)}K
                                    </span>
                                  </div>
                                  <div>
                                    <span class="text-gray-500 dark:text-gray-400">
                                      输出限制:
                                    </span>
                                    <span class="ml-2 text-gray-900 dark:text-white font-medium">
                                      {(model.limit.output / 1000).toFixed(0)}K
                                    </span>
                                  </div>
                                  <div>
                                    <span class="text-gray-500 dark:text-gray-400">
                                      推理能力:
                                    </span>
                                    <span class="ml-2 text-gray-900 dark:text-white font-medium">
                                      {model.capabilities.reasoning ? "✓" : "✗"}
                                    </span>
                                  </div>
                                  <div>
                                    <span class="text-gray-500 dark:text-gray-400">
                                      支持附件:
                                    </span>
                                    <span class="ml-2 text-gray-900 dark:text-white font-medium">
                                      {model.capabilities.attachment ? "✓" : "✗"}
                                    </span>
                                  </div>
                                  <Show
                                    when={model.cost.input > 0 || model.cost.output > 0}
                                  >
                                    <div class="col-span-2">
                                      <span class="text-gray-500 dark:text-gray-400">
                                        成本:
                                      </span>
                                      <span class="ml-2 text-gray-900 dark:text-white font-medium">
                                        输入 ${model.cost.input}/1M · 输出 $
                                        {model.cost.output}/1M
                                      </span>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            );
                          })()}
                        </Show>
                      </Show>
                    </label>
                  </div>
                </Show>

                {/* Save Status */}
                <Show when={saveStatus()}>
                  <div
                    class={`p-4 rounded-lg mb-6 ${
                      saveStatus()?.type === "success"
                        ? "bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800"
                        : "bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800"
                    }`}
                  >
                    {saveStatus()?.message}
                  </div>
                </Show>

                {/* Action Buttons */}
                <div class="flex gap-4">
                  <button
                    onClick={handleSave}
                    disabled={
                      saving() || !selectedProviderID() || !selectedModelID()
                    }
                    class="flex-1 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
                  >
                    {saving() ? "保存中..." : "保存为默认设置"}
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={saving()}
                    class="px-6 py-3 bg-gray-200 hover:bg-gray-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-gray-700 dark:text-gray-300 font-medium rounded-lg transition-colors disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>

                {/* Info Box */}
                <div class="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <h3 class="text-blue-800 dark:text-blue-200 font-semibold mb-2 text-sm">
                    💡 使用说明
                  </h3>
                  <ul class="text-blue-700 dark:text-blue-300 text-sm space-y-1">
                    <li>• 此设置将作为创建新会话时的默认模型</li>
                    <li>• 已有的会话不受影响，保持原有模型配置</li>
                    <li>• 设置保存在浏览器本地存储中</li>
                    <li>
                      • 在聊天页面可以随时切换当前会话使用的模型
                    </li>
                  </ul>
                </div>
              </Show>
            </Show>
          </div>
        </main>
      </div>
    </div>
  );
}
