import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Auth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { logger } from "../lib/logger";
import { useStorageSync, initStorageSyncAsync, getCurrentNetworkSourceKey } from "../lib/storage-sync";

interface SyncState {
  currentUrl: string | null;
  timestamp: number;
  deviceId: string | null;
}

const OPENCODE_APP_BASE = "/opencode-app";
const URL_SYNC_INTERVAL = 2000;

interface ProjectEntry {
  worktree: string;
  expanded?: boolean;
}

interface ServerData {
  list?: string[];
  projects?: Record<string, ProjectEntry[]>;
  lastProject?: Record<string, string>;
}

function syncProjectsAcrossNetworkSources() {
  const serverKey = "opencode.global.dat:server";
  const layoutKey = "opencode.global.dat:layout.page";
  const currentSource = getCurrentNetworkSourceKey();

  try {
    const serverValue = localStorage.getItem(serverKey);
    
    if (!serverValue) {
      logger.debug("[OfficialApp] No server data found, skipping sync");
      return;
    }

    const parsed: ServerData = JSON.parse(serverValue);
    let modified = false;

    if (!parsed.projects) parsed.projects = {};
    if (!parsed.lastProject) parsed.lastProject = {};

    const referenceProjects = parsed.projects["local"] || 
      Object.values(parsed.projects).find(list => list && list.length > 0) || [];

    if (!parsed.projects[currentSource] && referenceProjects.length > 0) {
      parsed.projects[currentSource] = [...referenceProjects];
      modified = true;
      logger.debug("[OfficialApp] Copied projects to", currentSource);
    }

    const referenceLastProject = parsed.lastProject["local"] || 
      Object.values(parsed.lastProject).find(v => v);

    if (!parsed.lastProject[currentSource] && referenceLastProject) {
      parsed.lastProject[currentSource] = referenceLastProject;
      modified = true;
      logger.debug("[OfficialApp] Copied lastProject to", currentSource);
    }

    if (modified) {
      localStorage.setItem(serverKey, JSON.stringify(parsed));
      logger.debug("[OfficialApp] Server data synced for", currentSource);
    }

    syncLayoutPage(layoutKey, currentSource);
  } catch (err) {
    logger.warn("[OfficialApp] Failed to sync projects:", err);
  }
}

function syncLayoutPage(layoutKey: string, currentSource: string) {
  try {
    const layoutValue = localStorage.getItem(layoutKey);
    if (!layoutValue) return;

    const layout = JSON.parse(layoutValue) as Record<string, unknown>;
    const localLayout = layout["local"];

    if (currentSource !== "local" && localLayout && !layout[currentSource]) {
      layout[currentSource] = localLayout;
      localStorage.setItem(layoutKey, JSON.stringify(layout));
      logger.debug("[OfficialApp] Layout synced from local to", currentSource);
    }
  } catch (err) {
    logger.warn("[OfficialApp] Failed to sync layout:", err);
  }
}

