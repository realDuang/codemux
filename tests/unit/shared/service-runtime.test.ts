import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { EngineManager } from "../../../electron/main/gateway/engine-manager";
import { ServiceRuntime, type ServiceRuntimeOptions } from "../../../shared/service-runtime";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFixture(webMode: ServiceRuntimeOptions["webMode"] = "dev-proxy") {
  const events: string[] = [];
  const sync = (name: string) => vi.fn((..._args: unknown[]) => { events.push(name); });
  const recordAsync = (name: string) => vi.fn(async (..._args: unknown[]) => { events.push(name); });
  const engineManager = {
    initFromStore: sync("routing:init"),
    stopAll: recordAsync("engines:stop"),
  };
  const engines = [
    ["First", { start: recordAsync("engine:first"), stop: recordAsync("engine:first:stop") }],
    ["Second", { start: recordAsync("engine:second"), stop: recordAsync("engine:second:stop") }],
  ] as const;
  const httpServer = createServer();
  const options = {
    webMode,
    webPort: 12340,
    gatewayPort: 12341,
    internalGatewayToken: "internal token",
    ensureDefaultWorkspace: sync("workspace:init"),
    deviceStore: { init: sync("devices:init") },
    conversationStore: { init: sync("conversations:init"), flushAll: recordAsync("conversations:flush") },
    // Only lifecycle methods are exercised; the scheduler receives this same instance.
    engineManager: engineManager as unknown as EngineManager,
    engines,
    scheduledTaskService: { init: sync("scheduler:init"), shutdown: recordAsync("scheduler:stop") },
    authApiServer: {
      setChannelManager: sync("auth:channels"), start: recordAsync("auth:start"), stop: recordAsync("auth:stop"),
    },
    productionServer: {
      setChannelManager: sync("http:channels"),
      start: vi.fn(async () => { events.push("http:start"); return 12345; }),
      stop: recordAsync("http:stop"),
      isRunning: vi.fn(() => webMode === "static"),
      getServer: vi.fn((): ReturnType<typeof createServer> | null => httpServer),
      getPort: vi.fn(() => 12345),
    },
    remoteAccessManager: { initialize: recordAsync("remote:init") },
    setRemoteAccessPort: sync("remote:port"),
    stopRemoteAccessTunnel: recordAsync("tunnel:stop"),
    gatewayServer: { start: sync("gateway:start"), stop: sync("gateway:stop") },
    closeGateway: undefined as ServiceRuntimeOptions["closeGateway"],
    channelManager: {
      setRuntimeOptions: sync("channels:options"),
      initFromConfig: recordAsync("channels:init"),
      stopAll: recordAsync("channels:stop"),
      listChannels: vi.fn(() => []),
      getConfig: vi.fn(),
      updateConfig: vi.fn(async () => {}),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      getStatus: vi.fn(),
    },
    webhookServer: { start: recordAsync("webhook:start"), stop: recordAsync("webhook:stop"), serverPort: 12342 },
    unwatchAll: sync("watchers:stop"),
    destroyTerminals: sync("terminals:stop"),
    log: { info: vi.fn(), error: vi.fn() },
  } satisfies ServiceRuntimeOptions;
  return { runtime: new ServiceRuntime(options), options, engineManager, events, httpServer };
}

