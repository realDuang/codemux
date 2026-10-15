import { afterEach, describe, expect, it, vi } from "vitest";
import { copyResponseToClipboard, copyTextToClipboard } from "../../../../src/lib/clipboard";

class ElementStub {
  focus = vi.fn();
  closest = vi.fn<() => { appendChild: (element: TextareaStub) => void } | null>(() => null);
}

class TextInputStub extends ElementStub {
  selectionStart: number | null = 2;
  selectionEnd: number | null = 7;
  selectionDirection: "forward" | "backward" | "none" | null = "backward";
  setSelectionRange = vi.fn();
}

class InputStub extends TextInputStub {}

class TextareaStub extends TextInputStub {
  value = "";
  readOnly = false;
  tabIndex = 0;
  style = { cssText: "" };
  select = vi.fn();
  remove = vi.fn();
}

function setupPage(activeElement: ElementStub | null = new InputStub()) {
  const textarea = new TextareaStub();
  const savedRange = { selectedText: "original selection" };
  const selection = {
    rangeCount: 1,
    getRangeAt: vi.fn(() => ({ cloneRange: () => savedRange })),
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  const page = {
    activeElement,
    getSelection: vi.fn((): typeof selection | null => selection),
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn<(element: TextareaStub) => void>() },
    execCommand: vi.fn<(command: string) => boolean>(() => true),
  };
  vi.stubGlobal("HTMLElement", ElementStub);
  vi.stubGlobal("HTMLInputElement", InputStub);
  vi.stubGlobal("HTMLTextAreaElement", TextareaStub);
  vi.stubGlobal("document", page);
  return { page, textarea, selection, savedRange };
}

afterEach(() => vi.unstubAllGlobals());

