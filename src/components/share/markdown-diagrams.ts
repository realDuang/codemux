import type { MarkedExtension, Tokens } from "marked"
import type { Mermaid, MermaidConfig } from "mermaid"
import { escapeMarkdownHtml } from "../../lib/markdown-stream"

interface MathToken extends Tokens.Generic {
  type: "mathBlock" | "mathInline"
  text: string
  display: boolean
}

function findMathEnd(source: string, delimiter: string, start: number): number {
  let index = source.indexOf(delimiter, start)
  while (index >= 0) {
    let escapes = 0
    for (let previous = index - 1; previous >= 0 && source[previous] === "\\"; previous--) escapes++
    if (escapes % 2 === 0) return index
    index = source.indexOf(delimiter, index + delimiter.length)
  }
  return -1
}

function mathToken(source: string, display: boolean): MathToken | undefined {
  const opening = display ? /^(?: {0,3})(\$\$|\\\[)/.exec(source) : /^(\$(?!\$)|\\\()/.exec(source)
  if (!opening) return undefined
  const delimiter = opening[1]
  const closing = delimiter === "\\[" ? "\\]" : delimiter === "\\(" ? "\\)" : delimiter
  const end = findMathEnd(source, closing, opening[0].length)
  if (end < 0) return undefined
  const text = source.slice(opening[0].length, end)
  // Avoid treating currency amounts or whitespace-delimited dollars as inline TeX.
  if (!display && (text.includes("\n") || !text || /^\s|\s$/.test(text) || (delimiter === "$" && /\d/.test(source[end + 1] || "")))) return undefined
  return {
    type: display ? "mathBlock" : "mathInline",
    raw: source.slice(0, end + closing.length),
    text,
    display,
  }
}

/** Delimiters are tokenized before Markdown escapes consume TeX commands. */
export const markdownMathExtension: MarkedExtension = {
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start(source) { return source.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/) },
      tokenizer(source) { return mathToken(source, true) },
      renderer(token) {
        return `<div data-math-source="${escapeMarkdownHtml(token.text)}" data-math-display="block">${escapeMarkdownHtml(token.raw)}</div>\n`
      },
    },
    {
      name: "mathInline",
      level: "inline",
      start(source) { return source.search(/\$|\\[([]/) },
      tokenizer(source) {
        const token = mathToken(source, false) ?? mathToken(source, true)
        return token && { ...token, type: "mathInline" }
      },
      renderer(token) {
        return `<span data-math-source="${escapeMarkdownHtml(token.text)}" data-math-display="${token.display ? "block" : "inline"}">${escapeMarkdownHtml(token.raw)}</span>`
      },
    },
  ],
}

export function mermaidPlaceholder(source: string): string {
  return `<div data-mermaid-source="${escapeMarkdownHtml(source)}"><pre><code class="language-mermaid">${escapeMarkdownHtml(source)}</code></pre></div>`
}

let katexPromise: Promise<typeof import("katex")> | undefined
let mermaidPromise: Promise<Mermaid> | undefined
let diagramSequence = 0

export async function renderMarkdownMath(source: string, displayMode: boolean): Promise<string | undefined> {
  try {
    katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([katex]) => katex)
    const katex = await katexPromise
    return katex.renderToString(source, {
      displayMode,
      trust: false,
      throwOnError: true,
      strict: "error",
      maxExpand: 1000,
      maxSize: 100,
    })
  } catch {
    // A malformed or still-growing expression remains readable as its source.
    return undefined
  }
}

async function getMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => mermaid)
  return mermaidPromise
}

const enhancedMath = new WeakSet<HTMLElement>()
const diagramThemes = new WeakMap<HTMLElement, string>()
const themeObservers = new WeakMap<HTMLElement, { observer: MutationObserver; isStreaming: boolean }>()
// Mermaid has global configuration; serialize initialization and render as one operation.
let renderQueue: Promise<void> = Promise.resolve()

