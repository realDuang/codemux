import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateCodexCatalogEnrollment } from "../../../../../electron/main/engines/codex/desktop-catalog-enrollment";

const directories: string[] = [];
function directory() {
  const value = mkdtempSync(join(tmpdir(), "codemux-enrollment-test-"));
  directories.push(value);
  return value;
}
afterEach(() => { for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("getOrCreateCodexCatalogEnrollment", () => {
  it("persists a second-precision cutoff and retains it on restart and upgrade", () => {
    const data = directory(), home = directory();
    const first = getOrCreateCodexCatalogEnrollment(data, home, 1780000000123);
    expect(first.cutoffMs).toBe(1780000000000);
    expect(getOrCreateCodexCatalogEnrollment(data, home, 1880000000999)).toEqual(first);
  });

  it("isolates profiles while recognizing a symlink to the same home", () => {
    const data = directory(), firstHome = directory(), secondHome = directory();
    const alias = join(directory(), "home-link");
    symlinkSync(firstHome, alias);
    const first = getOrCreateCodexCatalogEnrollment(data, firstHome, 1780000000000);
    expect(getOrCreateCodexCatalogEnrollment(data, alias, 1780000002000)).toEqual(first);
    const second = getOrCreateCodexCatalogEnrollment(data, secondHome, 1780000003000);
    expect(second.sourceId).not.toBe(first.sourceId);
    expect(second.cutoffMs).toBe(1780000003000);
    expect(getOrCreateCodexCatalogEnrollment(data, firstHome)).toEqual(first);
  });

  it("fails closed on corrupt data instead of silently enrolling old history", () => {
    const data = directory(), home = directory();
    const original = getOrCreateCodexCatalogEnrollment(data, home, 1780000000000);
    const file = join(data, "codex-desktop-catalog.json");
    const broken = { version: 1, sources: { [original.sourceId]: { cutoffMs: 0 } } };
    writeFileSync(file, JSON.stringify(broken));
    expect(() => getOrCreateCodexCatalogEnrollment(data, home)).toThrow("cutoff is invalid");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(broken);
  });
});
