import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../../../../src/lib/clipboard";

class ElementStub {
  focus = vi.fn();
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
});
