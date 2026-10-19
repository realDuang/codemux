import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { RemoteHostInput } from "../../shared/remote-hosts";
import type { RemoteHostManager } from "./remote-host-manager";

/** Only the local shell's main frame may open network connections on this computer. */
export function registerRemoteHostIpc(manager: RemoteHostManager, getWindow: () => BrowserWindow | null): void {
  const guard = (event: IpcMainInvokeEvent) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("Remote host management is available only in the local desktop");
    }
  };
  const hostId = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.length > 128) throw new Error("Invalid host ID");
    return value;
  };
  ipcMain.handle("remoteHosts:list", event => { guard(event); return manager.list(); });
  ipcMain.handle("remoteHosts:save", (event, input: RemoteHostInput, id?: string) => {
    guard(event);
    return manager.save(input, id === undefined ? undefined : hostId(id));
  });
  ipcMain.handle("remoteHosts:connect", (event, id: unknown) => { guard(event); return manager.connect(hostId(id)); });
  ipcMain.handle("remoteHosts:disconnect", (event, id: unknown) => { guard(event); return manager.disconnect(hostId(id)); });
  ipcMain.handle("remoteHosts:remove", (event, id: unknown) => { guard(event); return manager.remove(hostId(id)); });
}
