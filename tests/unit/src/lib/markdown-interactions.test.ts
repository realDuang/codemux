import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marked } from "marked";
import {
  enhanceMarkdownInteractions,
  prepareMarkdownTables,
  getMarkdownTableClipboard,
  resolveLocalMarkdownPath,
  type MarkdownInteractionOptions,
} from "../../../../src/lib/markdown-interactions";
import { isLocalMarkdownReference, markdownRenderer } from "../../../../src/lib/markdown-stream";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  previewFile: vi.fn(),
  openPanel: vi.fn(),
  setRootDirectory: vi.fn(),
  fileStore: { rootDirectory: "/workspace" as string | null },
}));
vi.mock("../../../../src/lib/gateway-api", () => ({ gateway: { readFile: mocks.readFile } }));
vi.mock("../../../../src/stores/file", () => mocks);

const labels: MarkdownInteractionOptions["labels"] = {
  copyTable: "Copy table", copied: "Copied", copyFailed: "Copy failed",
  tableRegion: "Table", imageUnavailable: "Image unavailable",
  expandTable: "Expand table", closeTable: "Close table", tableDialog: "Table details",
  scrollHorizontally: "Scroll horizontally to view more",
};

class ElementStub {
  attributes = new Map<string, string>();
  hidden = false;
  tagName = "IMG";
  src = "";
  alt = "";
  textContent = "";
  clientWidth = 200;
  scrollWidth = 900;
  scrollLeft = 0;
  listeners = new Map<string, (event: unknown) => unknown>();
  after = vi.fn();
  remove = vi.fn();
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  addEventListener(name: string, handler: (event: unknown) => unknown) { this.listeners.set(name, handler); }
  removeEventListener(name: string) { this.listeners.delete(name); }
  closest(selector: string) { return selector === "a[href]" && this.hasAttribute("href") ? this : null; }
  matches(selector: string) { return selector === "[data-markdown-table-scroll]" && this.hasAttribute("data-markdown-table-scroll"); }
}

function page(images: ElementStub[] = [], media: ElementStub[] = []) {
  const root = new ElementStub();
  Object.assign(root, {
    querySelectorAll: (selector: string) => selector === "img[data-local-src]" ? images : selector === "audio[data-local-src], video[data-local-src]" ? media : [],
    contains: (element: ElementStub) => images.includes(element) || media.includes(element) || element.hasAttribute("href"),
  });
  const cleanup = enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels, workingDirectory: "/workspace" });
  return { root, cleanup };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fileStore.rootDirectory = "/workspace";
  mocks.setRootDirectory.mockImplementation(async (directory: string) => { mocks.fileStore.rootDirectory = directory; });
  mocks.readFile.mockResolvedValue({ binary: true, mimeType: "image/png", content: "aW1hZ2U=", size: 5 });
  vi.stubGlobal("Element", ElementStub);
  vi.stubGlobal("HTMLElement", ElementStub);
  vi.stubGlobal("document", { createElement: () => new ElementStub() });
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveLocalMarkdownPath", () => {
  it.each([
    ["src/main.ts:12", "/workspace", { absolutePath: "/workspace/src/main.ts", relativePath: "src/main.ts", line: 12 }],
    ["main.ts:12:3", "/workspace", { absolutePath: "/workspace/main.ts", relativePath: "main.ts", line: 12 }],
    ["Makefile:12", "/workspace", { absolutePath: "/workspace/Makefile", relativePath: "Makefile", line: 12 }],
    ["./src/../main.ts#L8", "/workspace", { absolutePath: "/workspace/main.ts", relativePath: "main.ts", line: 8 }],
    ["file:///workspace/My%20File.md#L2-L5", "/workspace", { absolutePath: "/workspace/My File.md", relativePath: "My File.md", line: 2 }],
    ["C:\\work\\src\\main.ts:7", "C:\\work", { absolutePath: "C:/work/src/main.ts", relativePath: "src/main.ts", line: 7 }],
    ["file:///C:/work/image.png", "C:\\work", { absolutePath: "C:/work/image.png", relativePath: "image.png" }],
  ])("resolves %s relative to its declared workspace", (source, directory, expected) => {
    expect(resolveLocalMarkdownPath(source, directory)).toEqual(expected);
  });

  it.each([
    "../private.png", "/workspace-other/private.png", "/etc/passwd", "file://server/share/image.png",
    "%2e%2e/private.png", "src/%00.png", "https://example.com/image.png", "//example.com/image.png", "#section",
  ])("rejects external or out-of-workspace source %s", (source) => {
    expect(resolveLocalMarkdownPath(source, "/workspace")).toBeUndefined();
  });

  it("does not invent a workspace for local files", () => {
    expect(resolveLocalMarkdownPath("/workspace/image.png")).toBeUndefined();
    expect(resolveLocalMarkdownPath("image.png", "relative-workspace")).toBeUndefined();
  });
});