export function getMarkdownDiagramTheme(element: HTMLElement): MermaidConfig {
  const dark = typeof document !== "undefined" && document.documentElement?.classList.contains("dark")
  const computed = typeof getComputedStyle === "function" ? getComputedStyle(element) : undefined
  const color = (token: string, light: string, night: string): string => {
    const value = computed?.getPropertyValue(token).trim()
    // Mermaid's color parser accepts hex and RGB, but not CSS variables or color-mix.
    return value && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s/]+\))$/i.test(value) ? value : dark ? night : light
  }
  const text = color("--conversation-text", "#242424", "#ececec")
  const muted = color("--conversation-muted", "#626262", "#b4b4b4")
  const surface = color("--conversation-surface", "#f5f5f5", "#232323")
  const background = color("--conversation-bg", "#ffffff", "#171717")
  const border = color("--conversation-border", "#dedede", "#3c3c3c")
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    theme: "base",
    themeVariables: {
      darkMode: dark,
      background,
      primaryColor: surface,
      primaryTextColor: text,
      primaryBorderColor: muted,
      secondaryColor: background,
      secondaryTextColor: text,
      secondaryBorderColor: muted,
      tertiaryColor: surface,
      tertiaryTextColor: text,
      tertiaryBorderColor: muted,
      lineColor: muted,
      textColor: text,
      mainBkg: surface,
      nodeBorder: muted,
      clusterBkg: background,
      clusterBorder: border,
      edgeLabelBackground: background,
      titleColor: text,
      actorBkg: surface,
      actorBorder: muted,
      actorTextColor: text,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: text,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: muted,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: surface,
      noteBorderColor: muted,
      noteTextColor: text,
      activationBkgColor: surface,
      activationBorderColor: muted,
      fontFamily: computed?.getPropertyValue("font-family") || "sans-serif",
    },
    secure: ["securityLevel", "startOnLoad", "htmlLabels", "suppressErrorRendering", "maxTextSize", "theme", "themeVariables", "secure"],
  }
}

function observeTheme(container: HTMLElement, isStreaming: boolean) {
  const existing = themeObservers.get(container)
  if (existing) { existing.isStreaming = isStreaming; return }
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return
  const state = {
    isStreaming,
    observer: new MutationObserver(() => { void enhanceMarkdownDiagrams(container, state.isStreaming) }),
  }
  state.observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
  themeObservers.set(container, state)
}

export function disposeMarkdownDiagrams(container: HTMLElement): void {
  themeObservers.get(container)?.observer.disconnect()
  themeObservers.delete(container)
  for (const element of container.querySelectorAll<HTMLElement>("[data-mermaid-source]")) diagramThemes.delete(element)
}

/** Enhance retained blocks in place; failures keep the original text/code visible. */
export async function enhanceMarkdownDiagrams(container: HTMLElement, isStreaming: boolean): Promise<void> {
  const math = Array.from(container.querySelectorAll<HTMLElement>("[data-math-source]"))
  const allDiagrams = Array.from(container.querySelectorAll<HTMLElement>("[data-mermaid-source]"))
  if (allDiagrams.length) observeTheme(container, isStreaming)
  const diagrams = isStreaming ? [] : allDiagrams
  await Promise.allSettled([
    ...math.map(async (element) => {
      if (enhancedMath.has(element)) return
      enhancedMath.add(element)
      const source = element.getAttribute("data-math-source") || ""
      const html = await renderMarkdownMath(source, element.getAttribute("data-math-display") === "block")
      if (html && container.contains(element)) element.innerHTML = html
    }),
    ...diagrams.map(async (element) => {
      const theme = getMarkdownDiagramTheme(element)
      const key = JSON.stringify(theme)
      if (diagramThemes.get(element) === key) return
      diagramThemes.set(element, key)
      const source = element.getAttribute("data-mermaid-source") || ""
      const render = async () => {
        try {
          const mermaid = await getMermaid()
          if (!container.contains(element) || diagramThemes.get(element) !== key) return
          mermaid.initialize(theme)
          // Never call bindFunctions: diagram source cannot install callbacks.
          const { svg } = await mermaid.render(`codemux-diagram-${++diagramSequence}`, source)
          if (!container.contains(element) || diagramThemes.get(element) !== key) return
          const template = document.createElement("template")
          template.innerHTML = svg
          template.content.querySelectorAll("script, foreignObject, iframe, object, embed").forEach(node => node.remove())
          for (const node of template.content.querySelectorAll("*")) {
            for (const attribute of Array.from(node.attributes)) {
              if (/^on/i.test(attribute.name) || (node.localName === "a" && /href$/i.test(attribute.name))) node.removeAttribute(attribute.name)
            }
          }
          element.replaceChildren(template.content)
        } catch {
          // Invalid source keeps its code block; theme failures keep the last readable diagram.
        }
      }
      renderQueue = renderQueue.then(render, render)
      await renderQueue
    }),
  ])
}
