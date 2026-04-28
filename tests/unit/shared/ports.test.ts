import { afterEach, describe, expect, it, vi } from "vitest";

const PORT_ENV_KEYS = [
  "CODEMUX_PORT_OFFSET",
  "CODEMUX_WEB_PORT",
  "CODEMUX_WEB_STANDALONE_PORT",
  "CODEMUX_GATEWAY_PORT",
  "CODEMUX_OPENCODE_PORT",
  "CODEMUX_AUTH_API_PORT",
  "CODEMUX_WEBHOOK_PORT",
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of PORT_ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

async function importPorts(env: Partial<Record<(typeof PORT_ENV_KEYS)[number], string>> = {}) {
  vi.resetModules();
  for (const key of PORT_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  return import("../../../shared/ports");
}

describe("shared ports", () => {
  afterEach(() => {
    vi.resetModules();
    for (const key of PORT_ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("uses default ports without environment overrides", async () => {
    const ports = await importPorts();

    expect(ports.PORT_OFFSET).toBe(0);
    expect(ports.WEB_PORT).toBe(8233);
    expect(ports.WEB_STANDALONE_PORT).toBe(8234);
    expect(ports.GATEWAY_PORT).toBe(4200);
    expect(ports.OPENCODE_PORT).toBe(4096);
    expect(ports.AUTH_API_PORT).toBe(4097);
    expect(ports.WEBHOOK_PORT).toBe(4098);
  });

  it("applies CODEMUX_PORT_OFFSET to every default port", async () => {
    const ports = await importPorts({ CODEMUX_PORT_OFFSET: "100" });

    expect(ports.PORT_OFFSET).toBe(100);
    expect(ports.WEB_PORT).toBe(8333);
    expect(ports.WEB_STANDALONE_PORT).toBe(8334);
    expect(ports.GATEWAY_PORT).toBe(4300);
    expect(ports.OPENCODE_PORT).toBe(4196);
    expect(ports.AUTH_API_PORT).toBe(4197);
    expect(ports.WEBHOOK_PORT).toBe(4198);
  });

  it("lets individual port overrides win over the offset", async () => {
    const ports = await importPorts({
      CODEMUX_PORT_OFFSET: "100",
      CODEMUX_WEB_PORT: "9001",
      CODEMUX_GATEWAY_PORT: "9002",
    });

    expect(ports.WEB_PORT).toBe(9001);
    expect(ports.GATEWAY_PORT).toBe(9002);
    expect(ports.OPENCODE_PORT).toBe(4196);
  });

  it("ignores invalid numeric values", async () => {
    const ports = await importPorts({
      CODEMUX_PORT_OFFSET: "abc",
      CODEMUX_WEB_PORT: "70000",
      CODEMUX_GATEWAY_PORT: "0",
    });

    expect(ports.PORT_OFFSET).toBe(0);
    expect(ports.WEB_PORT).toBe(8233);
    expect(ports.GATEWAY_PORT).toBe(4200);
  });
});
