import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { isLocalRequest } from "./http-utils";
import {
  HOST_CONTROL_FILENAME,
  type HostControlMetadata,
  type HostRuntimeStatus,
} from "./host-control-types";

export interface HostControlServerOptions {
  dataPath: string;
  invoke: (method: string, args?: unknown[]) => unknown | Promise<unknown>;
  getStatus: () => HostRuntimeStatus;
  stop: () => void | Promise<void>;
}

export interface HostControlServer {
  readonly instanceId: string;
  readonly dataPath: string;
  readonly port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed) return;
  const serialized = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Connection": "close",
  });
  res.end(serialized);
}

async function readRequest(req: IncomingMessage): Promise<{ method: string; args: unknown[] }> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control request");
  const { method, args, ...extra } = value as Record<string, unknown>;
  if (typeof method !== "string" || !method || method.length > 128
    || (args !== undefined && !Array.isArray(args)) || Object.keys(extra).length > 0) {
    throw new Error("Invalid control request");
  }
  return { method, args: (args as unknown[] | undefined) ?? [] };
}

function isOwner(req: IncomingMessage, credential: Buffer): boolean {
  if (!isLocalRequest(req)) return false;
  const header = req.headers.authorization;
  const count = req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "authorization").length;
  if (count !== 1 || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  return supplied.length === credential.length && timingSafeEqual(supplied, credential);
}

function errorMessage(error: unknown, ownerCredential: string): string {
  const message = error instanceof Error ? error.message : "Host operation failed";
  return message.replaceAll(ownerCredential, "[redacted]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}

/** Start only after acquiring the runtime's data-directory lock. */
export async function startHostControlServer(options: HostControlServerOptions): Promise<HostControlServer> {
  const dataPath = await fs.realpath(options.dataPath);
  const instanceId = randomUUID();
  const ownerCredential = randomBytes(32).toString("hex");
  const credential = Buffer.from(ownerCredential, "utf8");
  const metadataPath = path.join(dataPath, HOST_CONTROL_FILENAME);
  const temporaryPath = path.join(dataPath, `.${HOST_CONTROL_FILENAME}.${instanceId}.tmp`);
  let stopRequested = false;
  let closing = false;
  const pendingInvocations = new Set<Promise<unknown>>();
  const server = http.createServer(async (req, res) => {
    if (!isOwner(req, credential)) {
      reply(res, 401, { error: "Unauthorized" });
      return;
    }
    // An exact path also rejects credentials passed in a URL or query string.
    if (req.method !== "POST" || req.url !== "/control") {
      reply(res, 404, { error: "Not found" });
      return;
    }
    let request: Awaited<ReturnType<typeof readRequest>>;
    try {
      request = await readRequest(req);
    } catch {
      if (!res.destroyed) reply(res, 400, { error: "Invalid control request" });
      return;
    }
    try {
      if (closing) {
        reply(res, 503, { error: "CodeMux host is stopping" });
        return;
      }
      if (request.method === "host:stop") {
        if (!stopRequested) {
          stopRequested = true;
          // Closing this listener during the request would wait for its own response.
          res.once("finish", () => {
            void Promise.resolve().then(options.stop).catch(() => {
              // The host owns shutdown failure reporting and process exit policy.
            });
          });
        }
        reply(res, 200, { result: { stopping: true } });
      } else {
        let result: unknown;
        if (request.method === "host:status") {
          result = options.getStatus();
        } else {
          const invocation = Promise.resolve().then(() => options.invoke(request.method, request.args));
          pendingInvocations.add(invocation);
          try {
            result = await invocation;
          } finally {
            pendingInvocations.delete(invocation);
          }
        }
        reply(res, 200, { result });
      }
    } catch (error) {
      reply(res, 400, { error: errorMessage(error, ownerCredential) });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const closeListener = () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Host control listener has no TCP address");
    const metadata: HostControlMetadata = {
      version: 1, instanceId, pid: process.pid, port: address.port, dataPath, ownerCredential,
    };
    await fs.writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, metadataPath);
    let closePromise: Promise<void> | undefined;
    return {
      instanceId, dataPath, port: address.port,
      close() {
        closing = true;
        closePromise ??= (async () => {
          await closeListener();
          // A caller disconnecting does not cancel an operation already in progress.
          await Promise.allSettled(pendingInvocations);
          try {
            const current: unknown = JSON.parse(await fs.readFile(metadataPath, "utf8"));
            if (current && typeof current === "object" && "instanceId" in current && current.instanceId === instanceId) {
              await fs.unlink(metadataPath);
            }
          } catch (error) {
            if (!(error instanceof SyntaxError) && (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")) throw error;
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (server.listening) await closeListener();
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
