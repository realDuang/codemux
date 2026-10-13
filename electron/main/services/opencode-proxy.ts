import http from "http";
import { sendJson } from "../../../shared/http-utils";
import { OPENCODE_PORT } from "../../../shared/ports";
import { prodServerLog } from "./logger";

/**
 * Proxy a request to OpenCode server
 */
export function proxyToOpenCode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetPath: string
): void {
  const body: Buffer[] = [];

  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    const bodyBuffer = Buffer.concat(body);

    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: OPENCODE_PORT,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${OPENCODE_PORT}`,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Copy status and headers
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      prodServerLog.error("Proxy to OpenCode failed:", err.message);
      sendJson(res, { error: "OpenCode service unavailable", details: err.message }, 503);
    });

    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });

  req.on("error", (err) => {
    prodServerLog.error("Request error:", err);
    sendJson(res, { error: "Request failed" }, 500);
  });
}
