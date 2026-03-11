import style from "./content-bash.module.css"
import { createResource, createSignal } from "solid-js"
import { CopyButton } from "./CopyButton"
import { createOverflow } from "./common"
import { useI18n } from "../../lib/i18n";
import { getHighlight, setHighlight, hasHighlight } from "../../lib/highlight-cache"

/**
 * Maximum number of lines to syntax-highlight.
 * Lines beyond this threshold are displayed as plain escaped text,
 * avoiding multi-second Shiki calls on large build logs or test results.
 */
const MAX_HIGHLIGHT_LINES = 200

async function highlightCode(code: string, lang: string): Promise<string> {
  if (!code) return ""

  const cacheKey = `${lang}:${code}`
  if (hasHighlight(cacheKey)) {
    return getHighlight(cacheKey)!
  }

  // For very long output, only highlight the first N lines and escape the rest
  const lines = code.split("\n")
  let codeToHighlight = code
  let overflowHtml = ""

  if (lines.length > MAX_HIGHLIGHT_LINES) {
    codeToHighlight = lines.slice(0, MAX_HIGHLIGHT_LINES).join("\n")
    const remaining = lines.slice(MAX_HIGHLIGHT_LINES)
    const escaped = remaining
      .join("\n")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
    overflowHtml = `<pre style="opacity:0.7"><code>${escaped}</code></pre>`
  }

  const { codeToHtml } = await import("shiki")
  const html = await codeToHtml(codeToHighlight, {
    lang,
    themes: {
      light: "github-light",
      dark: "one-dark-pro",
    },
  })

  const result = html + overflowHtml
  setHighlight(cacheKey, result)
  return result
}

interface Props {
  command: string
  output: string
  description?: string
  expand?: boolean
}

export function ContentBash(props: Props) {
  const { t } = useI18n();
  const [commandHtml] = createResource(
    () => props.command,
    (command) => highlightCode(command, "bash"),
  )

  const [outputHtml] = createResource(
    () => props.output,
    (output) => highlightCode(output, "console"),
  )

  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()

  return (
    <div class={style.root} data-expanded={expanded() || props.expand === true ? true : undefined}>
      <div data-slot="body">
        <div data-slot="header">
          <span>{props.description}</span>
        </div>
        <div data-slot="content">
          <div innerHTML={commandHtml()} />
          <div data-slot="output" ref={overflow.ref} innerHTML={outputHtml()} />
        </div>
        <CopyButton text={() => props.command || ""} />
      </div>

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
