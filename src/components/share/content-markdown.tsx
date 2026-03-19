import { createOverflow } from "./common"
import { attachCopyButtons } from "./CopyButton"
import { createResource, createSignal, createEffect, onCleanup } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { logger } from "../../lib/logger"
import style from "./content-markdown.module.css"
import { getHighlight, setHighlight } from "../../lib/highlight-cache"
import { highlightCode, resolveLang } from "../../lib/shiki-highlighter"

// Lazy-initialized marked instance with Shiki integration
let markedInstancePromise: Promise<any> | null = null

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function sanitizeHref(href: string): string {
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:') || trimmed.startsWith('data:')) {
    return '';
  }
  return href;
}

function getMarkedInstance() {
  if (markedInstancePromise) return markedInstancePromise
  markedInstancePromise = (async () => {
    const [{ marked }, { default: markedShiki }, { transformerNotationDiff }] =
      await Promise.all([
        import("marked"),
        import("marked-shiki"),
        import("@shikijs/transformers"),
      ])

    return marked.use(
      {
        renderer: {
          link(href: string, title: string | null | undefined, text: string) {
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
            const sanitizedHref = escapeHtml(sanitizeHref(href))
            return `<a href="${sanitizedHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text || escapeHtml(href)}</a>`
          },
        },
      },
      markedShiki({
        async highlight(code: string, lang: string) {
          const resolved = resolveLang(lang)
          const cacheKey = `${resolved}:${code}`
          const cached = getHighlight(cacheKey)
          if (cached) return cached

          const html = await highlightCode(code, resolved, {
            transformers: [transformerNotationDiff()],
          })
          setHighlight(cacheKey, html)
          return html
        },
      }),
    )
  })()
  return markedInstancePromise
}

interface Props {
  text: string
  expand?: boolean
  highlight?: boolean
}
export function ContentMarkdown(props: Props) {
  const { t } = useI18n();

  // Debounced text — coalesces rapid SSE token updates into ~6-7 re-parses/sec
  const [debouncedText, setDebouncedText] = createSignal(strip(props.text))
  createEffect(() => {
    const text = strip(props.text)
    const timer = setTimeout(() => setDebouncedText(text), 150)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    logger.debug("[ContentMarkdown] Text changed, length:", props.text?.length || 0);
  });

  const [html] = createResource(
    debouncedText,
    async (markdown) => {
      if (!markdown) return ""
      logger.debug("[ContentMarkdown] Parsing markdown, length:", markdown.length);
      const m = await getMarkedInstance()
      return m.parse(markdown)
    },
    { initialValue: "" }
  )
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()
  let markdownRef: HTMLDivElement | undefined

  // Show raw text as fallback while markdown is loading (avoids blank/white screen)
  const displayHtml = () => {
    const parsed = html()
    if (parsed) return parsed
    // Fallback: escape HTML and wrap in <p> for basic readability
    const raw = debouncedText()
    if (!raw) return ""
    const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    return `<p>${escaped.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`
  }

  createEffect(() => {
    const _ = displayHtml()
    if (!markdownRef) return
    queueMicrotask(() => attachCopyButtons(markdownRef!))
  })

  return (
    <div
      class={style.root}
      data-highlight={props.highlight === true ? true : undefined}
      data-expanded={expanded() || props.expand === true ? true : undefined}
    >
      <div data-slot="markdown" ref={(el) => { overflow.ref(el); markdownRef = el; }} innerHTML={displayHtml()} />

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

function strip(text: string): string {
  if (!text) return ""
  const wrappedRe = /^\s*<([A-Za-z]\w*)>\s*([\s\S]*?)\s*<\/\1>\s*$/
  const match = text.match(wrappedRe)
  return match ? match[2] : text
}
