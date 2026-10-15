import { afterEach, describe, expect, it, vi } from "vitest"
import { Marked } from "marked"
import {
  enhanceMarkdownDiagrams,
  disposeMarkdownDiagrams,
  getMarkdownDiagramTheme,
  markdownMathExtension,
  mermaidPlaceholder,
  renderMarkdownMath,
} from "../../../../../src/components/share/markdown-diagrams"
import { createMarkdownCodeExtension, markdownRenderer } from "../../../../../src/lib/markdown-stream"

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn().mockRejectedValue(new Error("Invalid diagram")),
  load: vi.fn(),
}))
vi.mock("mermaid", () => {
  mermaid.load()
  return { default: mermaid }
})

afterEach(() => vi.unstubAllGlobals())

const markdown = new Marked({ renderer: markdownRenderer }, markdownMathExtension)

describe("markdownMathExtension", () => {
  it.each([
    ["An inline $x^2 + y^2$ result.", "inline", "x^2 + y^2"],
    [String.raw`An inline \(\frac{1}{2}\) result.`, "inline", String.raw`\frac{1}{2}`],
    ["$$\nx^2 + y^2\n$$", "block", "x^2 + y^2"],
    [String.raw`\[\sum_{i=1}^{n} i\]`, "block", String.raw`\sum_{i=1}^{n} i`],
    ["A display formula $$x^2$$ in a paragraph.", "block", "x^2"],
  ])("recognizes complete TeX in %s before Markdown consumes its escapes", (source, mode, formula) => {
    const html = markdown.parse(source) as string
    expect(html).toContain(`data-math-display="${mode}"`)
    expect(html).toContain(formula)
  })

  it.each([
    "An unfinished $x^2",
    String.raw`\[\frac{`,
    "The prices are $5 and $10.",
    "`$literal$`",
    "```text\n$x^2$\n```",
    String.raw`An escaped \$x^2\$ price.`,
  ])("keeps incomplete expressions, currency, and code readable: %s", source => {
    const html = markdown.parse(source) as string
    expect(html).not.toContain("data-math-source")
    expect(html.length).toBeGreaterThan(0)
  })

  it("keeps unsafe text in a formula placeholder inert", () => {
    const html = markdown.parse('$<img src=x onerror="alert(1)">$') as string
    expect(html).toContain("&lt;img")
    expect(html).not.toContain("<img")
    expect(html).toContain("&quot;alert(1)&quot;")
  })
})

describe("renderMarkdownMath", () => {
  it("renders real inline and display math with the KaTeX accessibility output", async () => {
    const inline = await renderMarkdownMath(String.raw`\frac{1}{2}`, false)
    const block = await renderMarkdownMath(String.raw`\sum_{i=1}^{n} i`, true)
    expect(inline).toContain('class="katex"')
    expect(inline).toContain("<math")
    expect(block).toContain('class="katex-display"')
  })

  it("returns no replacement for invalid TeX so the source remains available", async () => {
    expect(await renderMarkdownMath(String.raw`\frac{`, false)).toBeUndefined()
  })

  it("does not produce a trusted link or executable markup from TeX commands", async () => {
    const html = await renderMarkdownMath(String.raw`\href{javascript:alert(1)}{click}`, false)
    expect(html || "").not.toContain("<a ")
    expect(html || "").not.toContain('href="javascript:')
  })
})

