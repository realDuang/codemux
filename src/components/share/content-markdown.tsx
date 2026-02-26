import { marked } from "marked"
import { codeToHtml } from "shiki"
import markedShiki from "marked-shiki"
import { createOverflow } from "./common"
import { createResource, createSignal, createEffect } from "solid-js"
import { transformerNotationDiff } from "@shikijs/transformers"
import { useI18n } from "../../lib/i18n"
import { logger } from "../../lib/logger"
import style from "./content-markdown.module.css"

const markedWithShiki = marked.use(
  {
    renderer: {
      link(link: any) {
        const { href, title, text } = link;
        const titleAttr = title ? ` title="${title}"` : ""
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
      },
    },
  },
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

interface Props {
  text: string
  expand?: boolean
  highlight?: boolean
}
export function ContentMarkdown(props: Props) {
  const { t } = useI18n();
  // Add debug logs
  createEffect(() => {
    logger.debug("[ContentMarkdown] Text changed, length:", props.text?.length || 0);
  });

  const [html] = createResource(
    () => strip(props.text),
    async (markdown) => {
      logger.debug("[ContentMarkdown] Parsing markdown, length:", markdown?.length || 0);
      return markedWithShiki.parse(markdown)
    },
    { initialValue: "" } // Add initial value to avoid undefined
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
