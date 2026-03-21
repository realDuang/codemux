// ============================================================================
// WebhookServer — Shared HTTP server for channel webhook callbacks
// Telegram and WeCom channels register route handlers to receive platform
// callbacks. Feishu uses its own WSClient and doesn't need this.
// ============================================================================

import http from "http";
import { channelLog } from "../services/logger";

/** Parsed webhook request */
export interface WebhookRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** Raw request body as Buffer */
  rawBody: Buffer;
  /** Parsed body (JSON or URL-encoded), null if parse failed or raw XML */
  body: unknown;
  /** Content-Type header value */
  contentType: string;
}

/** Webhook route handler */
export type WebhookHandler = (
  req: WebhookRequest,
) => Promise<WebhookResponse>;

/** Response from a webhook handler */
export interface WebhookResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/**
 * Shared HTTP server for receiving webhook callbacks from chat platforms.
 * Channels register path-based route handlers (e.g., "/webhook/telegram").
 */
export class WebhookServer {
  private server: http.Server | null = null;
  private routes = new Map<string, WebhookHandler>();
  private port: number;

  constructor(port = 4098) {
    this.port = port;
  }

  /** Register a route handler for a path prefix (e.g., "/webhook/telegram") */
  registerRoute(pathPrefix: string, handler: WebhookHandler): void {
    const normalized = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
    this.routes.set(normalized, handler);
    channelLog.info(`[Webhook] Registered route: ${normalized}`);
  }

  /** Unregister a route handler */
  unregisterRoute(pathPrefix: string): void {
    const normalized = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
    this.routes.delete(normalized);
    channelLog.info(`[Webhook] Unregistered route: ${normalized}`);
  }

  /** Start the HTTP server */
  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.on("error", (err) => {
        channelLog.error(`[Webhook] Server error:`, err);
        reject(err);
      });

      this.server!.listen(this.port, () => {
        channelLog.info(`[Webhook] Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /** Stop the HTTP server */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        channelLog.info("[Webhook] Server stopped");
        this.server = null;
        resolve();
      });
    });
  }

  /** Whether the server is currently running */
  get isRunning(): boolean {
    return this.server !== null;
  }

  /** The port the server is configured to use */
  get serverPort(): number {
    return this.port;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url || "/", `http://localhost:${this.port}`);
      const pathname = url.pathname;
      channelLog.verbose(`[Webhook] ${req.method} ${pathname}`);

      // Find matching route handler (longest prefix match)
      let matchedPrefix = "";
      let matchedHandler: WebhookHandler | undefined;
      for (const [prefix, handler] of this.routes) {
        if (pathname.startsWith(prefix) && prefix.length > matchedPrefix.length) {
          matchedPrefix = prefix;
          matchedHandler = handler;
        }
      }

      if (!matchedHandler) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      // Read request body
      let rawBody: Buffer;
      try {
        rawBody = await this.readBody(req);
      } catch (err: any) {
        if (err?.message?.includes("5MB")) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Request Entity Too Large");
          return;
        }
        throw err;
      }
      const contentType = (req.headers["content-type"] || "").toLowerCase();

      // Parse body based on content type
      let body: unknown = null;
      if (contentType.includes("application/json")) {
        try {
          body = JSON.parse(rawBody.toString("utf-8"));
        } catch {
          // Leave body as null
        }
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        try {
          body = Object.fromEntries(new URLSearchParams(rawBody.toString("utf-8")));
        } catch {
          // Leave body as null
        }
      }
      // For XML (WeCom) and other content types, body stays null — use rawBody

      // Build query params
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        query[key] = value;
      }

      const webhookReq: WebhookRequest = {
        method: (req.method || "GET").toUpperCase(),
        path: pathname,
        query,
        headers: req.headers as Record<string, string | string[] | undefined>,
        rawBody,
        body,
        contentType,
      };

      const webhookRes = await matchedHandler(webhookReq);

      // Send response
      const responseHeaders = webhookRes.headers || {};
      if (!responseHeaders["Content-Type"] && !responseHeaders["content-type"]) {
        responseHeaders["Content-Type"] = "text/plain";
      }
      res.writeHead(webhookRes.status, responseHeaders);
      res.end(webhookRes.body ?? "");
    } catch (err) {
      channelLog.error("[Webhook] Request handling error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let rejected = false;
      req.on("data", (chunk: Buffer) => {
        if (rejected) return;
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          rejected = true;
          req.removeAllListeners("data");
          reject(new Error("Body exceeds 5MB limit"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
      req.on("error", reject);
    });
  }
}
