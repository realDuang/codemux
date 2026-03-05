import { createResource, Suspense } from "solid-js"
import style from "./content-code.module.css"

const highlightCache = new Map<string, string>()

async function highlight(code: string, lang?: string) {
  const cacheKey = `${lang || "text"}:${code}`
  if (highlightCache.has(cacheKey)) {
    return highlightCache.get(cacheKey)!
  }

  const [{ codeToHtml, bundledLanguages }, { transformerNotationDiff }] = await Promise.all([
    import("shiki"),
    import("@shikijs/transformers"),
  ])

  const result = await codeToHtml(code, {
    lang: lang && lang in bundledLanguages ? lang : "text",
    themes: {
      light: "github-light",
      dark: "one-dark-pro",
    },
    transformers: [transformerNotationDiff()],
  })

  highlightCache.set(cacheKey, result)
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
    async ({ code, lang, showLineNumbers }) => {
      const codeStr = code || ""
      const result = await highlight(codeStr, lang)

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
        innerHTML={html()}
        class={style.root}
        data-flush={props.flush === true ? true : undefined}
        data-transparent-bg={props.transparentBg === true ? true : undefined}
      />
    </Suspense>
  )
}
