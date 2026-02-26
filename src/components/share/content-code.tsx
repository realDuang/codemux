import { codeToHtml, bundledLanguages } from "shiki"
import { createResource, Suspense } from "solid-js"
import { transformerNotationDiff } from "@shikijs/transformers"
import style from "./content-code.module.css"

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
      const result = await codeToHtml(codeStr, {
        lang: lang && lang in bundledLanguages ? lang : "text",
        themes: {
          light: "github-light",
          dark: "one-dark-pro",
        },
        transformers: [transformerNotationDiff()],
      })

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