export default function OfficialApp() {
  const { t } = useI18n();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [iframeSrc, setIframeSrc] = createSignal<string | null>(null);

  useStorageSync();

  let iframeRef: HTMLIFrameElement | undefined;
  let lastSyncedUrl = "";

  function stripBasePath(fullPath: string): string {
    if (fullPath.startsWith(OPENCODE_APP_BASE)) {
      return fullPath.slice(OPENCODE_APP_BASE.length) || "/";
    }
    return fullPath;
  }

  function addBasePath(path: string): string {
    if (path.startsWith(OPENCODE_APP_BASE)) {
      return path;
    }
    return `${OPENCODE_APP_BASE}${path.startsWith("/") ? path : "/" + path}`;
  }

  createEffect(() => {
    if (!Auth.isAuthenticated()) {
      logger.debug("[OfficialApp] Not authenticated, redirecting to entry");
      window.location.href = "/";
    }
  });

  createEffect(async () => {
    const token = Auth.getToken();
    if (!token) return;

    await initStorageSyncAsync();
    syncProjectsAcrossNetworkSources();

    const syncState = await fetchSyncState();
    if (syncState?.currentUrl && syncState.currentUrl !== "/") {
      const fullPath = addBasePath(syncState.currentUrl);
      lastSyncedUrl = syncState.currentUrl;
      setIframeSrc(`${fullPath}?_t=${Date.now()}`);
      logger.debug("[OfficialApp] Loading with synced URL:", syncState.currentUrl);
    } else {
      setIframeSrc(`/opencode-app/?_t=${Date.now()}`);
    }
  });

  async function syncUrlToServer(url: string) {
    const token = Auth.getToken();
    if (!token) return;

    try {
      await fetch("/api/sync-state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url }),
      });
      logger.debug("[OfficialApp] URL synced to server:", url);
    } catch (err) {
      logger.error("[OfficialApp] Failed to sync URL:", err);
    }
  }

  async function fetchSyncState(): Promise<SyncState | null> {
    const token = Auth.getToken();
    if (!token) return null;

    try {
      const response = await fetch("/api/sync-state", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        logger.warn("[OfficialApp] Sync state fetch failed:", response.status);
        return null;
      }
      return await response.json();
    } catch (err) {
      logger.error("[OfficialApp] Failed to fetch sync state:", err);
      return null;
    }
  }

  function getCurrentIframeUrl(): string | null {
    try {
      const pathname = iframeRef?.contentWindow?.location.pathname ?? null;
      if (!pathname) return null;
      return stripBasePath(pathname);
    } catch {
      return null;
    }
  }

  // Periodically sync current URL to server (for other devices to pick up on refresh)
  createEffect(() => {
    if (!iframeSrc()) return;

    const syncInterval = setInterval(() => {
      const currentUrl = getCurrentIframeUrl();
      if (!currentUrl || currentUrl === "/") return;

      // Only sync if URL changed since last sync
      if (currentUrl !== lastSyncedUrl) {
        lastSyncedUrl = currentUrl;
        syncUrlToServer(currentUrl);
      }
    }, URL_SYNC_INTERVAL);

    onCleanup(() => {
      clearInterval(syncInterval);
    });
  });

  function handleIframeLoad() {
    setLoading(false);
    logger.debug("[OfficialApp] Iframe loaded successfully");

    const currentUrl = getCurrentIframeUrl();
    if (currentUrl && currentUrl !== "/" && currentUrl !== lastSyncedUrl) {
      lastSyncedUrl = currentUrl;
      syncUrlToServer(currentUrl);
    }
  }

  function handleIframeError() {
    setLoading(false);
    setError("Failed to load official app. Run: bun run build:official-app");
    logger.error("[OfficialApp] Failed to load iframe");
  }

  createEffect(() => {
    fetch("/opencode-app/index.html", { method: "HEAD" })
      .then((res) => {
        if (!res.ok) {
          setError("Official app not built. Run: bun run build:official-app");
          setLoading(false);
        }
      })
      .catch(() => {
        setError("Official app not built. Run: bun run build:official-app");
        setLoading(false);
      });
  });

  return (
    <div class="h-screen w-screen flex flex-col bg-zinc-950">
      <div class="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800">
        <div class="flex items-center gap-3">
          <a
            href="/chat"
            class="flex items-center gap-2 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
                clip-rule="evenodd"
              />
            </svg>
            <span class="text-sm">{t().common.back || "Back"}</span>
          </a>
          <span class="text-zinc-600">|</span>
          <span class="text-zinc-300 text-sm font-medium">
            OpenCode Official UI
          </span>
        </div>
        <div class="flex items-center gap-2">
          <a
            href="/chat"
            class="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
          >
            Simple UI
          </a>
        </div>
      </div>

      <div class="flex-1 relative">
        <Show when={loading()}>
          <div class="absolute inset-0 flex items-center justify-center bg-zinc-950 z-10">
            <div class="flex flex-col items-center gap-4">
              <div class="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span class="text-zinc-400 text-sm">{t().common.loading}</span>
            </div>
          </div>
        </Show>

        <Show when={error()}>
          <div class="absolute inset-0 flex items-center justify-center bg-zinc-950 z-10">
            <div class="flex flex-col items-center gap-4 max-w-md text-center px-6">
              <div class="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-8 w-8 text-red-500"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fill-rule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clip-rule="evenodd"
                  />
                </svg>
              </div>
              <p class="text-zinc-300">{error()}</p>
              <div class="flex gap-3">
                <a
                  href="/chat"
                  class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors"
                >
                  Use Simple UI
                </a>
                <button
                  onClick={() => window.location.reload()}
                  class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        </Show>

        <Show when={!error() && iframeSrc()}>
          <iframe
            ref={iframeRef}
            src={iframeSrc()!}
            class="w-full h-full border-0"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            title="OpenCode Official App"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        </Show>
      </div>
    </div>
  );
}
