import { createSignal, Show, onCleanup } from "solid-js"
import { logger } from "../../lib/logger"
import "./copy-button.css"

const ICON_COPY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`

const ICON_CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`

interface CopyButtonProps {
  text: string | (() => string)
}

export function CopyButton(props: CopyButtonProps) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  const handleCopy = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const text = typeof props.text === "function" ? props.text() : props.text
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => setCopied(false), 2000)
      })
      .catch(err => logger.error("Copy failed", err))
  }

  return (
    <button
      type="button"
      data-component="copy-button"
      data-copied={copied() ? "" : undefined}
      aria-label={copied() ? "Copied" : "Copy to clipboard"}
      title={copied() ? "Copied" : "Copy to clipboard"}
      onClick={handleCopy}
    >
      <Show when={copied()} fallback={<span innerHTML={ICON_COPY} />}>
        <span innerHTML={ICON_CHECK} />
      </Show>
    </button>
  )
}

/**
 * Attach copy buttons to all <pre> elements inside a container.
 * Used for innerHTML-rendered content (e.g., markdown code blocks).
 */
export function attachCopyButtons(container: HTMLElement) {
  const pres = container.querySelectorAll("pre")
  pres.forEach(pre => {
    if (pre.querySelector("[data-component='copy-button']")) return
    pre.style.position = "relative"

    const btn = document.createElement("button")
    btn.type = "button"
    btn.setAttribute("data-component", "copy-button")
    btn.setAttribute("aria-label", "Copy to clipboard")
    btn.title = "Copy to clipboard"
    btn.innerHTML = ICON_COPY

    btn.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      navigator.clipboard.writeText(pre.textContent || "").then(() => {
        btn.innerHTML = ICON_CHECK
        btn.setAttribute("data-copied", "")
        setTimeout(() => {
          btn.innerHTML = ICON_COPY
          btn.removeAttribute("data-copied")
        }, 2000)
      }).catch(err => logger.error("Copy failed", err))
    })

    pre.appendChild(btn)
  })
}