describe("markdownRenderer local references", () => {
  const markdown = new Marked({ renderer: markdownRenderer });
  it("defers local image reads and file navigation to the authorized gateway", () => {
    const html = markdown.parse('[source](main.ts:3) ![diagram](/workspace/diagram.png)') as string;
    expect(html).toContain('href="#" data-local-href="main.ts:3"');
    expect(html).toContain('data-local-src="/workspace/diagram.png"');
    expect(html).not.toContain('<img src=');
    expect(markdown.parse('![remote](https://example.com/image.png)')).toContain('src="https://example.com/image.png"');
  });

  it("sanitizes obfuscated executable URLs before classifying local links", () => {
    const html = markdown.parse('[bad](<java\tscript:alert>)') as string;
    expect(html).toContain('href=""');
    expect(html).not.toContain("data-local-href");
    expect(isLocalMarkdownReference("mailto:test@example.com")).toBe(false);
    expect(isLocalMarkdownReference("tel:123456")).toBe(false);
  });
});

describe("getMarkdownTableClipboard", () => {
  it("escapes multiline TSV cells and keeps the original HTML line breaks", () => {
    const decoration = { remove: vi.fn() };
    const clone = {
      querySelectorAll: () => [decoration],
      outerHTML: "<table><tr><td>A<br>B</td><td>One</td></tr></table>",
      rows: [
        { cells: [{ textContent: ' A\n"B" ', querySelectorAll: () => [] }, { textContent: "One", querySelectorAll: () => [] }] },
        { cells: [{ textContent: "Two\tcolumns", querySelectorAll: () => [] }, { textContent: "三", querySelectorAll: () => [] }] },
      ],
    };
    const table = { cloneNode: () => clone } as unknown as HTMLTableElement;
    expect(getMarkdownTableClipboard(table)).toEqual({
      text: '"A\n""B"""\tOne\n"Two\tcolumns"\t三', html: clone.outerHTML,
    });
    expect(decoration.remove).toHaveBeenCalledOnce();
  });
});

