import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDesktopIpcClient, type DesktopFollowerMethod, type DesktopThreadStream } from "../../../../../electron/main/engines/codex/desktop-ipc-client";

interface Message {
  type: string;
  method?: string;
  requestId?: string;
  version?: number;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}
interface Fixture {
  client: CodexDesktopIpcClient;
  socketPath: string;
  messages: Message[];
  send: (message: Message) => void;
  sendBytes: (bytes: Buffer) => void;
  override?: (message: Message) => boolean;
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});

function encode(message: Message): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function fixture(options: { requestTimeoutMs?: number; maxFrameBytes?: number } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "codemux-ipc-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\codemux-test-${randomUUID()}`
    : join(directory, "router.sock");
  const messages: Message[] = [];
  const sockets = new Set<Socket>();
  let currentSocket: Socket;
  const client = new CodexDesktopIpcClient({ socketPath, ...options });
  const result: Fixture = { client, socketPath, messages,
    send: (message) => currentSocket.write(encode(message)),
    sendBytes: (bytes) => currentSocket.write(bytes),
  };
  const server: Server = createServer((socket) => {
    currentSocket = socket;
    sockets.add(socket);
    // Disconnect tests intentionally close the peer while replies are in flight.
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0);
        const message: Message = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        messages.push(message);
        if (result.override?.(message)) continue;
        if (message.type === "request") {
          socket.write(encode({ type: "response", requestId: message.requestId, resultType: "success", method: message.method,
            handledByClientId: message.method === "initialize" ? "codemux-client" : "desktop-owner",
            result: message.method === "initialize" ? { clientId: "codemux-client" }
              : message.method === "thread-owner-discovery" ? { supportsUntrustedAppInput: true } : { ok: true },
          }));
        } else if (message.method === "thread-stream-following-changed" && message.params?.following) {
          socket.write(encode(streamMessage({ type: "snapshot", revision: 1, conversationState: { id: "thread", turns: [] } }, String(message.params.hostId))));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  if (process.platform !== "win32") await chmod(socketPath, 0o600);
  cleanup.push(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return result;
}

function streamMessage(change: Message, hostId = "local"): Message {
  return { type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: "desktop-owner",
    targetClientIds: ["codemux-client"], params: { conversationId: "thread", hostId, change } };
}
async function follow(f: Fixture, hostId = "local"): Promise<void> {
  await f.client.connect();
  const owner = await f.client.discoverOwner("thread", hostId);
  await f.client.followThread("thread", owner!.ownerClientId, hostId);
}

describe("CodexDesktopIpcClient.discoverOwner", () => {
  it.each([undefined, "CodeMux", "VS Code", ""])("retains only an explicitly advertised application name %s", async (clientName) => {
    const f = await fixture();
    f.override = (message) => {
      if (message.method !== "thread-owner-discovery") return false;
      f.send({ type: "response", requestId: message.requestId, resultType: "success", method: message.method,
        handledByClientId: "native-owner", result: { supportsUntrustedAppInput: false, ...(clientName === undefined ? {} : { clientName }) },
      });
      return true;
    };
    await f.client.connect();
    const owner = await f.client.discoverOwner("thread");
    expect(owner).toEqual({ ownerClientId: "native-owner", supportsUntrustedAppInput: false, ...(clientName ? { clientName } : {}) });
    expect(f.client.getThreadOwner("thread")).toEqual(owner);
    const cached = f.client.getThreadOwner("thread")!;
    cached.clientName = "Changed by caller";
    expect(f.client.getThreadOwner("thread")).toEqual(owner);
    f.client.close();
    expect(f.client.getThreadOwner("thread")).toBeUndefined();
  });
});

describe("CodexDesktopIpcClient.connect", () => {
  it("initializes the existing router and never advertises thread ownership", async () => {
    const f = await fixture();
    await Promise.all([f.client.connect(), f.client.connect()]);
    expect(f.client.connected).toBe(true);
    expect(f.client.clientId).toBe("codemux-client");
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({ type: "request", method: "initialize", version: 0, sourceClientId: "initializing-client", params: { clientType: "codemux" } });
    f.send({ type: "client-discovery-request", requestId: "foreign-request", request: { method: "thread-owner-discovery" } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ type: "client-discovery-response", requestId: "foreign-request", response: { canHandle: false } }));
  });

  it.skipIf(process.platform === "win32")("rejects an endpoint readable by other users", async () => {
    const f = await fixture();
    await chmod(f.socketPath, 0o666);
    await expect(f.client.connect()).rejects.toMatchObject({ code: "unsafe-endpoint" });
    expect(f.messages).toHaveLength(0);
  });

  it("does not initialize after being closed during connection setup", async () => {
    const f = await fixture();
    const connecting = f.client.connect();
    f.client.close();
    // Unix waits for endpoint inspection; named pipes start connecting immediately.
    await expect(connecting).rejects.toMatchObject({ code: process.platform === "win32" ? "connection-closed" : "client-closed" });
    expect(f.client.connected).toBe(false);
    expect(f.messages).toHaveLength(0);
  });
});

describe("CodexDesktopIpcClient thread availability facts", () => {
  it("broadcasts the native fact versions with its own source identity", async () => {
    const f = await fixture();
    await f.client.connect();
    f.client.notifyThreadArchived("thread", "/repo");
    f.client.notifyThreadUnarchived("thread");
    await vi.waitFor(() => expect(f.messages.filter((message) => message.type === "broadcast")).toHaveLength(2));
    expect(f.messages.slice(-2)).toEqual([
      { type: "broadcast", method: "thread-archived", version: 2, sourceClientId: "codemux-client", params: { conversationId: "thread", hostId: "local", cwd: "/repo" } },
      { type: "broadcast", method: "thread-unarchived", version: 1, sourceClientId: "codemux-client", params: { conversationId: "thread", hostId: "local" } },
    ]);
    expect(() => f.client.notifyThreadArchived("thread", "/repo", "other-client")).toThrow("invalid-thread-notification");
    expect(() => f.client.notifyThreadUnarchived("thread", "remote")).toThrow("invalid-thread-notification");
    expect(() => f.client.notifyThreadArchived("thread", "")).toThrow("invalid-thread-notification");
    expect(f.messages.some((message) => message.method === "thread/archive" || message.method === "thread/unarchive")).toBe(false);
  });

  it("receives external facts for followed and previously followed threads across reconnect", async () => {
    const f = await fixture();
    await follow(f);
    const archived = vi.fn();
    const unarchived = vi.fn();
    f.client.on("threadArchived", archived);
    f.client.on("threadUnarchived", unarchived);
    f.send({ type: "broadcast", method: "thread-archived", version: 2, sourceClientId: "external-metadata-client", params: { conversationId: "thread", hostId: "local", cwd: "/repo" } });
    await vi.waitFor(() => expect(archived).toHaveBeenCalledExactlyOnceWith({ conversationId: "thread", hostId: "local", cwd: "/repo", sourceClientId: "external-metadata-client" }));
    f.client.unfollowThread("thread");
    f.send({ type: "broadcast", method: "thread-unarchived", version: 1, sourceClientId: "official-desktop", params: { conversationId: "thread", hostId: "local" } });
    await vi.waitFor(() => expect(unarchived).toHaveBeenCalledOnce());
    f.client.close();
    await f.client.connect();
    f.send({ type: "broadcast", method: "thread-unarchived", version: 1, sourceClientId: "official-desktop", params: { conversationId: "thread", hostId: "local" } });
    await vi.waitFor(() => expect(unarchived).toHaveBeenCalledTimes(2));
    expect(unarchived).toHaveBeenLastCalledWith({ conversationId: "thread", hostId: "local", sourceClientId: "official-desktop" });
  });

  it("ignores invalid lifecycle versions, fields, hosts, targets and unrelated threads", async () => {
    const f = await fixture();
    await follow(f);
    const archived = vi.fn();
    const unarchived = vi.fn();
    f.client.on("threadArchived", archived);
    f.client.on("threadUnarchived", unarchived);
    const valid: Message = { type: "broadcast", method: "thread-archived", version: 2, sourceClientId: "official-desktop", params: { conversationId: "thread", hostId: "local", cwd: "/repo" } };
    f.send({ ...valid, version: 1 });
    f.send({ ...valid, sourceClientId: "" });
    f.send({ ...valid, targetClientIds: ["other-client"] });
    f.send({ ...valid, params: { conversationId: "thread", hostId: "remote", cwd: "/repo" } });
    f.send({ ...valid, params: { conversationId: "unrelated", hostId: "local", cwd: "/repo" } });
    f.send({ ...valid, params: { conversationId: "thread", hostId: "local", cwd: null } });
    f.send({ ...valid, method: "thread-unarchived", version: 2 });
    f.send(valid);
    await vi.waitFor(() => expect(archived).toHaveBeenCalledOnce());
    expect(unarchived).not.toHaveBeenCalled();
    expect(f.client.connected).toBe(true);
  });
});

describe("CodexDesktopIpcClient.followThread", () => {
  it("discovers an owner and reconstructs fragmented and coalesced frames", async () => {
    const f = await fixture();
    f.override = (message) => {
      if (message.type !== "broadcast") return false;
      const snapshot = encode(streamMessage({ type: "snapshot", revision: 1, conversationState: { id: "thread", title: "测试" } }));
      const patches = encode(streamMessage({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace", path: ["title"], value: "Updated" }], acceptedTextChanges: [] }));
      f.sendBytes(snapshot.subarray(0, 2));
      f.sendBytes(Buffer.concat([snapshot.subarray(2), patches]));
      return true;
    };
    const streams: DesktopThreadStream[] = [];
    f.client.on("stream", (stream) => streams.push(stream));
    await follow(f);
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[0].change).toMatchObject({ type: "snapshot", revision: 1, conversationState: { title: "测试" } });
    expect(streams[1].change).toMatchObject({ type: "patches", baseRevision: 1, revision: 2 });
    expect(f.messages.find((message) => message.type === "broadcast")).toMatchObject({ version: 1, targetClientIds: ["desktop-owner"], params: { conversationId: "thread", hostId: "local", following: true } });
  });

  it("discards content from other threads, owners, and target clients", async () => {
    const f = await fixture();
    await follow(f);
    const stream = vi.fn();
    f.client.on("stream", stream);
    const change = { type: "snapshot", revision: 2, conversationState: {} };
    f.send({ ...streamMessage(change), sourceClientId: "another-owner" });
    f.send({ ...streamMessage(change), targetClientIds: ["another-client"] });
    f.send({ ...streamMessage(change), params: { conversationId: "another-thread", hostId: "local", change } });
    f.send(streamMessage(change));
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    expect((await f.client.followThread("thread", "desktop-owner")).revision).toBe(2);
  });

  it("closes the connection on an incompatible subscribed stream version", async () => {
    const f = await fixture();
    await follow(f);
    const error = vi.fn();
    f.client.on("error", error);
    f.send({ ...streamMessage({ type: "snapshot", revision: 2, conversationState: {} }), version: 12 });
    await vi.waitFor(() => expect(f.client.connected).toBe(false));
    expect(error.mock.calls[0][0]).toMatchObject({ code: "notification-version-mismatch" });
    await expect(f.client.startTurn("thread", "desktop-owner", { request: { input: [] } })).rejects.toMatchObject({ code: "not-connected" });
  });

  it("removes stale owners without interrupting their turns", async () => {
    const f = await fixture();
    await follow(f);
    const disconnected = vi.fn();
    f.client.on("ownerDisconnected", disconnected);
    f.send({ type: "broadcast", method: "client-status-changed", version: 0, sourceClientId: "desktop-owner", params: { clientId: "desktop-owner", status: "disconnected" } });
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledWith("desktop-owner"));
    await expect(f.client.startTurn("thread", "desktop-owner", { request: { input: [] } })).rejects.toMatchObject({ code: "thread-not-synchronized" });
    expect(f.messages.some((message) => message.method?.includes("interrupt"))).toBe(false);
  });

  it("returns null when no compatible owner is available", async () => {
    const f = await fixture();
    await f.client.connect();
    f.override = (message) => {
      f.send({ type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found" });
      return true;
    };
    await expect(f.client.discoverOwner("thread")).resolves.toBeNull();
    await expect(f.client.followThread("thread", "unverified-owner")).rejects.toMatchObject({ code: "owner-not-discovered" });
  });

  it("waits for the router's fixed discovery deadline before receiving no-client-found", async () => {
    const f = await fixture();
    await f.client.connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.override = (message) => {
      setTimeout(() => f.send({ type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found" }), 10_000);
      return true;
    };
    const result = f.client.discoverOwner("thread");
    const assertion = expect(result).resolves.toBeNull();
    await vi.waitFor(() => expect(f.messages.at(-1)?.method).toBe("thread-owner-discovery"));
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(f.messages.at(-1)?.timeoutMs).toBe(10_000);
  });

  it("preserves a silent router timeout as an error instead of assuming no owner", async () => {
    const f = await fixture({ requestTimeoutMs: 100 });
    await f.client.connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.override = () => true;
    const assertion = expect(f.client.discoverOwner("thread")).rejects.toMatchObject({ code: "request-timeout" });
    await vi.waitFor(() => expect(f.messages.at(-1)?.method).toBe("thread-owner-discovery"));
    await vi.advanceTimersByTimeAsync(11_100);
    await assertion;
    await expect(f.client.followThread("thread", "unverified-owner")).rejects.toMatchObject({ code: "owner-not-discovered" });
  });
});

describe("CodexDesktopIpcClient.isFollowingThread", () => {
  it("requires a connected, discovered owner and an accepted snapshot", async () => {
    const f = await fixture();
    expect(f.client.isFollowingThread("thread", "desktop-owner")).toBe(false);
    await f.client.connect();
    await f.client.discoverOwner("thread");
    expect(f.client.isFollowingThread("thread", "desktop-owner")).toBe(false);
    f.override = (message) => message.method === "thread-stream-following-changed";
    const following = f.client.followThread("thread", "desktop-owner");
    await vi.waitFor(() => expect(f.messages.at(-1)?.method).toBe("thread-stream-following-changed"));
    expect(f.client.isFollowingThread("thread", "desktop-owner")).toBe(false);
    f.send(streamMessage({ type: "snapshot", revision: 1, conversationState: { id: "thread" } }));
    await following;
    expect(f.client.isFollowingThread("thread", "desktop-owner")).toBe(true);
    f.client.unfollowThread("thread");
    expect(f.client.isFollowingThread("thread", "desktop-owner")).toBe(false);
    f.override = undefined;
    await f.client.followThread("thread", "desktop-owner");
    f.client.close();
    expect(f.client.isFollowingThread("thread", "desktop-owner")).toBe(false);
  });

  it("invalidates the old snapshot when discovery returns a different owner", async () => {
    const f = await fixture();
    await follow(f);
    f.override = (message) => {
      if (message.method !== "thread-owner-discovery") return false;
      f.send({ type: "response", requestId: message.requestId, resultType: "success", method: message.method,
        handledByClientId: "replacement-owner", result: { supportsUntrustedAppInput: true } });
      return true;
    };
    await f.client.discoverOwner("thread");
    expect(f.client.isFollowingThread("thread", "desktop-owner")).toBe(false);
    expect(f.client.isFollowingThread("thread", "replacement-owner")).toBe(false);
  });
});

describe("CodexDesktopIpcClient.notifyThreadMetadataAvailable", () => {
  it.each(["local", "ssh-host"])("notifies only the followed owner on %s using this client's identity", async (hostId) => {
    const f = await fixture();
    await follow(f, hostId);
    expect(f.client.isFollowingThread("thread", "desktop-owner", hostId)).toBe(true);
    const before = f.messages.length;
    if (hostId === "local") f.client.notifyThreadMetadataAvailable("thread", "desktop-owner");
    else f.client.notifyThreadMetadataAvailable("thread", "desktop-owner", hostId);
    await vi.waitFor(() => expect(f.messages).toHaveLength(before + 1));
    expect(f.messages[before]).toEqual({ type: "broadcast", method: "thread-unarchived", version: 1,
      sourceClientId: "codemux-client", targetClientIds: ["desktop-owner"], params: { conversationId: "thread", hostId } });
    f.send({ type: "client-discovery-request", requestId: "metadata-owner-check", request: {
      method: "thread-owner-discovery", version: 1, params: { conversationId: "thread", hostId },
    } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ type: "client-discovery-response",
      requestId: "metadata-owner-check", response: { canHandle: false } }));
    expect(f.messages.some((message) => ["thread/archive", "thread/unarchive"].includes(message.method ?? ""))).toBe(false);
  });

  it("rejects notification before following or receiving the initial snapshot", async () => {
    const f = await fixture();
    await f.client.connect();
    expect(() => f.client.notifyThreadMetadataAvailable("thread", "desktop-owner")).toThrow(expect.objectContaining({ code: "thread-not-synchronized" }));
    await f.client.discoverOwner("thread");
    expect(() => f.client.notifyThreadMetadataAvailable("thread", "desktop-owner")).toThrow(expect.objectContaining({ code: "thread-not-synchronized" }));
    f.override = (message) => message.method === "thread-stream-following-changed";
    const following = f.client.followThread("thread", "desktop-owner");
    await vi.waitFor(() => expect(f.messages.at(-1)?.method).toBe("thread-stream-following-changed"));
    expect(() => f.client.notifyThreadMetadataAvailable("thread", "desktop-owner")).toThrow(expect.objectContaining({ code: "thread-not-synchronized" }));
    f.send(streamMessage({ type: "snapshot", revision: 1, conversationState: { id: "thread" } }));
    await following;
    await f.client.discoverOwner("barrier-thread");
    expect(f.messages.some((message) => message.method === "thread-unarchived")).toBe(false);
  });

  it.each([
    ["another-thread", "desktop-owner", "local"],
    ["thread", "another-owner", "local"],
    ["thread", "desktop-owner", "ssh-host"],
  ])("rejects an unmatched thread, owner, or host: %s / %s / %s", async (conversationId, ownerClientId, hostId) => {
    const f = await fixture();
    await follow(f);
    expect(f.client.isFollowingThread(conversationId, ownerClientId, hostId)).toBe(false);
    expect(() => f.client.notifyThreadMetadataAvailable(conversationId, ownerClientId, hostId)).toThrow(expect.objectContaining({ code: "thread-not-synchronized" }));
    await f.client.discoverOwner("barrier-thread");
    expect(f.messages.some((message) => message.method === "thread-unarchived")).toBe(false);
  });

  it("rejects both the old and replacement owners after discovery changes", async () => {
    const f = await fixture();
    await follow(f);
    f.override = (message) => {
      if (message.method !== "thread-owner-discovery") return false;
      f.send({ type: "response", requestId: message.requestId, resultType: "success", method: message.method,
        handledByClientId: "replacement-owner", result: { supportsUntrustedAppInput: true } });
      return true;
    };
    await f.client.discoverOwner("thread");
    for (const ownerClientId of ["desktop-owner", "replacement-owner"]) {
      expect(() => f.client.notifyThreadMetadataAvailable("thread", ownerClientId)).toThrow(expect.objectContaining({ code: "thread-not-synchronized" }));
    }
    await f.client.discoverOwner("barrier-thread");
    expect(f.messages.some((message) => message.method === "thread-unarchived")).toBe(false);
  });

  it("rejects a closed connection with the existing not-connected error", async () => {
    const f = await fixture();
    await follow(f);
    f.client.close();
    expect(() => f.client.notifyThreadMetadataAvailable("thread", "desktop-owner")).toThrow(expect.objectContaining({ code: "not-connected" }));
    expect(f.messages.some((message) => message.method === "thread-unarchived")).toBe(false);
  });
});

describe("CodexDesktopIpcClient.requestFollower", () => {
  it("preserves the installed settings, queue, edit, and response contracts", async () => {
    const f = await fixture();
    await follow(f);
    f.override = (message) => {
      if (message.type !== "request") return false;
      f.send({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, handledByClientId: "desktop-owner",
        result: message.method === "thread-follower-read-model-settings" ? { settings: { model: "model", reasoningEffort: "high", modelProvider: "custom" } }
          : message.method === "thread-follower-update-thread-settings" ? { applied: true } : { ok: true } });
      return true;
    };
    await expect(f.client.readModelSettings("thread", "desktop-owner")).resolves.toMatchObject({ settings: { model: "model", modelProvider: "custom" } });
    const settings = { model: "next-model", effort: "high", serviceTier: "fast", collaborationMode: { mode: "plan", settings: { model: "next-model", reasoning_effort: "high" } } };
    await expect(f.client.updateThreadSettings("thread", "desktop-owner", settings, { condition: { ifEffortEquals: "medium", ifModelEquals: "model" } })).resolves.toEqual({ applied: true });
    await f.client.updateDaybreak("thread", "desktop-owner", true);
    await f.client.compactThread("thread", "desktop-owner");
    await f.client.editLastUserTurn("thread", "desktop-owner", { turnId: "turn", message: "edited", agentMode: "auto", shouldSendPermissionOverrides: false });
    const queued = [{ id: "queued", text: "later", context: {}, createdAt: 1 }];
    await f.client.setQueuedFollowUps("thread", "desktop-owner", queued, ["discarded"]);
    await f.client.removeQueuedMessage("thread", "desktop-owner", "queued");
    await f.client.clearQueuedMessages("thread", "desktop-owner");
    await f.client.replyPermissionsApproval("thread", "desktop-owner", "permissions", { permissions: {}, scope: "turn" });
    await f.client.replyMcpElicitation("thread", "desktop-owner", "elicitation", { action: "decline" });
    const requests = f.messages.filter((message) => message.method?.startsWith("thread-follower-"));
    expect(requests.map((message) => message.version)).toEqual([1, 2, 1, 1, 2, 1, 1, 1, 1, 1]);
    expect(requests[1].params).toEqual({ conversationId: "thread", threadSettings: settings, condition: { ifEffortEquals: "medium", ifModelEquals: "model" } });
    expect(requests[5].params).toEqual({ conversationId: "thread", state: { thread: queued }, discardedMessageIds: ["discarded"] });
    expect(requests[8].params).toEqual({ conversationId: "thread", requestId: "permissions", response: { permissions: {}, scope: "turn" } });
    expect(requests[9].params).toEqual({ conversationId: "thread", requestId: "elicitation", response: { action: "decline" } });
  });

  it("carries data URL image input without inventing local file attachments", async () => {
    const f = await fixture();
    await follow(f);
    const input = [{ type: "text", text: "Inspect this image", text_elements: [] }, { type: "image", url: "data:image/png;base64,fixture" }];
    await f.client.startTurn("thread", "desktop-owner", { request: { threadId: "thread", input }, context: { attachments: [] } });
    expect(f.messages.at(-1)?.params).toMatchObject({ turnStart: { request: { input }, context: { attachments: [] } } });
  });

  it("routes start, steering, interruption, and approvals through the verified owner", async () => {
    const f = await fixture();
    await follow(f);
    await f.client.startTurn("thread", "desktop-owner", { request: { threadId: "thread", input: [{ type: "text", text: "hello" }] } });
    await f.client.steerTurn("thread", "desktop-owner", { input: [{ type: "text", text: "continue" }], clientUserMessageId: "message", restoreMessage: { id: "message", context: {} } });
    await f.client.interruptTurn("thread", "desktop-owner", "active-turn");
    await f.client.replyCommandApproval("thread", "desktop-owner", "approval", "accept");
    await f.client.replyFileApproval("thread", "desktop-owner", "file-approval", "decline");
    await f.client.submitUserInput("thread", "desktop-owner", "question", { answers: {} });
    const requests = f.messages.filter((message) => message.method?.startsWith("thread-follower-"));
    expect(requests.map((message) => message.version)).toEqual([2, 1, 4, 1, 1, 1]);
    expect(requests.every((message) => message.targetClientId === "desktop-owner" && message.hostId === undefined)).toBe(true);
    expect(requests[2].params).toEqual({ conversationId: "thread", mode: "user-stop", expectedTurnId: "active-turn" });
    expect(requests[3].params).toEqual({ conversationId: "thread", requestId: "approval", decision: "accept" });
  });

  it("uses the host-specific protocol version and rejects a response from another owner", async () => {
    const f = await fixture();
    await follow(f, "ssh-host");
    f.override = (message) => {
      f.send({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, handledByClientId: "another-owner", result: { ok: true } });
      return true;
    };
    await expect(f.client.interruptTurn("thread", "desktop-owner", "turn", "ssh-host")).rejects.toMatchObject({ code: "response-routing-mismatch" });
    expect(f.messages.at(-1)).toMatchObject({ hostId: "ssh-host", version: 5, targetClientId: "desktop-owner" });
  });

  it("never retries an ambiguous timed out mutation", async () => {
    const f = await fixture({ requestTimeoutMs: 100 });
    await follow(f);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.override = (message) => message.method === "thread-follower-start-turn";
    const assertion = expect(f.client.startTurn("thread", "desktop-owner", { request: { input: [] } })).rejects.toMatchObject({ code: "request-timeout" });
    await vi.waitFor(() => expect(f.messages.at(-1)?.method).toBe("thread-follower-start-turn"));
    await vi.advanceTimersByTimeAsync(11_100);
    await assertion;
    expect(f.messages.filter((message) => message.method === "thread-follower-start-turn")).toHaveLength(1);
  });

  it("allows discovery time in addition to the unchanged target-handler budget", async () => {
    const f = await fixture({ requestTimeoutMs: 100 });
    await follow(f);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.override = (message) => {
      setTimeout(() => f.send({ type: "response", requestId: message.requestId, resultType: "success", method: message.method,
        handledByClientId: "desktop-owner", result: { result: { turnId: "turn" } } }), 10_050);
      return true;
    };
    const assertion = expect(f.client.startTurn("thread", "desktop-owner", { request: { input: [] } })).resolves.toEqual({ result: { turnId: "turn" } });
    await vi.waitFor(() => expect(f.messages.at(-1)?.method).toBe("thread-follower-start-turn"));
    await vi.advanceTimersByTimeAsync(10_050);
    await assertion;
    expect(f.messages.at(-1)?.timeoutMs).toBe(100);
  });

  it("keeps an explicit broker request-timeout response ambiguous", async () => {
    const f = await fixture({ requestTimeoutMs: 100 });
    await f.client.connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.override = (message) => {
      setTimeout(() => f.send({ type: "response", requestId: message.requestId, resultType: "error", error: "request-timeout" }), 10_100);
      return true;
    };
    const assertion = expect(f.client.discoverOwner("thread")).rejects.toMatchObject({ code: "request-timeout" });
    await vi.waitFor(() => expect(f.messages.at(-1)?.method).toBe("thread-owner-discovery"));
    await vi.advanceTimersByTimeAsync(10_100);
    await assertion;
  });
});

describe("CodexDesktopIpcClient.registerOwnedThread", () => {
  it("accepts the native composer queue protocol and publishes authoritative queues to followers", async () => {
    const f = await fixture();
    await f.client.connect();
    const queued = [{ id: "native-user", text: "Continue", context: {}, createdAt: 1 }];
    const handleRequest = vi.fn(async () => ({ ok: true }));
    f.client.registerOwnedThread({ conversationId: "owned", supportedMethods: ["thread-follower-set-queued-follow-ups-state"],
      getSnapshot: () => ({ type: "snapshot", revision: 1, conversationState: { id: "owned" } }),
      getQueuedFollowUps: () => queued, handleRequest });
    f.send({ type: "client-discovery-request", requestId: "queue-discovery", request: {
      method: "thread-follower-set-queued-follow-ups-state", version: 1, params: { conversationId: "owned", state: { owned: queued }, discardedMessageIds: [] },
    } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ requestId: "queue-discovery", response: { canHandle: true } }));
    f.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1, sourceClientId: "desktop-follower",
      targetClientIds: ["codemux-client"], params: { conversationId: "owned", hostId: "local", following: true } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ method: "thread-queued-followups-changed", version: 2,
      targetClientIds: ["desktop-follower"], params: { conversationId: "owned", hostId: "local", messages: queued } }));
    f.send({ type: "request", requestId: "native-queue", sourceClientId: "desktop-follower", targetClientId: "codemux-client",
      method: "thread-follower-set-queued-follow-ups-state", version: 1, params: { conversationId: "owned", state: { owned: queued }, discardedMessageIds: [] } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ requestId: "native-queue", resultType: "success", result: { ok: true } }));
    expect(handleRequest).toHaveBeenCalledOnce();
    f.client.publishOwnedQueuedFollowUps("owned", []);
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ method: "thread-queued-followups-changed", version: 2,
      targetClientIds: ["desktop-follower"], params: { conversationId: "owned", messages: [] } }));
    expect(() => f.client.publishOwnedQueuedFollowUps("unowned", [])).toThrow("thread-not-owned");
  });

  it("advertises only explicitly owned threads and exact supported method versions", async () => {
    const f = await fixture();
    await f.client.connect();
    const unregister = f.client.registerOwnedThread({ conversationId: "owned", supportedMethods: ["thread-follower-start-turn"],
      getSnapshot: () => ({ type: "snapshot", revision: 1, conversationState: { id: "owned" } }), handleRequest: async () => ({ result: {} }) });
    const cases = [
      { id: "owner", method: "thread-owner-discovery", version: 1, conversationId: "owned", canHandle: true },
      { id: "start", method: "thread-follower-start-turn", version: 2, conversationId: "owned", canHandle: true },
      { id: "old-version", method: "thread-follower-start-turn", version: 1, conversationId: "owned", canHandle: false },
      { id: "unowned", method: "thread-follower-start-turn", version: 2, conversationId: "other", canHandle: false },
      { id: "unsupported", method: "thread-follower-steer-turn", version: 1, conversationId: "owned", canHandle: false },
      { id: "invented", method: "thread-follower-create-thread", version: 0, conversationId: "owned", canHandle: false },
    ];
    for (const test of cases) {
      f.send({ type: "client-discovery-request", requestId: test.id, request: { method: test.method, version: test.version,
        params: { conversationId: test.conversationId, hostId: "local" } } });
    }
    await vi.waitFor(() => expect(f.messages.filter((message) => message.type === "client-discovery-response")).toHaveLength(cases.length));
    for (const test of cases) expect(f.messages.find((message) => message.requestId === test.id)).toMatchObject({ response: { canHandle: test.canHandle } });
    unregister();
    expect(() => f.client.publishOwnedThreadState("owned", { type: "snapshot", revision: 1, conversationState: { id: "owned" } })).toThrow("thread-not-owned");
  });

  it("publishes snapshots and patches only to the current followers", async () => {
    const f = await fixture();
    await f.client.connect();
    f.client.registerOwnedThread({ conversationId: "owned", supportedMethods: [],
      getSnapshot: () => ({ type: "snapshot", revision: 1, conversationState: { id: "owned", turns: [] } }), handleRequest: async () => ({}) });
    f.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1, sourceClientId: "desktop-follower",
      targetClientIds: ["codemux-client"], params: { conversationId: "owned", hostId: "local", following: true } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ method: "thread-stream-state-changed", version: 11, targetClientIds: ["desktop-follower"],
      params: { conversationId: "owned", change: { type: "snapshot", revision: 1 } } }));
    f.client.publishOwnedThreadState("owned", { type: "patches", revision: 2, baseRevision: 1, patches: [] });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ targetClientIds: ["desktop-follower"], params: { change: { type: "patches", revision: 2 } } }));
    const count = f.messages.length;
    f.send({ type: "broadcast", method: "client-status-changed", version: 0, sourceClientId: "desktop-follower", params: { clientId: "desktop-follower", status: "disconnected" } });
    await new Promise<void>((resolve) => f.client.once("ownerDisconnected", () => resolve()));
    f.client.publishOwnedThreadState("owned", { type: "snapshot", revision: 3, conversationState: { id: "owned" } });
    expect(f.messages).toHaveLength(count);
  });

  it("routes owner requests, deduplicates request IDs, and redacts execution errors", async () => {
    const f = await fixture();
    await f.client.connect();
    const handleRequest = vi.fn(async (_method: DesktopFollowerMethod, params: Record<string, unknown>) => {
      if (params.fail) throw new Error("PRIVATE_SOURCE_TEXT");
      return { result: { turnId: "owned-turn" } };
    });
    f.client.registerOwnedThread({ conversationId: "owned", supportedMethods: ["thread-follower-start-turn"],
      getSnapshot: () => ({ type: "snapshot", revision: 1, conversationState: { id: "owned" } }), handleRequest });
    f.send({ type: "request", requestId: "discover", sourceClientId: "desktop-follower", targetClientId: "codemux-client", method: "thread-owner-discovery", version: 1,
      params: { conversationId: "owned", hostId: "local" } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ requestId: "discover", result: { supportsUntrustedAppInput: false } }));
    expect(f.messages.at(-1)?.result).toEqual({ supportsUntrustedAppInput: false });
    const request = { type: "request", requestId: "start-owned", sourceClientId: "desktop-follower", targetClientId: "codemux-client", method: "thread-follower-start-turn", version: 2,
      params: { conversationId: "owned", turnStart: { request: { input: [] } } } };
    f.send(request);
    f.send(request);
    await vi.waitFor(() => expect(f.messages.filter((message) => message.requestId === "start-owned")).toHaveLength(2));
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(f.messages.at(-1)).toMatchObject({ resultType: "success", handledByClientId: "codemux-client", result: { result: { turnId: "owned-turn" } } });
    f.send({ ...request, requestId: "failed-owned", params: { ...request.params, fail: true } });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ requestId: "failed-owned", resultType: "error", error: "owner-request-failed" }));
    expect(JSON.stringify(f.messages)).not.toContain("PRIVATE_SOURCE_TEXT");
  });

  it("advertises a configured owner application without changing discovery routing", async () => {
    const f = await fixture();
    await f.client.connect();
    f.client.registerOwnedThread({ conversationId: "owned", clientName: "CodeMux", supportedMethods: [],
      getSnapshot: () => ({ type: "snapshot", revision: 1, conversationState: { id: "owned" } }), handleRequest: async () => ({}),
    });
    f.send({ type: "request", requestId: "named-owner", sourceClientId: "follower", targetClientId: "codemux-client", method: "thread-owner-discovery", version: 1,
      params: { conversationId: "owned", hostId: "local" },
    });
    await vi.waitFor(() => expect(f.messages.at(-1)).toMatchObject({ requestId: "named-owner", handledByClientId: "codemux-client", result: { supportsUntrustedAppInput: false, clientName: "CodeMux" } }));
  });

  it("refuses to claim a followed thread and releases registrations on close", async () => {
    const f = await fixture();
    await follow(f);
    const registration = { conversationId: "thread", supportedMethods: [],
      getSnapshot: () => ({ type: "snapshot" as const, revision: 1, conversationState: { id: "thread" } }), handleRequest: async () => ({}) };
    expect(() => f.client.registerOwnedThread(registration)).toThrow("thread-ownership-conflict");
    f.client.registerOwnedThread({ ...registration, conversationId: "owned" });
    f.client.close();
    await f.client.connect();
    expect(() => f.client.publishOwnedThreadState("owned", { type: "snapshot", revision: 1, conversationState: { id: "owned" } })).toThrow("thread-not-owned");
  });
});

describe("CodexDesktopIpcClient.close", () => {
  it("rejects outstanding requests and only detaches this connection", async () => {
    const f = await fixture();
    await follow(f);
    f.override = () => true;
    const pending = f.client.loadCompleteHistory("thread", "desktop-owner");
    f.client.close();
    await expect(pending).rejects.toMatchObject({ code: "client-closed" });
    expect(f.client.connected).toBe(false);
    expect(f.messages.some((message) => ["thread/unsubscribe", "turn/interrupt", "thread-follower-interrupt-turn"].includes(message.method ?? ""))).toBe(false);
    f.override = undefined;
    await f.client.connect();
    expect(f.client.connected).toBe(true);
  });

  it.each([0, 4097])("rejects invalid frame length %s before allocating a body", async (length) => {
    const f = await fixture({ maxFrameBytes: 4096 });
    await f.client.connect();
    const error = vi.fn();
    f.client.on("error", error);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(length);
    f.sendBytes(header);
    await vi.waitFor(() => expect(f.client.connected).toBe(false));
    expect(error.mock.calls[0][0]).toMatchObject({ code: "invalid-frame-length" });
  });
});
