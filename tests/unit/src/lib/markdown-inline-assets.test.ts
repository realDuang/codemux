import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhanceMarkdownInteractions, type MarkdownInteractionOptions } from "../../../../src/lib/markdown-interactions";
import type { FilePart } from "../../../../src/types/unified";
import { MAX_IMAGE_SIZE_BYTES } from "../../../../shared/image-limits";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("../../../../src/lib/gateway-api", () => ({ gateway: { readFile: mocks.readFile } }));
vi.mock("../../../../src/stores/file", () => ({ fileStore: {}, openPanel: vi.fn(), previewFile: vi.fn(), setRootDirectory: vi.fn() }));

const labels: MarkdownInteractionOptions["labels"] = {
  copyTable: "Copy", copied: "Copied", copyFailed: "Failed", tableRegion: "Table", imageUnavailable: "Unavailable",
  expandTable: "Expand", closeTable: "Close", tableDialog: "Details", scrollHorizontally: "Scroll",
};
const SOURCE = "/private/visualizations/current/preview.png";
const DATA = "data:image/png;base64,aW1hZ2U=";

class ElementStub {
  attributes = new Map<string, string>();
  hidden = false;
  src = "";
  alt = "Preview";
  textContent = "";
  after = vi.fn();
  remove = vi.fn();
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === "src") this.src = ""; }
  addEventListener() {}
  removeEventListener() {}
}

function asset(overrides: Partial<FilePart> = {}): FilePart {
  return { id: "asset", messageId: "message", sessionId: "session", type: "file", filename: "Preview", sourcePath: SOURCE, mime: "image/png", url: DATA, ...overrides };
}

function page(options: Partial<MarkdownInteractionOptions> = {}, source = SOURCE) {
  const image = new ElementStub();
  image.setAttribute("data-local-src", source);
  const root = new ElementStub();
  Object.assign(root, {
    querySelectorAll: (selector: string) => selector === "img[data-local-src]" ? [image] : [],
    contains: (element: unknown) => element === image,
  });
  const refresh = (next: Partial<MarkdownInteractionOptions>) => enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels, ...next });
  const cleanup = refresh({ workingDirectory: "/workspace", ...options });
  return { image, refresh, cleanup };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", { createElement: () => new ElementStub() });
});
afterEach(() => vi.unstubAllGlobals());

describe("Markdown inline assets", () => {
  it("renders the exact adapter-authorized reference without a path read or working directory", () => {
    const { image, refresh, cleanup } = page({ workingDirectory: undefined, inlineAssets: [asset()] });
    expect(image.src).toBe(DATA);
    expect(image.hidden).toBe(false);
    expect(mocks.readFile).not.toHaveBeenCalled();
    refresh({ inlineAssets: [asset()] });
    expect(image.src).toBe(DATA);
    cleanup();
  });

  it.each([
    { sourcePath: `${SOURCE}-other` },
    { url: "https://example.com/preview.png" },
    { mime: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zy8+" },
    { mime: "image/jpeg" },
    { url: "data:image/png;base64,invalid<script>" },
    { url: `data:image/png;base64,${"A".repeat(Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4 + 4)}` },
  ])("rejects an unbound or invalid inline asset %j without broadening file access", (overrides) => {
    const { image, cleanup } = page({ inlineAssets: [asset(overrides)] });
    expect(image.src).toBe("");
    expect(image.hidden).toBe(true);
    expect(mocks.readFile).not.toHaveBeenCalled();
    cleanup();
  });

  it("retries the same rendered image when completed text supplies its asset", () => {
    const { image, refresh, cleanup } = page();
    expect(image.hidden).toBe(true);
    refresh({ workingDirectory: "/workspace", inlineAssets: [asset()] });
    expect(image.hidden).toBe(false);
    expect(image.src).toBe(DATA);
    expect(mocks.readFile).not.toHaveBeenCalled();
    cleanup();
  });

  it("updates and removes inline bytes when the owning text changes", () => {
    const { image, refresh, cleanup } = page({ workingDirectory: undefined, inlineAssets: [asset()] });
    const updated = "data:image/png;base64,dXBkYXRl";
    refresh({ inlineAssets: [asset({ url: updated })] });
    expect(image.src).toBe(updated);
    refresh({});
    expect(image.src).toBe("");
    expect(image.hidden).toBe(true);
    expect(mocks.readFile).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores a stale workspace response after a bound asset replaces that load", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.readFile.mockReturnValue(new Promise((done) => { resolve = done; }));
    const source = "/workspace/preview.png";
    const { image, refresh, cleanup } = page({}, source);
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith(source, "/workspace");
    refresh({ workingDirectory: "/workspace", inlineAssets: [asset({ sourcePath: source })] });
    expect(image.src).toBe(DATA);
    resolve({ binary: true, mimeType: "image/png", content: "c3RhbGU=", size: 5 });
    await Promise.resolve();
    expect(image.src).toBe(DATA);
    cleanup();
  });

  it.each(["directory", "source"])("ignores a pending workspace response after its %s disappears", async (removed) => {
    let resolve: (value: unknown) => void = () => {};
    mocks.readFile.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { image, refresh, cleanup } = page({}, "/workspace/preview.png");
    if (removed === "source") image.setAttribute("data-local-src", "");
    refresh(removed === "source" ? { workingDirectory: "/workspace" } : {});
    resolve({ binary: true, mimeType: "image/png", content: "c3RhbGU=", size: 5 });
    await Promise.resolve();
    expect(image.src).toBe("");
    expect(image.hidden).toBe(true);
    cleanup();
  });
});
