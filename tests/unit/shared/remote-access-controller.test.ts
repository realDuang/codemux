import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { RemoteAccessController } from "../../../shared/remote-access-controller";
import type { RemoteAccessStatus, RemoteAccessTunnelInfo } from "../../../shared/remote-access";

const CUSTOM_URL = "http://192.168.31.123:18233";
const CLOUDFLARE_URL = "https://codemux.example.com";

function request(host = "192.168.31.123:18233", remoteAddress = "192.168.31.2"): IncomingMessage {
  return { headers: { host }, socket: { remoteAddress } } as IncomingMessage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(initialSettings: Record<string, unknown> = {}, cloudflareAvailable = true) {
  let settings = { ...initialSettings };
  let tunnelInfo: RemoteAccessTunnelInfo = { status: "stopped", url: "" };
  const events: string[] = [];
  const saveSettings = vi.fn(async (patch: Record<string, unknown>) => {
    events.push(`save:${patch.remoteAccessMode}`);
    settings = { ...settings, ...patch };
  });
  const stop = vi.fn(async () => {
    events.push("stop");
    tunnelInfo = { status: "stopped", url: "" };
  });
  const start = vi.fn(async (): Promise<RemoteAccessTunnelInfo> => {
    events.push("start");
    tunnelInfo = { status: "running", url: CLOUDFLARE_URL };
    return tunnelInfo;
  });
  const controller = new RemoteAccessController({
    loadSettings: () => settings,
    saveSettings,
    tunnel: { start, stop, getInfo: () => tunnelInfo },
    getPort: () => 8233,
    cloudflareAvailable,
  });
  return {
    controller, saveSettings, stop, start, events,
    getSettings: () => settings,
    setTunnelInfo: (info: RemoteAccessTunnelInfo) => { tunnelInfo = info; },
  };
}

describe("RemoteAccessController", () => {
  describe("initialize", () => {
    it("defaults new installations to off even when a Cloudflare hostname is saved", async () => {
      const host = fixture({ tunnelConfig: { hostname: "codemux.example.com" } });
      await Promise.all([host.controller.initialize(), host.controller.initialize()]);

      expect(host.controller.getStatus()).toMatchObject({ mode: "off", url: "" });
      expect(host.getSettings().remoteAccessMode).toBe("off");
      expect(host.start).not.toHaveBeenCalled();
      expect(host.stop).toHaveBeenCalledTimes(1);
      expect(host.controller.isRequestAllowed(request())).toBe(false);
      expect(host.controller.isRequestAllowed(request("localhost:8233", "127.0.0.1"))).toBe(true);
    });

    it.each([
      [" http://192.168.31.123:18233/ ", "custom", CUSTOM_URL],
      ["https://example.com/path", "off", ""],
      ["", "off", ""],
    ])("migrates legacy custom address %j without starting Cloudflare", async (customAccessUrl, mode, url) => {
      const host = fixture({ customAccessUrl });
      await host.controller.initialize();

      expect(host.controller.getStatus()).toMatchObject({ mode, url, customAccessUrl: url });
      expect(host.getSettings().remoteAccessMode).toBe(mode);
      expect(host.start).not.toHaveBeenCalled();
    });

    it("restores an explicitly enabled Cloudflare mode only during initialization", async () => {
      const host = fixture({ remoteAccessMode: "cloudflare", tunnelConfig: { hostname: "codemux.example.com" } });
      expect(host.controller.getStatus().mode).toBe("off");
      expect(host.start).not.toHaveBeenCalled();

      await host.controller.initialize();

      expect(host.start).toHaveBeenCalledWith(8233, { hostname: "codemux.example.com" });
      expect(host.controller.getStatus()).toMatchObject({ mode: "cloudflare", url: CLOUDFLARE_URL });
    });
  });

  describe("update", () => {
    it.each(["", "https://codemux.example.com/path", "https://user:secret@example.com"])(
      "rejects unusable custom address %j before changing the active entry", async (customAccessUrl) => {
        const host = fixture({ remoteAccessMode: "custom", customAccessUrl: CUSTOM_URL });

        await expect(host.controller.update({ mode: "custom", customAccessUrl })).rejects.toThrow();

        expect(host.controller.getStatus()).toMatchObject({ mode: "custom", url: CUSTOM_URL });
        expect(host.controller.isRequestAllowed(request())).toBe(true);
        expect(host.stop).not.toHaveBeenCalled();
        expect(host.start).not.toHaveBeenCalled();
        expect(host.saveSettings).not.toHaveBeenCalled();
      },
    );

    it("disables admission while waiting for Cloudflare shutdown and host persistence", async () => {
      const host = fixture({ remoteAccessMode: "cloudflare", customAccessUrl: CUSTOM_URL });
      await host.controller.initialize();
      host.events.length = 0;
      const stopped = deferred<void>();
      const saved = deferred<void>();
      host.stop.mockImplementationOnce(async () => {
        host.events.push("stop-begin");
        await stopped.promise;
        host.setTunnelInfo({ status: "stopped", url: "" });
        host.events.push("stop-end");
      });
      host.saveSettings.mockImplementationOnce(async () => {
        host.events.push("save-begin");
        await saved.promise;
        host.events.push("save-end");
      });

      const updating = host.controller.update({ mode: "custom" });
      await vi.waitFor(() => expect(host.events).toEqual(["stop-begin"]));
      expect(host.controller.getStatus()).toMatchObject({ mode: "off", url: "", tunnel: { status: "running" } });
      expect(host.controller.isRequestAllowed(request())).toBe(false);
      expect(host.controller.isRequestAllowed(request("codemux.example.com"))).toBe(false);

      stopped.resolve();
      await vi.waitFor(() => expect(host.events).toContain("save-begin"));
      expect(host.controller.isRequestAllowed(request())).toBe(false);
      saved.resolve();
      expect(await updating).toMatchObject({ mode: "custom", url: CUSTOM_URL, tunnel: { status: "stopped" } });
      expect(host.events).toEqual(["stop-begin", "stop-end", "save-begin", "save-end"]);
      expect(host.controller.isRequestAllowed(request())).toBe(true);
      expect(host.controller.isRequestAllowed(request("codemux.example.com"))).toBe(false);
    });

    it("serializes conflicting mode changes and preserves the custom address while disabled", async () => {
      const host = fixture({ remoteAccessMode: "custom", customAccessUrl: CUSTOM_URL });
      const firstStop = deferred<void>();
      host.stop.mockImplementationOnce(async () => {
        host.events.push("stop-begin");
        await firstStop.promise;
        host.events.push("stop-end");
      });
      const cloudflare = host.controller.update({ mode: "cloudflare", tunnelConfig: { hostname: "codemux.example.com" } });
      const disabled = host.controller.update({ mode: "off" });
      await vi.waitFor(() => expect(host.events).toEqual(["stop-begin"]));
      expect(host.start).not.toHaveBeenCalled();

      firstStop.resolve();
      expect(await cloudflare).toMatchObject({ mode: "cloudflare", url: CLOUDFLARE_URL });
      expect(await disabled).toMatchObject({
        mode: "off", url: "", customAccessUrl: CUSTOM_URL,
        tunnelConfig: { hostname: "codemux.example.com" }, tunnel: { status: "stopped" },
      });
      expect(host.events).toEqual(["stop-begin", "stop-end", "start", "save:cloudflare", "stop", "save:off"]);
      expect(host.getSettings()).toMatchObject({ remoteAccessMode: "off", customAccessUrl: CUSTOM_URL, tunnelConfig: { hostname: "codemux.example.com" } });
      expect(host.controller.isRequestAllowed(request())).toBe(false);
    });

    it("fails closed when Cloudflare cannot be stopped and accepts a later retry", async () => {
      const host = fixture({ remoteAccessMode: "cloudflare", customAccessUrl: CUSTOM_URL });
      await host.controller.initialize();
      host.stop.mockRejectedValueOnce(new Error("shutdown deadline")).mockRejectedValueOnce(new Error("still running"));

      await expect(host.controller.update({ mode: "custom" })).rejects.toThrow("shutdown deadline");

      expect(host.controller.getStatus()).toMatchObject({ mode: "off", url: "", tunnel: { status: "running" } });
      expect(host.getSettings().remoteAccessMode).toBe("off");
      expect(host.controller.isRequestAllowed(request())).toBe(false);
      expect(host.controller.isRequestAllowed(request("codemux.example.com"))).toBe(false);
      expect(await host.controller.update({ mode: "custom" })).toMatchObject({ mode: "custom", url: CUSTOM_URL, tunnel: { status: "stopped" } });
    });

    it("withdraws a failed Cloudflare start and retains saved configuration", async () => {
      const host = fixture({ remoteAccessMode: "custom", customAccessUrl: CUSTOM_URL, tunnelConfig: { hostname: "old.example.com" } });
      host.start.mockImplementationOnce(async () => {
        host.setTunnelInfo({ status: "error", url: "", error: "credentials missing" });
        return { status: "error", url: "", error: "credentials missing" };
      });

      await expect(host.controller.update({ mode: "cloudflare", tunnelConfig: { hostname: "new.example.com" } })).rejects.toThrow("credentials missing");

      expect(host.controller.getStatus()).toMatchObject({ mode: "off", customAccessUrl: CUSTOM_URL, tunnelConfig: { hostname: "old.example.com" }, tunnel: { status: "stopped" } });
      expect(host.getSettings()).toMatchObject({ remoteAccessMode: "off", customAccessUrl: CUSTOM_URL, tunnelConfig: { hostname: "old.example.com" } });
      expect(host.stop).toHaveBeenCalledTimes(2);
      expect(host.controller.isRequestAllowed(request())).toBe(false);
    });

    it("stops a newly started tunnel when saving the selected mode fails", async () => {
      const host = fixture({ remoteAccessMode: "custom", customAccessUrl: CUSTOM_URL });
      host.saveSettings.mockRejectedValueOnce(new Error("disk full"));

      await expect(host.controller.update({ mode: "cloudflare" })).rejects.toThrow("disk full");

      expect(host.controller.getStatus()).toMatchObject({ mode: "off", url: "", customAccessUrl: CUSTOM_URL, tunnel: { status: "stopped" } });
      expect(host.stop).toHaveBeenCalledTimes(2);
      expect(host.getSettings().remoteAccessMode).toBe("off");
      expect(host.controller.isRequestAllowed(request("codemux.example.com"))).toBe(false);
    });

    it("keeps admission closed even when both persistence and cleanup fail", async () => {
      const host = fixture({ remoteAccessMode: "custom", customAccessUrl: CUSTOM_URL });
      host.saveSettings.mockRejectedValue(new Error("disk full"));
      host.stop.mockImplementationOnce(async () => undefined).mockRejectedValueOnce(new Error("shutdown failed"));

      await expect(host.controller.update({ mode: "cloudflare" })).rejects.toThrow("disk full");

      expect(host.controller.getStatus()).toMatchObject({ mode: "off", url: "", tunnel: { status: "running" } });
      expect(host.controller.isRequestAllowed(request())).toBe(false);
      expect(host.controller.isRequestAllowed(request("codemux.example.com"))).toBe(false);
    });

    it("rejects Cloudflare on a host that cannot control it without disabling working custom access", async () => {
      const host = fixture({ remoteAccessMode: "custom", customAccessUrl: CUSTOM_URL }, false);

      await expect(host.controller.update({ mode: "cloudflare" })).rejects.toThrow("unavailable");

      expect(host.controller.getStatus()).toMatchObject({ mode: "custom", url: CUSTOM_URL, cloudflareAvailable: false });
      expect(host.stop).not.toHaveBeenCalled();
      expect(host.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe("subscribe", () => {
    it("reports only off during a provider switch and stops notifying after unsubscribe", async () => {
      const host = fixture({ remoteAccessMode: "custom", customAccessUrl: CUSTOM_URL });
      const statuses: RemoteAccessStatus[] = [];
      const unsubscribe = host.controller.subscribe(status => statuses.push(status));

      await host.controller.update({ mode: "cloudflare" });

      expect(statuses.map(status => status.mode)).toEqual(["off", "cloudflare"]);
      expect(statuses[0].url).toBe("");
      unsubscribe();
      await host.controller.update({ mode: "off" });
      expect(statuses).toHaveLength(2);
    });
  });
});