describe("ServiceRuntime", () => {
  describe("initialize", () => {
    it("initializes persistence and routing before the scheduler without starting services", () => {
      const { runtime, options, events } = createFixture();
      expect(events).toEqual([]);
      expect(runtime.isStartupReady()).toBe(false);

      runtime.initialize();

      expect(events).toEqual([
        "workspace:init", "devices:init", "conversations:init", "routing:init", "scheduler:init",
      ]);
      expect(options.scheduledTaskService.init).toHaveBeenCalledWith(options.engineManager);
      expect(runtime.isStartupReady()).toBe(false);
    });
  });

  describe("start", () => {
    it("starts dev endpoints in order and returns while engines are still starting", async () => {
      const { runtime, options, events } = createFixture();
      const first = deferred();
      const second = deferred();
      options.engines[0][1].start.mockImplementation(() => {
        events.push("engine:first");
        return first.promise;
      });
      options.engines[1][1].start.mockImplementation(() => {
        events.push("engine:second");
        return second.promise;
      });

      runtime.initialize();
      events.push("ipc:register");
      await runtime.start();
      events.push("window:create", "tray:init");

      expect(events).toEqual([
        "workspace:init", "devices:init", "conversations:init", "routing:init", "scheduler:init",
        "ipc:register", "auth:channels", "auth:start", "remote:init", "gateway:start",
        "engine:first", "engine:second", "window:create", "tray:init",
      ]);
      expect(options.authApiServer.setChannelManager).toHaveBeenCalledWith(options.channelManager);
      expect(options.productionServer.start).not.toHaveBeenCalled();
      expect(options.gatewayServer.start).toHaveBeenCalledWith({ port: 12341 });
      expect(options.channelManager.initFromConfig).not.toHaveBeenCalled();

      const completion = runtime.completeStartup();
      first.resolve();
      await first.promise;
      expect(runtime.isStartupReady()).toBe(false);
      expect(options.webhookServer.start).not.toHaveBeenCalled();
      second.resolve();
      await completion;
      expect(runtime.isStartupReady()).toBe(true);
      expect(events.indexOf("channels:init")).toBeGreaterThan(events.indexOf("window:create"));
    });

    it("attaches the static gateway and channels to the actual HTTP port", async () => {
      const { runtime, options, events, httpServer } = createFixture("static");

      await runtime.start();
      await runtime.completeStartup();

      expect(events.slice(0, 6)).toEqual([
        "http:channels", "http:start", "remote:port", "remote:init", "gateway:start", "engine:first",
      ]);
      expect(options.productionServer.start).toHaveBeenCalledWith(12340);
      expect(options.productionServer.setChannelManager).toHaveBeenCalledWith(options.channelManager);
      expect(options.setRemoteAccessPort).toHaveBeenCalledWith(12345);
      expect(options.authApiServer.start).not.toHaveBeenCalled();
      expect(options.gatewayServer.start).toHaveBeenCalledWith({ server: httpServer, path: "/ws" });
      const channelOptions = options.channelManager.initFromConfig.mock.calls[0][0];
      expect(channelOptions).toEqual({ gatewayUrl: "ws://127.0.0.1:12345/ws?token=internal+token" });
      expect(options.channelManager.setRuntimeOptions).toHaveBeenCalledWith(channelOptions);
    });

    it.each(["stopped", "missing-server"])("keeps the standalone gateway fallback for a %s HTTP server", async (state) => {
      const { runtime, options } = createFixture("static");
      if (state === "stopped") options.productionServer.isRunning.mockReturnValue(false);
      else options.productionServer.getServer.mockReturnValue(null);

      await runtime.start();

      expect(options.gatewayServer.start).toHaveBeenCalledWith({ port: 12341 });
    });

    it.each(["dev-proxy", "static"] as const)("continues after network startup failures (web mode: %s)", async (webMode) => {
      const { runtime, options } = createFixture(webMode);
      const httpError = new Error("Port occupied");
      const remoteError = new Error("Tunnel unavailable");
      const gatewayError = new Error("Gateway port occupied");
      const http = webMode === "static" ? options.productionServer : options.authApiServer;
      http.start.mockRejectedValue(httpError);
      options.productionServer.isRunning.mockReturnValue(false);
      options.remoteAccessManager.initialize.mockRejectedValue(remoteError);
      options.gatewayServer.start.mockImplementation(() => { throw gatewayError; });

      await runtime.start();
      await runtime.completeStartup();

      expect(options.log.error).toHaveBeenCalledWith(
        `Failed to start ${webMode === "static" ? "Production" : "Auth API"} server:`, httpError,
      );
      expect(options.log.error).toHaveBeenCalledWith("Failed to initialize remote access:", remoteError);
      expect(options.log.error).toHaveBeenCalledWith("Failed to start Gateway server:", gatewayError);
      for (const [, engine] of options.engines) expect(engine.start).toHaveBeenCalledOnce();
      expect(options.channelManager.initFromConfig).toHaveBeenCalledWith({
        gatewayUrl: "ws://127.0.0.1:12341/?token=internal+token",
      });
      expect(runtime.isStartupReady()).toBe(true);
    });
  });

  describe("completeStartup", () => {
    it("defers channels until host setup and keeps readiness false until channel initialization settles", async () => {
      const { runtime, options, events } = createFixture("static");
      const webhook = deferred();
      const channels = deferred();
      options.webhookServer.start.mockImplementation(() => {
        events.push("webhook:start");
        return webhook.promise;
      });
      options.channelManager.initFromConfig.mockImplementation(() => {
        events.push("channels:init");
        return channels.promise;
      });

      await runtime.start();
      await Promise.resolve();
      expect(options.webhookServer.start).not.toHaveBeenCalled();
      events.push("window:create", "tray:init", "updater:init");
      const completion = runtime.completeStartup();
      await vi.waitFor(() => expect(options.webhookServer.start).toHaveBeenCalledOnce());
      expect(options.channelManager.initFromConfig).not.toHaveBeenCalled();
      expect(runtime.isStartupReady()).toBe(false);
      webhook.resolve();
      await vi.waitFor(() => expect(options.channelManager.initFromConfig).toHaveBeenCalledOnce());
      expect(runtime.isStartupReady()).toBe(false);
      channels.resolve();
      await completion;
      expect(runtime.isStartupReady()).toBe(true);
      expect(events.slice(-6)).toEqual([
        "window:create", "tray:init", "updater:init", "channels:options", "webhook:start", "channels:init",
      ]);
    });

    it.each([new Error("Engine unavailable"), { message: "Missing credentials" }, "Engine unavailable"])(
      "marks startup settled when engines, webhook, and channels fail: %s",
      async (engineError) => {
        const { runtime, options } = createFixture();
        const webhookError = new Error("Webhook port occupied");
        const channelError = new Error("Channel unavailable");
        options.engines[0][1].start.mockRejectedValue(engineError);
        options.webhookServer.start.mockRejectedValue(webhookError);
        options.channelManager.initFromConfig.mockRejectedValue(channelError);

        await runtime.start();
        await runtime.completeStartup();

        expect(options.log.error).toHaveBeenCalledWith(
          "First engine failed to start:", typeof engineError === "string" ? engineError : engineError.message,
        );
        expect(options.log.info).toHaveBeenCalledWith("Second engine started successfully");
        expect(options.log.error).toHaveBeenCalledWith("Failed to start channel webhook server:", webhookError);
        expect(options.log.error).toHaveBeenCalledWith("Failed to initialize channels:", channelError);
        expect(runtime.isStartupReady()).toBe(true);
      },
    );
  });

  describe("stop", () => {
    it("starts engine shutdown before pending startup settles and cleans up a late-spawned engine", async () => {
      const { runtime, options, engineManager } = createFixture();
      const starting = deferred();
      let childRunning = false;
      options.engines[0][1].start.mockImplementation(async () => {
        await starting.promise;
        childRunning = true;
      });
      engineManager.stopAll.mockImplementation(async () => { childRunning = false; });
      options.engines[0][1].stop.mockImplementation(async () => { childRunning = false; });
      await runtime.start();
      const completion = runtime.completeStartup();

      const stopping = runtime.stop();
      expect(runtime.stop()).toBe(stopping);
      expect(runtime.isStopping()).toBe(true);
      await vi.waitFor(() => expect(engineManager.stopAll).toHaveBeenCalledOnce());
      expect(options.engines[0][1].stop).not.toHaveBeenCalled();
      expect(options.webhookServer.start).not.toHaveBeenCalled();

      starting.resolve();
      await Promise.all([stopping, completion]);

      expect(childRunning).toBe(false);
      expect(engineManager.stopAll).toHaveBeenCalledOnce();
      expect(options.engines[0][1].stop).toHaveBeenCalledOnce();
      expect(options.engines[1][1].stop).not.toHaveBeenCalled();
      expect(options.channelManager.initFromConfig).not.toHaveBeenCalled();
      expect(runtime.isStartupReady()).toBe(false);
    });

    it.each(["webhook", "channels"] as const)("waits for pending %s startup before closing it without blocking engine shutdown", async (stage) => {
      const { runtime, options, engineManager, events } = createFixture();
      const starting = deferred();
      const start = stage === "webhook" ? options.webhookServer.start : options.channelManager.initFromConfig;
      start.mockImplementation(async () => {
        await starting.promise;
        events.push(`${stage}:late-start`);
      });
      await runtime.start();
      const completion = runtime.completeStartup();
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

      const stopping = runtime.stop();
      await vi.waitFor(() => expect(engineManager.stopAll).toHaveBeenCalledOnce());
      expect(options.channelManager.stopAll).not.toHaveBeenCalled();
      expect(options.webhookServer.stop).not.toHaveBeenCalled();
      expect(runtime.isStartupReady()).toBe(false);
      starting.resolve();
      await Promise.all([stopping, completion]);

      expect(events.indexOf("channels:stop")).toBeGreaterThan(events.indexOf(`${stage}:late-start`));
      expect(events.indexOf("webhook:stop")).toBeGreaterThan(events.indexOf(`${stage}:late-start`));
      if (stage === "webhook") expect(options.channelManager.initFromConfig).not.toHaveBeenCalled();
      expect(options.channelManager.stopAll).toHaveBeenCalledOnce();
      expect(options.webhookServer.stop).toHaveBeenCalledOnce();
      expect(runtime.isStartupReady()).toBe(false);
    });

    it.each(["dev-proxy", "static"] as const)("waits for an in-flight %s listener and prevents further startup", async (webMode) => {
      const { runtime, options, engineManager } = createFixture(webMode);
      const listening = deferred();
      if (webMode === "static") {
        options.productionServer.start.mockImplementation(async () => { await listening.promise; return 12345; });
      } else {
        options.authApiServer.start.mockReturnValue(listening.promise);
      }
      const start = runtime.start();
      const completion = runtime.completeStartup();

      const stopping = runtime.stop();
      await vi.waitFor(() => expect(engineManager.stopAll).toHaveBeenCalledOnce());
      expect(options.productionServer.stop).not.toHaveBeenCalled();
      expect(options.authApiServer.stop).not.toHaveBeenCalled();
      listening.resolve();
      await Promise.all([start, completion, stopping]);

      expect(options.remoteAccessManager.initialize).not.toHaveBeenCalled();
      expect(options.setRemoteAccessPort).not.toHaveBeenCalled();
      expect(options.gatewayServer.start).not.toHaveBeenCalled();
      for (const [, adapter] of options.engines) expect(adapter.start).not.toHaveBeenCalled();
      expect(options.webhookServer.start).not.toHaveBeenCalled();
      expect(options.productionServer.stop).toHaveBeenCalledOnce();
      expect(options.authApiServer.stop).toHaveBeenCalledOnce();
      expect(runtime.isStartupReady()).toBe(false);
    });

    it("closes a tunnel started by in-flight remote access initialization without launching engines", async () => {
      const { runtime, options, engineManager } = createFixture();
      const remote = deferred();
      options.remoteAccessManager.initialize.mockReturnValue(remote.promise);
      const start = runtime.start();
      await vi.waitFor(() => expect(options.remoteAccessManager.initialize).toHaveBeenCalledOnce());

      const stopping = runtime.stop();
      await vi.waitFor(() => expect(engineManager.stopAll).toHaveBeenCalledOnce());
      expect(options.stopRemoteAccessTunnel).not.toHaveBeenCalled();
      remote.resolve();
      await Promise.all([start, stopping]);

      expect(options.stopRemoteAccessTunnel).toHaveBeenCalledOnce();
      expect(options.gatewayServer.start).not.toHaveBeenCalled();
      for (const [, adapter] of options.engines) expect(adapter.start).not.toHaveBeenCalled();
    });

    it("awaits gateway closure before HTTP shutdown while stopping other services concurrently", async () => {
      const { runtime, options, engineManager } = createFixture();
      const closed = deferred();
      options.closeGateway = vi.fn(() => closed.promise);

      const stopping = runtime.stop();
      await vi.waitFor(() => expect(options.closeGateway).toHaveBeenCalledOnce());
      expect(options.gatewayServer.stop).toHaveBeenCalledOnce();
      expect(engineManager.stopAll).toHaveBeenCalledOnce();
      expect(options.channelManager.stopAll).toHaveBeenCalledOnce();
      expect(options.authApiServer.stop).not.toHaveBeenCalled();
      expect(options.productionServer.stop).not.toHaveBeenCalled();
      closed.resolve();
      await stopping;

      expect(options.authApiServer.stop).toHaveBeenCalledOnce();
      expect(options.productionServer.stop).toHaveBeenCalledOnce();
    });

    it("finishes other cleanup before reporting a gateway closure failure", async () => {
      const { runtime, options } = createFixture();
      const error = new Error("Gateway closure failed");
      const authStopped = deferred();
      options.closeGateway = vi.fn(async () => { throw error; });
      options.authApiServer.stop.mockReturnValue(authStopped.promise);
      let finished = false;
      const stopping = runtime.stop().then(
        () => { finished = true; },
        caught => { finished = true; return caught; },
      );
      await vi.waitFor(() => expect(options.authApiServer.stop).toHaveBeenCalledOnce());
      expect(options.productionServer.stop).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      authStopped.resolve();

      expect(await stopping).toBe(error);
    });

    it("runs normal cleanup once and prevents restarting a stopped runtime", async () => {
      const { runtime, options, engineManager, events } = createFixture();
      await runtime.start();
      await runtime.completeStartup();
      expect(runtime.isStartupReady()).toBe(true);

      const stopping = runtime.stop();
      expect(runtime.stop()).toBe(stopping);
      await stopping;
      const stoppedEvents = [...events];
      runtime.initialize();
      await runtime.start();
      await runtime.completeStartup();
      expect(runtime.stop()).toBe(stopping);

      expect(events).toEqual(stoppedEvents);
      expect(options.unwatchAll).toHaveBeenCalledOnce();
      expect(options.destroyTerminals).toHaveBeenCalledOnce();
      expect(options.conversationStore.flushAll).toHaveBeenCalledOnce();
      expect(options.gatewayServer.stop).toHaveBeenCalledOnce();
      expect(options.stopRemoteAccessTunnel).toHaveBeenCalledOnce();
      expect(options.authApiServer.stop).toHaveBeenCalledOnce();
      expect(options.productionServer.stop).toHaveBeenCalledOnce();
      expect(options.webhookServer.stop).toHaveBeenCalledOnce();
      expect(options.channelManager.stopAll).toHaveBeenCalledOnce();
      expect(engineManager.stopAll).toHaveBeenCalledOnce();
      expect(options.scheduledTaskService.shutdown).toHaveBeenCalledOnce();
      for (const [, adapter] of options.engines) expect(adapter.stop).not.toHaveBeenCalled();
      expect(runtime.isStopping()).toBe(true);
      expect(runtime.isStartupReady()).toBe(false);
    });

    it("stops native resources before flushing and closes gateway clients before concurrent service cleanup", async () => {
      const { runtime, options, engineManager, events } = createFixture();
      const flush = deferred();
      const engines = deferred();
      options.conversationStore.flushAll.mockImplementation(() => {
        events.push("conversations:flush");
        return flush.promise;
      });
      engineManager.stopAll.mockImplementation(() => {
        events.push("engines:stop");
        return engines.promise;
      });
      let stopped = false;

      const stopping = runtime.stop().then(() => { stopped = true; });
      expect(events).toEqual(["watchers:stop", "terminals:stop", "conversations:flush"]);
      flush.resolve();
      await flush.promise;

      expect(events).toEqual([
        "watchers:stop", "terminals:stop", "conversations:flush", "gateway:stop",
        "tunnel:stop", "auth:stop", "channels:stop", "webhook:stop", "engines:stop", "http:stop", "scheduler:stop",
      ]);
      expect(stopped).toBe(false);
      engines.resolve();
      await stopping;
      expect(stopped).toBe(true);
    });

    it("propagates a cleanup failure to the host after starting all asynchronous cleanup", async () => {
      const { runtime, options, events } = createFixture();
      const error = new Error("Tunnel stop failed");
      options.stopRemoteAccessTunnel.mockRejectedValue(error);

      await expect(runtime.stop()).rejects.toBe(error);

      expect(events).toContain("scheduler:stop");
      expect(options.productionServer.stop).toHaveBeenCalledOnce();
    });

    it("preserves the early exit when conversation flushing fails", async () => {
      const { runtime, options, events } = createFixture();
      const error = new Error("Storage unavailable");
      options.conversationStore.flushAll.mockRejectedValue(error);

      await expect(runtime.stop()).rejects.toBe(error);

      expect(events).toEqual(["watchers:stop", "terminals:stop"]);
      expect(options.gatewayServer.stop).not.toHaveBeenCalled();
    });
  });

  describe("stopForUpdate", () => {
    it("prevents pending startup from becoming ready while retaining update-only cleanup", async () => {
      const { runtime, options, engineManager } = createFixture();
      const engine = deferred();
      options.engines[0][1].start.mockReturnValue(engine.promise);
      options.closeGateway = vi.fn(async () => {});
      await runtime.start();
      const completion = runtime.completeStartup();

      const stopping = runtime.stopForUpdate();
      expect(runtime.stopForUpdate()).toBe(stopping);
      expect(runtime.isStopping()).toBe(true);
      await stopping;
      engine.resolve();
      await completion;

      expect(options.webhookServer.start).not.toHaveBeenCalled();
      expect(options.channelManager.initFromConfig).not.toHaveBeenCalled();
      expect(engineManager.stopAll).not.toHaveBeenCalled();
      expect(options.closeGateway).not.toHaveBeenCalled();
      expect(options.gatewayServer.stop).toHaveBeenCalledOnce();
      expect(runtime.isStartupReady()).toBe(false);
    });

    it("keeps the update cleanup sequence separate from normal service shutdown", async () => {
      const { runtime, options, events } = createFixture();
      const flush = deferred();
      const scheduler = deferred();
      options.conversationStore.flushAll.mockImplementation(() => {
        events.push("conversations:flush");
        return flush.promise;
      });
      options.scheduledTaskService.shutdown.mockImplementation(() => {
        events.push("scheduler:stop");
        return scheduler.promise;
      });

      const stopping = runtime.stopForUpdate();
      expect(events).toEqual(["conversations:flush"]);
      flush.resolve();
      await flush.promise;
      expect(events).toEqual(["conversations:flush", "scheduler:stop"]);
      scheduler.resolve();
      await stopping;

      expect(events).toEqual([
        "conversations:flush", "scheduler:stop", "terminals:stop", "gateway:stop", "tunnel:stop",
      ]);
      expect(options.unwatchAll).not.toHaveBeenCalled();
      expect(options.channelManager.stopAll).not.toHaveBeenCalled();
      expect(options.productionServer.stop).not.toHaveBeenCalled();
    });

    it("preserves update cleanup failure propagation without entering normal shutdown", async () => {
      const { runtime, options } = createFixture();
      const error = new Error("Scheduler flush failed");
      options.scheduledTaskService.shutdown.mockRejectedValue(error);

      await expect(runtime.stopForUpdate()).rejects.toBe(error);

      expect(options.destroyTerminals).not.toHaveBeenCalled();
      expect(options.authApiServer.stop).not.toHaveBeenCalled();
      expect(options.unwatchAll).not.toHaveBeenCalled();
    });
  });
});