describe("enhanceMarkdownInteractions", () => {
  it("scrolls a focused table with arrow and boundary keys without trapping other keys", () => {
    const { root, cleanup } = page();
    const table = new ElementStub();
    table.setAttribute("data-markdown-table-scroll", "");
    const preventDefault = vi.fn();
    const key = (value: string) => root.listeners.get("keydown")!({ target: table, key: value, preventDefault });
    key("ArrowRight");
    expect(table.scrollLeft).toBe(100);
    key("End");
    expect(table.scrollLeft).toBe(900);
    key("Home");
    expect(table.scrollLeft).toBe(0);
    key("Tab");
    expect(preventDefault).toHaveBeenCalledTimes(3);
    cleanup();
  });

  it("opens a local file at its requested line without browser navigation", async () => {
    const { root, cleanup } = page();
    const link = new ElementStub();
    link.setAttribute("href", "#");
    link.setAttribute("data-local-href", "src/main.ts:24");
    const preventDefault = vi.fn();
    await root.listeners.get("click")!({ target: link, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.openPanel).toHaveBeenCalledOnce();
    expect(mocks.previewFile).toHaveBeenCalledExactlyOnceWith("/workspace/src/main.ts", "main.ts", "src/main.ts", 24);
    cleanup();
    expect(root.listeners.size).toBe(0);
  });

  it("does not intercept normal HTTPS links or read files outside the workspace", async () => {
    const { root, cleanup } = page();
    const link = new ElementStub();
    const preventDefault = vi.fn();
    link.setAttribute("href", "https://example.com");
    await root.listeners.get("click")!({ target: link, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    link.setAttribute("data-local-href", "../private.json");
    await root.listeners.get("click")!({ target: link, preventDefault });
    expect(mocks.previewFile).not.toHaveBeenCalled();
    cleanup();
  });

  it("loads a local image once through the file gateway and preserves it on refresh", async () => {
    const image = new ElementStub();
    image.setAttribute("data-local-src", "image.png");
    const { root, cleanup } = page([image]);
    await vi.waitFor(() => expect(image.src).toBe("data:image/png;base64,aW1hZ2U="));
    enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels, workingDirectory: "/workspace" });
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/workspace/image.png", "/workspace");
    cleanup();
  });

  it.each(["../private.png", "credentials.json"])("does not read disallowed image source %s", (source) => {
    const image = new ElementStub();
    image.setAttribute("data-local-src", source);
    image.alt = "Unavailable diagram";
    const { cleanup } = page([image]);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(image.hidden).toBe(true);
    expect(image.after.mock.calls[0][0].textContent).toBe("Unavailable diagram");
    cleanup();
  });

  it("waits for the working directory before reading a local image", async () => {
    const image = new ElementStub();
    image.setAttribute("data-local-src", "image.png");
    const root = new ElementStub();
    Object.assign(root, {
      querySelectorAll: (selector: string) => selector === "img[data-local-src]" ? [image] : [],
      contains: () => true,
    });
    const cleanup = enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(image.hasAttribute("data-local-loading")).toBe(false);
    enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels, workingDirectory: "/workspace" });
    await vi.waitFor(() => expect(image.src).toContain("data:image/png;base64,"));
    cleanup();
  });

  it("uses readable alt text when the gateway returns non-image data", async () => {
    mocks.readFile.mockResolvedValue({ binary: true, mimeType: "text/html", content: "invalid", size: 7 });
    const image = new ElementStub();
    image.setAttribute("data-local-src", "image.png");
    image.alt = "Diagram could not be loaded";
    const { cleanup } = page([image]);
    await vi.waitFor(() => expect(image.hidden).toBe(true));
    expect(image.after.mock.calls[0][0].textContent).toBe(image.alt);
    expect(image.src).toBe("");
    cleanup();
  });

  it("ignores asynchronous image responses after cleanup", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.readFile.mockReturnValue(new Promise((done) => { resolve = done; }));
    const image = new ElementStub();
    image.setAttribute("data-local-src", "image.png");
    const { cleanup } = page([image]);
    cleanup();
    resolve({ binary: true, mimeType: "text/html", content: "invalid", size: 7 });
    await Promise.resolve();
    expect(image.src).toBe("");
    expect(image.after).not.toHaveBeenCalled();
  });
});


describe("local Markdown media", () => {
  it.each([["AUDIO", "audio/wav", "sound.wav"], ["VIDEO", "video/mp4", "clip.mp4"]])("loads %s through the workspace gateway", async (tag, mime, name) => {
    mocks.readFile.mockResolvedValue({ binary: true, mimeType: mime, content: "bWVkaWE=", size: 5 });
    const media = new ElementStub();
    media.tagName = tag;
    media.setAttribute("data-local-src", name);
    const { cleanup } = page([], [media]);
    await vi.waitFor(() => expect(media.src).toBe(`data:${mime};base64,bWVkaWE=`));
    expect(mocks.readFile).toHaveBeenCalledWith(`/workspace/${name}`, "/workspace");
    cleanup();
  });

  it("rejects out-of-workspace media before making a file request", async () => {
    const media = new ElementStub();
    media.tagName = "AUDIO";
    media.setAttribute("aria-label", "Audio unavailable");
    media.setAttribute("data-local-src", "../private.wav");
    const { cleanup } = page([], [media]);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(media.hidden).toBe(true);
    expect(media.after.mock.calls[0][0].textContent).toBe("Audio unavailable");
    cleanup();
  });
});

