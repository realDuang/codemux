import { Router, HashRouter, Route, useNavigate, Navigate } from "@solidjs/router";
import { createEffect, createSignal, onMount, Show, type ParentComponent } from "solid-js";
import { Auth } from "./lib/auth";
import { I18nProvider, useI18n } from "./lib/i18n";
import { logger } from "./lib/logger";
import { initElectronTitleBar, isElectron } from "./lib/platform";
import "./lib/theme";
import EntryPage from "./pages/EntryPage";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import Devices from "./pages/Devices";
import { AccessRequestNotification } from "./components/AccessRequestNotification";

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
    <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-50 dark:bg-slate-950 electron-safe-top overflow-hidden">
      {/* Animated background glow */}
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          class="w-[500px] h-[500px] rounded-full opacity-[0.07] dark:opacity-[0.05]"
          style={{
            background: "radial-gradient(circle, #3b82f6 0%, transparent 70%)",
            animation: "splash-pulse 3s ease-in-out infinite",
          }}
        />
      </div>

      {/* Content */}
      <div class="relative z-10 flex flex-col items-center">
        {/* Logo with draw-in animation */}
        <div
          class="mb-8"
          style={{
            animation: "splash-logo-enter 0.8s cubic-bezier(0.16, 1, 0.3, 1) both",
          }}
        >
          <div
            class="relative"
            style={{
              animation: "splash-float 4s ease-in-out infinite",
              "animation-delay": "0.8s",
            }}
          >
            <img
              src={`${import.meta.env.BASE_URL}assets/logo.png`}
              alt="OpenCode Remote"
              class="w-24 h-24 object-contain"
              style={{
                filter: "drop-shadow(0 0 24px rgba(59, 130, 246, 0.3))",
              }}
            />
            {/* Shimmer sweep */}
            <div
              class="absolute inset-0 overflow-hidden rounded"
              style={{
                animation: "splash-shimmer 2.5s ease-in-out infinite",
                "animation-delay": "1s",
              }}
            >
              <div
                class="absolute inset-0"
                style={{
                  background: "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.15) 45%, rgba(255,255,255,0.3) 50%, rgba(255,255,255,0.15) 55%, transparent 60%)",
                  transform: "translateX(-100%)",
                  animation: "splash-shimmer-slide 2.5s ease-in-out infinite",
                  "animation-delay": "1s",
                }}
              />
            </div>
          </div>
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
        @keyframes splash-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }
        @keyframes splash-pulse {
          0%, 100% { transform: scale(0.8); opacity: 0.07; }
          50% { transform: scale(1.1); opacity: 0.12; }
        }
        @keyframes splash-dot {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes splash-shimmer-slide {
          0%, 100% { transform: translateX(-100%); }
          50% { transform: translateX(100%); }
        }
        .dark @keyframes splash-pulse {
          0%, 100% { transform: scale(0.8); opacity: 0.05; }
          50% { transform: scale(1.1); opacity: 0.08; }
        }
      `}</style>
    </div>
  );
}

function App() {
  logger.debug("🎨 App component rendering");
  logger.debug("🔐 Is authenticated:", Auth.isAuthenticated());

  // Startup readiness: web is always ready; Electron waits for IPC signal
  const [appReady, setAppReady] = createSignal(!isElectron());

  // Initialize Electron title bar safe area on mount
  onMount(() => {
    initElectronTitleBar();

    if (isElectron()) {
      const api = (window as any).electronAPI;
      if (api?.startup) {
        // Check if already ready (e.g. services started before renderer loaded)
        api.startup.isReady().then((ready: boolean) => {
          if (ready) {
            setAppReady(true);
          } else {
            // Wait for push notification from main process
            api.startup.onReady(() => {
              setAppReady(true);
            });
          }
        });
      } else {
        // No startup API available (shouldn't happen), don't block
        setAppReady(true);
      }
    }
  });

  return (
    <I18nProvider>
      <Show when={!appReady()}>
        <StartupSplash />
      </Show>
      <Show when={appReady()}>
        <AccessRequestNotification />
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
