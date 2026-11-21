import { afterEach, describe, expect, it, vi } from "vitest";
import { DevTunnelError, type DevTunnelCommandOptions } from "../../../shared/dev-tunnel-cli";
import { DevTunnelManager } from "../../../shared/dev-tunnel-manager";

const PORT = 8233;
const URL = "https://codemux-test-8233.jpe1.devtunnels.ms";
const managers: DevTunnelManager[] = [];

function fixture() {
  let settings: Record<string, unknown> = {};
  const user = { status: "Logged in", provider: "microsoft", objectId: "test-owner", tenantId: "test-tenant" };
  const tunnels: { tunnelId: string; ports: { portNumber: number; portUri?: string }[]; hostConnections?: number }[] = [];
  let hosting: DevTunnelCommandOptions | undefined;
  const command = vi.fn(async (_exe: string, args: string[], options: DevTunnelCommandOptions) => {
    options.signal.throwIfAborted();
    const [operation, subcommand] = args;
    if (operation === "user") {
      if (subcommand === "login") user.status = "Logged in";
      return JSON.stringify(user);
    }
    if (operation === "list") return JSON.stringify({ tunnels });
    if (operation === "create") {
      const tunnel = { tunnelId: `${subcommand}.jpe1`, ports: [] };
      tunnels.push(tunnel);
      return JSON.stringify({ tunnel });
    }
    if (operation === "show") return JSON.stringify({ tunnel: tunnels.find(tunnel => tunnel.tunnelId === subcommand) });
    if (operation === "port" && subcommand === "create") {
      tunnels.find(tunnel => tunnel.tunnelId === args[2])!.ports.push({ portNumber: Number(args[4]) });
    }
    if (operation === "host") {
      hosting = options;
      return new Promise<string>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return "{}";
  });
  const saveSettings = vi.fn(async patch => { settings = { ...settings, ...patch }; });
  const manager = new DevTunnelManager({ loadSettings: () => settings, saveSettings, getPath: () => "devtunnel", command });
  managers.push(manager);
  return {
    manager, command, saveSettings, tunnels, user,
    settings: () => settings,
    hosting: () => hosting,
    ready: () => hosting?.onOutput?.(`Connect via browser: ${URL}\nReady to accept connections for tunnel\n`),
    calls: () => command.mock.calls.map(([, args]) => args),
  };
}

afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.stop())); });

