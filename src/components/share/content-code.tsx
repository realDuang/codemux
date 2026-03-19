import { createResource, Suspense } from "solid-js"
import { CopyButton } from "./CopyButton"
import style from "./content-code.module.css"
import { getHighlight, setHighlight, hasHighlight } from "../../lib/highlight-cache"
import { highlightCode, resolveLang } from "../../lib/shiki-highlighter"

async function highlight(code: string, lang?: string, transparentBg?: boolean) {
  const resolved = resolveLang(lang)
  const cacheKey = `${resolved}:${transparentBg ? "t" : "f"}:${code}`
  if (hasHighlight(cacheKey)) {
    return getHighlight(cacheKey)!
  }

  const { transformerNotationDiff } = await import("@shikijs/transformers")
  const result = await highlightCode(code, resolved, {
    transformers: [transformerNotationDiff()],
    transparentBg,
  })

  setHighlight(cacheKey, result)
  return result
}

interface Props {
  code: string
  lang?: string
  flush?: boolean
  showLineNumbers?: boolean
  transparentBg?: boolean
}

export function ContentCode(props: Props) {
  const [html] = createResource(
    () => ({ code: props.code, lang: props.lang, showLineNumbers: props.showLineNumbers, transparentBg: props.transparentBg }),
    async ({ code, lang, showLineNumbers, transparentBg }) => {
      const codeStr = code || ""
      const result = await highlight(codeStr, lang, transparentBg)

      // If showLineNumbers is not explicitly set, we don't add line numbers for single lines
      const lines = codeStr.split("\n")
      const shouldShowLineNumbers = showLineNumbers ?? (lines.length > 1)

      if (!shouldShowLineNumbers) {
        return result
      }

      // Wrap the result with line numbers
      const lineNumbersHtml = lines
        .map((_: string, i: number) => `<span class="${style.lineNumber}">${i + 1}</span>`)
        .join("")

      return `<div class="${style.withLineNumbers}"><div class="${style.lineNumbers}">${lineNumbersHtml}</div><div class="${style.codeContent}">${result}</div></div>`
    },
  )

  return (
    <Suspense>
      <div
        class={style.root}
        data-flush={props.flush === true ? true : undefined}
        data-transparent-bg={props.transparentBg === true ? true : undefined}
      >
        <div innerHTML={html()} />
        <CopyButton text={() => props.code || ""} />
      </div>
    </Suspense>
  )
}
