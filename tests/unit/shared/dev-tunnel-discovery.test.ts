import { afterEach, describe, expect, it, vi } from "vitest";
import { DevTunnelError, type DevTunnelCommandOptions } from "../../../shared/dev-tunnel-cli";
import { DevTunnelDiscovery } from "../../../shared/dev-tunnel-discovery";
import { readDevTunnelUrl } from "../../../shared/dev-tunnel-metadata";
import { readDevTunnelConfig } from "../../../shared/remote-access";

const ID = "codemux-01234567-89ab-cdef-0123-456789abcdef.jpe1";
const URL = "https://opaque-alias-8233.jpe1.devtunnels.ms";
const instances: DevTunnelDiscovery[] = [];

function fixture() {
  const user = { status: "Logged in", objectId: "test-owner" };
  const tunnel = {
    tunnelId: ID, description: "Development PC", hostConnections: 1,
    labels: ["codemux", "codemux-discovery-v1"],
    ports: [{ portNumber: 8233, protocol: "http", portUri: URL }],
    accessControl: [{ token: "never-return" }],
  };
  const port = { tunnelId: ID, portNumber: 8233, labels: ["codemux-web"] };
  const summary = { ...tunnel, ports: undefined };
  const command = vi.fn(async (_exe: string, args: string[], options: DevTunnelCommandOptions): Promise<string> => {
    options.signal.throwIfAborted();
    if (args[0] === "user" && args[1] === "show") return JSON.stringify(user);
    if (args[0] === "user" && args[1] === "login") { user.status = "Logged in"; return ""; }
    if (args[0] === "list") return JSON.stringify({ tunnels: [summary] });
    if (args[0] === "show") return JSON.stringify({ tunnel });
    if (args[0] === "port" && args[1] === "show") return JSON.stringify({ port });
    throw new Error("Unexpected mutating command");
  });
  const discovery = new DevTunnelDiscovery({ getPath: () => "devtunnel", command });
  instances.push(discovery);
  return { discovery, command, user, tunnel, port, summary, calls: () => command.mock.calls.map(([, args]) => args) };
}

afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.cancel())); });

