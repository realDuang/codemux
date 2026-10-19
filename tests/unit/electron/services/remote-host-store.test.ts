import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteHostStore } from "../../../../electron/main/services/remote-host-store";
import type { RemoteHostInput } from "../../../../shared/remote-hosts";

let directory: string;
let filePath: string;

function directInput(name = "Office Mac"): RemoteHostInput {
  return {
    name,
    connection: { type: "direct", host: "desktop.local", port: 8233, useTls: false },
  };
}

function sshInput(): RemoteHostInput {
  return {
    name: "Development Server",
    connection: { type: "ssh", address: "Dev-Box", remotePort: 8233 },
  };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codemux-remote-host-store-"));
  filePath = path.join(directory, "remote-hosts.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("RemoteHostStore", () => {
  describe("list", () => {
    it("starts empty without writing a file when no hosts are saved", () => {
      expect(new RemoteHostStore(directory).list()).toEqual([]);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("returns independent nested copies of saved hosts", () => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(directInput());
      const listed = store.list();
      listed[0].name = "Changed externally";
      if (listed[0].connection.type === "direct") listed[0].connection.host = "attacker.local";
      listed.splice(0, 1);

      expect(store.list()).toEqual([saved]);
      expect(new RemoteHostStore(directory).list()).toEqual([saved]);
    });

    it("filters invalid saved records without rewriting the original file during loading", () => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(directInput());
      const raw = JSON.stringify({
        version: 1,
        hosts: [
          saved,
          null,
          { id: "missing-fields" },
          { ...saved, connection: { type: "direct", host: "bad/path", port: 8233, useTls: false } },
          { ...saved, connection: { type: "ssh", address: "Dev-Box", remotePort: 0 } },
          { ...saved, connection: { type: "ssh", address: "Dev-Box", remotePort: 8233, password: "secret" } },
          { ...saved, token: "secret" },
        ],
      });
      fs.writeFileSync(filePath, raw);

      expect(new RemoteHostStore(directory).list()).toEqual([saved]);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(raw);
    });

    it.each([
      "{broken json",
      "null",
      "[]",
      JSON.stringify({ version: 2, hosts: [] }),
      JSON.stringify({ version: 1, hosts: {} }),
      JSON.stringify({ version: 1 }),
    ])("fails without overwriting a malformed store: %s", (raw) => {
      fs.writeFileSync(filePath, raw);
      // A corrupt host list must not abort the unrelated local desktop startup.
      const store = new RemoteHostStore(directory);
      expect(() => store.list()).toThrow();
      expect(() => store.save(directInput())).toThrow();
      expect(() => store.remove("unknown")).toThrow();
      expect(fs.readFileSync(filePath, "utf-8")).toBe(raw);
    });
  });

  describe("get", () => {
    it("returns an independent nested copy and reports missing hosts", () => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(sshInput());
      const fetched = store.get(saved.id)!;
      fetched.name = "Changed externally";
      if (fetched.connection.type === "ssh") fetched.connection.address = "Other-Box";

      expect(store.get(saved.id)).toEqual(saved);
      expect(store.get("missing-host")).toBeUndefined();
    });
  });

  describe("save", () => {
    it("persists direct and SSH hosts with distinct stable identities and private permissions", () => {
      const store = new RemoteHostStore(directory);
      const direct = store.save(directInput());
      const ssh = store.save(sshInput());

      expect(direct.id).toEqual(expect.any(String));
      expect(direct.id).not.toBe(ssh.id);
      expect(direct.createdAt).toBeTruthy();
      expect(direct.updatedAt).toBeTruthy();
      expect(new RemoteHostStore(directory).list()).toEqual([direct, ssh]);
      if (process.platform !== "win32") expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(directory)).toEqual(["remote-hosts.json"]);
    });

    it("updates one host while preserving its identity and creation date", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-18T01:00:00.000Z"));
      const store = new RemoteHostStore(directory);
      const direct = store.save(directInput());
      const ssh = store.save(sshInput());
      vi.setSystemTime(new Date("2026-10-18T02:00:00.000Z"));

      const updated = store.save({
        name: "Office Mac Updated",
        connection: { type: "direct", host: "other.local", port: 443, useTls: true },
      }, direct.id);

      expect(updated).toMatchObject({
        id: direct.id,
        name: "Office Mac Updated",
        createdAt: direct.createdAt,
        connection: { type: "direct", host: "other.local", port: 443, useTls: true },
      });
      expect(updated.updatedAt).not.toEqual(direct.updatedAt);
      expect(store.list()).toEqual([updated, ssh]);
      expect(new RemoteHostStore(directory).get(direct.id)).toEqual(updated);
    });

    it("does not retain references from inputs or returned values", () => {
      const store = new RemoteHostStore(directory);
      const input = directInput();
      const saved = store.save(input);
      const expected = structuredClone(saved);
      input.name = "Input changed";
      if (input.connection.type === "direct") input.connection.host = "input.local";
      saved.name = "Result changed";
      if (saved.connection.type === "direct") saved.connection.host = "result.local";

      expect(store.get(saved.id)).toEqual(expected);
      expect(new RemoteHostStore(directory).get(saved.id)).toEqual(expected);
    });

    it.each([
      { ...directInput(), token: "do-not-persist" },
      { ...sshInput(), password: "do-not-persist" },
      { name: "Unsafe", connection: { type: "ssh", address: "user:do-not-persist@host", remotePort: 8233 } },
      { name: "Unsafe", connection: { type: "ssh", address: "Dev-Box", remotePort: 8233, privateKey: "do-not-persist" } },
    ])("rejects credentials and extra fields before persisting %j", (input) => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(directInput());
      const previous = fs.readFileSync(filePath, "utf-8");

      expect(() => store.save(input as RemoteHostInput)).toThrow();
      expect(store.list()).toEqual([saved]);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(previous);
      expect(previous).not.toContain("do-not-persist");
    });

    it.each(["writeFileSync", "renameSync"] as const)(
      "preserves the last successful state when %s fails",
      (operation) => {
        const store = new RemoteHostStore(directory);
        const saved = store.save(directInput());
        const previous = fs.readFileSync(filePath, "utf-8");
        const failure = new Error("Storage unavailable");
        vi.spyOn(fs, operation).mockImplementationOnce(() => { throw failure; });

        expect(() => store.save(sshInput())).toThrow(failure);
        expect(store.list()).toEqual([saved]);
        expect(fs.readFileSync(filePath, "utf-8")).toBe(previous);
        expect(new RemoteHostStore(directory).list()).toEqual([saved]);
      },
    );
  });

  describe("remove", () => {
    it("removes only the selected host from memory and disk", () => {
      const store = new RemoteHostStore(directory);
      const direct = store.save(directInput());
      const ssh = store.save(sshInput());

      store.remove(direct.id);

      expect(store.get(direct.id)).toBeUndefined();
      expect(store.list()).toEqual([ssh]);
      expect(new RemoteHostStore(directory).list()).toEqual([ssh]);
    });

    it("keeps a host available when persistence fails", () => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(sshInput());
      const failure = new Error("Rename denied");
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw failure; });

      expect(() => store.remove(saved.id)).toThrow(failure);
      expect(store.get(saved.id)).toEqual(saved);
      expect(new RemoteHostStore(directory).get(saved.id)).toEqual(saved);
    });
  });

  describe("setLocalPort", () => {
    it("persists the SSH forwarding port for reuse after restart", () => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(sshInput());

      store.setLocalPort(saved.id, 38233);

      expect(store.get(saved.id)).toMatchObject({ id: saved.id, localPort: 38233 });
      expect(new RemoteHostStore(directory).get(saved.id)).toEqual(store.get(saved.id));
    });

    it.each([0, -1, 65536, 1.5, Number.NaN])("rejects invalid local port %j", (port) => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(sshInput());

      expect(() => store.setLocalPort(saved.id, port)).toThrow();
      expect(store.get(saved.id)).toEqual(saved);
      expect(new RemoteHostStore(directory).get(saved.id)).toEqual(saved);
    });

    it("retains the previous local port when persistence fails", () => {
      const store = new RemoteHostStore(directory);
      const saved = store.save(sshInput());
      store.setLocalPort(saved.id, 38233);
      const previous = store.get(saved.id);
      const failure = new Error("Rename denied");
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw failure; });

      expect(() => store.setLocalPort(saved.id, 38234)).toThrow(failure);
      expect(store.get(saved.id)).toEqual(previous);
      expect(new RemoteHostStore(directory).get(saved.id)).toEqual(previous);
    });
  });
});
