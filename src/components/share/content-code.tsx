import { codeToHtml, bundledLanguages } from "shiki"
import { createSignal, createEffect, on, onCleanup } from "solid-js"
import { transformerNotationDiff } from "@shikijs/transformers"
import { enqueueHighlight } from "./highlight-queue"
import style from "./content-code.module.css"

interface Props {
  code: string
  lang?: string
  flush?: boolean
  showLineNumbers?: boolean
  transparentBg?: boolean
}

/**
 * Escapes HTML special characters to prevent XSS when rendering plain text.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function ContentCode(props: Props) {
  const [html, setHtml] = createSignal("")
  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  createEffect(on(
    () => ({ code: props.code, lang: props.lang, showLineNumbers: props.showLineNumbers }),
    ({ code, lang, showLineNumbers }) => {
      const codeStr = code || ""

      // Phase 1: immediate plain-text render (no shiki) — stable height
      const escaped = escapeHtml(codeStr)
      const lines = codeStr.split("\n")
      const shouldShowLineNumbers = showLineNumbers ?? (lines.length > 1)

      if (shouldShowLineNumbers) {
        const lineNumbersHtml = lines
          .map((_: string, i: number) => `<span class="${style.lineNumber}">${i + 1}</span>`)
          .join("")
        setHtml(`<div class="${style.withLineNumbers}"><div class="${style.lineNumbers}">${lineNumbersHtml}</div><div class="${style.codeContent}"><pre class="shiki" style="margin:0"><code>${escaped}</code></pre></div></div>`)
      } else {
        setHtml(`<pre class="shiki" style="margin:0"><code>${escaped}</code></pre>`)
      }

      // Phase 2: async shiki highlight — replace when ready
      if (highlightTimer) clearTimeout(highlightTimer)
      highlightTimer = setTimeout(() => {
        highlightTimer = null
        enqueueHighlight(() => codeToHtml(codeStr, {
          lang: lang && lang in bundledLanguages ? lang : "text",
          themes: {
            light: "github-light",
            dark: "one-dark-pro",
          },
          transformers: [transformerNotationDiff()],
        })).then((result) => {
          // Only apply if code hasn't changed since we scheduled
          if (props.code !== code) return

          if (shouldShowLineNumbers) {
            const lineNumbersHtml = lines
              .map((_: string, i: number) => `<span class="${style.lineNumber}">${i + 1}</span>`)
              .join("")
            setHtml(`<div class="${style.withLineNumbers}"><div class="${style.lineNumbers}">${lineNumbersHtml}</div><div class="${style.codeContent}">${result}</div></div>`)
          } else {
            setHtml(result as string)
          }
        })
      }, 50)
    },
  ))

  onCleanup(() => { if (highlightTimer) clearTimeout(highlightTimer) })

  return (
    <div
      class={style.root}
      data-flush={props.flush === true ? true : undefined}
      data-transparent-bg={props.transparentBg === true ? true : undefined}
    >
      <div innerHTML={html()} />
    </div>
  )
}
