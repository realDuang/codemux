import { Router, HashRouter, Route, useNavigate, Navigate } from "@solidjs/router";
import { createEffect, createSignal, lazy, onCleanup, onMount, Show, Suspense, type ParentComponent, type ParentProps } from "solid-js";
import { Auth } from "./lib/auth";
import { I18nProvider, useI18n } from "./lib/i18n";
import { logger } from "./lib/logger";
import { publicAssetUrl } from "./lib/public-assets";
import { initElectronTitleBar, isElectron } from "./lib/platform";
import "./lib/theme";
import { AccessRequestNotification } from "./components/AccessRequestNotification";
import { UpdateNotification } from "./components/UpdateNotification";
import { NotificationToast } from "./components/NotificationToast";
import { Spinner } from "./components/Spinner";
import EntryPage from "./pages/EntryPage";
import Chat from "./pages/Chat";
import { LocalServerManager } from "./desktop/LocalServerManager";
import { initialLocalServerView, observeLocalServer, receiveLocalServerState, type LocalServerAction } from "./desktop/local-server-state";
import type { LocalServerState } from "../shared/local-server-types";

const PageFallback = () => (
  <div class="fixed inset-0 flex items-center justify-center bg-gray-50 dark:bg-slate-950">
    <Spinner size="large" class="text-blue-500" />
  </div>
);

const SettingsLazy = lazy(() => import("./pages/Settings"));
const DevicesLazy = lazy(() => import("./pages/Devices"));

const Settings = () => <Suspense fallback={<PageFallback />}><SettingsLazy /></Suspense>;
const Devices = () => <Suspense fallback={<PageFallback />}><DevicesLazy /></Suspense>;

// Use HashRouter for Electron (file:// protocol) and regular Router for web
// HashRouter uses URL hashes (#/path) which work with file:// protocol
const AppRouter: ParentComponent = (props) => {
  // In production Electron, use HashRouter for file:// protocol compatibility
  if (isElectron() && window.location.protocol === "file:") {
    return <HashRouter>{props.children}</HashRouter>;
  }
  return <Router>{props.children}</Router>;
};

// Redirect component for /login route
function LoginRedirect() {
  return <Navigate href="/" />;
}

// Redirect component for /remote route
function RemoteRedirect() {
  if (isElectron()) {
    logger.debug("[Remote Route] Electron host, redirecting to /");
    return <Navigate href="/" />;
  }
  // Web clients: redirect to chat if authenticated, else to /
  if (Auth.isAuthenticated()) {
    logger.debug("[Remote Route] Web client authenticated, redirecting to /chat");
    return <Navigate href="/chat" />;
  }
  logger.debug("[Remote Route] Web client not authenticated, redirecting to /");
  return <Navigate href="/" />;
}

// Protected chat route component
function ChatRoute() {
  const navigate = useNavigate();

  createEffect(() => {
    if (!Auth.isAuthenticated()) {
      logger.debug("❌ Not authenticated, redirecting to entry");
      navigate("/", { replace: true });
    } else {
      logger.debug("✅ Authenticated, showing chat");
    }
  });

  return <Chat />;
}

// Startup splash overlay — shown in Electron until all services are ready
function StartupSplash() {
  const { t } = useI18n();

  return (
    <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--cm-canvas)] electron-safe-top overflow-hidden">
      {/* Animated background glow */}
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          class="w-[500px] h-[500px] rounded-full opacity-[0.07] dark:opacity-[0.05] dark:animate-[dark-splash-pulse_3s_ease-in-out_infinite]"
          style={{
            background: "radial-gradient(circle, var(--cm-accent) 0%, transparent 70%)",
            animation: "splash-pulse 3s ease-in-out infinite",
          }}
        />
      </div>

      {/* Content */}
      <div class="relative z-10 flex flex-col items-center">
        {/* Logo with a single entrance transition */}
        <div
          class="mb-8"
          style={{
            animation: "splash-logo-enter 0.8s cubic-bezier(0.16, 1, 0.3, 1) both",
          }}
        >
          <img
            src={publicAssetUrl("logo.png")}
            alt="CodeMux"
            class="w-24 h-24 object-contain"
            style={{ filter: "drop-shadow(0 6px 12px rgba(15, 23, 42, 0.12))" }}
          />
        </div>

        {/* Loading indicator */}
        <div
          class="flex flex-col items-center gap-4"
          style={{
            animation: "splash-fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both",
          }}
        >
          {/* Dot loader */}
          <div class="flex gap-1.5">
            <div
              class="w-1.5 h-1.5 rounded-full bg-blue-500/70"
              style={{ animation: "splash-dot 1.4s ease-in-out infinite" }}
            />
            <div
              class="w-1.5 h-1.5 rounded-full bg-blue-500/70"
              style={{ animation: "splash-dot 1.4s ease-in-out 0.2s infinite" }}
            />
            <div
              class="w-1.5 h-1.5 rounded-full bg-blue-500/70"
              style={{ animation: "splash-dot 1.4s ease-in-out 0.4s infinite" }}
            />
          </div>

          <p class="text-sm text-gray-400 dark:text-gray-500 tracking-wide">
            {t().entry.startingServices}
          </p>
        </div>
      </div>

      {/* Inline keyframes */}
      <style>{`
        @keyframes splash-logo-enter {
          from { opacity: 0; transform: scale(0.7) translateY(10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes splash-fade-up {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes splash-pulse {
          0%, 100% { transform: scale(0.8); opacity: 0.07; }
          50% { transform: scale(1.1); opacity: 0.12; }
        }
        @keyframes splash-dot {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes dark-splash-pulse {
          0%, 100% { transform: scale(0.8); opacity: 0.05; }
          50% { transform: scale(1.1); opacity: 0.08; }
        }
      `}</style>
    </div>
  );
}

