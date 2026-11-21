import { RemoteAccessController } from "../shared/remote-access-controller";
import { WEB_STANDALONE_PORT } from "../shared/ports";
import { loadSettings, saveSettings } from "./settings-store";
import { tunnelManager } from "./tunnel-manager";
import { DevTunnelManager } from "../shared/dev-tunnel-manager";

const devTunnelManager = new DevTunnelManager({ loadSettings, saveSettings });

/** Standalone hosts use the same policy authority as Electron's main process. */
export const remoteAccessManager = new RemoteAccessController({
  loadSettings,
  saveSettings,
  tunnel: tunnelManager,
  getPort: () => WEB_STANDALONE_PORT,
  devTunnel: devTunnelManager,
});

tunnelManager.setOnUnexpectedExit(() => {
  if (remoteAccessManager.getStatus().mode === "cloudflare") {
    void remoteAccessManager.update({ mode: "off" }).catch(error => {
      console.error("[Remote Access] Failed to persist connector shutdown:", error);
    });
  }
});
