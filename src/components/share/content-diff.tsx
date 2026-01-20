import { parsePatch } from "diff"
import { createMemo, For } from "solid-js"
import { ContentCode } from "./content-code"
import styles from "./content-diff.module.css"
import { logger } from "../../lib/logger"

type UnifiedLine = {
  content: string
  type: "added" | "removed" | "unchanged"
  oldLineNo?: number
  newLineNo?: number
}

interface Props {
  diff: string
  lang?: string
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

  return (
    <div class={styles.root}>
      <For each={lines()}>
        {(line) => (
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
              <ContentCode code={line.content} lang={props.lang} flush transparentBg />
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