// A small DOM model keeps these behavior checks independent of browser/layout APIs.
class TableElement extends ElementStub {
  children: TableElement[] = [];
  parentElement: TableElement | null = null;
  tabIndex = -1;
  open = false;
  isConnected = true;
  focus = vi.fn();
  constructor(tag = "div") { super(); this.tagName = tag.toUpperCase(); }
  append(...elements: TableElement[]) { elements.forEach(element => this.appendChild(element)); }
  appendChild(element: TableElement) {
    element.remove();
    this.children.push(element);
    element.parentElement = this;
    return element;
  }
  prepend(element: TableElement) { element.remove(); this.children.unshift(element); element.parentElement = this; }
  remove = vi.fn(() => {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  });
  replaceWith(element: TableElement) {
    const parent = this.parentElement!;
    parent.children.splice(parent.children.indexOf(this), 1, element);
    element.parentElement = parent;
    this.parentElement = null;
  }
  toggleAttribute(name: string, force?: boolean) {
    const enabled = force ?? !this.hasAttribute(name);
    if (enabled) this.setAttribute(name, ""); else this.removeAttribute(name);
    return enabled;
  }
  matches(selector: string): boolean {
    return selector.split(",").some(item => {
      const value = item.trim();
      const attribute = /\[([^=\]]+)(?:="([^"]*)")?\]/.exec(value);
      const tag = /^[a-z]+/i.exec(value)?.[0];
      return (!tag || this.tagName.toLowerCase() === tag) && (!attribute || (this.hasAttribute(attribute[1]) && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2])));
    });
  }
  closest(selector: string): TableElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): TableElement[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(element: TableElement): boolean { return this === element || this.children.some(child => child.contains(element)); }
  cloneNode(): TableElement {
    const copy = new TableElement(this.tagName);
    copy.attributes = new Map(this.attributes);
    copy.textContent = this.textContent;
    copy.append(...this.children.map(child => child.cloneNode()));
    return copy;
  }
  get rows() { return this.querySelectorAll("tr"); }
  get cells() { return this.children.filter(child => child.matches("th, td")); }
  get outerHTML(): string { return `<${this.tagName.toLowerCase()}>${this.textContent}${this.children.map(child => child.outerHTML).join("")}</${this.tagName.toLowerCase()}>`; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.({}); }
}

describe("Markdown table viewing", () => {
  function tablePage() {
    vi.stubGlobal("document", { createElement: (tag: string) => new TableElement(tag) });
    const root = new TableElement();
    const table = new TableElement("table");
    const row = new TableElement("tr");
    const heading = new TableElement("th");
    heading.textContent = "Metric";
    const value = new TableElement("td");
    value.textContent = "42";
    row.append(heading, value);
    table.append(row);
    root.append(table);
    prepareMarkdownTables(root as unknown as ParentNode);
    const cleanup = enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels });
    const click = (target: TableElement) => root.listeners.get("click")!({ target, preventDefault: vi.fn() });
    return { root, table, cleanup, click };
  }

  it("keeps the native table and row cells in a stable keyboard scroll region across refreshes", () => {
    const { root, table, cleanup } = tablePage();
    const frame = root.querySelector("[data-markdown-table-frame]")!;
    const region = root.querySelector("[data-markdown-table-scroll]")!;
    const copy = root.querySelector("[data-markdown-copy-table]");
    region.scrollLeft = 55;
    prepareMarkdownTables(root as unknown as ParentNode);
    enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels });
    expect(root.children[0]).toBe(frame);
    expect(root.querySelector("table")).toBe(table);
    expect(table.rows[0].cells.map(cell => cell.tagName)).toEqual(["TH", "TD"]);
    expect(table.children.some(child => child.tagName === "CAPTION")).toBe(false);
    expect(root.querySelector("[data-markdown-copy-table]")).toBe(copy);
    expect(region.tabIndex).toBe(0);
    expect(region.getAttribute("role")).toBe("region");
    expect(region.scrollLeft).toBe(55);
    expect(frame.hasAttribute("data-overflow-start")).toBe(true);
    expect(frame.hasAttribute("data-overflow-end")).toBe(true);
    cleanup();
  });

  it("opens an independent semantic table and returns focus after Escape and cleanup", async () => {
    const { root, table, cleanup, click } = tablePage();
    const trigger = root.querySelector("[data-markdown-expand-table]")!;
    await click(trigger);
    const dialog = root.querySelector("[data-markdown-table-dialog]")!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe(labels.tableDialog);
    const clone = dialog.querySelector("table")!;
    expect(clone).not.toBe(table);
    expect(clone.rows[0].cells.map(cell => cell.textContent)).toEqual(["Metric", "42"]);
    const close = dialog.querySelector("[data-markdown-close-table]")!;
    expect(close.focus).toHaveBeenCalledOnce();
    root.listeners.get("keydown")!({ target: close, key: "Escape", preventDefault: vi.fn() });
    expect(root.querySelector("[data-markdown-table-dialog]")).toBeNull();
    expect(trigger.focus).toHaveBeenCalledOnce();
    await click(trigger);
    cleanup();
    expect(root.querySelector("[data-markdown-table-dialog]")).toBeNull();
    expect(root.listeners.size).toBe(0);
  });
});
