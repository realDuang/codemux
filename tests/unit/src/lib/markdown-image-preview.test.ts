import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhanceMarkdownInteractions, type MarkdownInteractionOptions } from "../../../../src/lib/markdown-interactions";
import type { FilePart } from "../../../../src/types/unified";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("../../../../src/lib/gateway-api", () => ({ gateway: { readFile: mocks.readFile } }));
vi.mock("../../../../src/stores/file", () => ({ fileStore: {}, openPanel: vi.fn(), previewFile: vi.fn(), setRootDirectory: vi.fn() }));

const labels: MarkdownInteractionOptions["labels"] = {
  copyTable: "Copy", copied: "Copied", copyFailed: "Failed", tableRegion: "Table", imageUnavailable: "Unavailable",
  expandTable: "Expand", closeTable: "Close", tableDialog: "Details", scrollHorizontally: "Scroll",
  previewImage: "Preview image", closeImage: "Close image preview",
};
const SOURCE = "/private/visualizations/current/preview.png";
const DATA = "data:image/png;base64,aW1hZ2U=";

interface StubEvent {
  target?: PreviewElement;
  key?: string;
  type?: string;
  button?: number;
  preventDefault: ReturnType<typeof vi.fn>;
}

// Model only DOM identity, delegated events and native dialog lifecycle, not layout.
class PreviewElement {
  attributes = new Map<string, string>();
  children: PreviewElement[] = [];
  parentElement: PreviewElement | null = null;
  listeners = new Map<string, (event: StubEvent) => unknown>();
  hidden = false;
  src = "";
  alt = "";
  textContent = "";
  tabIndex = -1;
  open = false;
  connected = false;
  focus = vi.fn();
  tagName: string;

  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  get isConnected(): boolean { return this.connected || (this.parentElement?.isConnected ?? false); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "tabindex") this.tabIndex = Number(value);
    if (name === "src") this.src = value;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
    if (name === "tabindex") this.tabIndex = -1;
  }
  addEventListener(name: string, listener: (event: StubEvent) => unknown) { this.listeners.set(name, listener); }
  removeEventListener(name: string) { this.listeners.delete(name); }
  append(...elements: PreviewElement[]) { elements.forEach(element => this.appendChild(element)); }
  appendChild(element: PreviewElement) {
    element.remove();
    this.children.push(element);
    element.parentElement = this;
    return element;
  }
  after(element: PreviewElement) {
    const parent = this.parentElement;
    if (!parent) return;
    element.remove();
    parent.children.splice(parent.children.indexOf(this) + 1, 0, element);
    element.parentElement = parent;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  matches(selector: string): boolean {
    return selector.split(",").some(item => {
      const value = item.trim();
      const tag = /^[a-z]+/i.exec(value)?.[0];
      const attributes = [...value.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
      return (!tag || this.tagName.toLowerCase() === tag)
        && attributes.every(([, name, content]) => this.hasAttribute(name) && (content === undefined || this.getAttribute(name) === content));
    });
  }
  closest(selector: string): PreviewElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  contains(element: PreviewElement): boolean { return this === element || this.children.some(child => child.contains(element)); }
  querySelectorAll(selector: string): PreviewElement[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  showModal = vi.fn(() => { this.open = true; });
  close() { this.open = false; this.listeners.get("close")?.({ preventDefault: vi.fn() }); }
}

function asset(overrides: Partial<FilePart> = {}): FilePart {
  return { id: "asset", messageId: "message", sessionId: "session", type: "file", filename: "Icon preview", sourcePath: SOURCE, mime: "image/png", url: DATA, ...overrides };
}

function page() {
  const root = new PreviewElement();
  root.connected = true;
  const paragraph = new PreviewElement("p");
  const image = new PreviewElement("img");
  image.alt = "Icon preview";
  image.setAttribute("data-local-src", SOURCE);
  paragraph.append(image);
  root.append(paragraph);
  const refresh = (options: Partial<MarkdownInteractionOptions> = { inlineAssets: [asset()] }) =>
    enhanceMarkdownInteractions(root as unknown as HTMLElement, { labels, ...options });
  const cleanup = refresh();
  const click = (target: PreviewElement) => {
    const event: StubEvent = { target, type: "click", button: 0, preventDefault: vi.fn() };
    root.listeners.get("click")?.(event);
    return event;
  };
  const key = (target: PreviewElement, value: string) => {
    const event: StubEvent = { target, key: value, preventDefault: vi.fn() };
    root.listeners.get("keydown")?.(event);
    return event;
  };
  return { root, paragraph, image, refresh, cleanup, click, key };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue({ binary: true, mimeType: "image/png", content: "d29ya3NwYWNl", size: 9 });
  vi.stubGlobal("Element", PreviewElement);
  vi.stubGlobal("HTMLElement", PreviewElement);
  vi.stubGlobal("HTMLImageElement", PreviewElement);
  vi.stubGlobal("document", { createElement: (tag: string) => new PreviewElement(tag) });
});
afterEach(() => vi.unstubAllGlobals());

describe("enhanceMarkdownInteractions image previews", () => {
  it("makes only a validated inline image keyboard accessible while preserving its Markdown node", async () => {
    const { root, paragraph, image, refresh, cleanup, click, key } = page();
    expect(paragraph.children).toEqual([image]);
    expect(image.src).toBe(DATA);
    expect(image.alt).toBe("Icon preview");
    expect(image.getAttribute("data-local-src")).toBe(SOURCE);
    expect(image.hasAttribute("data-inline-asset")).toBe(true);
    expect(image.getAttribute("role")).toBe("button");
    expect(image.tabIndex).toBe(0);
    expect(image.getAttribute("aria-haspopup")).toBe("dialog");
    expect(key(image, "Tab").preventDefault).not.toHaveBeenCalled();
    const workspace = new PreviewElement("img");
    workspace.setAttribute("data-local-src", "/workspace/image.png");
    const remote = new PreviewElement("img");
    remote.src = "https://example.com/image.png";
    root.append(workspace, remote);
    refresh({ workingDirectory: "/workspace", inlineAssets: [asset()] });
    await Promise.resolve();
    for (const ordinary of [workspace, remote]) {
      expect(ordinary.hasAttribute("data-inline-asset")).toBe(false);
      expect(ordinary.getAttribute("role")).toBeNull();
      expect(ordinary.tabIndex).toBe(-1);
      expect(click(ordinary).preventDefault).not.toHaveBeenCalled();
    }
    expect(root.querySelector("[data-markdown-image-dialog]")).toBeNull();
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/workspace/image.png", "/workspace");
    cleanup();
  });

  it.each([
    ["click", "button"],
    ["Enter", "Escape"],
    [" ", "cancel"],
  ])("opens with %s and restores focus after %s closes the native dialog", (opening, closing) => {
    const { root, paragraph, image, cleanup, click, key } = page();
    const event = opening === "click" ? click(image) : key(image, opening);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const dialog = root.querySelector("[data-markdown-image-dialog]")!;
    expect(dialog).not.toBeNull();
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(dialog.hasAttribute("data-markdown-decoration")).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe(labels.previewImage);
    const expanded = dialog.querySelector("img")!;
    expect(expanded).not.toBe(image);
    expect(expanded.src).toBe(DATA);
    expect(expanded.alt).toBe(image.alt);
    expect(expanded.hasAttribute("data-local-src")).toBe(false);
    expect(expanded.hasAttribute("data-inline-asset")).toBe(false);
    expect(paragraph.children).toEqual([image]);
    const close = dialog.querySelector("[data-markdown-close-image]")!;
    expect(close.focus).toHaveBeenCalledOnce();
    expect(close.textContent).toBe(labels.closeImage);
    if (closing === "button") click(close);
    else if (closing === "Escape") expect(key(close, "Escape").preventDefault).toHaveBeenCalledOnce();
    else {
      const cancel = { preventDefault: vi.fn() };
      dialog.listeners.get("cancel")!(cancel);
      expect(cancel.preventDefault).toHaveBeenCalledOnce();
    }
    expect(root.querySelector("[data-markdown-image-dialog]")).toBeNull();
    expect(image.focus).toHaveBeenCalledOnce();
    expect(image.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(mocks.readFile).not.toHaveBeenCalled();
    cleanup();
  });

  it.each(["source", "bytes", "authorization"] as const)("closes an open preview when its %s changes", (change) => {
    const { root, image, refresh, cleanup, click } = page();
    click(image);
    expect(root.querySelector("[data-markdown-image-dialog]")).not.toBeNull();
    if (change === "source") {
      image.setAttribute("data-local-src", `${SOURCE}-other`);
      refresh();
    } else if (change === "bytes") refresh({ inlineAssets: [asset({ url: "data:image/png;base64,dXBkYXRl" })] });
    else refresh({});
    expect(root.querySelector("[data-markdown-image-dialog]")).toBeNull();
    if (change !== "bytes") {
      expect(image.hasAttribute("data-inline-asset")).toBe(false);
      expect(image.getAttribute("role")).toBeNull();
      expect(image.tabIndex).toBe(-1);
      expect(image.getAttribute("aria-haspopup")).toBeNull();
      expect(image.src).toBe("");
      expect(image.hidden).toBe(true);
      expect(image.focus).not.toHaveBeenCalled();
      expect(click(image).preventDefault).not.toHaveBeenCalled();
    }
    expect(mocks.readFile).not.toHaveBeenCalled();
    cleanup();
  });

  it.each(["hidden", "detached"] as const)("does not restore focus to a %s image trigger", (condition) => {
    const { root, image, cleanup, click, key } = page();
    click(image);
    const close = root.querySelector("[data-markdown-close-image]")!;
    expect(close).not.toBeNull();
    if (condition === "hidden") image.hidden = true;
    else image.remove();
    key(close, "Escape");
    expect(root.querySelector("[data-markdown-image-dialog]")).toBeNull();
    expect(image.focus).not.toHaveBeenCalled();
    cleanup();
  });

  it("removes the open preview and delegated listeners on cleanup", () => {
    const { root, image, cleanup, click } = page();
    click(image);
    const dialog = root.querySelector("[data-markdown-image-dialog]")!;
    expect(dialog).not.toBeNull();
    cleanup();
    expect(dialog.open).toBe(false);
    expect(root.querySelector("[data-markdown-image-dialog]")).toBeNull();
    expect(root.listeners.size).toBe(0);
    expect(() => dialog.listeners.get("close")?.({ preventDefault: vi.fn() })).not.toThrow();
    expect(root.querySelector("[data-markdown-image-dialog]")).toBeNull();
  });
});
