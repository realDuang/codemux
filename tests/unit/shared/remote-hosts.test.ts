import { describe, expect, it } from "vitest";
import {
  getDirectHostUrl,
  normalizeRemoteHostInput,
  parseSshAddress,
} from "../../../shared/remote-hosts";

describe("normalizeRemoteHostInput", () => {
  it("trims names and connection addresses without changing SSH config alias casing", () => {
    expect(normalizeRemoteHostInput({
      name: "  Development Mac  ",
      connection: { type: "ssh", address: "  Work-Mac  ", remotePort: 8233 },
    })).toEqual({
      name: "Development Mac",
      connection: { type: "ssh", address: "Work-Mac", remotePort: 8233 },
    });
  });

  it.each([undefined, "", "  "])("uses the connection address when the name is %j", (name) => {
    expect(normalizeRemoteHostInput({
      name,
      connection: { type: "direct", host: "  desktop.local  ", port: 8233, useTls: false },
    })).toEqual({
      name: "desktop.local",
      connection: { type: "direct", host: "desktop.local", port: 8233, useTls: false },
    });
    expect(normalizeRemoteHostInput({
      name,
      connection: { type: "ssh", address: "Dev-Box", remotePort: 8233 },
    })).toEqual({
      name: "Dev-Box",
      connection: { type: "ssh", address: "Dev-Box", remotePort: 8233 },
    });
  });

  it.each(["localhost", "desktop.local", "192.168.1.10", "2001:db8::1", "::1"])(
    "accepts the direct host %s",
    (host) => {
      expect(normalizeRemoteHostInput({
        connection: { type: "direct", host, port: 8233, useTls: false },
      }).connection).toEqual({ type: "direct", host, port: 8233, useTls: false });
    },
  );

  it.each([
    "https://desktop.local",
    "desktop.local/path",
    "desktop.local?token=secret",
    "desktop.local#secret",
    "user@desktop.local",
    "desktop.local:8233",
    "desktop local",
    "desktop\nlocal",
    "",
  ])("rejects a direct host that contains more than a host: %j", (host) => {
    expect(() => normalizeRemoteHostInput({
      connection: { type: "direct", host, port: 8233, useTls: false },
    })).toThrow();
  });

  it.each([0, -1, 65536, 8233.5, "8233", null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the invalid direct and forwarded port %j",
    (port) => {
      expect(() => normalizeRemoteHostInput({
        connection: { type: "direct", host: "desktop.local", port, useTls: false },
      })).toThrow();
      expect(() => normalizeRemoteHostInput({
        connection: { type: "ssh", address: "Dev-Box", remotePort: port },
      })).toThrow();
    },
  );

  it.each([1, 65535])("accepts port boundary %i", (port) => {
    expect(normalizeRemoteHostInput({
      connection: { type: "direct", host: "desktop.local", port, useTls: true },
    }).connection).toMatchObject({ port, useTls: true });
    expect(normalizeRemoteHostInput({
      connection: { type: "ssh", address: "Dev-Box", remotePort: port },
    }).connection).toMatchObject({ remotePort: port });
  });

  it.each(["true", 1, null, undefined])("rejects a non-boolean TLS flag %j", (useTls) => {
    expect(() => normalizeRemoteHostInput({
      connection: { type: "direct", host: "desktop.local", port: 8233, useTls },
    })).toThrow();
  });

  it.each([
    null,
    [],
    "desktop.local",
    {},
    { connection: null },
    { connection: { type: "relay", address: "desktop.local" } },
    { name: 123, connection: { type: "ssh", address: "Dev-Box", remotePort: 8233 } },
    { name: "bad\u0000name", connection: { type: "ssh", address: "Dev-Box", remotePort: 8233 } },
    { password: "do-not-save", connection: { type: "ssh", address: "Dev-Box", remotePort: 8233 } },
    { connection: { type: "ssh", address: "Dev-Box", remotePort: 8233, privateKey: "do-not-save" } },
    { connection: { type: "direct", host: "desktop.local", port: 8233, useTls: false, token: "do-not-save" } },
  ])("rejects malformed inputs and extra fields: %j", (input) => {
    expect(() => normalizeRemoteHostInput(input)).toThrow();
  });
});

describe("getDirectHostUrl", () => {
  it.each([
    ["desktop.local", 8233, false, "http://desktop.local:8233"],
    ["Desktop.EXAMPLE", 443, true, "https://desktop.example"],
    ["desktop.local", 80, false, "http://desktop.local"],
    ["192.168.1.10", 8443, true, "https://192.168.1.10:8443"],
    ["2001:db8::1", 8233, false, "http://[2001:db8::1]:8233"],
    ["::1", 443, true, "https://[::1]"],
  ] as const)("builds a canonical origin for %s:%i with TLS %s", (host, port, useTls, expected) => {
    expect(getDirectHostUrl({ type: "direct", host, port, useTls })).toBe(expected);
  });
});

describe("parseSshAddress", () => {
  it.each([
    ["Work-Mac", { destination: "Work-Mac" }],
    ["  Work-Mac  ", { destination: "Work-Mac" }],
    ["DevUser@Work-Mac", { destination: "DevUser@Work-Mac" }],
    ["user@192.168.1.10:2222", { destination: "user@192.168.1.10", port: 2222 }],
    ["ssh://DevUser@Work-Mac:2222", { destination: "DevUser@Work-Mac", port: 2222 }],
    ["ssh://DevUser@Work-Mac/", { destination: "DevUser@Work-Mac" }],
    ["[2001:db8::1]", { destination: "2001:db8::1" }],
    ["user@[2001:db8::1]:2222", { destination: "user@2001:db8::1", port: 2222 }],
    ["ssh://user@[2001:db8::1]:2222/", { destination: "user@2001:db8::1", port: 2222 }],
  ])("parses %s without losing connection details", (address, expected) => {
    expect(parseSshAddress(address as string)).toEqual(expected);
  });

  it.each([
    "",
    "-oProxyCommand=whoami",
    "user@host -p 22",
    "user@host\n-oProxyCommand=whoami",
    "user\u0000@host",
    "user:password@host",
    "ssh://user:password@host",
    "ssh://user@host/path",
    "ssh://user@host?token=secret",
    "ssh://user@host#secret",
    "https://user@host",
    "user@host:0",
    "user@host:65536",
    "user@host:22.5",
    "user@host:port",
    "user@host:",
    "user@[2001:db8::1]:65536",
    "user@[2001:db8::1",
    "user@@host",
    "user@",
  ])("rejects unsafe or malformed SSH addresses: %j", (address) => {
    expect(() => parseSshAddress(address)).toThrow();
  });
});
