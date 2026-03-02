import style from "./content-bash.module.css"
import { createSignal, createEffect, on, onCleanup } from "solid-js"
import { createOverflow } from "./common"
import { enqueueHighlight } from "./highlight-queue"
import { codeToHtml } from "shiki"

interface Props {
  command: string
  output: string
  description?: string
  expand?: boolean
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function ContentBash(props: Props) {
  const [commandHtml, setCommandHtml] = createSignal("")
  const [outputHtml, setOutputHtml] = createSignal("")
  let cmdTimer: ReturnType<typeof setTimeout> | null = null
  let outTimer: ReturnType<typeof setTimeout> | null = null

  // Two-phase command rendering
  createEffect(on(
    () => props.command,
    (command) => {
      const cmd = command || ""
      // Phase 1: plain text
      setCommandHtml(`<pre class="shiki" style="margin:0"><code>${escapeHtml(cmd)}</code></pre>`)
      // Phase 2: shiki highlight
      if (cmdTimer) clearTimeout(cmdTimer)
      cmdTimer = setTimeout(() => {
        cmdTimer = null
        enqueueHighlight(() => codeToHtml(cmd, {
          lang: "bash",
          themes: { light: "github-light", dark: "one-dark-pro" },
        })).then((result) => {
          if (props.command === command) setCommandHtml(result as string)
        })
      }, 50)
    },
  ))

  // Two-phase output rendering
  createEffect(on(
    () => props.output,
    (output) => {
      const out = output || ""
      // Phase 1: plain text
      setOutputHtml(`<pre class="shiki" style="margin:0"><code>${escapeHtml(out)}</code></pre>`)
      // Phase 2: shiki highlight
      if (outTimer) clearTimeout(outTimer)
      outTimer = setTimeout(() => {
        outTimer = null
        enqueueHighlight(() => codeToHtml(out, {
          lang: "console",
          themes: { light: "github-light", dark: "one-dark-pro" },
        })).then((result) => {
          if (props.output === output) setOutputHtml(result as string)
        })
      }, 50)
    },
  ))

  onCleanup(() => {
    if (cmdTimer) clearTimeout(cmdTimer)
    if (outTimer) clearTimeout(outTimer)
  })

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
      </div>

      {!props.expand && overflow.status && (
        <button
          type="button"
          data-component="text-button"
          data-slot="expand-button"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded() ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}
