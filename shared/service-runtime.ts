import type { ChannelManager } from "../electron/main/channels/channel-manager";
import type { WebhookServer } from "../electron/main/channels/webhook-server";
import type { EngineAdapter } from "../electron/main/engines/engine-adapter";
import type { EngineManager } from "../electron/main/gateway/engine-manager";
import type { GatewayServer } from "../electron/main/gateway/ws-server";
import type { authApiServer } from "../electron/main/services/auth-api-server";
import type { conversationStore } from "../electron/main/services/conversation-store";
import type { deviceStore } from "../electron/main/services/device-store";
import type { ScopedLogger } from "../electron/main/services/logger";
import type { productionServer } from "../electron/main/services/production-server";
import type { ScheduledTaskService } from "../electron/main/services/scheduled-task-service";
import type { ChannelManagerRoutes } from "./channel-route-handlers";
import type { RemoteAccessController } from "./remote-access-controller";

export interface ServiceRuntimeOptions {
  webMode: "static" | "dev-proxy";
  webPort: number;
  gatewayPort: number;
  internalGatewayToken: string;
  ensureDefaultWorkspace: () => void;
  deviceStore: Pick<typeof deviceStore, "init">;
  conversationStore: Pick<typeof conversationStore, "init" | "flushAll">;
  engineManager: EngineManager;
  engines: ReadonlyArray<readonly [name: string, adapter: Pick<EngineAdapter, "start" | "stop">]>;
  scheduledTaskService: Pick<ScheduledTaskService, "init" | "shutdown">;
  authApiServer: Pick<typeof authApiServer, "setChannelManager" | "start" | "stop">;
  productionServer: Pick<typeof productionServer, "setChannelManager" | "start" | "stop" | "isRunning" | "getServer" | "getPort">;
  remoteAccessManager: Pick<RemoteAccessController, "initialize">;
  setRemoteAccessPort: (port: number) => void;
  stopRemoteAccessTunnel: () => Promise<void>;
  gatewayServer: Pick<GatewayServer, "start" | "stop">;
  closeGateway?: () => Promise<void>;
  channelManager: Pick<ChannelManager, "setRuntimeOptions" | "initFromConfig" | "stopAll" | keyof ChannelManagerRoutes>;
  webhookServer: Pick<WebhookServer, "start" | "stop" | "serverPort">;
  unwatchAll: () => void;
  destroyTerminals: () => void;
  log: Pick<ScopedLogger, "info" | "error">;
}

interface EngineStartup {
  adapter: Pick<EngineAdapter, "start" | "stop">;
  promise: Promise<void>;
  settled: boolean;
}

function afterSettled(pending: Promise<unknown> | undefined, cleanup: () => Promise<void>): Promise<void> {
  return pending ? pending.then(cleanup, cleanup) : cleanup();
}

