import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";
import { createPwaController, isIosDevice } from "../../../../src/web/pwa";

const { registerSW, updateServiceWorker, warn } = vi.hoisted(() => ({
  registerSW: vi.fn<(options: RegisterSWOptions) => (reload?: boolean) => Promise<void>>(),
  updateServiceWorker: vi.fn<(reload?: boolean) => Promise<void>>(),
  warn: vi.fn(),
}));

vi.mock("virtual:pwa-register", () => ({ registerSW }));
vi.mock("../../../../src/lib/logger", () => ({ logger: { warn } }));

const buildId = "1234567890abcdef1234567890abcdef";
const cleanups: Array<() => void> = [];

function createBrowser() {
  const displayMode = Object.assign(new EventTarget(), { matches: false });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn> } | null,
  });
  const browserWindow = Object.assign(new EventTarget(), {
    isSecureContext: true,
    electronAPI: undefined as object | undefined,
    matchMedia: vi.fn(() => displayMode),
    location: { reload: vi.fn() },
  });
  const browserDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const browserNavigator = {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/145.0",
    platform: "Linux x86_64",
    maxTouchPoints: 0,
    standalone: false,
    onLine: true,
    serviceWorker,
  };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", browserDocument);
  vi.stubGlobal("navigator", browserNavigator);
  return { browserWindow, browserDocument, browserNavigator, displayMode, serviceWorker };
}

function startController(canReload = () => true) {
  const controller = createPwaController(canReload);
  cleanups.push(controller.start());
  return controller;
}

function registrationCallbacks(): RegisterSWOptions {
  const options = registerSW.mock.calls.at(-1)?.[0];
  expect(options).toBeDefined();
  return options!;
}

function createRegistration() {
  const active = { postMessage: vi.fn() };
  const update = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const registration = { active, update } as unknown as ServiceWorkerRegistration;
  return { registration, active, update };
}

function installEvent(outcome: "accepted" | "dismissed" = "accepted") {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome }),
  });
}

function versionRequest(type = "CODEMUX_PWA_VERSION_REQUEST") {
  const postMessage = vi.fn();
  const event = Object.assign(new Event("message"), { data: { type }, ports: [{ postMessage }] });
  return { event, postMessage };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("PROD", true);
  vi.stubGlobal("__PWA_BUILD_ID__", buildId);
  registerSW.mockReset().mockReturnValue(updateServiceWorker);
  updateServiceWorker.mockReset().mockResolvedValue(undefined);
  warn.mockClear();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("isIosDevice", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", "iPhone", 5, true],
    ["Mozilla/5.0 (iPad; CPU OS 18_0)", "iPad", 5, true],
    ["Mozilla/5.0 (iPod touch)", "iPod", 5, true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 5, true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 0, false],
    ["Mozilla/5.0 (Linux; Android 16)", "Linux armv8l", 5, false],
  ])("detects installation guidance for %s", (userAgent, platform, maxTouchPoints, expected) => {
    expect(isIosDevice(userAgent, platform, maxTouchPoints)).toBe(expected);
  });
});

