import { createSignal, createEffect, Show, onCleanup } from "solid-js";
import { useI18n } from "../lib/i18n";
import { weixinIlinkAPI } from "../lib/electron-api";
import { logger } from "../lib/logger";

export interface WeixinIlinkConfig {
  botToken: string;
  baseUrl: string;
  accountId: string;
  autoApprovePermissions: boolean;
  streamingThrottleMs: number;
}

interface WeixinIlinkLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialConfig: WeixinIlinkConfig;
  /** Secret keys that are already configured server-side. */
  secretsConfigured?: string[];
  onSave: (cfg: WeixinIlinkConfig) => Promise<void>;
}

const POLL_INTERVAL_MS = 2000;
type Stage = "idle" | "loading" | "ready" | "scaned" | "confirmed" | "expired" | "error";

export function WeixinIlinkLoginModal(props: WeixinIlinkLoginModalProps) {
  const { t } = useI18n();
  const [stage, setStage] = createSignal<Stage>("idle");
  const [errorMsg, setErrorMsg] = createSignal<string>("");
  const [qrToken, setQrToken] = createSignal<string>("");
  const [qrImg, setQrImg] = createSignal<string>("");
  const [activeBaseUrl, setActiveBaseUrl] = createSignal<string>("");
  const [saving, setSaving] = createSignal(false);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const closeAndCleanup = () => {
    stopped = true;
    stopPolling();
    setStage("idle");
    setQrToken("");
    setQrImg("");
    setErrorMsg("");
    props.onClose();
  };

  const startQrFlow = async () => {
    stopped = false;
    setStage("loading");
    setErrorMsg("");
    setQrToken("");
    setQrImg("");
    try {
      const result = await weixinIlinkAPI.getQrCode(props.initialConfig.baseUrl);
      if (!result) {
        throw new Error("Electron API unavailable (only supported in desktop app)");
      }
      if (stopped) return;
      setQrToken(result.qrcode);
      setQrImg(result.qrcodeImgContent);
      setActiveBaseUrl(result.baseUrl);
      setStage("ready");
      pollTimer = setInterval(() => {
        void pollOnce();
      }, POLL_INTERVAL_MS);
    } catch (err) {
      logger.error("[WeixinIlinkLoginModal] Failed to get QR code:", err);
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const pollOnce = async () => {
    const token = qrToken();
    if (!token || stopped) return;
    try {
      const status = await weixinIlinkAPI.pollQrCodeStatus(token, activeBaseUrl());
      if (!status || stopped) return;
      switch (status.status) {
        case "wait":
          if (stage() !== "ready") setStage("ready");
          break;
        case "scaned":
          setStage("scaned");
          break;
        case "expired":
          stopPolling();
          setStage("expired");
          break;
        case "confirmed": {
          stopPolling();
          if (!status.botToken || !status.accountId) {
            setStage("error");
            setErrorMsg("Confirmed login but missing botToken/accountId");
            return;
          }
          setStage("confirmed");
          await persistAndStart({
            botToken: status.botToken,
            accountId: status.accountId,
            baseUrl: status.baseUrl || activeBaseUrl(),
          });
          break;
        }
      }
    } catch (err) {
      logger.error("[WeixinIlinkLoginModal] Poll error:", err);
      // Keep polling on transient errors; only surface terminal failures.
    }
  };

  const persistAndStart = async (creds: { botToken: string; accountId: string; baseUrl: string }) => {
    setSaving(true);
    try {
      const next: WeixinIlinkConfig = {
        ...props.initialConfig,
        botToken: creds.botToken,
        accountId: creds.accountId,
        baseUrl: creds.baseUrl,
      };
      await props.onSave(next);
      closeAndCleanup();
    } catch (err) {
      logger.error("[WeixinIlinkLoginModal] Failed to persist credentials:", err);
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  createEffect(() => {
    if (props.isOpen) {
      void startQrFlow();
    } else {
      stopped = true;
      stopPolling();
    }
  });

  onCleanup(() => {
    stopped = true;
    stopPolling();
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeAndCleanup();
  };

  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={handleKeyDown}>
        <div
          class="absolute inset-0 bg-black/50 backdrop-blur-xs"
          onClick={closeAndCleanup}
          aria-hidden="true"
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="weixin-ilink-login-modal-title"
          class="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden flex flex-col"
        >
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800">
            <h2 id="weixin-ilink-login-modal-title" class="text-lg font-semibold text-gray-900 dark:text-white">
              {(t().channel as Record<string, string>).weixinIlinkLoginTitle ?? "WeChat iLink Login"}
            </h2>
            <button
              onClick={closeAndCleanup}
              class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition-colors"
              aria-label="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          <div class="p-6 flex flex-col items-center gap-4">
            <Show when={stage() === "loading"}>
              <p class="text-sm text-gray-600 dark:text-gray-400">
                {(t().channel as Record<string, string>).weixinIlinkLoading ?? "Fetching QR code..."}
              </p>
            </Show>

            <Show when={stage() === "ready" || stage() === "scaned" || stage() === "confirmed"}>
              <Show when={qrImg()}>
                <img
                  src={qrImg()}
                  alt="WeChat iLink QR code"
                  class="w-56 h-56 object-contain border border-gray-200 dark:border-slate-700 rounded-lg bg-white"
                />
              </Show>
              <p class="text-sm text-gray-700 dark:text-gray-300 text-center">
                <Show when={stage() === "ready"}>
                  {(t().channel as Record<string, string>).weixinIlinkScanPrompt ?? "Open WeChat on your phone and scan the QR code."}
                </Show>
                <Show when={stage() === "scaned"}>
                  {(t().channel as Record<string, string>).weixinIlinkScanedPrompt ?? "Scanned. Confirm login on your phone..."}
                </Show>
                <Show when={stage() === "confirmed"}>
                  {(t().channel as Record<string, string>).weixinIlinkConfirmedPrompt ?? "Login confirmed, saving..."}
                </Show>
              </p>
            </Show>

            <Show when={stage() === "expired"}>
              <p class="text-sm text-amber-600 dark:text-amber-400">
                {(t().channel as Record<string, string>).weixinIlinkExpired ?? "QR code expired."}
              </p>
              <button
                onClick={() => void startQrFlow()}
                class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
              >
                {(t().channel as Record<string, string>).weixinIlinkRefresh ?? "Refresh QR code"}
              </button>
            </Show>

            <Show when={stage() === "error"}>
              <p class="text-sm text-red-600 dark:text-red-400 text-center">
                {errorMsg() || ((t().channel as Record<string, string>).weixinIlinkError ?? "An error occurred.")}
              </p>
              <button
                onClick={() => void startQrFlow()}
                class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                disabled={saving()}
              >
                {(t().channel as Record<string, string>).weixinIlinkRetry ?? "Retry"}
              </button>
            </Show>

            <Show when={props.secretsConfigured?.includes("botToken") && stage() === "ready"}>
              <p class="text-xs text-gray-400 dark:text-gray-500 text-center">
                {(t().channel as Record<string, string>).weixinIlinkAlreadyConfigured ?? "A bot is already configured. Scanning will replace it."}
              </p>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
