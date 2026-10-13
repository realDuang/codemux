/// <reference types="vite-plugin-pwa/client" />
import { createSignal } from "solid-js";
import { registerSW } from "virtual:pwa-register";
import { isElectron } from "../lib/platform";
import { logger } from "../lib/logger";
import { createPwaUpdateGate } from "./pwa-update";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

export function createPwaController(canReload: () => boolean) {
  const displayMode = window.matchMedia("(display-mode: standalone)");
  const inStandaloneMode = () => displayMode.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const [installed, setInstalled] = createSignal(inStandaloneMode());
  const [installPrompt, setInstallPrompt] = createSignal<InstallPromptEvent>();
  const [updateAvailable, setUpdateAvailable] = createSignal(false);
  const [updating, setUpdating] = createSignal(false);
  const [updateFailed, setUpdateFailed] = createSignal(false);
  const enabled = import.meta.env.PROD && window.isSecureContext && !isElectron();
  const ios = isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  let registration: ServiceWorkerRegistration | undefined;
  let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;
  let updateTimeout: ReturnType<typeof setTimeout> | undefined;
  const updateGate = createPwaUpdateGate(canReload, () => window.location.reload());

  const handleInstallPrompt = (event: Event) => {
    event.preventDefault();
    setInstallPrompt(event as InstallPromptEvent);
  };
  const handleInstalled = () => {
    setInstalled(true);
    setInstallPrompt(undefined);
  };
  const handleDisplayMode = () => setInstalled(inStandaloneMode());
  const reportClientReady = () => {
    (navigator.serviceWorker?.controller ?? registration?.active)?.postMessage({ type: "CODEMUX_PWA_CLIENT_READY" });
  };
  const handleVersionRequest = (event: MessageEvent) => {
    if (event.data?.type === "CODEMUX_PWA_VERSION_REQUEST") {
      event.ports[0]?.postMessage({ buildId: __PWA_BUILD_ID__ });
    }
  };
  const checkForUpdate = () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      reportClientReady();
      void registration?.update().catch(() => { /* Retry when the app returns online. */ });
    }
  };

  function start() {
    if (!enabled) return () => {};
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    displayMode.addEventListener("change", handleDisplayMode);
    document.addEventListener("visibilitychange", checkForUpdate);
    window.addEventListener("online", checkForUpdate);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", handleVersionRequest);
      navigator.serviceWorker.addEventListener("controllerchange", reportClientReady);
      updateServiceWorker = registerSW({
        immediate: true,
        onNeedRefresh: () => setUpdateAvailable(true),
        onNeedReload: () => {
          clearTimeout(updateTimeout);
          updateGate.activate();
          setUpdating(false);
          setUpdateAvailable(true);
        },
        onRegisteredSW: (_url, value) => { registration = value; reportClientReady(); },
        onRegisterError: (error: unknown) => logger.warn("[PWA] Registration failed", error),
      });
    }
    return () => {
      clearTimeout(updateTimeout);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      displayMode.removeEventListener("change", handleDisplayMode);
      document.removeEventListener("visibilitychange", checkForUpdate);
      window.removeEventListener("online", checkForUpdate);
      navigator.serviceWorker?.removeEventListener("message", handleVersionRequest);
      navigator.serviceWorker?.removeEventListener("controllerchange", reportClientReady);
    };
  }

  async function install() {
    const event = installPrompt();
    if (!event) return;
    setInstallPrompt(undefined);
    try {
      await event.prompt();
      if ((await event.userChoice).outcome === "accepted") setInstalled(true);
    } catch (error) {
      logger.warn("[PWA] Installation prompt failed", error);
    }
  }

  async function update() {
    if (!updateServiceWorker || updating() || !updateGate.request()) return;
    setUpdating(true);
    setUpdateFailed(false);
    try {
      await updateServiceWorker(true);
      updateTimeout = setTimeout(() => {
        updateGate.cancel();
        setUpdating(false);
        setUpdateFailed(true);
      }, 15_000);
    } catch (error) {
      updateGate.cancel();
      setUpdateFailed(true);
      setUpdating(false);
      logger.warn("[PWA] Update failed", error);
    }
  }

  return { start, install, update, installed, updateAvailable, updating, updateFailed, canInstall: () => enabled && !installed() && (ios || Boolean(installPrompt())), ios };
}
