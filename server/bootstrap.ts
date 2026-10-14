import { runtimeHost } from "#runtime-host";
import { acquireRuntimeLock, type RuntimeLock } from "../shared/runtime-lock";
import { createServiceHost, type ServiceHost } from "./service-host";
import { mainLog } from "../electron/main/services/logger";
import { terminateOwnedChildren } from "../shared/terminate-owned-children";
import { startHostControlServer, type HostControlServer } from "../shared/host-control-server";
import { sendDesktopMessage, serverRuntimeRole, watchRuntimeParent } from "./runtime-role";
import { authApiServer } from "../electron/main/services/auth-api-server";
import { GATEWAY_PORT, WEB_PORT } from "../shared/ports";

export async function startServer(): Promise<void> {
  let host: ServiceHost | undefined;
  let ownership: RuntimeLock | undefined;
  let controlStartup: Promise<HostControlServer> | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let exitCode = 0;

  const ownershipPromise = acquireRuntimeLock(runtimeHost.paths.userDataPath, {
    onCompromised: () => {
      // Another host may own these files now. Do not run persistence or release hooks.
      process.stderr.write("Runtime data ownership was lost; exiting without saving state.\n");
      terminateOwnedChildren();
      process.exit(1);
    },
  });

  function stop(code = 0): Promise<void> {
    exitCode = Math.max(exitCode, code);
    if (stopPromise) return stopPromise;
    stopping = true;
    // Individual SDKs can fail to settle; a host must still honor service-manager stop.
    const deadline = setTimeout(() => {
      mainLog.error("Server shutdown timed out");
      terminateOwnedChildren();
      process.exit(1);
    }, 30_000);
    deadline.unref();
    stopPromise = (async () => {
      try {
        const control = await controlStartup?.catch(() => undefined);
        try {
          await control?.close();
        } catch (error) {
          exitCode = 1;
          mainLog.error("Control endpoint cleanup failed:", error);
        }
        await host?.stop();
      } catch (error) {
        mainLog.error("Server cleanup failed:", error);
        // Pending writes may still own this data. Release only through the process
        // exit hook, after synchronously terminating children and ending JavaScript.
        terminateOwnedChildren();
        clearTimeout(deadline);
        return process.exit(1);
      }
      try {
        // A signal may arrive before host creation while the lock is being acquired.
        ownership ??= await ownershipPromise.catch(() => undefined);
        await ownership?.release();
      } catch (error) {
        exitCode = 1;
        mainLog.error("Runtime ownership cleanup failed:", error);
      } finally {
        clearTimeout(deadline);
        process.exit(exitCode);
      }
    })();
    return stopPromise;
  }

  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  watchRuntimeParent(serverRuntimeRole, () => { void stop(); });
  process.on("uncaughtException", error => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      mainLog.warn("Suppressed EPIPE error:", error.message);
      return;
    }
    mainLog.error("Uncaught server exception:", error);
    void stop(1);
  });
  process.on("unhandledRejection", error => {
    mainLog.error("Unhandled server rejection:", error);
    void stop(1);
  });

  try {
    ownership = await ownershipPromise;
    if (stopping) return;
    host = createServiceHost(serverRuntimeRole.webMode);
    host.runtime.initialize();
    const services = host;
    controlStartup = startHostControlServer({
      dataPath: ownership.dataPath,
      invoke: (method, args) => services.management.invoke(method, args),
      getStatus: () => ({
        ...services.getStatus(),
        dataPath: ownership!.dataPath,
        ...(serverRuntimeRole.kind === "desktop" ? { desktopParentPid: serverRuntimeRole.desktopParentPid } : {}),
        ...(serverRuntimeRole.kind === "standalone" && serverRuntimeRole.webMode === "dev-proxy"
          && serverRuntimeRole.developmentParentPid !== undefined
          ? { developmentParentPid: serverRuntimeRole.developmentParentPid } : {}),
      }),
      stop: () => stop(),
    });
    await controlStartup;
    if (stopping) return;
    sendDesktopMessage(serverRuntimeRole, { type: "codemux.control", pid: process.pid });
    await host.runtime.start();
    if (stopping) return;
    // A separately bound WebSocket server reports its address on the next loop turn.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (stopping) return;
    if (serverRuntimeRole.webMode === "static") {
      if (!host.productionServer.getServer()?.listening) {
        throw new Error("The CodeMux HTTP server did not start");
      }
      if (host.gatewayServer.getPort() !== host.productionServer.getPort()) {
        throw new Error("The CodeMux WebSocket gateway did not attach to the HTTP server");
      }
    } else {
      if (!authApiServer.isRunning()) throw new Error("The CodeMux Auth API server did not start");
      if (host.gatewayServer.getPort() !== GATEWAY_PORT) {
        throw new Error("The CodeMux WebSocket gateway did not start");
      }
    }
    const port = serverRuntimeRole.webMode === "static" ? host.productionServer.getPort() : WEB_PORT;
    sendDesktopMessage(serverRuntimeRole, { type: "codemux.listening", pid: process.pid, port });
    await host.runtime.completeStartup();
    if (stopping) return;
    const status = {
      type: "codemux.ready",
      pid: process.pid,
      port,
      dataPath: ownership.dataPath,
    };
    if (serverRuntimeRole.kind === "desktop") sendDesktopMessage(serverRuntimeRole, status);
    else process.send?.(status);
    console.log(JSON.stringify(status));
  } catch (error) {
    mainLog.error("Failed to start CodeMux server:", error);
    await stop(1);
  }
}
