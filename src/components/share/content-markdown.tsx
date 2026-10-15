import { createOverflow } from "./common"
import { createResource, createSignal, createEffect, onCleanup } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { logger } from "../../lib/logger"
import style from "./content-markdown.module.css"
import "./copy-button.css"
import { getHighlight, setHighlight } from "../../lib/highlight-cache"
import { highlightCode, resolveLang } from "../../lib/shiki-highlighter"
import type { Marked } from "marked"
import type { FilePart } from "../../types/unified"
import { enhanceMarkdownDiagrams, disposeMarkdownDiagrams, markdownMathExtension, mermaidPlaceholder } from "./markdown-diagrams"
import { attachCopyButtons, enhanceMarkdownInteractions, prepareMarkdownTables } from "../../lib/markdown-interactions"
import {
  createMarkdownStreamScheduler,
  createMarkdownCodeExtension,
  getOpenMarkdownFence,
  escapeMarkdownHtml,
  markdownRenderer,
  previewStreamingMarkdown,
  reconcileMarkdownBlocks,
} from "../../lib/markdown-stream"

// Lazy-initialized marked instance with Shiki integration
let markedInstancePromise: Promise<Marked> | null = null

function getMarkedInstance() {
  if (markedInstancePromise) return markedInstancePromise
  markedInstancePromise = (async () => {
    const [{ Marked }, { transformerNotationDiff }] =
      await Promise.all([
        import("marked"),
        import("@shikijs/transformers"),
      ])

    return new Marked(
      { renderer: markdownRenderer },
      markdownMathExtension,
      createMarkdownCodeExtension(async (code, lang) => {
        if (lang.trim().toLowerCase() === "mermaid") return mermaidPlaceholder(code)
        const resolved = resolveLang(lang)
        const cacheKey = `${resolved}:${code}`
        const cached = getHighlight(cacheKey)
        if (cached) return cached.replace("<pre", `<pre data-code-language="${escapeMarkdownHtml(lang)}"`)

        const html = await highlightCode(code, resolved, {
          transformers: [transformerNotationDiff()],
        })
        setHighlight(cacheKey, html)
        return html.replace("<pre", `<pre data-code-language="${escapeMarkdownHtml(lang)}"`)
      }),
    )
  })()
  return markedInstancePromise
}

interface Props {
  text: string
  expand?: boolean
  highlight?: boolean
  isStreaming?: boolean
  buffered?: boolean
  workingDirectory?: string
  inlineAssets?: FilePart[]
}
export function ContentMarkdown(props: Props) {
  const { t } = useI18n();

  const [frame, setFrame] = createSignal({ text: props.text, isStreaming: props.isStreaming === true })
  const scheduler = createMarkdownStreamScheduler(setFrame)
  onCleanup(() => scheduler.dispose())
  createEffect(() => {
    const next = { text: props.text, isStreaming: props.isStreaming === true }
    if (props.buffered === false) {
      scheduler.dispose()
      setFrame(next)
    } else scheduler.update(next)
  })

  createEffect(() => {
    logger.debug("[ContentMarkdown] Text changed, length:", props.text?.length || 0);
  });

  const [html] = createResource(
    frame,
    async (current) => {
      if (!current.text) return ""
      const markdown = current.isStreaming ? previewStreamingMarkdown(current.text) : current.text
      logger.debug("[ContentMarkdown] Parsing markdown, length:", markdown.length);
      try {
        const m = await getMarkedInstance()
        return await m.parse(markdown)
      } catch {
        logger.warn("[ContentMarkdown] Rendering failed; retaining readable source")
        return `<pre>${escapeMarkdownHtml(markdown)}</pre>`
      }
    },
    { initialValue: "" }
  )
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()
  let markdownRef: HTMLDivElement | undefined
  let blocks: { html: string; node: ChildNode }[] = []
  let cleanupInteractions: (() => void) | undefined
  let cleanupCode: (() => void) | undefined
  onCleanup(() => {
    cleanupInteractions?.()
    cleanupCode?.()
    if (markdownRef) disposeMarkdownDiagrams(markdownRef)
  })

  // Show raw text as fallback while markdown is loading (avoids blank/white screen)
  const displayHtml = () => {
    const parsed = html()
    if (parsed) return parsed
    // Fallback: escape HTML and wrap in <p> for basic readability
    const raw = frame().text
    if (!raw) return ""
    const escaped = escapeMarkdownHtml(raw)
    return `<p>${escaped.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`
  }

  createEffect(() => {
    const currentHtml = displayHtml()
    const isStreaming = frame().isStreaming
    if (!markdownRef) return
    const template = document.createElement("template")
    template.innerHTML = currentHtml
    prepareMarkdownTables(template.content)
    const next = Array.from(template.content.childNodes, (node) => ({
      html: node.nodeType === Node.ELEMENT_NODE ? (node as Element).outerHTML : `${node.nodeType}:${node.textContent}`,
      node,
    }))
    const reconciled = reconcileMarkdownBlocks(blocks, next)
    let prefix = 0
    while (prefix < blocks.length && prefix < reconciled.length && blocks[prefix] === reconciled[prefix]) prefix++
    for (const block of blocks.slice(prefix)) block.node.remove()
    for (const block of reconciled.slice(prefix)) markdownRef.appendChild(block.node)
    blocks = reconciled
    if (!html.loading) {
      const pres = Array.from(markdownRef.querySelectorAll("pre"))
      for (const pre of pres) pre.removeAttribute("data-code-incomplete")
      if (isStreaming && getOpenMarkdownFence(frame().text)) pres.at(-1)?.setAttribute("data-code-incomplete", "")
    }
    cleanupCode = attachCopyButtons(markdownRef, {
      codeRegion: t().markdown.codeRegion,
      plainText: t().markdown.plainText,
      copyCode: t().markdown.copyCode,
      copied: t().common.copied,
      copyFailed: t().markdown.copyFailed,
      wrapCode: t().markdown.wrapCode,
      unwrapCode: t().markdown.unwrapCode,
      scrollHorizontally: t().markdown.scrollHorizontally,
    })
    cleanupInteractions = enhanceMarkdownInteractions(markdownRef, {
      workingDirectory: props.workingDirectory,
      inlineAssets: props.inlineAssets,
      labels: {
        copyTable: t().markdown.copyTable,
        copied: t().common.copied,
        copyFailed: t().markdown.copyFailed,
        tableRegion: t().markdown.tableRegion,
        expandTable: t().markdown.expandTable,
        closeTable: t().markdown.closeTable,
        tableDialog: t().markdown.tableDialog,
        scrollHorizontally: t().markdown.scrollHorizontally,
        imageUnavailable: t().markdown.imageUnavailable,
        previewImage: t().markdown.previewImage,
        closeImage: t().markdown.closeImage,
        mediaUnavailable: t().markdown.mediaUnavailable,
      },
    })
    void enhanceMarkdownDiagrams(markdownRef, isStreaming)
  })

  return (
    <div
      class={style.root}
      data-highlight={props.highlight === true ? true : undefined}
      data-expanded={expanded() || props.expand === true ? true : undefined}
    >
      <div
        data-slot="markdown"
        data-markdown-pending={frame().text !== props.text || frame().isStreaming !== (props.isStreaming === true) || html.loading ? "true" : undefined}
        ref={(el) => { overflow.ref(el); markdownRef = el; }}
      />

      {((!props.expand && overflow.status) || expanded()) && (
        <button
          type="button"
          data-component="text-button"
          data-slot="expand-button"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded() ? t().common.showLess : t().common.showMore}
        </button>
      )}
    </div>
  )
}
