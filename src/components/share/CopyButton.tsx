import { createSignal, Show, onCleanup } from "solid-js"
import { copyTextToClipboard } from "../../lib/clipboard"
import { useI18n } from "../../lib/i18n"
import "./copy-button.css"

const ICON_COPY = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const ICON_CHECK = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`

interface CopyButtonProps {
  text: string | (() => string)
}

export function CopyButton(props: CopyButtonProps) {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<"copied" | "failed">()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const label = () => status() === "copied" ? t().common.copied
    : status() === "failed" ? t().markdown.copyFailed : t().markdown.copyCode

  onCleanup(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })

  const handleCopy = async (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const text = typeof props.text === "function" ? props.text() : props.text
    const success = await copyTextToClipboard(text)
    if (disposed) return
    setStatus(success ? "copied" : "failed")
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => setStatus(undefined), 2000)
  }

  return (
    <button
      type="button"
      data-component="copy-button"
      data-markdown-decoration=""
      data-copied={status() === "copied" ? "" : undefined}
      aria-label={label()}
      title={label()}
      onClick={handleCopy}
    >
      <Show when={status() === "copied"} fallback={<span innerHTML={ICON_COPY} />}>
        <span innerHTML={ICON_CHECK} />
      </Show>
      <span data-copy-announcement="" role="status">{status() ? label() : ""}</span>
    </button>
  )
}