function App(props: ParentProps) {
  logger.debug("🎨 App component rendering");
  logger.debug("🔐 Is authenticated:", Auth.isAuthenticated());

  // Startup readiness: web is always ready; Electron waits for IPC signal
  const [appReady, setAppReady] = createSignal(!isElectron());
  const runtime = isElectron() ? window.electronAPI?.runtime : undefined;
  const [serverView, setServerView] = createSignal(initialLocalServerView);
  const [runtimePending, setRuntimePending] = createSignal(false);
  const [runtimeError, setRuntimeError] = createSignal<string | null>(null);
  let runtimeObserver: ReturnType<typeof observeLocalServer> | undefined;

  const handleRuntimeState = (state: LocalServerState) => {
    setServerView((view) => receiveLocalServerState(view, state));
    if (state.phase === "ready") setAppReady(true);
  };

  const handleRuntimeAction = async (action: LocalServerAction) => {
    if (!runtimeObserver || runtimePending()) return;
    setRuntimePending(true);
    setRuntimeError(null);
    try {
      await runtimeObserver.run(action);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimePending(false);
    }
  };

  const handleOpenLogs = async () => {
    try {
      await runtime?.openLogs();
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }
  };

  // Initialize Electron title bar safe area on mount
  onMount(() => {
    initElectronTitleBar();

    if (runtime) {
      runtimeObserver = observeLocalServer(runtime, handleRuntimeState, (error) => {
        setServerView((view) => receiveLocalServerState(view, {
          ...view.state,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      const unsubscribeManager = runtime.onShowManager(() => {
        setServerView((view) => ({ ...view, managerVisible: true }));
      });
      onCleanup(() => {
        runtimeObserver?.dispose();
        unsubscribeManager();
      });
    } else if (isElectron()) {
      const api = window.electronAPI;
      if (api?.startup) {
        // Subscribe first: readiness can arrive while the initial query is pending.
        const unsubscribe = api.startup.onReady(() => setAppReady(true));
        let disposed = false;
        void api.startup.isReady().then((ready) => {
          if (ready && !disposed) setAppReady(true);
        }).catch((error: unknown) => logger.error("[Startup] Readiness check failed:", error));
        onCleanup(() => {
          disposed = true;
          unsubscribe?.();
        });
      } else {
        // No startup API available (shouldn't happen), don't block
        setAppReady(true);
      }
    }
  });

  return (
    <I18nProvider>
      <Show when={!appReady() && !runtime}>
        <StartupSplash />
      </Show>
      <Show when={runtime && serverView().managerVisible}>
        <LocalServerManager
          state={serverView().state}
          canClose={serverView().hasBeenReady}
          pending={runtimePending()}
          actionError={runtimeError()}
          onAction={handleRuntimeAction}
          onOpenLogs={handleOpenLogs}
          onClose={() => setServerView((view) => ({ ...view, managerVisible: false }))}
        />
      </Show>
      <Show when={appReady()}>
        {props.children}
        <NotificationToast />
        <AccessRequestNotification />
        <UpdateNotification />
        <AppRouter>
          <Route path="/" component={EntryPage} />
          <Route path="/login" component={LoginRedirect} />
          <Route path="/remote" component={RemoteRedirect} />
          <Route path="/settings" component={Settings} />
          <Route path="/devices" component={Devices} />
          <Route path="/chat" component={ChatRoute} />
        </AppRouter>
      </Show>
    </I18nProvider>
  );
}

export default App;
