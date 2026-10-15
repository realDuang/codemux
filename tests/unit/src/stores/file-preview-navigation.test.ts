import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateway } from "../../../../src/lib/gateway-api";
import {
  closeTab,
  fileStore,
  loadDiff,
  previewFile,
  setRootDirectory,
  switchTab,
} from "../../../../src/stores/file";
import type { FileExplorerContent } from "../../../../src/types/unified";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const content: FileExplorerContent = { content: "one\ntwo\nthree", binary: false, size: 13 };

beforeEach(async () => {
  vi.spyOn(gateway, "listFiles").mockResolvedValue([]);
  vi.spyOn(gateway, "getGitStatus").mockResolvedValue([]);
  vi.spyOn(gateway, "watchDirectory").mockResolvedValue(undefined);
  vi.spyOn(gateway, "unwatchDirectory").mockResolvedValue(undefined);
  await setRootDirectory("/workspace");
});

afterEach(async () => {
  await setRootDirectory(null);
  vi.restoreAllMocks();
});

describe("previewFile line navigation", () => {
  it("preserves the navigation identity during diff loading and renews it for repeated links", async () => {
    const read = vi.spyOn(gateway, "readFile").mockResolvedValue(content);
    vi.spyOn(gateway, "getGitDiff").mockResolvedValue("@@ -1 +1 @@\n-one\n+first");

    await previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);
    const firstRequest = fileStore.preview!.lineRequestId!;
    expect(fileStore.preview).toMatchObject({ line: 2, loading: false });
    expect(firstRequest).toBeGreaterThan(0);

    await loadDiff("/workspace", "main.ts");
    expect(fileStore.preview).toMatchObject({ line: 2, lineRequestId: firstRequest, loading: false });

    await previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);
    expect(fileStore.preview!.lineRequestId).toBeGreaterThan(firstRequest);
    expect(read).toHaveBeenCalledOnce();

    await previewFile("/workspace/main.ts", "main.ts", "main.ts");
    expect(fileStore.preview!.line).toBeUndefined();
    expect(fileStore.preview!.lineRequestId).toBeUndefined();
  });

  it("keeps the latest line target when repeated links share a pending file read", async () => {
    const pending = deferred<FileExplorerContent>();
    const read = vi.spyOn(gateway, "readFile").mockReturnValue(pending.promise);

    const first = previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);
    const firstRequest = fileStore.preview!.lineRequestId!;
    const second = previewFile("/workspace/main.ts", "main.ts", "main.ts", 3);
    const latestRequest = fileStore.preview!.lineRequestId!;
    expect(latestRequest).toBeGreaterThan(firstRequest);
    expect(fileStore.preview).toMatchObject({ line: 3, loading: true });
    expect(fileStore.openTabs.all.map((tab) => tab.path)).toEqual(["main.ts"]);

    pending.resolve(content);
    await Promise.all([first, second]);

    expect(fileStore.preview).toMatchObject({
      line: 3, lineRequestId: latestRequest, loading: false, content,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith("/workspace/main.ts", "/workspace");
  });

  it("preserves the latest failed navigation and clears its error when the link is retried", async () => {
    const pending = deferred<FileExplorerContent>();
    const read = vi.spyOn(gateway, "readFile")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(content);
    const first = previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);
    const second = previewFile("/workspace/main.ts", "main.ts", "main.ts", 3);
    const failedRequest = fileStore.preview!.lineRequestId!;

    pending.reject(new Error("File temporarily unavailable"));
    await Promise.all([first, second]);

    expect(fileStore.preview).toMatchObject({
      path: "main.ts", line: 3, lineRequestId: failedRequest,
      loading: false, error: "File temporarily unavailable",
    });
    expect(fileStore.preview!.content).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();

    await previewFile("/workspace/main.ts", "main.ts", "main.ts", 3);

    expect(fileStore.preview).toMatchObject({ line: 3, content, loading: false });
    expect(fileStore.preview!.lineRequestId).toBeGreaterThan(failedRequest);
    expect(fileStore.preview!.error).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    expect(fileStore.openTabs.all).toHaveLength(1);
  });
});

describe("switchTab", () => {
  it("returns to a background-loaded file without replaying its earlier line request", async () => {
    const pending = deferred<FileExplorerContent>();
    const otherContent = { ...content, content: "other file" };
    const read = vi.spyOn(gateway, "readFile")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(otherContent);
    const first = previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);
    await previewFile("/workspace/other.ts", "other.ts", "other.ts", 3);
    const activeRequest = fileStore.preview!.lineRequestId;

    pending.resolve(content);
    await first;

    expect(fileStore.preview).toMatchObject({
      path: "other.ts", content: otherContent, line: 3, lineRequestId: activeRequest,
    });
    switchTab("main.ts");

    expect(fileStore.openTabs.active).toBe("main.ts");
    expect(fileStore.preview).toMatchObject({ path: "main.ts", content, loading: false });
    expect(fileStore.preview!.line).toBeUndefined();
    expect(fileStore.preview!.lineRequestId).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("closeTab", () => {
  it("returns to the adjacent cached file and clears the preview after the last tab closes", async () => {
    const read = vi.spyOn(gateway, "readFile").mockResolvedValue(content);
    await previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);
    await previewFile("/workspace/other.ts", "other.ts", "other.ts", 3);
    await previewFile("/workspace/last.ts", "last.ts", "last.ts", 1);

    closeTab("other.ts");
    expect(fileStore.openTabs.all.map((tab) => tab.path)).toEqual(["main.ts", "last.ts"]);
    expect(fileStore.preview).toMatchObject({ path: "last.ts", line: 1 });

    closeTab("last.ts");
    expect(fileStore.openTabs.active).toBe("main.ts");
    expect(fileStore.preview).toMatchObject({ path: "main.ts", content, loading: false });
    expect(fileStore.preview!.line).toBeUndefined();
    expect(fileStore.preview!.lineRequestId).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(3);

    closeTab("main.ts");
    expect(fileStore.openTabs).toEqual({ active: null, all: [] });
    expect(fileStore.preview).toBeNull();
  });
});

describe("setRootDirectory", () => {
  it("clears the previous navigation and cache before the project is reopened", async () => {
    const updatedContent = { ...content, content: "updated file" };
    const read = vi.spyOn(gateway, "readFile")
      .mockResolvedValueOnce(content)
      .mockResolvedValueOnce(updatedContent);
    await previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);
    const firstRequest = fileStore.preview!.lineRequestId!;

    await setRootDirectory(null);

    expect(gateway.unwatchDirectory).toHaveBeenCalledExactlyOnceWith("/workspace");
    expect(fileStore.rootDirectory).toBeNull();
    expect(fileStore.openTabs).toEqual({ active: null, all: [] });
    expect(fileStore.preview).toBeNull();

    await setRootDirectory("/workspace");
    await previewFile("/workspace/main.ts", "main.ts", "main.ts", 2);

    expect(fileStore.preview).toMatchObject({ content: updatedContent, line: 2, loading: false });
    expect(fileStore.preview!.lineRequestId).toBeGreaterThan(firstRequest);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
