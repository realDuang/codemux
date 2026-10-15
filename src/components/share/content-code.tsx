import { createMemo, createResource } from "solid-js"
import type { ShikiTransformer } from "shiki"
import { CopyButton } from "./CopyButton"
import style from "./content-code.module.css"
import { getHighlight, setHighlight, hasHighlight } from "../../lib/highlight-cache"
import { highlightCode, resolveLang } from "../../lib/shiki-highlighter"

async function highlight(code: string, lang?: string, transparentBg?: boolean) {
  const resolved = resolveLang(lang)
  const cacheKey = `numbered-lines:${resolved}:${transparentBg ? "t" : "f"}:${code}`
  if (hasHighlight(cacheKey)) {
    return getHighlight(cacheKey)!
  }

  const { transformerNotationDiff } = await import("@shikijs/transformers")
  const lineNumbers: ShikiTransformer = {
    line(node, line) {
      node.properties["data-line"] = line
    },
  }
  const result = await highlightCode(code, resolved, {
    transformers: [transformerNotationDiff(), lineNumbers],
    transparentBg,
  })

  setHighlight(cacheKey, result)
  return result
}

function plainCode(code: string): string {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const lines = escaped.split("\n").map((line, index) => `<span class="line" data-line="${index + 1}">${line}</span>`)
  return `<pre><code>${lines.join("\n")}</code></pre>`
}

interface Props {
  code: string
  lang?: string
  flush?: boolean
  showLineNumbers?: boolean
  transparentBg?: boolean
}

export function ContentCode(props: Props) {
  const source = createMemo(() => props.code || "")
  const lineCount = createMemo(() => source().split("\n").length)
  const fallback = createMemo(() => plainCode(source()))
  const [html] = createResource(
    () => ({ code: source(), lang: props.lang, transparentBg: props.transparentBg }),
    async ({ code, lang, transparentBg }) => {
      try {
        return { code, lang, transparentBg, html: await highlight(code, lang, transparentBg) }
      } catch {
        // Readable source and line navigation remain available when highlighting fails.
        return { code, lang, transparentBg, html: plainCode(code) }
      }
    },
  )
  const content = createMemo(() => {
    const latest = html.latest
    return latest?.code === source() && latest.lang === props.lang && latest.transparentBg === props.transparentBg
      ? latest.html : fallback()
  })

  return (
    <div
      class={style.root}
      data-flush={props.flush === true ? true : undefined}
      data-transparent-bg={props.transparentBg === true ? true : undefined}
      data-line-numbers={(props.showLineNumbers ?? lineCount() > 1) ? "" : undefined}
      style={{ "--line-number-width": `${Math.max(2, String(lineCount()).length)}ch` }}
    >
      <div innerHTML={content()} />
      <CopyButton text={source} />
    </div>
  )
}