describe("DevTunnelDiscovery", () => {
  it("discovers tagged Web endpoints without changing tunnels or exposing CLI credentials", async () => {
    const host = fixture();
    const result = await host.discovery.discover(false);
    expect(result).toEqual({ status: "ready", tunnels: [{ tunnelId: ID, name: "Development PC", online: true, url: URL }] });
    expect(host.calls()).toEqual([
      ["user", "show", "--json"],
      ["list", "--all-labels", "codemux", "--all-labels", "codemux-discovery-v1", "--json"],
      ["show", ID, "--json"],
      ["port", "show", ID, "--port-number", "8233", "--json"],
    ]);
    expect(JSON.stringify(result)).not.toContain("never-return");
  });

  it.each([
    ["unmarked tunnel", (host: ReturnType<typeof fixture>) => { host.summary.labels = []; }],
    ["future protocol", (host: ReturnType<typeof fixture>) => { host.summary.labels = ["codemux", "codemux-discovery-v2"]; }],
    ["unsafe identity", (host: ReturnType<typeof fixture>) => { host.summary.tunnelId = "--help"; }],
    ["removed labels", (host: ReturnType<typeof fixture>) => { host.tunnel.labels = []; }],
    ["different identity", (host: ReturnType<typeof fixture>) => { host.tunnel.tunnelId = "other.jpe1"; }],
    ["extra port", (host: ReturnType<typeof fixture>) => { host.tunnel.ports.push({ portNumber: 22, protocol: "ssh", portUri: "" }); }],
    ["unmarked port", (host: ReturnType<typeof fixture>) => { host.port.labels = []; }],
    ["mismatched port", (host: ReturnType<typeof fixture>) => { host.port.portNumber = 9000; }],
  ])("excludes %s rather than guessing that it is CodeMux", async (_label, change) => {
    const host = fixture();
    change(host);
    expect(await host.discovery.discover(false)).toEqual({ status: "ready", tunnels: [] });
  });

  it.each(["", "https://attacker.example", "https://other-9000.jpe1.devtunnels.ms", "https://other-8233.use1.devtunnels.ms", `${URL}/path`, `${URL}?token=secret`])(
    "never connects using an absent or mismatched address %s", async address => {
      const host = fixture();
      host.tunnel.ports[0].portUri = address;
      host.tunnel.hostConnections = 0;
      expect(await host.discovery.discover(false)).toEqual({
        status: "ready", tunnels: [{ tunnelId: ID, name: "Development PC", online: false }],
      });
    },
  );

  it("requires explicit consent for login and reuses cached credentials otherwise", async () => {
    const host = fixture();
    host.user.status = "Not logged in";
    expect((await host.discovery.discover(false)).status).toBe("loginRequired");
    expect(host.calls()).toEqual([["user", "show", "--json"]]);
    expect((await host.discovery.discover(true)).status).toBe("ready");
    expect(host.calls()).toContainEqual(["user", "login", "--entra", "--use-browser-auth"]);
    expect(host.command.mock.calls.find(([, args]) => args[1] === "login")?.[2].login).toBe(true);
    expect(host.calls().flat()).not.toContain("--use-device-code-auth");
  });

  it("refreshes expired credentials once, only after an explicit login request", async () => {
    const host = fixture();
    const original = host.command.getMockImplementation()!;
    let loggedIn = false;
    host.command.mockImplementation((exe, args, options) => {
      if (args[1] === "login") loggedIn = true;
      if (args[0] === "list" && !loggedIn) throw new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Expired credential");
      return original(exe, args, options);
    });
    expect((await host.discovery.discover(false)).status).toBe("loginRequired");
    expect((await host.discovery.discover(true)).status).toBe("ready");
    expect(host.calls().filter(args => args[1] === "login")).toHaveLength(1);
  });

  it("accepts empty lists but distinguishes unexpected warnings and sanitizes failures", async () => {
    const host = fixture();
    const original = host.command.getMockImplementation()!;
    let output = 'WARNING: CLI update available\n{"warning":"No tunnels found."}';
    host.command.mockImplementation((exe, args, options) => args[0] === "list" ? Promise.resolve(output) : original(exe, args, options));
    expect(await host.discovery.discover(false)).toEqual({ status: "ready", tunnels: [] });
    output = '{"warning":"network failed with SECRET-TOKEN"}';
    expect(await host.discovery.discover(false)).toEqual({ status: "error", tunnels: [], errorCode: "DEVTUNNEL_COMMAND_FAILED" });
    host.command.mockRejectedValue(new Error("SECRET-TOKEN"));
    expect(JSON.stringify(await host.discovery.discover(true))).not.toContain("SECRET-TOKEN");
  });

  it("reports missing CLI without launching login", async () => {
    const command = vi.fn();
    const discovery = new DevTunnelDiscovery({ getPath: () => undefined, command });
    expect(await discovery.discover(true)).toEqual({ status: "unavailable", tunnels: [] });
    expect(command).not.toHaveBeenCalled();
  });

  it("cancels a pending login and prevents concurrent requests from opening duplicate prompts", async () => {
    const host = fixture();
    host.user.status = "Not logged in";
    const original = host.command.getMockImplementation()!;
    host.command.mockImplementation((exe, args, options) => {
      if (args[1] === "login") return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DevTunnelError("DEVTUNNEL_CANCELLED", "Cancelled")), { once: true });
      });
      return original(exe, args, options);
    });
    const first = host.discovery.discover(true);
    expect(host.discovery.discover(true)).toBe(first);
    await vi.waitFor(() => expect(host.calls().some(args => args[1] === "login")).toBe(true));
    await host.discovery.cancel();
    expect(await first).toMatchObject({ status: "error", errorCode: "DEVTUNNEL_CANCELLED", tunnels: [] });
    expect(host.calls().some(args => args[0] === "list")).toBe(false);
    expect((await host.discovery.discover(false)).status).toBe("loginRequired");
  });
});

describe("readDevTunnelUrl", () => {
  it("accepts only shared HTTPS origins, never credentials or alternate destinations", () => {
    expect(readDevTunnelUrl(` ${URL}/ `)).toBe(URL);
    for (const value of [`http://${new globalThis.URL(URL).host}`, `${URL}:8443`, `${URL}/path`, `${URL}?q=1`, `${URL}#x`, "https://user:pass@example.devtunnels.ms", "https://devtunnels.ms.attacker.example", "file:///local"]) {
      expect(readDevTunnelUrl(value)).toBeUndefined();
    }
  });
});

describe("readDevTunnelConfig", () => {
  it("normalizes optional discovery names and rejects unsafe or oversized metadata", () => {
    expect(readDevTunnelConfig({ access: "private", name: " Work PC " })).toEqual({ access: "private", name: "Work PC" });
    expect(readDevTunnelConfig({ access: "private", name: " " })).toEqual({ access: "private" });
    for (const name of [12, {}, "a\nb", "x".repeat(101)]) {
      expect(() => readDevTunnelConfig({ access: "private", name })).toThrow("display name");
    }
  });
});
