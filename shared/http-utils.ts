import type { IncomingMessage, ServerResponse } from "http";

// =============================================================================
// Common HTTP utilities shared across Vite plugins, Electron servers, and tests
// =============================================================================

/**
 * Send a JSON response with optional status code and CORS headers.
 */
export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-opencode-directory",
  });
  res.end(body);
}

/**
 * Parse the JSON body of an incoming HTTP request.
 * Enforces a 1MB size limit to prevent abuse.
 */
export function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB

    req.on("data", (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Extract a Bearer token from the Authorization header.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

/**
 * Get the client IP address from the request,
 * checking X-Forwarded-For header first for proxied requests.
 */
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Check if an IP address is localhost.
 */
export function isLocalhost(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
