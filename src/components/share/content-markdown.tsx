import { createOverflow } from "./common"
import { createResource, createSignal, createEffect, onCleanup } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { logger } from "../../lib/logger"
import style from "./content-markdown.module.css"

// Shiki highlight cache — avoids redundant codeToHtml calls for identical code blocks
const highlightCache = new Map<string, string>()

// Lazy-initialized marked instance with Shiki integration
let markedInstancePromise: Promise<any> | null = null

function getMarkedInstance() {
  if (markedInstancePromise) return markedInstancePromise
  markedInstancePromise = (async () => {
    const [{ marked }, { codeToHtml }, { default: markedShiki }, { transformerNotationDiff }] =
      await Promise.all([
        import("marked"),
        import("shiki"),
        import("marked-shiki"),
        import("@shikijs/transformers"),
      ])

    return marked.use(
      {
        renderer: {
          link(link: any) {
            const { href, title, text } = link
            const titleAttr = title ? ` title="${title}"` : ""
            return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
          },
        },
      },
      markedShiki({
        async highlight(code: string, lang: string) {
          const cacheKey = `${lang || "text"}:${code}`
          const cached = highlightCache.get(cacheKey)
          if (cached) return cached

          const html = await codeToHtml(code, {
            lang: lang || "text",
            themes: {
              light: "github-light",
              dark: "one-dark-pro",
            },
            transformers: [transformerNotationDiff()],
          })
          highlightCache.set(cacheKey, html)
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

  return (
    <div
      class={style.root}
      data-highlight={props.highlight === true ? true : undefined}
      data-expanded={expanded() || props.expand === true ? true : undefined}
    >
      <div data-slot="markdown" ref={overflow.ref} innerHTML={html()} />

      {!props.expand && overflow.status && (
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
