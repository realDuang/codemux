import { test, expect, type Page } from "@playwright/test";
import type { RemoteAccessStatus, RemoteAccessUpdate } from "../../../shared/remote-access";
import { CONNECTION_CENTER_PATH } from "../../../src/lib/routes";
import type { DevTunnelDiscoveryResult } from "../../../shared/dev-tunnel-metadata";
import type { RemoteHostInput, RemoteHostState } from "../../../shared/remote-hosts";

async function setup(page: Page, available = true) {
  let state: RemoteAccessStatus = {
    mode: "off", url: "", customAccessUrl: "", tunnelConfig: {},
    tunnel: { status: "stopped", url: "" }, cloudflareAvailable: true,
    devTunnelAvailable: available, devTunnelConfig: { access: "private" },
  };
  const updates: RemoteAccessUpdate[] = [];
  await page.route("**/api/remote-access", async route => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON() as RemoteAccessUpdate;
      updates.push(patch);
      state = { ...state, ...patch };
      if (patch.mode === "devtunnel") state = { ...state, url: "", tunnel: { status: "starting", url: "", phase: "login" } };
      if (patch.mode === "off") state = { ...state, url: "", tunnel: { status: "stopped", url: "" } };
    }
    await route.fulfill({ json: state });
  });
  await page.goto(`${process.env.TEST_BASE_URL}${CONNECTION_CENTER_PATH}`);
  await expect(page.getByTestId("share-method-devtunnel")).toBeEnabled();
  return {
    updates,
    setState: (patch: Partial<RemoteAccessStatus>) => { state = { ...state, ...patch }; },
  };
}

