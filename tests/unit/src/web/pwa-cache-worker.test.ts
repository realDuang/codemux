import { describe, expect, it, vi } from "vitest";
import { createPwaCacheManager, requestPwaClientVersion } from "../../../../src/web/pwa-cache-worker";

const current = "a".repeat(32);
const old = "b".repeat(32);
const unused = "c".repeat(32);
const origin = "https://codemux.example";
const cacheName = (version: string) => `codemux-web-${version}-precache-v2-${origin}/`;

function fixture() {
  const stored = new Map<string, Map<string, Response>>([
    [cacheName(current), new Map()],
    [cacheName(old), new Map([[`${origin}/assets/Settings-AbCd1234.js`, new Response("old chunk")]])],
    [cacheName(unused), new Map()],
    ["another-app", new Map()],
  ]);
  const clients = [{ id: "new-tab", postMessage: vi.fn() }, { id: "old-tab", postMessage: vi.fn() }];
  const environment = {
    origin,
    scope: `${origin}/`,
    caches: {
      keys: vi.fn(async () => [...stored.keys()]),
      delete: vi.fn(async (name: string) => stored.delete(name)),
      open: vi.fn(async (name: string) => ({ match: async (request: Request) => stored.get(name)?.get(request.url) }) as Cache),
    },
    clients: vi.fn(async () => clients),
    clientVersion: vi.fn(async (client: { id: string }): Promise<string | undefined> => client.id === "new-tab" ? current : old),
    activeVersion: vi.fn(async (): Promise<string | undefined> => current),
    updatePending: vi.fn(() => false),
    fetch: vi.fn(async () => new Response("network")),
  };
  return { stored, clients, environment, manager: createPwaCacheManager(current, environment) };
}

describe("createPwaCacheManager", () => {
  it("keeps chunks needed by a live old tab and collects unused versions", async () => {
    const { manager, environment } = fixture();
    await manager.cleanup();
    expect(environment.caches.delete.mock.calls).toEqual([[cacheName(unused)]]);
    expect(await (await manager.asset(new Request(`${origin}/assets/Settings-AbCd1234.js`))).text()).toBe("old chunk");
    expect(environment.fetch).not.toHaveBeenCalled();
  });

  it("collects an old version after its last client is gone", async () => {
    const { manager, clients, environment } = fixture();
    clients.pop();
    await manager.cleanup();
    expect(environment.caches.delete.mock.calls).toEqual([[cacheName(old)], [cacheName(unused)]]);
  });

  it("retains all versions when a suspended client cannot identify its build", async () => {
    const { manager, environment } = fixture();
    environment.clientVersion.mockResolvedValueOnce(current).mockResolvedValueOnce(undefined);
    await manager.cleanup();
    expect(environment.caches.delete).not.toHaveBeenCalled();
  });

  it("retains all versions if a new client appears during collection", async () => {
    const { manager, clients, environment } = fixture();
    environment.clients.mockResolvedValueOnce([...clients]).mockResolvedValueOnce([...clients, { id: "arriving", postMessage: vi.fn() }]);
    await manager.cleanup();
    expect(environment.caches.delete).not.toHaveBeenCalled();
  });

  it.each(["pending", "new-active", "unknown-active"])("does not collect while another worker is %s", async (state) => {
    const { manager, environment } = fixture();
    if (state === "pending") environment.updatePending.mockReturnValue(true);
    else environment.activeVersion.mockResolvedValue(state === "new-active" ? old : undefined);
    await manager.cleanup();
    expect(environment.caches.delete).not.toHaveBeenCalled();
  });

  it("stops collecting if a new worker activates during client discovery", async () => {
    const { manager, environment } = fixture();
    environment.activeVersion.mockResolvedValueOnce(current).mockResolvedValue(old);
    await manager.cleanup();
    expect(environment.caches.delete).not.toHaveBeenCalled();
  });

  it.each([
    `${origin}/api/settings/shared`, `${origin}/chat`, `${origin}/assets/logo.png`,
    `${origin}/assets/plain.js`, `${origin}/assets/Settings-AbCd1234.js?query=1`,
    "https://other.example/assets/Settings-AbCd1234.js",
  ])("never reads version caches for %s", async (url) => {
    const { manager, environment } = fixture();
    expect(await (await manager.asset(new Request(url))).text()).toBe("network");
    expect(environment.caches.open).not.toHaveBeenCalled();
  });

  it("uses the network for an absent chunk or non-GET request", async () => {
    const { manager, environment } = fixture();
    await manager.asset(new Request(`${origin}/assets/missing-AbCd1234.css`));
    await manager.asset(new Request(`${origin}/assets/Settings-AbCd1234.js`, { method: "POST" }));
    expect(environment.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("requestPwaClientVersion", () => {
  it("reads a client's compiled version over a dedicated message port", async () => {
    const client = { postMessage: (_message: unknown, ports: Transferable[]) => (ports[0] as MessagePort).postMessage({ buildId: old }) };
    expect(await requestPwaClientVersion(client)).toBe(old);
  });

  it("treats a client that cannot respond as unknown", async () => {
    expect(await requestPwaClientVersion({ postMessage: vi.fn() }, 1)).toBeUndefined();
    expect(await requestPwaClientVersion({ postMessage: () => { throw new Error("closed"); } })).toBeUndefined();
  });
});
