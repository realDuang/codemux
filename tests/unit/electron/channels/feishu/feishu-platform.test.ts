import * as lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_FEISHU_CONFIG } from "../../../../../electron/main/channels/feishu/feishu-types";
import {
  formatFeishuStartupError,
  getLarkDomain,
  normalizeFeishuPlatform,
} from "../../../../../electron/main/channels/feishu/feishu-platform";

describe("DEFAULT_FEISHU_CONFIG", () => {
  it("defaults platform to feishu", () => {
    expect(DEFAULT_FEISHU_CONFIG.platform).toBe("feishu");
  });
});

describe("normalizeFeishuPlatform", () => {
  it.each([
    { input: "feishu", expected: "feishu" },
    { input: "lark", expected: "lark" },
    { input: undefined, expected: "feishu" },
    { input: "unexpected", expected: "feishu" },
  ])("normalizes $input to $expected", ({ input, expected }) => {
    expect(normalizeFeishuPlatform(input)).toBe(expected);
  });
});

describe("getLarkDomain", () => {
  it("maps feishu platform to the Feishu SDK domain", () => {
    expect(getLarkDomain("feishu")).toBe(lark.Domain.Feishu);
  });

  it("maps lark platform to the Lark SDK domain", () => {
    expect(getLarkDomain("lark")).toBe(lark.Domain.Lark);
  });
});

describe("formatFeishuStartupError", () => {
  it("adds a Lark-specific hint for WS config failures", () => {
    const formatted = formatFeishuStartupError(
      new Error("Cannot read properties of undefined (reading 'PingInterval')"),
      "lark",
    );

    expect(formatted).toContain("Failed to connect to Lark long connection");
    expect(formatted).toContain("selected platform matches your tenant");
    expect(formatted).toContain("Original error");
  });

  it("adds a platform-selection hint when config defaulted to Feishu", () => {
    const formatted = formatFeishuStartupError(
      new Error("code: 1000040351, system busy"),
      "feishu",
      false,
    );

    expect(formatted).toContain("switch Platform to Lark");
  });

  it("returns the original message for unrelated errors", () => {
    expect(formatFeishuStartupError(new Error("boom"), "feishu")).toBe("boom");
  });

  it("preserves already formatted startup messages", () => {
    const message = "Timed out waiting for Lark websocket connection.";
    expect(formatFeishuStartupError(new Error(message), "lark")).toBe(message);
  });
});