describe("copyTextToClipboard", () => {
  it("copies inside an active modal without selecting inert document content", async () => {
    const button = new ElementStub();
    const { page, textarea, selection, savedRange } = setupPage(button);
    let dialogTextarea: TextareaStub | undefined;
    const dialog = { appendChild: vi.fn((element: TextareaStub) => { dialogTextarea = element; }) };
    button.closest.mockReturnValue(dialog);
    page.execCommand.mockImplementation(() => dialogTextarea === textarea && textarea.value === "row\tvalue\n1\tdata");
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });

    expect(await copyTextToClipboard("row\tvalue\n1\tdata")).toBe(true);
    expect(page.body.appendChild).not.toHaveBeenCalled();
    expect(dialog.appendChild).toHaveBeenCalledOnce();
    expect(dialog.appendChild.mock.calls[0][0]).toBe(textarea);
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(button.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(selection.addRange).toHaveBeenCalledExactlyOnceWith(savedRange);
  });

  it("uses the Clipboard API without disturbing the page selection", async () => {
    const { page } = setupPage();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, userActivation: { isActive: false } });

    expect(await copyTextToClipboard("https://codemux.example/access")).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://codemux.example/access");
    expect(page.createElement).not.toHaveBeenCalled();
    expect(page.getSelection).not.toHaveBeenCalled();
    expect(page.execCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["input", InputStub],
    ["textarea", TextareaStub],
  ] as const)("restores %s focus and selection after the Clipboard API denies access", async (_name, Input) => {
    const input = new Input();
    const { page, textarea, selection, savedRange } = setupPage(input);
    const userActivation = { isActive: true };
    const writeText = vi.fn(async () => {
      userActivation.isActive = false;
      throw new DOMException("Access denied", "NotAllowedError");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText }, userActivation });

    expect(await copyTextToClipboard("copied\ncontent")).toBe(true);
    expect(page.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(page.body.appendChild).toHaveBeenCalledOnce();
    expect(page.body.appendChild.mock.calls[0][0]).toBe(textarea);
    expect(textarea.value).toBe("copied\ncontent");
    expect(textarea.readOnly).toBe(true);
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(input.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(input.setSelectionRange).toHaveBeenCalledExactlyOnceWith(2, 7, "backward");
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledExactlyOnceWith(savedRange);
  });

  it.each(["denied", "throws"])("restores the editor and removes temporary content when legacy copying %s", async (failure) => {
    const input = new TextareaStub();
    const { page, textarea, selection, savedRange } = setupPage(input);
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    page.execCommand.mockImplementation(() => {
      if (failure === "throws") throw new Error("Copy unavailable");
      return false;
    });

    expect(await copyTextToClipboard("private draft")).toBe(false);
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(input.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(input.setSelectionRange).toHaveBeenCalledExactlyOnceWith(2, 7, "backward");
    expect(selection.addRange).toHaveBeenCalledExactlyOnceWith(savedRange);
  });

  it("does not attempt legacy copying without a user gesture", async () => {
    const { page } = setupPage();
    vi.stubGlobal("navigator", { userActivation: { isActive: false } });

    expect(await copyTextToClipboard("text")).toBe(false);
    expect(page.createElement).not.toHaveBeenCalled();
    expect(page.execCommand).not.toHaveBeenCalled();
  });

  it("returns false when neither clipboard API is available", async () => {
    const { page } = setupPage();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", { ...page, execCommand: undefined });

    expect(await copyTextToClipboard("text")).toBe(false);
    expect(page.createElement).not.toHaveBeenCalled();
  });

  it("supports older browsers without user-activation or text-selection APIs", async () => {
    const button = new ElementStub();
    const { page, textarea } = setupPage(button);
    page.getSelection.mockReturnValue(null);
    vi.stubGlobal("navigator", {});

    expect(await copyTextToClipboard("text")).toBe(true);
    expect(page.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(button.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("falls back to text after rich clipboard writing fails and preserves the initiating gesture", async () => {
    const { page, textarea } = setupPage();
    const userActivation = { isActive: true };
    const write = vi.fn(async () => {
      userActivation.isActive = false;
      throw new DOMException("Rich content denied", "NotAllowedError");
    });
    const writeText = vi.fn().mockRejectedValue(new DOMException("Unavailable", "NotAllowedError"));
    vi.stubGlobal("ClipboardItem", class { constructor(public contents: Record<string, Blob>) {} });
    vi.stubGlobal("navigator", { clipboard: { write, writeText }, userActivation });

    expect(await copyTextToClipboard("Visible answer", "<p>Visible answer</p>")).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Visible answer");
    expect(page.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(textarea.value).toBe("Visible answer");
  });
});

describe("copyResponseToClipboard", () => {
  const part = {
    text: "Visible answer\n<oai-mem-citation>private metadata</oai-mem-citation>",
    displayText: "Visible answer",
  };

  it("writes plain text and clean HTML without mutating the rendered Markdown", async () => {
    const removed = new Set<string>();
    const decoration = { remove: vi.fn(() => removed.add("decoration")) };
    const copyButton = { remove: vi.fn(() => removed.add("button")) };
    const footer = { remove: vi.fn(() => removed.add("footer")) };
    const metadata = { remove: vi.fn(() => removed.add("metadata")) };
    const clone = {
      querySelectorAll: vi.fn(() => [decoration, copyButton, footer, metadata]),
      get innerHTML() {
        return "<p><strong>Visible answer</strong></p>" +
          (removed.has("button") ? "" : "<button>Copy</button>") +
          (removed.has("decoration") ? "" : '<span data-component="decoration">Decoration</span>') +
          (removed.has("footer") ? "" : '<div data-component="content-footer">Date</div>') +
          (removed.has("metadata") ? "" : "<oai-mem-citation>private metadata</oai-mem-citation>");
      },
    };
    const markdown = { cloneNode: vi.fn(() => clone), querySelector: () => null, innerHTML: "Original rendered Markdown" };
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    vi.stubGlobal("ClipboardItem", class { constructor(public contents: Record<string, Blob>) {} });
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    expect(await copyResponseToClipboard(part, markdown as unknown as HTMLElement)).toBe(true);
    const item = write.mock.calls[0][0][0] as { contents: Record<string, Blob> };
    expect(await item.contents["text/plain"].text()).toBe("Visible answer");
    expect(await item.contents["text/html"].text()).toBe("<p><strong>Visible answer</strong></p>");
    expect(markdown.cloneNode).toHaveBeenCalledExactlyOnceWith(true);
    expect(markdown.innerHTML).toBe("Original rendered Markdown");
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each(["missing ClipboardItem", "missing write", "write rejected"])("copies only visible text when rich copying is unavailable: %s", async (reason) => {
    const write = vi.fn().mockRejectedValue(new Error("HTML clipboard denied"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clone = { querySelectorAll: () => [], innerHTML: "<p>Visible answer</p>" };
    const markdown = { cloneNode: () => clone, querySelector: () => null };
    vi.stubGlobal("ClipboardItem", reason === "missing ClipboardItem" ? undefined
      : class { constructor(public contents: Record<string, Blob>) {} });
    vi.stubGlobal("navigator", { clipboard: { write: reason === "missing write" ? undefined : write, writeText } });

    expect(await copyResponseToClipboard(part, markdown as unknown as HTMLElement)).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Visible answer");
  });

  it("copies original text for engines without display metadata or a rendered container", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await copyResponseToClipboard({ text: "**Original Markdown**" })).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("**Original Markdown**");
  });

  it("uses complete plain text while async Markdown rendering still contains an older fragment", async () => {
    const cloneNode = vi.fn(() => ({ innerHTML: "<p>Old partial answer</p>" }));
    const markdown = { cloneNode, querySelector: () => ({}) };
    const write = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class { constructor(public contents: Record<string, Blob>) {} });
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    expect(await copyResponseToClipboard(part, markdown as unknown as HTMLElement)).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Visible answer");
    expect(write).not.toHaveBeenCalled();
    expect(cloneNode).not.toHaveBeenCalled();
  });
});
