interface PwaClient {
  id: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

interface PwaCacheEnvironment {
  origin: string;
  scope: string;
  caches: Pick<CacheStorage, "keys" | "delete" | "open">;
  clients(): Promise<PwaClient[]>;
  clientVersion(client: PwaClient): Promise<string | undefined>;
  activeVersion(): Promise<string | undefined>;
  updatePending(): boolean;
  fetch(request: Request): Promise<Response>;
}

export function requestPwaClientVersion(client: Pick<PwaClient, "postMessage">, timeout = 1500): Promise<string | undefined> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (version?: string) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(version);
    };
    const timer = setTimeout(() => finish(), timeout);
    channel.port1.onmessage = (event: MessageEvent<{ buildId?: unknown }>) => {
      const version = event.data?.buildId;
      finish(typeof version === "string" && /^[a-f0-9]{32}$/.test(version) ? version : undefined);
    };
    try {
      client.postMessage({ type: "CODEMUX_PWA_VERSION_REQUEST" }, [channel.port2]);
    } catch {
      finish();
    }
  });
}

export function createPwaCacheManager(buildId: string, environment: PwaCacheEnvironment) {
  const prefix = "codemux-web-";
  const suffix = `-precache-v2-${environment.scope}`;
  const cacheVersion = (name: string) => {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
    const version = name.slice(prefix.length, -suffix.length);
    return /^[a-f0-9]{32}$/.test(version) ? version : undefined;
  };
  let cleaning: Promise<void> | undefined;

  async function prune() {
    if (environment.updatePending() || await environment.activeVersion() !== buildId) return;
    const names = await environment.caches.keys();
    const clients = await environment.clients();
    const versions = await Promise.all(clients.map((client) => environment.clientVersion(client)));
    // Suspended, old, or not-yet-started pages may still need their cached chunks.
    if (versions.some((version) => !version)) return;
    const knownClients = new Set(clients.map((client) => client.id));
    if ((await environment.clients()).some((client) => !knownClients.has(client.id))) return;
    const retained = new Set([buildId, ...versions]);
    for (const name of names) {
      if (environment.updatePending() || await environment.activeVersion() !== buildId) return;
      const version = cacheVersion(name);
      if (version && !retained.has(version)) await environment.caches.delete(name);
    }
  }

  return {
    cleanup(): Promise<void> {
      if (!cleaning) cleaning = prune().finally(() => { cleaning = undefined; });
      return cleaning;
    },
    async asset(request: Request): Promise<Response> {
      const url = new URL(request.url);
      // Only immutable build chunks may fall back to an older app version.
      if (request.method === "GET" && url.origin === environment.origin && !url.search
        && /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname)) {
        for (const name of await environment.caches.keys()) {
          if (!cacheVersion(name)) continue;
          const cached = await (await environment.caches.open(name)).match(request);
          if (cached) return cached;
        }
      }
      return environment.fetch(request);
    },
  };
}

interface PwaWorkerScope {
  location: { origin: string };
  registration: { scope: string; installing: unknown; waiting: unknown; active?: Pick<PwaClient, "postMessage"> };
  clients: { matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<PwaClient[]> };
  caches: CacheStorage;
  fetch(request: Request): Promise<Response>;
  codemuxCachedAsset(request: Request): Promise<Response>;
  addEventListener(type: string, listener: (event: { data?: { type?: string }; ports?: MessagePort[]; waitUntil(promise: Promise<unknown>): void }) => void): void;
}

// This file is compiled as a classic importScripts helper, not imported by pages.
if (typeof self !== "undefined" && "registration" in self) {
  const worker = self as unknown as PwaWorkerScope;
  const manager = createPwaCacheManager(__PWA_BUILD_ID__, {
    origin: worker.location.origin,
    scope: worker.registration.scope,
    caches: worker.caches,
    clients: () => worker.clients.matchAll({ type: "window", includeUncontrolled: true }),
    clientVersion: requestPwaClientVersion,
    activeVersion: () => worker.registration.active
      ? requestPwaClientVersion(worker.registration.active) : Promise.resolve(undefined),
    updatePending: () => Boolean(worker.registration.installing || worker.registration.waiting),
    fetch: (request) => worker.fetch(request),
  });
  worker.codemuxCachedAsset = (request) => manager.asset(request);
  const cleanup = () => manager.cleanup().catch(() => { /* Keep caches if collection is unavailable. */ });
  worker.addEventListener("activate", (event) => event.waitUntil(cleanup()));
  worker.addEventListener("message", (event) => {
    if (event.data?.type === "CODEMUX_PWA_VERSION_REQUEST") event.ports?.[0]?.postMessage({ buildId: __PWA_BUILD_ID__ });
    if (event.data?.type === "CODEMUX_PWA_CLIENT_READY") event.waitUntil(cleanup());
  });
}
