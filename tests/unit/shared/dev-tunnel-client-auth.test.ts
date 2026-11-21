import { afterEach, describe, expect, it, vi } from "vitest";
import { DevTunnelClientAuth } from "../../../shared/dev-tunnel-client-auth";
import { DevTunnelError, type DevTunnelCommandOptions } from "../../../shared/dev-tunnel-cli";
import type { DevTunnelDiscoveryResult } from "../../../shared/dev-tunnel-metadata";

const ID = "codemux-01234567-89ab-cdef-0123-456789abcdef.jpe1";
const ORIGIN = "https://opaque-alias-8233.jpe1.devtunnels.ms";
const instances: DevTunnelClientAuth[] = [];

function fixture() {
  const result: DevTunnelDiscoveryResult = {
    status: "ready", tunnels: [{ tunnelId: ID, name: "Test PC", online: true, url: ORIGIN }],
  };
  const discovery = { discover: vi.fn(async () => result), cancel: vi.fn(async () => {}) };
  const credential = { token: "test.payload.signature", expiration: new Date(Date.now() + 86_400_000).toISOString() };
  const command = vi.fn(async (_exe: string, _args: string[], options: DevTunnelCommandOptions) => {
    options.signal.throwIfAborted();
    return JSON.stringify(credential);
  });
  const getPath = vi.fn((): string | undefined => "devtunnel");
  const auth = new DevTunnelClientAuth({ discovery, command, getPath });
  instances.push(auth);
  return { auth, discovery, command, credential, result, getPath };
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.close()));
  vi.useRealTimers();
});

describe("DevTunnelClientAuth", () => {
  it("resolves the service alias through account discovery and requests only connect scope", async () => {
    const host = fixture();
    host.credential.expiration = new Date(Date.now() + 86_400_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
    expect(await host.auth.prepare(ORIGIN)).toBe(true);
    expect(host.discovery.discover).toHaveBeenCalledWith(true);
    expect(host.command).toHaveBeenCalledWith("devtunnel", ["token", ID, "--scope", "connect", "--json"], { signal: expect.any(AbortSignal) });
    expect(await host.auth.authorization()).toBe("tunnel test.payload.signature");
    expect(host.command).toHaveBeenCalledOnce();
  });

  it.each(["missing-cli", "other-owner", "invalid-origin"] as const)("leaves %s to the external browser without minting credentials", async reason => {
    const host = fixture();
    if (reason === "missing-cli") host.getPath.mockReturnValue(undefined);
    if (reason === "other-owner") host.result.tunnels = [];
    expect(await host.auth.prepare(reason === "invalid-origin" ? "https://other.example" : ORIGIN)).toBe(false);
    expect(host.command).not.toHaveBeenCalled();
  });

  it("surfaces account login failures without raw output or silently broadening access", async () => {
    const host = fixture();
    host.discovery.discover.mockResolvedValue({ status: "loginRequired", tunnels: [], errorCode: "DEVTUNNEL_LOGIN_REQUIRED" });
    await expect(host.auth.prepare(ORIGIN)).rejects.toMatchObject({ code: "DEVTUNNEL_LOGIN_REQUIRED" });
    expect(host.command).not.toHaveBeenCalled();
  });

  it.each(["expired", "invalid-expiration", "invalid-token"] as const)("rejects an %s credential without exposing its contents", async reason => {
    const host = fixture();
    if (reason === "expired") host.credential.expiration = new Date(Date.now() - 1).toISOString();
    if (reason === "invalid-expiration") host.credential.expiration = "invalid";
    if (reason === "invalid-token") host.credential.token = "secret\r\nInjected: header";
    await expect(host.auth.prepare(ORIGIN)).rejects.toThrow("invalid connection credential");
  });

  it("refreshes before expiry, deduplicates concurrent requests, and never opens background login", async () => {
    vi.useFakeTimers();
    const host = fixture();
    await host.auth.prepare(ORIGIN);
    vi.advanceTimersByTime(86_350_000);
    host.credential.expiration = new Date(Date.now() + 86_400_000).toISOString();
    host.credential.token = "refreshed.payload.signature";
    const first = host.auth.authorization();
    expect(host.auth.authorization()).toBe(first);
    expect(await first).toBe("tunnel refreshed.payload.signature");
    expect(host.command).toHaveBeenCalledTimes(2);
    expect(host.discovery.discover).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(86_350_000);
    host.command.mockRejectedValue(new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Login required"));
    await expect(host.auth.authorization()).rejects.toMatchObject({ code: "DEVTUNNEL_LOGIN_REQUIRED" });
    expect(host.discovery.discover).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight token request and discards credentials on close", async () => {
    const host = fixture();
    host.command.mockImplementation((_exe, _args, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const pending = host.auth.prepare(ORIGIN);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(host.command).toHaveBeenCalled());
    await host.auth.close();
    await rejected;
    expect(host.discovery.cancel).toHaveBeenCalled();
    await expect(host.auth.authorization()).rejects.toThrow("cancelled");
  });
});
