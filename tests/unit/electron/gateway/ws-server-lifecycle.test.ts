import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import type { EngineManager } from "../../../../electron/main/gateway/engine-manager";

const fixtures = vi.hoisted(() => ({
  settingsPath: "",
  unwatchAll: vi.fn(),
  createWorktree: vi.fn(async () => ({ name: "feature" })),
}));

vi.mock("../../../../electron/main/gateway/engine-manager", () => ({}));
vi.mock("../../../../electron/main/services/file-service", () => ({
  onFileChange: vi.fn(),
  unwatchAll: fixtures.unwatchAll,
}));
vi.mock("../../../../electron/main/services/logger", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { gatewayLog: logger, terminalLog: logger, default: { scope: () => logger } };
});
vi.mock("../../../../electron/main/services/conversation-store", () => ({ conversationStore: {} }));
vi.mock("../../../../electron/main/services/scheduled-task-service", () => ({
  scheduledTaskService: { on: vi.fn() },
}));
vi.mock("../../../../electron/main/services/orchestrator-service", () => ({
  orchestratorService: { init: vi.fn(), on: vi.fn() },
}));
vi.mock("../../../../electron/main/services/app-paths", () => ({
  getSettingsPath: () => fixtures.settingsPath,
}));
vi.mock("../../../../electron/main/services/worktree-manager", () => ({
  worktreeManager: { create: fixtures.createWorktree },
}));
vi.mock("../../../../electron/main/services/terminal-profiles", () => ({
  listTerminalProfiles: () => ({ profiles: [], defaultProfileId: null }),
  getTerminalProfile: () => null,
}));
vi.mock("../../../../electron/main/services/terminal-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../electron/main/services/terminal-service")>();
  return { ...actual, getTerminalService: () => terminalService };
});

import { GatewayServer } from "../../../../electron/main/gateway/ws-server";
import { TerminalService, type PtyModule } from "../../../../electron/main/services/terminal-service";
import { GatewayRequestType, type GatewayResponse } from "../../../../src/types/unified";

let terminalService: TerminalService;
let testDirectory: string;
const gateways: GatewayServer[] = [];
const httpServers: Server[] = [];
const clients: WebSocket[] = [];
const killPty = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  testDirectory = await mkdtemp(join(tmpdir(), "codemux-gateway-lifecycle-"));
  fixtures.settingsPath = join(testDirectory, "settings.json");
  const ptyModule: PtyModule = {
    spawn: () => ({
      pid: 123,
      kill: killPty,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
    }) as ReturnType<PtyModule["spawn"]>,
  };
  terminalService = new TerminalService({ ptyModule });
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(httpServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  terminalService.destroyAll();
  await rm(testDirectory, { recursive: true, force: true });
});

async function startGateway(attached: boolean): Promise<{ gateway: GatewayServer; ws: WebSocket }> {
  const gateway = new GatewayServer(new EventEmitter() as unknown as EngineManager);
  gateways.push(gateway);
  let port: number;
  if (attached) {
    const httpServer = createServer();
    httpServers.push(httpServer);
    gateway.start({ server: httpServer, path: "/ws" });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    port = (httpServer.address() as { port: number }).port;
  } else {
    gateway.start({ port: 0 });
    await vi.waitFor(() => expect(gateway.getPort()).toBeGreaterThan(0));
    port = gateway.getPort()!;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  clients.push(ws);
  await once(ws, "open");
  return { gateway, ws };
}

async function request(ws: WebSocket, type: GatewayRequestType, payload: unknown): Promise<GatewayResponse> {
  const response = once(ws, "message");
  ws.send(JSON.stringify({ type, requestId: "test-request", payload }));
  const [raw] = await response;
  return JSON.parse(raw.toString()) as GatewayResponse;
}

async function createTerminal(ws: WebSocket): Promise<void> {
  const response = await request(ws, GatewayRequestType.TERMINAL_CREATE, {
    cwd: testDirectory,
    cols: 80,
    rows: 24,
  });
  expect(response.error).toBeUndefined();
  expect(terminalService.count()).toBe(1);
}

describe("GatewayServer.close", () => {
  it.each([true, false])("awaits graceful shutdown and PTY cleanup (attached: %s)", async (attached) => {
    const { gateway, ws } = await startGateway(attached);
    await createTerminal(ws);
    const closed = once(ws, "close");

    gateway.stop();
    const completion = gateway.close();
    expect(gateway.close()).toBe(completion);
    await completion;
    const [code, reason] = await closed;

    expect(code).toBe(1001);
    expect(reason.toString()).toBe("Server shutting down");
    expect(killPty).toHaveBeenCalledOnce();
    expect(terminalService.count()).toBe(0);
    expect(fixtures.unwatchAll).toHaveBeenCalledOnce();
    expect(gateway.getPort()).toBeUndefined();
    await gateway.close();
  });

  it.each([true, false])("terminates a peer that never reads the close frame (attached: %s)", async (attached) => {
    const { gateway, ws } = await startGateway(attached);
    await createTerminal(ws);
    ws.pause();
    const startedAt = performance.now();

    await gateway.close();

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(killPty).toHaveBeenCalledOnce();
    expect(terminalService.count()).toBe(0);
  });

  it("can close an instance that never started", async () => {
    const gateway = new GatewayServer(new EventEmitter() as unknown as EngineManager);
    await gateway.close();
    expect(fixtures.unwatchAll).toHaveBeenCalledOnce();
  });
});

describe("GatewayServer worktree settings", () => {
  it("reads the current settings file for each worktree request", async () => {
    const { ws } = await startGateway(true);
    const payload = { directory: testDirectory, name: "feature" };
    await writeFile(fixtures.settingsPath, JSON.stringify({ worktreeEnabled: true }));

    expect((await request(ws, GatewayRequestType.WORKTREE_CREATE, payload)).error).toBeUndefined();
    expect(fixtures.createWorktree).toHaveBeenCalledWith(testDirectory, { name: "feature", baseBranch: undefined });

    for (const value of ['{"worktreeEnabled":false}', '{"worktreeEnabled":"true"}', "invalid json"]) {
      await writeFile(fixtures.settingsPath, value);
      expect((await request(ws, GatewayRequestType.WORKTREE_CREATE, payload)).error?.code).toBe("WORKTREE_DISABLED");
    }
    await rm(fixtures.settingsPath);
    expect((await request(ws, GatewayRequestType.WORKTREE_CREATE, payload)).error?.code).toBe("WORKTREE_DISABLED");
    expect(fixtures.createWorktree).toHaveBeenCalledOnce();
  });
});