describe("createPwaController", () => {
  it.each(["development", "insecure HTTP", "Electron"])(
    "does not register a worker or intercept installation in %s",
    async (environment) => {
      const { browserWindow, browserNavigator } = createBrowser();
      browserNavigator.userAgent = "iPhone";
      if (environment === "development") vi.stubEnv("PROD", false);
      if (environment === "insecure HTTP") browserWindow.isSecureContext = false;
      if (environment === "Electron") browserWindow.electronAPI = {};
      const canReload = vi.fn(() => true);
      const controller = startController(canReload);
      const event = installEvent();
      browserWindow.dispatchEvent(event);
      await controller.install();
      await controller.update();

      expect(controller.canInstall()).toBe(false);
      expect(registerSW).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(event.prompt).not.toHaveBeenCalled();
      expect(canReload).not.toHaveBeenCalled();
      expect(updateServiceWorker).not.toHaveBeenCalled();
    },
  );

  it("keeps manual iOS installation available without service worker support", async () => {
    const { browserNavigator } = createBrowser();
    const { serviceWorker: _serviceWorker, ...unsupportedNavigator } = browserNavigator;
    vi.stubGlobal("navigator", { ...unsupportedNavigator, userAgent: "iPhone" });
    const controller = startController();

    expect(controller.ios).toBe(true);
    expect(controller.canInstall()).toBe(true);
    await controller.install();
    await controller.update();
    expect(registerSW).not.toHaveBeenCalled();
    expect(controller.updating()).toBe(false);
  });

  it.each(["display mode", "iOS standalone"])(
    "hides the install affordance when already installed via %s",
    (mode) => {
      const { browserNavigator, displayMode } = createBrowser();
      browserNavigator.userAgent = "iPhone";
      if (mode === "display mode") displayMode.matches = true;
      else browserNavigator.standalone = true;
      const controller = startController();

      expect(controller.installed()).toBe(true);
      expect(controller.canInstall()).toBe(false);
      displayMode.matches = false;
      browserNavigator.standalone = false;
      displayMode.dispatchEvent(new Event("change"));
      expect(controller.installed()).toBe(false);
      expect(controller.canInstall()).toBe(true);
      displayMode.matches = true;
      displayMode.dispatchEvent(new Event("change"));
      expect(controller.canInstall()).toBe(false);
    },
  );

  it.each(["accepted", "dismissed"] as const)(
    "offers a desktop browser install prompt once and records an %s choice",
    async (outcome) => {
      const { browserWindow } = createBrowser();
      const controller = startController();
      expect(controller.canInstall()).toBe(false);
      const event = installEvent(outcome);
      browserWindow.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(controller.canInstall()).toBe(true);
      const installing = controller.install();
      expect(controller.canInstall()).toBe(false);
      await installing;
      await controller.install();
      expect(event.prompt).toHaveBeenCalledOnce();
      expect(controller.installed()).toBe(outcome === "accepted");
    },
  );

  it("discards the deferred prompt when the browser reports installation", async () => {
    const { browserWindow } = createBrowser();
    const controller = startController();
    const event = installEvent();
    browserWindow.dispatchEvent(event);
    browserWindow.dispatchEvent(new Event("appinstalled"));
    await controller.install();

    expect(controller.installed()).toBe(true);
    expect(controller.canInstall()).toBe(false);
    expect(event.prompt).not.toHaveBeenCalled();
  });

  it("recovers from a rejected installation prompt without marking the app installed", async () => {
    const { browserWindow } = createBrowser();
    const controller = startController();
    const event = installEvent();
    const error = new Error("Installation dialog unavailable");
    event.prompt.mockRejectedValue(error);
    browserWindow.dispatchEvent(event);
    await controller.install();

    expect(controller.installed()).toBe(false);
    expect(controller.canInstall()).toBe(false);
    expect(warn).toHaveBeenCalledWith("[PWA] Installation prompt failed", error);
    const retry = installEvent();
    browserWindow.dispatchEvent(retry);
    await controller.install();
    expect(controller.installed()).toBe(true);
  });

  it("waits for safe explicit consent and activation before refreshing the page", async () => {
    const { browserWindow } = createBrowser();
    const canReload = vi.fn(() => false);
    const controller = startController(canReload);
    const callbacks = registrationCallbacks();
    expect(registerSW).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
    expect(controller.updateAvailable()).toBe(false);
    callbacks.onNeedRefresh?.();
    expect(controller.updateAvailable()).toBe(true);
    expect(browserWindow.location.reload).not.toHaveBeenCalled();
    await controller.update();
    expect(updateServiceWorker).not.toHaveBeenCalled();

    canReload.mockReturnValue(true);
    await controller.update();
    await controller.update();
    expect(updateServiceWorker).toHaveBeenCalledExactlyOnceWith(true);
    expect(controller.updating()).toBe(true);
    expect(browserWindow.location.reload).not.toHaveBeenCalled();
    callbacks.onNeedReload?.();
    expect(browserWindow.location.reload).toHaveBeenCalledOnce();
    expect(controller.updating()).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(controller.updateFailed()).toBe(false);
  });

  it("requires this page's consent when another tab activates an update", async () => {
    const { browserWindow } = createBrowser();
    const controller = startController();
    registrationCallbacks().onNeedReload?.();

    expect(controller.updateAvailable()).toBe(true);
    expect(browserWindow.location.reload).not.toHaveBeenCalled();
    await controller.update();
    expect(browserWindow.location.reload).toHaveBeenCalledOnce();
  });

  it("preserves newly unsaved work if activation arrives after consent", async () => {
    const { browserWindow } = createBrowser();
    const canReload = vi.fn(() => true);
    const controller = startController(canReload);
    await controller.update();
    canReload.mockReturnValue(false);
    registrationCallbacks().onNeedReload?.();

    expect(browserWindow.location.reload).not.toHaveBeenCalled();
    expect(controller.updating()).toBe(false);
    expect(controller.updateAvailable()).toBe(true);
    canReload.mockReturnValue(true);
    await controller.update();
    expect(browserWindow.location.reload).toHaveBeenCalledOnce();
  });

  it("allows retry after an update failure and revokes permission for a late activation", async () => {
    const { browserWindow } = createBrowser();
    const controller = startController();
    const error = new Error("Worker update failed");
    updateServiceWorker.mockRejectedValueOnce(error);
    await controller.update();

    expect(controller.updateFailed()).toBe(true);
    expect(controller.updating()).toBe(false);
    expect(warn).toHaveBeenCalledWith("[PWA] Update failed", error);
    registrationCallbacks().onNeedReload?.();
    expect(browserWindow.location.reload).not.toHaveBeenCalled();
    await controller.update();
    expect(controller.updateFailed()).toBe(false);
    expect(updateServiceWorker).toHaveBeenCalledTimes(2);
    expect(browserWindow.location.reload).toHaveBeenCalledOnce();
  });

  it("times out a stalled update without letting a late activation reload the page", async () => {
    const { browserWindow } = createBrowser();
    const controller = startController();
    await controller.update();
    vi.advanceTimersByTime(14_999);
    expect(controller.updating()).toBe(true);
    expect(controller.updateFailed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.updating()).toBe(false);
    expect(controller.updateFailed()).toBe(true);
    registrationCallbacks().onNeedReload?.();
    expect(browserWindow.location.reload).not.toHaveBeenCalled();
  });

  it("logs registration failures and remains usable for installation", async () => {
    const { browserWindow } = createBrowser();
    const controller = startController();
    const error = new Error("Service worker registration rejected");
    registrationCallbacks().onRegisterError?.(error);
    expect(warn).toHaveBeenCalledWith("[PWA] Registration failed", error);
    expect(controller.updateAvailable()).toBe(false);
    browserWindow.dispatchEvent(installEvent());
    await controller.install();
    expect(controller.installed()).toBe(true);
  });

  it("reports client readiness to the controlling worker and falls back to the active registration", () => {
    const { serviceWorker } = createBrowser();
    startController();
    const { registration, active } = createRegistration();
    registrationCallbacks().onRegisteredSW?.("/sw.js", registration);
    expect(serviceWorker.controller?.postMessage).toHaveBeenCalledWith({ type: "CODEMUX_PWA_CLIENT_READY" });
    expect(active.postMessage).not.toHaveBeenCalled();
    serviceWorker.controller = null;
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(active.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "CODEMUX_PWA_CLIENT_READY" });
  });

  it("checks for updates on visible online returns and retries after a network failure", async () => {
    const { browserWindow, browserDocument, browserNavigator, serviceWorker } = createBrowser();
    startController();
    const { registration, update } = createRegistration();
    registrationCallbacks().onRegisteredSW?.("/sw.js", registration);
    serviceWorker.controller?.postMessage.mockClear();

    browserDocument.visibilityState = "hidden";
    browserWindow.dispatchEvent(new Event("online"));
    browserDocument.visibilityState = "visible";
    browserNavigator.onLine = false;
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(update).not.toHaveBeenCalled();
    expect(serviceWorker.controller?.postMessage).not.toHaveBeenCalled();

    browserNavigator.onLine = true;
    update.mockRejectedValueOnce(new Error("Network disconnected"));
    browserWindow.dispatchEvent(new Event("online"));
    await Promise.resolve();
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalledTimes(2);
    expect(serviceWorker.controller?.postMessage).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers build version requests and removes listeners and timers when disposed", async () => {
    const { browserWindow, browserDocument, displayMode, serviceWorker } = createBrowser();
    const controller = startController();
    const { registration, update } = createRegistration();
    registrationCallbacks().onRegisteredSW?.("/sw.js", registration);
    const ignored = versionRequest("OTHER_MESSAGE");
    serviceWorker.dispatchEvent(ignored.event);
    expect(ignored.postMessage).not.toHaveBeenCalled();
    const request = versionRequest();
    serviceWorker.dispatchEvent(request.event);
    expect(request.postMessage).toHaveBeenCalledExactlyOnceWith({ buildId });
    serviceWorker.dispatchEvent(Object.assign(new Event("message"), {
      data: { type: "CODEMUX_PWA_VERSION_REQUEST" }, ports: [],
    }));
    await controller.update();
    cleanups.pop()!();
    serviceWorker.controller?.postMessage.mockClear();

    const afterDisposal = versionRequest();
    serviceWorker.dispatchEvent(afterDisposal.event);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    browserWindow.dispatchEvent(new Event("online"));
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    const prompt = installEvent();
    browserWindow.dispatchEvent(prompt);
    browserWindow.dispatchEvent(new Event("appinstalled"));
    displayMode.matches = true;
    displayMode.dispatchEvent(new Event("change"));
    vi.advanceTimersByTime(15_000);

    expect(afterDisposal.postMessage).not.toHaveBeenCalled();
    expect(serviceWorker.controller?.postMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(prompt.defaultPrevented).toBe(false);
    expect(controller.canInstall()).toBe(false);
    expect(controller.installed()).toBe(false);
    expect(controller.updateFailed()).toBe(false);
  });
});
