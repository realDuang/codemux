import { parsePatch } from "diff"
import { createMemo, createResource, For, Show } from "solid-js"
import { CopyButton } from "./CopyButton"
import styles from "./content-diff.module.css"
import { logger } from "../../lib/logger"
import { getHighlighter, resolveLang } from "../../lib/shiki-highlighter"

type UnifiedLine = {
  content: string
  type: "added" | "removed" | "unchanged"
  oldLineNo?: number
  newLineNo?: number
}

interface Props {
  diff: string
  /** File language for Shiki syntax highlighting (e.g. "ts", "py"). */
  language?: string
}

/**
 * Highlight all lines using Shiki with dual themes, returning an array of HTML
 * strings aligned with the input lines array.
 */
async function highlightLines(
  lines: UnifiedLine[],
  lang: string | undefined,
): Promise<string[]> {
  if (!lang) return lines.map(() => "")

  try {
    const highlighter = await getHighlighter()
    const resolvedLang = resolveLang(lang)

    // Build a single string for batch tokenization, then split by line
    const code = lines.map((l) => l.content).join("\n")
    const tokenLines = highlighter.codeToTokensWithThemes(code, {
      lang: resolvedLang,
      themes: { light: "github-light", dark: "one-dark-pro" },
    })

    // Map each token line to an HTML string with CSS vars for light/dark
    return tokenLines.map((tokenLine) =>
      tokenLine
        .map((token) => {
          const lightColor = token.variants?.light?.color ?? ""
          const darkColor = token.variants?.dark?.color ?? lightColor
          if (!lightColor && !darkColor) return escapeHtml(token.content)
          return `<span style="--sl:${lightColor};--sd:${darkColor}">${escapeHtml(token.content)}</span>`
        })
        .join(""),
    )
  } catch (err) {
    logger.warn("Shiki highlighting failed for diff:", err)
    return lines.map(() => "")
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function ContentDiff(props: Props) {
  const lines = createMemo(() => {
    const unifiedLines: UnifiedLine[] = []

    try {
      const patches = parsePatch(props.diff)

      for (const patch of patches) {
        for (const hunk of patch.hunks) {
          let oldLineNo = hunk.oldStart
          let newLineNo = hunk.newStart

          for (const line of hunk.lines) {
            const content = line.slice(1)
            const prefix = line[0]

            if (prefix === "-") {
              unifiedLines.push({
                content,
                type: "removed",
                oldLineNo: oldLineNo++,
                newLineNo: undefined,
              })
            } else if (prefix === "+") {
              unifiedLines.push({
                content,
                type: "added",
                oldLineNo: undefined,
                newLineNo: newLineNo++,
              })
            } else if (prefix === " ") {
              unifiedLines.push({
                content: content === "" ? " " : content,
                type: "unchanged",
                oldLineNo: oldLineNo++,
                newLineNo: newLineNo++,
              })
            }
          }
        }
      }
    } catch (error) {
      logger.error("Failed to parse patch:", error)
      return []
    }

    return unifiedLines
  })

  // Async Shiki highlighting — resolves after highlighter loads
  const [highlighted] = createResource(
    () => ({ lines: lines(), lang: props.language }),
    ({ lines: ls, lang }) => highlightLines(ls, lang),
  )

  return (
    <div class={styles.root}>
      <CopyButton text={() => props.diff || ""} />
      <For each={lines()}>
        {(line, idx) => {
          const html = () => highlighted()?.[idx()]
          return (
            <div class={styles.line} data-type={line.type}>
              <span class={styles.lineNo} data-slot="old">
                {line.oldLineNo ?? ""}
              </span>
              <span class={styles.lineNo} data-slot="new">
                {line.newLineNo ?? ""}
              </span>
              <span class={styles.prefix}>
                {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
              </span>
              <span class={styles.content}>
                <Show when={html()} fallback={<code>{line.content}</code>}>
                  <code innerHTML={html()} />
                </Show>
              </span>
            </div>
          )
        }}
      </For>
    </div>
  )
}
