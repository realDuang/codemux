import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuPlatform } from "./feishu-types";

export function normalizeFeishuPlatform(value: unknown): FeishuPlatform {
  return value === "lark" ? "lark" : "feishu";
}

export function getLarkDomain(platform: FeishuPlatform): lark.Domain {
  return platform === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

export function formatFeishuStartupError(
  error: unknown,
  platform: FeishuPlatform,
  platformConfigured = true,
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("Failed to connect to") || message.startsWith("Timed out waiting for")) {
    return message;
  }

  if (message.includes("PingInterval") || message.includes("system busy")) {
    const platformName = platform === "lark" ? "Lark" : "Feishu";
    const platformHint = !platformConfigured && platform === "feishu"
      ? " If this is a Lark app from open.larksuite.com, open Configure and switch Platform to Lark, then save."
      : "";
    return `Failed to connect to ${platformName} long connection. Verify the app is a self-built app, long connection is enabled in the correct developer console, and the selected platform matches your tenant.${platformHint} Original error: ${message}`;
  }

  return message;
}
