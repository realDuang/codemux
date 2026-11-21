import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgentHosts, parseEndpoint } from "../../../../../electron/main/session-sources/agent-host/discovery";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const standalone = {
  schemaVersion: 2, type: "standalone", pid: process.pid, instanceId: "native-host",
  connectionToken: "a".repeat(32), endpoint: { type: "tcp", host: "127.0.0.1", port: 31546 },
};

describe("parseEndpoint", () => {
  it.each(["127.0.0.1", "::1", "localhost"])("accepts authenticated standalone TCP on %s", host => {
    expect(parseEndpoint({ ...standalone, endpoint: { ...standalone.endpoint, host } }, "profile"))
      .toMatchObject({ type: "standalone", transport: { type: "tcp", host, port: 31546 } });
  });

  it.each([
    { host: "0.0.0.0" }, { host: "::" }, { host: "192.168.1.1" }, { host: "remote.example" },
    { host: "localhost.evil.example" }, { host: "localhost@evil.example" },
    { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: "31546" },
  ])("rejects unsafe TCP metadata %j", patch => {
    expect(parseEndpoint({ ...standalone, endpoint: { ...standalone.endpoint, ...patch } }, "profile")).toBeUndefined();
  });

  it("rejects standalone hosts without a bearer token", () => {
    expect(parseEndpoint({ ...standalone, connectionToken: "" }, "profile")).toBeUndefined();
  });
});

describe("discoverAgentHosts", () => {
  async function registry() {
    const root = await mkdtemp(join(tmpdir(), "codemux-agent-registry-"));
    directories.push(root);
    const directory = join(root, "agent-host", "local-endpoint");
    await mkdir(directory, { recursive: true });
    return { root, directory };
  }

  it("discovers legacy-only standalone hosts when the entries directory is absent", async () => {
    const { root, directory } = await registry();
    await writeFile(join(directory, "metadata.json"), JSON.stringify([null, standalone]));
    expect(await discoverAgentHosts([root])).toMatchObject([{ type: "standalone", pid: process.pid, transport: standalone.endpoint }]);
  });

  it("prefers new registry entries while retaining distinct process kinds and live legacy hosts", async () => {
    const { root, directory } = await registry();
    await writeFile(join(directory, "metadata.json"), JSON.stringify([
      standalone, { ...standalone, instanceId: "legacy" },
      { ...standalone, instanceId: "dead", pid: 2147483647 },
    ]));
    await mkdir(join(directory, "entries"));
    await writeFile(join(directory, "entries", "updated.json"), JSON.stringify({ ...standalone, connectionToken: "b".repeat(32) }));
    await writeFile(join(directory, "entries", "editor.json"), JSON.stringify({ ...standalone, type: "editor" }));
    await writeFile(join(directory, "entries", "partial.json"), "{");
    const hosts = await discoverAgentHosts([root]);
    expect(hosts).toHaveLength(3);
    expect(hosts.find(host => host.type === "standalone" && host.instanceId === standalone.instanceId)?.token).toBe("b".repeat(32));
    expect(hosts.some(host => host.instanceId === "legacy")).toBe(true);
    expect(hosts.some(host => host.type === "editor")).toBe(true);
  });

  it("reads new entries despite a corrupt legacy registry", async () => {
    const { root, directory } = await registry();
    await writeFile(join(directory, "metadata.json"), "{");
    await mkdir(join(directory, "entries"));
    await writeFile(join(directory, "entries", "host.json"), JSON.stringify(standalone));
    expect(await discoverAgentHosts([root])).toHaveLength(1);
  });
});
