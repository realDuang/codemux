import { Marked } from "marked"
import { codeToHtml } from "shiki"
import markedShiki from "marked-shiki"
import { createOverflow } from "./common"
import { enqueueHighlight } from "./highlight-queue"
import { createSignal, createEffect, on, onCleanup } from "solid-js"
import { transformerNotationDiff } from "@shikijs/transformers"
import { useI18n } from "../../lib/i18n"
import style from "./content-markdown.module.css"

const linkRenderer = {
  link(link: any) {
    const { href, title, text } = link;
    const titleAttr = title ? ` title="${title}"` : ""
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
  },
}

// Full pipeline: marked + shiki code highlighting (expensive, async)
const markedWithShiki = new Marked(
  { renderer: linkRenderer },
  markedShiki({
    highlight(code, lang) {
      return codeToHtml(code, {
        lang: lang || "text",
        themes: {
          light: "github-light",
          dark: "one-dark-pro",
        },
        transformers: [transformerNotationDiff()],
      })
    },
  }),
)

// Lightweight pipeline: marked only, no shiki (fast, practically sync)
const markedPlain = new Marked({ renderer: linkRenderer })

interface Props {
  text: string
  expand?: boolean
  highlight?: boolean
}
export function ContentMarkdown(props: Props) {
  const { t } = useI18n();
  const [html, setHtml] = createSignal("")
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()

  // Track whether the text is actively streaming (changing rapidly).
  // While streaming, we use the cheap markedPlain parser so height
  // updates are synchronous and predictable.  Once text has been
  // stable for STABLE_MS we run the full shiki pipeline once.
  const STABLE_MS = 400
  let shikiTimer: ReturnType<typeof setTimeout> | null = null
  let lastLen = 0

  createEffect(on(
    () => strip(props.text),
    (markdown) => {
      if (!markdown) { setHtml(""); return }

      const isGrowing = markdown.length > lastLen
      lastLen = markdown.length

      // Fast synchronous parse (no shiki) — keeps height stable
      const plainHtml = markedPlain.parse(markdown) as string
      setHtml(plainHtml)

      // Schedule full shiki highlight after text stabilises
      if (shikiTimer) clearTimeout(shikiTimer)
      shikiTimer = setTimeout(() => {
        shikiTimer = null
        enqueueHighlight(() => markedWithShiki.parse(markdown)).then(
          (highlighted) => {
            // Only apply if text hasn't changed since we scheduled
            if (strip(props.text) === markdown) {
              setHtml(highlighted as string)
            }
          }
        )
      }, isGrowing ? STABLE_MS : 50) // shorter delay for non-streaming updates
    },
  ))

  onCleanup(() => { if (shikiTimer) clearTimeout(shikiTimer) })

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
