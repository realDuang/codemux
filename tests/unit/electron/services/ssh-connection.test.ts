import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshConnection } from "../../../../electron/main/services/ssh-connection";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../../../shared/terminate-owned-children", () => ({ terminateOwnedProcessTree: mocks.terminate }));

class FakeSsh extends EventEmitter {
  pid: number | undefined = 45_678;
  stderr = new PassThrough();
  server: net.Server | undefined;
  exited = false;
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    queueMicrotask(() => this.exit(0));
    return true;
  });

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.server?.close();
    this.emit("exit", code, null);
  }

  listen(args: string[]): void {
    const forward = args[args.indexOf("-L") + 1];
    const port = Number(forward.split(":")[1]);
    this.server = net.createServer(socket => socket.destroy());
    this.server.listen({ host: "127.0.0.1", port });
  }
}

let child: FakeSsh;
let instances: SshConnection[];

function connection(options: Partial<ConstructorParameters<typeof SshConnection>[0]> = {}): SshConnection {
  const instance = new SshConnection({ address: "WorkAlias", remotePort: 8233, startupTimeoutMs: 1500, ...options });
  instances.push(instance);
  return instance;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  child = new FakeSsh();
  instances = [];
  vi.spyOn(process, "kill").mockImplementation(() => true);
  mocks.spawn.mockImplementation((_file: string, args: string[]) => {
    child.listen(args);
    return child as unknown as ChildProcess;
  });
});

afterEach(async () => {
  child.kill.mockImplementation(() => { queueMicrotask(() => child.exit(0)); return true; });
  await Promise.all(instances.map(instance => instance.stop()));
  child.exit(0);
  vi.restoreAllMocks();
});

describe("SshConnection", () => {
  describe("start", () => {
    it("joins concurrent starts and owns a verified-key SSH process on the saved loopback port", async () => {
      const port = await availablePort();
      const onClose = vi.fn();
      const instance = connection({ address: "ssh://DevUser@WorkAlias:2222", preferredLocalPort: port, onClose });
      const starting = instance.start();
      expect(instance.start()).toBe(starting);
      await expect(starting).resolves.toEqual({ url: `http://127.0.0.1:${port}`, localPort: port });
      await expect(instance.start()).resolves.toEqual({ url: `http://127.0.0.1:${port}`, localPort: port });

      expect(mocks.spawn).toHaveBeenCalledOnce();
      const [file, args, options] = mocks.spawn.mock.calls[0];
      expect(file).toBe("ssh");
      expect(args.slice(-4)).toEqual(["-p", "2222", "--", "DevUser@WorkAlias"]);
      expect(args).toContain(`127.0.0.1:${port}:127.0.0.1:8233`);
      expect(args).toEqual(expect.arrayContaining([
        "-N", "-T", "BatchMode=yes", "ExitOnForwardFailure=yes", "StrictHostKeyChecking=yes",
        "ControlMaster=no", "ControlPath=none", "ForkAfterAuthentication=no", "ServerAliveInterval=15", "ServerAliveCountMax=3",
      ]));
      expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      expect(options.env.SSH_ASKPASS_REQUIRE).toBe("never");
      await instance.stop();
      expect(child.exited).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("refuses an occupied saved port without changing origin or spawning SSH", async () => {
      const occupied = net.createServer();
      await new Promise<void>(resolve => occupied.listen({ host: "127.0.0.1", port: 0 }, resolve));
      const port = (occupied.address() as net.AddressInfo).port;
      try {
        await expect(connection({ preferredLocalPort: port }).start()).rejects.toThrow("saved local SSH port");
        expect(mocks.spawn).not.toHaveBeenCalled();
      } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
    });

    it("returns only categorized authentication errors and reaps an early exit", async () => {
      mocks.spawn.mockImplementation(() => {
        queueMicrotask(() => {
          child.stderr.write("Welcome, token=do-not-expose\nDevUser@WorkAlias: Permission denied (publickey).\n");
          child.exit(255);
        });
        return child;
      });
      const onClose = vi.fn();
      await expect(connection({ onClose }).start()).rejects.toThrow("SSH authentication failed");
      expect(child.exited).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("explains unknown host keys without accepting or replacing them", async () => {
      mocks.spawn.mockImplementation(() => {
        queueMicrotask(() => {
          child.stderr.write("No ED25519 host key is known and you have requested strict checking.\nHost key verification failed.\n");
          child.exit(255);
        });
        return child;
      });
      await expect(connection().start()).rejects.toThrow("Verify this host with SSH in your terminal first");
      expect(mocks.spawn.mock.calls[0][1]).toContain("StrictHostKeyChecking=yes");
    });

    it("terminates an SSH process when forwarding startup times out", async () => {
      mocks.spawn.mockReturnValue(child);
      const instance = connection({ startupTimeoutMs: 20 });
      await expect(instance.start()).rejects.toThrow("SSH connection timed out");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.exited).toBe(true);
    });

    it("handles a missing SSH executable without exposing system error details", async () => {
      child.pid = undefined;
      mocks.spawn.mockImplementation(() => {
        queueMicrotask(() => child.emit("error", new Error("ENOENT /private/user-secret/ssh")));
        return child;
      });
      await expect(connection().start()).rejects.toThrow("Install the SSH client");
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("rejects invalid ports and command-shaped addresses before opening sockets", () => {
      expect(() => connection({ preferredLocalPort: 0 })).toThrow("Local port");
      expect(() => connection({ remotePort: 65536 })).toThrow();
      expect(() => connection({ address: "host -o ProxyCommand=evil" })).toThrow();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("cancels a pending connection and waits for process exit", async () => {
      mocks.spawn.mockReturnValue(child);
      const onClose = vi.fn();
      const instance = connection({ onClose });
      const starting = instance.start();
      const rejected = expect(starting).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
      const stopping = instance.stop();
      expect(instance.stop()).toBe(stopping);
      await stopping;
      await rejected;
      expect(child.exited).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("escalates to force termination if the owned process ignores graceful shutdown", async () => {
      const instance = connection();
      await instance.start();
      child.kill.mockImplementation(signal => {
        if (signal === "SIGKILL") queueMicrotask(() => child.exit(0));
        return true;
      });
      await instance.stop();
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.exited).toBe(true);
    });
  });

  describe("onClose", () => {
    it("reports an unexpected exit once with bounded output and releases the forwarding group", async () => {
      const onClose = vi.fn();
      const instance = connection({ onClose });
      await instance.start();
      child.stderr.write(`secret-banner-${"x".repeat(20_000)}\nConnection timed out\n`);
      child.exit(255);
      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose.mock.calls[0][0]).toBe("The SSH host could not be reached. Check your network and host address.");
      if (process.platform !== "win32") expect(process.kill).toHaveBeenCalledWith(-45_678, "SIGKILL");
    });
  });
});