describe("DevTunnelManager", () => {
  it("accepts structured responses with CLI warning prefixes without exposing those warnings", async () => {
    const host = fixture();
    const original = host.command.getMockImplementation()!;
    host.command.mockImplementation(async (exe, args, options) => {
      const output = await original(exe, args, options);
      return args.includes("--json") ? `WARNING: transient CLI diagnostic\n${output}\n` : output;
    });
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    host.ready();
    expect(host.manager.getInfo()).toMatchObject({ status: "running", url: URL });
    expect(host.manager.getInfo()).not.toHaveProperty("error");
  });

  it("creates a dedicated private persistent tunnel and admits it only after readiness", async () => {
    const host = fixture();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    expect(host.manager.getInfo()).toMatchObject({ status: "starting", url: "" });
    expect(host.calls()).toContainEqual(expect.arrayContaining(["create", expect.stringMatching(/^codemux-/), "--expiration", "30d"]));
    const id = host.tunnels[0].tunnelId;
    expect(host.calls()).toContainEqual(["access", "reset", id]);
    expect(host.calls()).toContainEqual(["access", "reset", id, "--port-number", "8233"]);
    expect(host.calls()).not.toContainEqual(expect.arrayContaining(["--anonymous"]));
    expect(host.calls()).not.toContainEqual(expect.arrayContaining(["user", "login"]));
    expect(host.calls()).toContainEqual(["host", id, "--host-header", "unchanged", "--origin-header", "unchanged"]);
    host.hosting()?.onOutput?.(`Connect via browser: ${URL}`);
    expect(host.manager.getInfo().url).toBe("");
    host.ready();
    expect(host.manager.getInfo()).toMatchObject({ status: "running", url: URL });
    await host.manager.stop();
    expect(host.manager.getInfo()).toMatchObject({ status: "stopped", url: "" });
    expect(host.calls().some(args => args[0] === "delete")).toBe(false);
  });

  it("reuses its own tunnel after stopping and never adopts another user's tunnel", async () => {
    const host = fixture();
    host.tunnels.push({ tunnelId: "unrelated-tunnel.jpe1", ports: [{ portNumber: 9000, portUri: "" }], hostConnections: 1 });
    await host.manager.start(PORT, { access: "anonymous" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    const id = host.tunnels[1].tunnelId;
    await host.manager.stop();
    host.command.mockClear();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.calls().some(args => args[0] === "host")).toBe(true));
    expect(host.calls().some(args => args[0] === "create")).toBe(false);
    expect(host.calls()).toContainEqual(["access", "reset", id]);
    expect(host.calls().flat()).not.toContain("unrelated-tunnel.jpe1");
    expect(host.calls().flat()).not.toContain("--anonymous");
    expect(host.calls()).toContainEqual(["port", "update", id, "--port-number", "8233", "--add-labels", "codemux-web"]);
    expect(host.calls()).toContainEqual([
      "update", id, "--expiration", "30d", "--description", "CodeMux remote access",
      "--add-labels", "codemux", "--add-labels", "codemux-discovery-v1",
      "--host-header", "unchanged", "--origin-header", "unchanged",
    ]);
  });

  it("handles a first-account empty list and publishes discovery labels with the configured name", async () => {
    const host = fixture();
    const original = host.command.getMockImplementation()!;
    host.command.mockImplementation((exe, args, options) => args[0] === "list"
      ? Promise.resolve('{"warning":"No tunnels found."}')
      : original(exe, args, options));
    await host.manager.start(PORT, { access: "private", name: "Development PC" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    const id = host.tunnels[0].tunnelId;
    expect(host.calls()).toContainEqual([
      "create", id.split(".")[0], "--expiration", "30d", "--description", "Development PC",
      "--labels", "codemux", "--labels", "codemux-discovery-v1", "--json",
    ]);
    expect(host.calls()).toContainEqual(["port", "create", id, "--port-number", "8233", "--protocol", "http", "--labels", "codemux-web", "--json"]);
  });

  it("creates a separate identity after switching CLI accounts", async () => {
    const host = fixture();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    const first = host.tunnels[0].tunnelId;
    await host.manager.stop();
    host.user.objectId = "another-owner";
    host.command.mockClear();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.tunnels).toHaveLength(2));
    expect(host.tunnels[1].tunnelId).not.toBe(first);
    expect(host.calls().some(args => args[1] === first)).toBe(false);
  });

  it("opens interactive login only for an explicit enable, never on startup restoration", async () => {
    const host = fixture();
    host.user.status = "Not logged in";
    await host.manager.start(PORT, { access: "private" }, false);
    await vi.waitFor(() => expect(host.manager.getInfo().errorCode).toBe("DEVTUNNEL_LOGIN_REQUIRED"));
    expect(host.calls().some(args => args[1] === "login")).toBe(false);
    await host.manager.stop();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    expect(host.calls()).toContainEqual(["user", "login", "--entra", "--use-browser-auth"]);
    expect(host.calls().flat()).not.toContain("--use-device-code-auth");
  });

  it("cancels a pending login without provisioning or reviving the tunnel", async () => {
    const host = fixture();
    host.user.status = "Not logged in";
    const original = host.command.getMockImplementation()!;
    host.command.mockImplementation(async (exe, args, options) => {
      if (args[1] === "login") return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
      return original(exe, args, options);
    });

    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.manager.getInfo().phase).toBe("login"));
    await host.manager.stop();
    expect(host.manager.getInfo()).toEqual({ status: "stopped", url: "" });
    expect(host.tunnels).toHaveLength(0);
  });

  it("reauthenticates on retry when the CLI cache claims a now-expired login", async () => {
    const host = fixture();
    const original = host.command.getMockImplementation()!;
    let expired = true;
    host.command.mockImplementation(async (exe, args, options) => {
      if (args[0] === "list" && expired) {
        expired = false;
        throw new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Expired credential");
      }
      return original(exe, args, options);
    });
    await host.manager.start(PORT, { access: "private" }, false);
    await vi.waitFor(() => expect(host.manager.getInfo().errorCode).toBe("DEVTUNNEL_LOGIN_REQUIRED"));
    await host.manager.stop();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    expect(host.calls()).toContainEqual(["user", "login", "--entra", "--use-browser-auth"]);
  });

  it.each(["tenant", "anonymous"] as const)("grants only connect access when explicitly selecting %s", async access => {
    const host = fixture();
    await host.manager.start(PORT, { access }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    expect(host.calls()).toContainEqual(["access", "create", host.tunnels[0].tunnelId, access === "tenant" ? "--tenant" : "--anonymous", "--scopes", "connect"]);
  });

  it("does not mutate or host a saved tunnel already hosted elsewhere", async () => {
    const host = fixture();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.hosting()).toBeDefined());
    await host.manager.stop();
    host.tunnels[0].hostConnections = 1;
    host.command.mockClear();
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.manager.getInfo().errorCode).toBe("DEVTUNNEL_ALREADY_HOSTED"));
    expect(host.calls().map(args => args[0])).toEqual(["user", "list", "show"]);
  });

  it("leaves an error with no usable URL when provisioning or login fails", async () => {
    const host = fixture();
    host.command.mockRejectedValue(new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Login required"));
    await host.manager.start(PORT, { access: "private" }, true);
    await vi.waitFor(() => expect(host.manager.getInfo().status).toBe("error"));
    expect(host.manager.getInfo()).toMatchObject({ errorCode: "DEVTUNNEL_LOGIN_REQUIRED", url: "" });
  });
});