describe("mermaidPlaceholder", () => {
  it("keeps the original diagram in an escaped, copyable code block", () => {
    const html = mermaidPlaceholder('graph TD; A["<script>alert(1)</script>"] --> B')
    expect(html).toContain('<pre><code class="language-mermaid">')
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("survives code rendering as an enhancement target without enabling raw HTML", async () => {
    const renderer = new Marked({ renderer: markdownRenderer }, createMarkdownCodeExtension(async code => mermaidPlaceholder(code)))
    const html = await renderer.parse("```mermaid\ngraph TD; A --> B\n```")
    expect(html).toContain('<div data-mermaid-source="graph TD; A --&gt; B">')
    expect(html).toContain('<code class="language-mermaid">')
    expect(html).not.toContain("&lt;div")
  })
})

describe("enhanceMarkdownDiagrams", () => {
  it("defers Mermaid loading during streaming and preserves invalid source after completion", async () => {
    const source = "graph TD; A -->"
    const element = {
      innerHTML: mermaidPlaceholder(source),
      getAttribute: (name: string) => name === "data-mermaid-source" ? source : null,
    } as unknown as HTMLElement
    const container = {
      contains: (node: HTMLElement) => node === element,
      querySelectorAll: (selector: string) => selector === "[data-mermaid-source]" ? [element] : [],
    } as unknown as HTMLElement
    const original = element.innerHTML
    await enhanceMarkdownDiagrams(container, true)
    expect(mermaid.load).not.toHaveBeenCalled()
    await enhanceMarkdownDiagrams(container, false)
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: "strict",
      startOnLoad: false,
      htmlLabels: false,
      suppressErrorRendering: true,
      secure: expect.arrayContaining(["securityLevel", "htmlLabels", "secure"]),
    }))
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), source)
    expect(element.innerHTML).toBe(original)
    await enhanceMarkdownDiagrams(container, false)
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })
})


describe("Markdown diagram themes", () => {
  it("maps the conversation palette to readable nodes, edges, and labels in both themes", () => {
    let dark = false
    vi.stubGlobal("document", { documentElement: { classList: { contains: () => dark } } })
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => name === "--conversation-border" ? "color-mix(in srgb, white, black)" : "" }))
    const element = {} as HTMLElement
    const light = getMarkdownDiagramTheme(element)
    expect(light.theme).toBe("base")
    expect(light.themeVariables).toEqual(expect.objectContaining({
      darkMode: false, primaryColor: "#f5f5f5", primaryTextColor: "#242424", lineColor: "#626262", clusterBorder: "#dedede",
    }))
    dark = true
    const night = getMarkdownDiagramTheme(element)
    expect(night.themeVariables).toEqual(expect.objectContaining({
      darkMode: true, primaryColor: "#232323", primaryTextColor: "#ececec", lineColor: "#b4b4b4", clusterBorder: "#3c3c3c",
    }))
    expect(night.secure).toEqual(expect.arrayContaining(["theme", "themeVariables", "securityLevel"]))
  })

  it("serializes global Mermaid configuration and rerenders only diagrams on a theme switch", async () => {
    let dark = false
    let notifyTheme: () => void = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { notifyTheme = callback }
      observe = vi.fn()
      disconnect = disconnect
    })
    const svg = { querySelectorAll: () => [] }
    vi.stubGlobal("document", {
      documentElement: { classList: { contains: () => dark } },
      createElement: () => ({ innerHTML: "", content: svg }),
    })
    const first = { getAttribute: () => "graph TD; A --> B", replaceChildren: vi.fn() } as unknown as HTMLElement
    const second = { getAttribute: () => "sequenceDiagram\nA->>B: Test", replaceChildren: vi.fn() } as unknown as HTMLElement
    const container = {
      contains: (element: HTMLElement) => element === first || element === second,
      querySelectorAll: (selector: string) => selector === "[data-mermaid-source]" ? [first, second] : [],
    } as unknown as HTMLElement
    let finishFirst: (value: { svg: string }) => void = () => {}
    mermaid.initialize.mockClear()
    mermaid.render.mockReset()
    mermaid.render.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValue({ svg: "<svg></svg>" })
    const completed = enhanceMarkdownDiagrams(container, false)
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    expect(mermaid.initialize).toHaveBeenCalledTimes(1)
    finishFirst({ svg: "<svg></svg>" })
    await completed
    expect(mermaid.render).toHaveBeenCalledTimes(2)
    expect(first.replaceChildren).toHaveBeenCalledOnce()
    await enhanceMarkdownDiagrams(container, false)
    expect(mermaid.render).toHaveBeenCalledTimes(2)
    dark = true
    notifyTheme()
    await vi.waitFor(() => expect(second.replaceChildren).toHaveBeenCalledTimes(2))
    expect(mermaid.render).toHaveBeenCalledTimes(4)
    expect(mermaid.initialize.mock.lastCall?.[0].themeVariables.darkMode).toBe(true)
    disposeMarkdownDiagrams(container)
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
