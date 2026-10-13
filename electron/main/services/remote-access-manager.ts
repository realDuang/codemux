import { RemoteAccessController } from "../../../shared/remote-access-controller";
import { WEB_PORT } from "../../../shared/ports";
import { loadSettings, saveSettings, mainLog } from "./logger";
import { tunnelManager } from "./tunnel-manager";

let webPort = WEB_PORT;

export const remoteAccessManager = new RemoteAccessController({
  loadSettings,
  saveSettings,
  tunnel: tunnelManager,
  getPort: () => webPort,
});

export function setRemoteAccessPort(port: number): void {
  webPort = port;
}

tunnelManager.setOnUnexpectedExit(() => {
  if (remoteAccessManager.getStatus().mode === "cloudflare") {
    void remoteAccessManager.update({ mode: "off" }).catch(error => {
      mainLog.error("Failed to persist remote access shutdown:", error);
    });
  }
});

export async function stopRemoteAccessTunnel(): Promise<void> {
  await tunnelManager.stop();
}
