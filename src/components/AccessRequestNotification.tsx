import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { Auth, type PendingRequest } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { isElectron } from "../lib/platform";

export function AccessRequestNotification() {
  const { t } = useI18n();
  const [requests, setRequests] = createSignal<PendingRequest[]>([]);
  const [isHost, setIsHost] = createSignal(false);
  const [processingIds, setProcessingIds] = createSignal<Set<string>>(new Set());
  const [feedback, setFeedback] = createSignal<Record<string, "approved" | "denied" | null>>({});

  let pollInterval: Timer | null = null;

  onMount(async () => {
    // Host mode: Electron OR localhost web access can see and handle approval notifications
    let hostMode = isElectron();
    
    if (!hostMode) {
      // Check if this is localhost web access
      hostMode = await Auth.isLocalAccess();
    }
    
    setIsHost(hostMode);

    if (hostMode) {
      fetchRequests();
      pollInterval = setInterval(fetchRequests, 3000);
    }
  });

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  const fetchRequests = async () => {
    try {
      const pending = await Auth.getPendingRequests();
      setRequests((prev) => {
        const processing = new Set(processingIds());
        const newIds = new Set(pending.map(r => r.id));

        const keptProcessing = prev.filter(r => processing.has(r.id) && !newIds.has(r.id));

        return [...pending, ...keptProcessing];
      });
    } catch (err) {
      console.error("Failed to fetch pending requests", err);
    }
  };

  const handleApprove = async (id: string) => {
    setProcessingIds(prev => new Set(prev).add(id));
    
    const success = await Auth.approveRequest(id);
    
    if (success) {
      setFeedback(prev => ({ ...prev, [id]: "approved" }));
      setTimeout(() => removeRequest(id), 1500);
    } else {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDeny = async (id: string) => {
    setProcessingIds(prev => new Set(prev).add(id));
    
    const success = await Auth.denyRequest(id);
    
    if (success) {
      setFeedback(prev => ({ ...prev, [id]: "denied" }));
      setTimeout(() => removeRequest(id), 1500);
    } else {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const removeRequest = (id: string) => {
    setRequests(prev => prev.filter(r => r.id !== id));
    setProcessingIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setFeedback(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  return (
    <Show when={isHost() && requests().length > 0}>
      <div 
        class="fixed bottom-6 right-6 z-50 flex flex-col gap-4 w-96 max-w-[calc(100vw-3rem)] font-sans"
      >
        <For each={requests()}>
          {(req) => (
            <div 
              class="relative bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-gray-100 dark:border-zinc-800 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300"
              classList={{
                "pointer-events-none": processingIds().has(req.id)
              }}
            >
              <Show when={feedback()[req.id]}>
                <div 
                  class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-white/90 dark:bg-zinc-900/95 backdrop-blur-xs transition-opacity duration-300"
                >
                  <Show 
                    when={feedback()[req.id] === "approved"}
                    fallback={
                      <div class="flex flex-col items-center text-red-500">
                        <div class="rounded-full bg-red-100 dark:bg-red-900/30 p-3 mb-2">
                          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                          </svg>
                        </div>
                        <span class="font-medium">{t().approval.requestDenied}</span>
                      </div>
                    }
                  >
                    <div class="flex flex-col items-center text-green-600 dark:text-green-500">
                      <div class="rounded-full bg-green-100 dark:bg-green-900/30 p-3 mb-2">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </div>
                      <span class="font-medium">{t().approval.requestApproved}</span>
                    </div>
                  </Show>
                </div>
              </Show>

              <div class="p-5">
                <div class="flex items-start justify-between mb-4">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center text-blue-600 dark:text-blue-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect width="16" height="10" x="2" y="7" rx="2" ry="2"/><line x1="12" x2="12" y1="17" y2="21"/><path d="M2 7h20"/><path d="M12 21a2 2 0 0 0 2-2"/>
                      </svg>
                    </div>
                    <div>
                      <h3 class="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-tight">
                        {t().approval.newRequestTitle}
                      </h3>
                      <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {new Date(req.createdAt).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                  <div class="px-2 py-1 rounded text-[10px] font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-500 uppercase tracking-wider">
                    New
                  </div>
                </div>

                <div class="space-y-2 mb-5">
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-gray-500 dark:text-gray-400">{t().approval.deviceName}:</span>
                    <span class="font-medium text-gray-900 dark:text-gray-200 truncate max-w-[180px]" title={req.device.name}>
                      {req.device.name}
                    </span>
                  </div>
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-gray-500 dark:text-gray-400">{t().approval.platform}:</span>
                    <span class="font-medium text-gray-900 dark:text-gray-200">
                      {req.device.platform} • {req.device.browser}
                    </span>
                  </div>
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-gray-500 dark:text-gray-400">{t().approval.ipAddress}:</span>
                    <span class="font-mono text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                      {req.ip}
                    </span>
                  </div>
                </div>

                <div class="flex gap-3">
                  <button
                    onClick={() => handleDeny(req.id)}
                    class="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-gray-600"
                  >
                    {t().approval.deny}
                  </button>
                  
                  <button
                    onClick={() => handleApprove(req.id)}
                    class="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
                  >
                    {t().approval.approve}
                  </button>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
