import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { attachCopyButtons, type MarkdownCodeLabels } from "../../../../src/lib/markdown-interactions"

const copyText = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock("../../../../src/lib/clipboard", () => ({ copyTextToClipboard: copyText }))
vi.mock("../../../../src/lib/gateway-api", () => ({ gateway: {} }))
vi.mock("../../../../src/stores/file", () => ({}))

const labels: MarkdownCodeLabels = {
  codeRegion: "Code block", plainText: "Plain text", copyCode: "Copy code", copied: "Copied",
  copyFailed: "Copy failed", wrapCode: "Wrap lines", unwrapCode: "Disable line wrapping",
  scrollHorizontally: "Scroll horizontally to view more",
}

class ElementStub {
  attributes = new Map<string, string>()
  nodes = new Map<string, ElementStub>()
  listeners = new Map<string, (event: unknown) => unknown>()
  classList = new Set<string>()
  textContent = ""
  innerHTML = ""
  disabled = false
  title = ""
  tabIndex = -1
  clientWidth = 300
  scrollWidth = 900
  scrollLeft = 75
  parentElement: ElementStub | null = null
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  hasAttribute(name: string) { return this.attributes.has(name) }
  removeAttribute(name: string) { this.attributes.delete(name) }
  toggleAttribute(name: string, force?: boolean) {
    const enabled = force ?? !this.hasAttribute(name)
    if (enabled) this.setAttribute(name, ""); else this.removeAttribute(name)
    return enabled
  }
  querySelector(selector: string) { return this.nodes.get(selector) }
  querySelectorAll(selector: string) { return selector === "pre" ? [this.nodes.get("pre")] : [] }
  contains = () => true
  closest(selector: string) { return selector === "pre" ? this.parentElement : this }
  addEventListener(name: string, handler: (event: unknown) => unknown) { this.listeners.set(name, handler) }
  removeEventListener(name: string) { this.listeners.delete(name) }
}

function codePage() {
  const root = new ElementStub()
  const pre = new ElementStub()
  const code = new ElementStub()
  const copy = new ElementStub()
  const wrap = new ElementStub()
  copy.parentElement = wrap.parentElement = code.parentElement = pre
  copy.setAttribute("data-markdown-copy-code", "")
  wrap.setAttribute("data-markdown-wrap-code", "")
  pre.setAttribute("data-code-language", "typescript")
  code.textContent = "  const answer = 42;\n\treturn answer;\n"
  root.nodes.set("pre", pre)
  pre.nodes = new Map([
    ["code", code], ["[data-markdown-copy-code]", copy], ["[data-markdown-wrap-code]", wrap],
    ["[data-markdown-code-toolbar]", new ElementStub()], ["[data-code-language]", new ElementStub()],
    ["[data-code-overflow-hint]", new ElementStub()],
  ])
  for (const selector of ["[data-copy-icon]", "[data-copy-label]", "[data-copy-announcement]"]) copy.nodes.set(selector, new ElementStub())
  const enhance = () => attachCopyButtons(root as unknown as HTMLElement, labels)
  const click = (target: ElementStub) => root.listeners.get("click")!({ target, preventDefault: vi.fn(), stopPropagation: vi.fn() })
  return { root, pre, code, copy, wrap, enhance, click }
}

beforeEach(() => { vi.stubGlobal("Element", ElementStub); vi.useFakeTimers(); copyText.mockClear() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe("Markdown code toolbar", () => {
  it("disables incomplete-code copying and copies only exact code after completion", async () => {
    const { pre, code, copy, enhance, click } = codePage()
    pre.setAttribute("data-code-incomplete", "")
    const cleanup = enhance()
    expect(copy.disabled).toBe(true)
    await click(copy)
    expect(copyText).not.toHaveBeenCalled()
    pre.removeAttribute("data-code-incomplete")
    enhance()
    expect(copy.disabled).toBe(false)
    await click(copy)
    expect(copyText).toHaveBeenCalledExactlyOnceWith("  const answer = 42;\n\treturn answer;\n")
    expect(copy.getAttribute("aria-label")).toBe("Copied")
    expect(copy.querySelector("[data-copy-announcement]")?.textContent).toBe("Copied")
    enhance()
    expect(copy.getAttribute("aria-label")).toBe("Copied")
    expect(pre.querySelector("code")).toBe(code)
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("toggles wrapping without replacing code or changing its selection-bearing text", async () => {
    const { pre, code, wrap, enhance, click, root } = codePage()
    const cleanup = enhance()
    const source = code.textContent
    expect(pre.hasAttribute("data-overflow-end")).toBe(true)
    await click(wrap)
    expect(pre.hasAttribute("data-code-wrap")).toBe(true)
    expect(wrap.getAttribute("aria-pressed")).toBe("true")
    expect(wrap.getAttribute("aria-label")).toBe("Disable line wrapping")
    enhance()
    expect(pre.querySelector("code")).toBe(code)
    expect(code.textContent).toBe(source)
    expect(code.scrollLeft).toBe(75)
    await click(wrap)
    expect(wrap.getAttribute("aria-pressed")).toBe("false")
    cleanup()
    expect(root.listeners.size).toBe(0)
  })

  it("announces clipboard failure without presenting success feedback", async () => {
    copyText.mockResolvedValueOnce(false)
    const { copy, enhance, click } = codePage()
    const cleanup = enhance()
    await click(copy)
    expect(copy.getAttribute("aria-label")).toBe("Copy failed")
    expect(copy.hasAttribute("data-copied")).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(copy.getAttribute("aria-label")).toBe("Copy code")
    cleanup()
  })
})
