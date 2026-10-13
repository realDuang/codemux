import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readRemoteAccessMode } from "../../../shared/remote-access";
import { isRemoteAccessRequestAllowed } from "../../../shared/remote-access-policy";

const CUSTOM_URL = "http://192.168.31.123:18233";

function request(
  headers: IncomingHttpHeaders,
  remoteAddress = "192.168.31.2",
  rawHeaders = ["Host", headers.host ?? ""],
): IncomingMessage {
  return { headers, rawHeaders, socket: { remoteAddress } } as IncomingMessage;
}

describe("Remote access admission", () => {
  describe("readRemoteAccessMode", () => {
    it("keeps an explicitly disabled installation off after retaining either provider configuration", () => {
      expect(readRemoteAccessMode({ remoteAccessMode: "off", customAccessUrl: CUSTOM_URL, tunnelConfig: { hostname: "codemux.example.com" } })).toBe("off");
      expect(readRemoteAccessMode({ tunnelConfig: { hostname: "codemux.example.com" } })).toBe("off");
      expect(readRemoteAccessMode({ remoteAccessMode: "unknown", customAccessUrl: CUSTOM_URL })).toBe("off");
    });
  });

  describe("isRemoteAccessRequestAllowed", () => {
    it("keeps direct local browser access available while rejecting remote and forwarded local impersonation when off", () => {
      const disabled = { mode: "off" as const, url: "" };
      expect(isRemoteAccessRequestAllowed(request({ host: "localhost:8233", origin: "http://localhost:8233" }, "127.0.0.1"), disabled)).toBe(true);
      expect(isRemoteAccessRequestAllowed(request({ host: "localhost:8233" }), disabled)).toBe(false);
      expect(isRemoteAccessRequestAllowed(request({ host: "localhost:8233", "x-forwarded-for": "192.168.31.2" }, "127.0.0.1"), disabled)).toBe(false);
      expect(isRemoteAccessRequestAllowed(request({ host: "192.168.31.123:18233" }), disabled)).toBe(false);
    });

    it("admits the selected custom address for browsers and requests without Origin", () => {
      const custom = { mode: "custom" as const, url: CUSTOM_URL };
      expect(isRemoteAccessRequestAllowed(request({ host: "192.168.31.123:18233", origin: CUSTOM_URL }), custom)).toBe(true);
      expect(isRemoteAccessRequestAllowed(request({ host: "192.168.31.123:18233" }), custom)).toBe(true);
      expect(isRemoteAccessRequestAllowed(request({ host: "192.168.31.123:18233", origin: CUSTOM_URL }), custom, true)).toBe(true);
    });

    it.each([
      { host: "192.168.31.123:8233" },
      { host: "codemux.example.com" },
      { host: "localhost:8233" },
      { host: "192.168.31.123:18233", origin: "https://192.168.31.123:18233" },
      { host: "192.168.31.123:18233", origin: "http://evil.example.com" },
      { host: "user@192.168.31.123:18233" },
      { host: "192.168.31.123:18233/path" },
      { host: "192.168.31.123:18233,localhost:8233" },
    ])("rejects a different or malformed browser entry %j", headers => {
      expect(isRemoteAccessRequestAllowed(request(headers), { mode: "custom", url: CUSTOM_URL })).toBe(false);
    });

    it("rejects duplicate Host headers even when Node exposes the expected first value", () => {
      const req = request(
        { host: "192.168.31.123:18233" },
        "192.168.31.2",
        ["Host", "192.168.31.123:18233", "hOsT", "evil.example.com"],
      );
      expect(isRemoteAccessRequestAllowed(req, { mode: "custom", url: CUSTOM_URL })).toBe(false);
    });

    it("admits only the active Cloudflare address and denies access until its URL is ready", () => {
      const active = { mode: "cloudflare" as const, url: "https://codemux.example.com" };
      expect(isRemoteAccessRequestAllowed(request({ host: "codemux.example.com", origin: active.url }), active)).toBe(true);
      expect(isRemoteAccessRequestAllowed(request({ host: "192.168.31.123:18233" }), active)).toBe(false);
      expect(isRemoteAccessRequestAllowed(request({ host: "codemux.example.com" }), { ...active, url: "" })).toBe(false);
    });

    it("keeps Electron and local development WebSockets usable while rejecting foreign origins", () => {
      const disabled = { mode: "off" as const, url: "" };
      for (const origin of [undefined, "null", "file://", "http://localhost:8233"]) {
        const local = request({ host: "localhost:4200", origin }, "127.0.0.1");
        expect(isRemoteAccessRequestAllowed(local, disabled, true)).toBe(true);
      }
      expect(isRemoteAccessRequestAllowed(request({ host: "localhost:4200", origin: "https://evil.example.com" }, "127.0.0.1"), disabled, true)).toBe(false);
      expect(isRemoteAccessRequestAllowed(request({ host: "localhost:4200", origin: "file://", "x-forwarded-for": "192.168.31.2" }, "127.0.0.1"), disabled, true)).toBe(false);
    });
  });
});