test.describe("Microsoft Dev Tunnels sharing", () => {
  test("defaults to private access, supports cancellation, retries login and withdraws disabled links", async ({ page }) => {
    const host = await setup(page);
    await page.getByTestId("share-method-devtunnel").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Only my account", { exact: true }).first()).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(host.updates).toEqual([]);
    await page.getByTestId("share-method-devtunnel").click();
    await page.getByTestId("save-devtunnel").click();
    expect(host.updates).toEqual([{ mode: "devtunnel", devTunnelConfig: { access: "private" } }]);
    await expect(page.getByText("Waiting for Microsoft sign-in", { exact: true })).toBeVisible();
    await expect(page.getByTestId("active-share-address")).not.toBeVisible();
    host.setState({ tunnel: { status: "error", url: "", errorCode: "DEVTUNNEL_LOGIN_REQUIRED", error: "Login required" } });
    await expect(page.getByRole("alert").getByText(/Microsoft sign-in is required/)).toBeVisible();
    await page.getByRole("button", { name: "Retry", exact: true }).first().click();
    expect(host.updates.at(-1)).toEqual({ mode: "devtunnel" });
    const url = "https://codemux-test-8233.jpe1.devtunnels.ms";
    host.setState({ url, tunnel: { status: "running", url } });
    await expect(page.getByTestId("active-share-address")).toHaveText(url);
    await expect(page.getByTestId("devtunnel-access-summary")).toHaveText("Only my account");
    await page.getByTestId("disable-share-access").click();
    await expect(page.getByTestId("share-method-devtunnel")).toBeVisible();
    await expect(page.getByTestId("active-share-address")).not.toBeVisible();
  });

  test("requires an explicit advanced choice to broaden access", async ({ page }) => {
    const host = await setup(page);
    await page.getByTestId("share-method-devtunnel").click();
    await page.getByText("Advanced access settings", { exact: true }).click();
    await page.getByTestId("devtunnel-access").selectOption("tenant");
    await expect(page.getByRole("note")).toContainText("every user");
    await page.getByTestId("devtunnel-access").selectOption("anonymous");
    await expect(page.getByRole("note")).toContainText("Removes Microsoft sign-in");
    await page.getByTestId("save-devtunnel").click();
    expect(host.updates[0]).toEqual({ mode: "devtunnel", devTunnelConfig: { access: "anonymous" } });
  });

  test("explains missing CLI installation without enabling the tunnel", async ({ page }) => {
    const host = await setup(page, false);
    await page.getByTestId("share-method-devtunnel").click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Install the Microsoft devtunnel CLI");
    await expect(page.getByTestId("save-devtunnel")).toBeDisabled();
    expect(host.updates).toEqual([]);
  });

  test("saves the optional discovery name with private sharing", async ({ page }) => {
    const host = await setup(page);
    await page.getByTestId("share-method-devtunnel").click();
    await page.getByTestId("devtunnel-computer-name").fill(" Development PC ");
    await page.getByTestId("save-devtunnel").click();
    expect(host.updates[0]).toEqual({ mode: "devtunnel", devTunnelConfig: { access: "private", name: "Development PC" } });
  });

  test("renders the provider and configuration on desktop and mobile", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => localStorage.setItem("settings:theme", JSON.stringify("light")));
    await page.setViewportSize({ width: 1280, height: 900 });
    await setup(page);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.screenshot({ path: testInfo.outputPath("devtunnel-desktop.png"), fullPage: true });
    await page.getByTestId("share-method-devtunnel").click();
    await expect(page.getByTestId("save-devtunnel")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("devtunnel-dialog-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("save-devtunnel")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("devtunnel-dialog-mobile.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: testInfo.outputPath("devtunnel-dialog-mobile-dark.png"), fullPage: true });
    await page.evaluate(() => localStorage.setItem("settings:locale", JSON.stringify("zh")));
    await page.reload();
    await page.getByTestId("share-method-devtunnel").click();
    await expect(page.getByTestId("save-devtunnel")).toHaveText("启用 Dev Tunnels");
    await page.screenshot({ path: testInfo.outputPath("devtunnel-dialog-mobile-zh.png"), fullPage: true });
  });

  const DISCOVERED_URL = "https://codemux-01234567-89ab-cdef-0123-456789abcdef-8233.jpe1.devtunnels.ms";
  const discovered: DevTunnelDiscoveryResult = {
    status: "ready",
    tunnels: [
      { tunnelId: "codemux-01234567-89ab-cdef-0123-456789abcdef.jpe1", name: "Development PC", online: true, url: DISCOVERED_URL },
      { tunnelId: "codemux-abcdef01-2345-6789-abcd-ef0123456789.jpe1", name: "Build workstation", online: false },
    ],
  };

  interface DiscoveryHarness {
    calls: boolean[];
    cancelled: number;
    saved: RemoteHostInput[];
    connected: string[];
  }
  type HarnessWindow = Window & { discoveryHarness: DiscoveryHarness };

  async function setupDiscovery(page: Page, initial: DevTunnelDiscoveryResult = discovered, pending = false) {
    await page.addInitScript(({ initial, ready, pending }) => {
      const state: DiscoveryHarness = { calls: [], cancelled: 0, saved: [], connected: [] };
      Object.assign(window, { discoveryHarness: state });
      const hosts: RemoteHostState[] = [];
      const listeners = new Set<(hosts: RemoteHostState[]) => void>();
      let finish: ((result: DevTunnelDiscoveryResult) => void) | undefined;
      let firstPending = pending;
      Object.assign(window, {
        electronAPI: {
          settings: {
            cache: {
              theme: JSON.parse(localStorage.getItem("settings:theme") || '"light"'),
              locale: JSON.parse(localStorage.getItem("settings:locale") || '"en"'),
            },
            save: async () => ({ success: true }),
          },
          system: { getLocalIp: async () => "127.0.0.1", updateTitleBarOverlay: async () => {} },
          auth: {
            localAuth: async () => ({ success: true, token: "test-token", deviceId: "test-desktop" }),
            validateToken: async () => ({ valid: true }),
            getAccessCode: async () => "123456",
            getPendingRequests: async () => [],
          },
          remoteAccess: { getStatus: () => fetch("/api/remote-access").then(response => response.json()) },
          remoteHosts: {
            list: async () => hosts,
            onChange: (listener: (hosts: RemoteHostState[]) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
            discoverDevTunnels: async (interactive: boolean) => {
              state.calls.push(interactive);
              if (firstPending) {
                firstPending = false;
                return new Promise<DevTunnelDiscoveryResult>(resolve => { finish = resolve; });
              }
              return interactive ? ready : initial;
            },
            cancelDevTunnelDiscovery: async () => { state.cancelled += 1; finish?.(ready); },
            save: async (input: RemoteHostInput, id?: string) => {
              state.saved.push(input);
              const host: RemoteHostState = { ...input, name: input.name || "Remote", id: id || "saved-tunnel", createdAt: 1, updatedAt: 1, status: "disconnected" };
              const index = hosts.findIndex(value => value.id === host.id);
              if (index >= 0) hosts.splice(index, 1, host);
              else hosts.push(host);
              listeners.forEach(listener => listener([...hosts]));
              return host;
            },
            connect: async (id: string) => {
              state.connected.push(id);
              hosts.find(host => host.id === id)!.status = "connected";
              listeners.forEach(listener => listener([...hosts]));
            },
            disconnect: async () => {},
            remove: async () => {},
          },
        },
      });
    }, { initial, ready: discovered, pending });
    await setup(page);
    await page.getByTestId("add-host-devtunnel").click();
  }

  test.describe("Dev Tunnels connections and account discovery", () => {
    test("retains browser link connections without exposing account discovery", async ({ page }) => {
      await setup(page);
      await page.getByTestId("add-host-devtunnel").click();
      await expect(page.getByRole("dialog")).toContainText("Account discovery is available in CodeMux Desktop");
      await expect(page.getByTestId("devtunnel-discovery")).not.toBeVisible();
      await page.getByTestId("devtunnel-connect-url").fill("http://example.devtunnels.ms");
      await page.getByTestId("connect-host").click();
      await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Enter an HTTPS");
      await page.route(`${DISCOVERED_URL}/**`, route => route.fulfill({ contentType: "text/html", body: "<p>Remote login</p>" }));
      await page.getByTestId("devtunnel-connect-url").fill(DISCOVERED_URL);
      await page.getByTestId("connect-host").click();
      await expect(page).toHaveURL(`${DISCOVERED_URL}/?connect=1`);
    });

    test("logs in only on request, connects an owned online computer and reopens its tunnel editor", async ({ page }) => {
      await setupDiscovery(page, { status: "loginRequired", tunnels: [] });
      expect(await page.evaluate(() => (window as HarnessWindow).discoveryHarness.calls)).toEqual([false]);
      await page.getByTestId("devtunnel-discovery-login").click();
      await expect(page.getByTestId("devtunnel-discovery-list")).toBeVisible();
      expect(await page.evaluate(() => (window as HarnessWindow).discoveryHarness.calls)).toEqual([false, true]);
      const rows = page.getByTestId("devtunnel-discovery-list").getByRole("listitem");
      await expect(rows.nth(1).getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
      await rows.first().getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      const state = await page.evaluate(() => (window as HarnessWindow).discoveryHarness);
      expect(state.saved).toEqual([{ name: "Development PC", connection: { type: "direct", host: new URL(DISCOVERED_URL).hostname, port: 443, useTls: true } }]);
      expect(state.connected).toEqual(["saved-tunnel"]);
      await page.getByTestId("saved-host").locator("summary").click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("dialog").getByRole("heading", { level: 2 })).toHaveText("Microsoft Dev Tunnels");
      await expect(page.getByTestId("devtunnel-connect-url")).toHaveValue(DISCOVERED_URL);
    });

    for (const [status, message] of [
      ["unavailable", "Install the Microsoft devtunnel CLI on this computer"],
      ["error", "Dev Tunnels could not complete the request"],
      ["ready", "No tagged CodeMux computers found"],
    ] as const) {
      test(`explains ${status} discovery while retaining manual connection`, async ({ page }) => {
        await setupDiscovery(page, { status, tunnels: [] });
        await expect(page.getByTestId("devtunnel-discovery")).toContainText(message);
        await page.getByTestId("devtunnel-connect-url").fill(DISCOVERED_URL);
        await page.getByTestId("connect-host").click();
        await expect(page.getByTestId("saved-host")).toBeVisible();
      });
    }

    test("cancels discovery on leaving the dialog and ignores the late result", async ({ page }) => {
      await setupDiscovery(page, discovered, true);
      await expect(page.getByTestId("devtunnel-discovery").getByRole("status")).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).last().click();
      await expect(page.getByTestId("devtunnel-discovery")).not.toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as HarnessWindow).discoveryHarness.cancelled)).toBe(1);
      await page.getByRole("dialog").getByTestId("add-host-devtunnel").click();
      await expect(page.getByTestId("devtunnel-discovery-list").getByRole("listitem")).toHaveCount(2);
    });

    test("renders discovered computers on desktop, mobile, dark theme and Chinese", async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await setupDiscovery(page);
      await expect(page.getByTestId("devtunnel-discovery-list")).toBeVisible();
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      await page.screenshot({ path: testInfo.outputPath("discovery-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("connect-host")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("discovery-mobile.png"), fullPage: true });
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.screenshot({ path: testInfo.outputPath("discovery-mobile-dark.png"), fullPage: true });
      await page.evaluate(() => localStorage.setItem("settings:locale", JSON.stringify("zh")));
      await page.reload();
      await page.getByTestId("add-host-devtunnel").click();
      await expect(page.getByTestId("devtunnel-discovery")).toContainText("我的 CodeMux 电脑");
      await page.screenshot({ path: testInfo.outputPath("discovery-mobile-zh.png"), fullPage: true });
    });
  });
});