async function finishCleanup(cleanups: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(cleanups);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/** Service lifecycle shared by hosts; window and process ownership stay with the caller. */
export class ServiceRuntime {
  private engineStarts: EngineStartup[] = [];
  private startupReady = false;
  private stopping = false;
  private startPromise: Promise<void> | undefined;
  private networkStartup: Promise<void> | undefined;
  private completionPromise: Promise<void> | undefined;
  private channelStartup: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(private options: ServiceRuntimeOptions) {}

  isStartupReady(): boolean {
    return this.startupReady;
  }

  isStopping(): boolean {
    return this.stopping;
  }

  initialize(): void {
    if (this.stopping) return;
    const services = this.options;
    services.ensureDefaultWorkspace();
    services.deviceStore.init();
    services.conversationStore.init();
    services.engineManager.initFromStore();
    services.scheduledTaskService.init(services.engineManager);
  }

  /** Start the network endpoints and launch engines without waiting for them. */
  start(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (!this.startPromise) {
      this.startPromise = this.startServices().finally(() => { this.networkStartup = undefined; });
      this.networkStartup = this.startPromise;
    }
    return this.startPromise;
  }

  private async startServices(): Promise<void> {
    const services = this.options;
    const { log } = services;

    if (services.webMode === "dev-proxy") {
      try {
        services.authApiServer.setChannelManager(services.channelManager);
        await services.authApiServer.start();
      } catch (err) {
        log.error("Failed to start Auth API server:", err);
      }
    } else {
      try {
        services.productionServer.setChannelManager(services.channelManager);
        const port = await services.productionServer.start(services.webPort);
        if (this.stopping) return;
        services.setRemoteAccessPort(port);
        log.info(`Production server started on port ${port}`);
      } catch (err) {
        log.error("Failed to start Production server:", err);
      }
    }

    if (this.stopping) return;
    await services.remoteAccessManager.initialize().catch(error => {
      log.error("Failed to initialize remote access:", error);
    });

    if (this.stopping) return;
    try {
      if (services.webMode === "static" && services.productionServer.isRunning()) {
        const httpServer = services.productionServer.getServer();
        if (httpServer) {
          services.gatewayServer.start({ server: httpServer, path: "/ws" });
          log.info("Gateway server attached to production server at /ws");
        } else {
          services.gatewayServer.start({ port: services.gatewayPort });
          log.info(`Gateway server started on port ${services.gatewayPort}`);
        }
      } else {
        services.gatewayServer.start({ port: services.gatewayPort });
        log.info(`Gateway server started on port ${services.gatewayPort}`);
      }
    } catch (err) {
      log.error("Failed to start Gateway server:", err);
    }

    for (const [name, adapter] of services.engines) {
      if (this.stopping) return;
      const startup: EngineStartup = { adapter, promise: Promise.resolve(), settled: false };
      this.engineStarts.push(startup);
      startup.promise = adapter.start().then(
        () => log.info(`${name} engine started successfully`),
        err => log.error(`${name} engine failed to start:`, err?.message ?? err),
      ).finally(() => { startup.settled = true; });
    }
  }

  /** Call after host UI setup, even when engines settle immediately. */
  completeStartup(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.completionPromise ??= this.finishStartup();
    return this.completionPromise;
  }

  private async finishStartup(): Promise<void> {
    await this.startPromise;
    if (this.stopping) return;
    await Promise.allSettled(this.engineStarts.map(startup => startup.promise));
    if (this.stopping) return;
    this.channelStartup = this.startChannels().finally(() => { this.channelStartup = undefined; });
    await this.channelStartup;
  }

  private async startChannels(): Promise<void> {
    const services = this.options;
    const { log } = services;
    log.info("All engines settled");

    const gatewayBaseUrl = services.webMode === "static" && services.productionServer.isRunning()
      ? `ws://127.0.0.1:${services.productionServer.getPort()}/ws`
      : `ws://127.0.0.1:${services.gatewayPort}`;
    const internalGatewayUrl = new URL(gatewayBaseUrl);
    internalGatewayUrl.searchParams.set("token", services.internalGatewayToken);
    const gatewayUrl = internalGatewayUrl.toString();
    services.channelManager.setRuntimeOptions({ gatewayUrl });

    try {
      await services.webhookServer.start();
      log.info(`Webhook server started on port ${services.webhookServer.serverPort}`);
    } catch (err) {
      log.error("Failed to start channel webhook server:", err);
    }

    if (this.stopping) return;
    try {
      await services.channelManager.initFromConfig({ gatewayUrl });
    } catch (err) {
      log.error("Failed to initialize channels:", err);
    }

    if (this.stopping) return;
    // Readiness means initialization settled, including unavailable engines/channels.
    this.startupReady = true;
    log.info("All engines and channels settled, startup ready");
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true;
      this.startupReady = false;
      const pendingEngines = this.engineStarts.filter(startup => !startup.settled);
      this.stopPromise = this.stopServices(pendingEngines);
    }
    return this.stopPromise;
  }

  private async stopServices(pendingEngines: EngineStartup[]): Promise<void> {
    const services = this.options;
    // Tear down native watchers and PTYs before persistence and engine shutdown.
    services.unwatchAll();
    services.destroyTerminals();
    await services.conversationStore.flushAll();

    // HTTP server.close waits for upgraded WebSockets to disconnect.
    services.gatewayServer.stop();
    const gatewayClosed = services.closeGateway?.();
    const httpStartup = this.networkStartup || gatewayClosed
      ? Promise.allSettled([this.networkStartup, gatewayClosed])
      : undefined;
    await finishCleanup([
      afterSettled(this.networkStartup, () => services.stopRemoteAccessTunnel()),
      afterSettled(httpStartup, () => services.authApiServer.stop()),
      afterSettled(this.channelStartup, () => services.channelManager.stopAll()),
      afterSettled(this.channelStartup, () => services.webhookServer.stop()),
      this.stopEngines(pendingEngines),
      afterSettled(httpStartup, () => services.productionServer.stop()),
      services.scheduledTaskService.shutdown(),
      gatewayClosed ?? Promise.resolve(),
    ]);
  }

  private stopEngines(pending: EngineStartup[]): Promise<void> {
    // Start cancellation immediately; an adapter may not settle until stop is called.
    const stopped = this.options.engineManager.stopAll();
    if (pending.length === 0) return stopped;
    return finishCleanup([
      stopped,
      ...pending.map(startup => afterSettled(
        Promise.allSettled([stopped, startup.promise]),
        // Some SDKs finish spawning after stop. Clean up only those late starts.
        () => startup.adapter.stop(),
      )),
    ]);
  }

  /** Preserve the updater's shorter cleanup path while its normal quit proceeds. */
  stopForUpdate(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true;
      this.startupReady = false;
      this.stopPromise = this.stopUpdateServices();
    }
    return this.stopPromise;
  }

  private async stopUpdateServices(): Promise<void> {
    const services = this.options;
    await services.conversationStore.flushAll();
    await services.scheduledTaskService.shutdown();
    services.destroyTerminals();
    services.gatewayServer.stop();
    await services.stopRemoteAccessTunnel();
  }
}
