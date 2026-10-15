import type { MarkedExtension, RendererObject } from "marked"

export interface MarkdownFrame {
  text: string
  isStreaming: boolean
}

/** Flush during continuous token delivery; completion never waits for the timer. */
export function createMarkdownStreamScheduler(flush: (frame: MarkdownFrame) => void, interval = 50) {
  let pending: MarkdownFrame | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFlush = -Infinity

  const emit = () => {
    timer = undefined
    if (!pending) return
    const frame = pending
    pending = undefined
    lastFlush = Date.now()
    flush(frame)
  }

  return {
    update(frame: MarkdownFrame) {
      pending = frame
      if (!frame.isStreaming || Date.now() - lastFlush >= interval) {
        if (timer !== undefined) clearTimeout(timer)
        emit()
      } else if (timer === undefined) {
        timer = setTimeout(emit, interval - (Date.now() - lastFlush))
      }
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = undefined
    },
  }
}

export function escapeMarkdownHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;")
}

function sanitizeHref(href: string): string {
  const scheme = href.replace(/[\u0000-\u0020\u007f-\u009f]/g, "").toLowerCase()
  return /^(javascript|vbscript|data):/.test(scheme) ? "" : href
}

/** Local references must be read through the workspace-authorized file gateway. */
export function isLocalMarkdownReference(value: string): boolean {
  return !!value && !/^(?:#|\?|\/\/|(?:https?|mailto|tel|sms):)/i.test(value)
    && (/^[a-z]:[\\/]/i.test(value) || /^file:/i.test(value)
      || /^[^:/\\]+:\d+(?::\d+)?$/.test(value)
      || !/^[a-z][a-z\d+.-]*:/i.test(value));
}

/** Raw HTML is user-visible source, never an executable part of a reply. */
export const markdownRenderer: RendererObject = {
  html(html: string) {
    return escapeMarkdownHtml(html)
  },
  link(href: string, title: string | null | undefined, text: string) {
    const titleAttr = title ? ` title="${escapeMarkdownHtml(title)}"` : ""
    const safeHref = sanitizeHref(href)
    if (isLocalMarkdownReference(safeHref)) {
      return `<a href="#" data-local-href="${escapeMarkdownHtml(safeHref)}"${titleAttr}>${text || escapeMarkdownHtml(href)}</a>`
    }
    return `<a href="${escapeMarkdownHtml(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text || escapeMarkdownHtml(href)}</a>`
  },
  image(href: string, title: string | null, text: string) {
    const safeHref = sanitizeHref(href)
    if (!safeHref) return escapeMarkdownHtml(text)
    const titleAttr = title ? ` title="${escapeMarkdownHtml(title)}"` : ""
    const sourceAttribute = isLocalMarkdownReference(safeHref) ? "data-local-src" : "src"
    const path = safeHref.split(/[?#]/)[0]
    const media = /\.(?:mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(path) ? "audio"
      : /\.(?:mp4|webm|mov|m4v)$/i.test(path) ? "video" : undefined
    if (media) {
      return `<${media} controls preload="metadata" ${media === "video" ? 'playsinline style="max-width:100%" ' : ""}${sourceAttribute}="${escapeMarkdownHtml(safeHref)}" aria-label="${escapeMarkdownHtml(text)}" data-markdown-media${titleAttr}>${escapeMarkdownHtml(text)}</${media}>`
    }
    return `<img ${sourceAttribute}="${escapeMarkdownHtml(safeHref)}" alt="${escapeMarkdownHtml(text)}"${titleAttr}>`
  },
}

/** Generated code HTML has a separate token so source HTML always stays escaped. */
export function createMarkdownCodeExtension(highlight: (code: string, language: string) => Promise<string>): MarkedExtension {
  return {
    async: true,
    extensions: [{
      name: "highlightedCode",
      renderer(token) { return token.html },
    }],
    async walkTokens(token) {
      if (token.type !== "code") return
      const language = token.lang?.split(" ")[0] || "text"
      let html: string
      try {
        html = await highlight(token.text, language)
      } catch {
        // Highlighting is optional; a failed block must not hide the whole reply.
        html = `<pre><code class="language-${escapeMarkdownHtml(language)}">${escapeMarkdownHtml(token.text)}\n</code></pre>`
      }
      Object.assign(token, { type: "highlightedCode", html: `${html}\n` })
    },
  }
}

export function getOpenMarkdownFence(text: string): string | undefined {
  let fence: string | undefined
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    if (!fence) fence = match[1]
    else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined
  }
  return fence
}

/** Complete only the displayed tail; the stored assistant text stays untouched. */
export function previewStreamingMarkdown(text: string): string {
  const fence = getOpenMarkdownFence(text)
  if (fence) return `${text}\n${fence}`

  const separator = text.lastIndexOf("\n\n")
  const start = separator < 0 ? 0 : separator + 2
  const tail = previewIncompleteLink(text.slice(start))
  const open: string[] = []
  let code: string | undefined
  for (let index = 0; index < tail.length; index++) {
    const mathEnd = code ? undefined : mathSpanEnd(tail, index)
    if (mathEnd !== undefined) { index = mathEnd; continue }
    if (tail[index] === "\\") { index++; continue }
    const match = /^(`+|\*{1,3}|_{1,3}|~~)/.exec(tail.slice(index))
    if (!match) continue
    const delimiter = match[1]
    const before = tail[index - 1] || ""
    const after = tail[index + delimiter.length] || ""
    index += delimiter.length - 1
    if (delimiter[0] === "`") {
      if (code === delimiter) code = undefined
      else if (!code) code = delimiter
      continue
    }
    if (code || (delimiter[0] === "_" && /\w/.test(before) && /\w/.test(after))) continue
    if (open.at(-1) === delimiter && before && !/\s/.test(before)) open.pop()
    else if (after && !/\s/.test(after)) open.push(delimiter)
  }
  return text.slice(0, start) + tail + (code || "") + open.reverse().join("")
}

function previewIncompleteLink(text: string): string {
  let code: string | undefined
  for (let index = 0; index < text.length; index++) {
    const mathEnd = code ? undefined : mathSpanEnd(text, index)
    if (mathEnd !== undefined) { index = mathEnd; continue }
    if (text[index] === "\\") { index++; continue }
    const ticks = /^`+/.exec(text.slice(index))?.[0]
    if (ticks) {
      if (code === ticks) code = undefined
      else if (!code) code = ticks
      index += ticks.length - 1
      continue
    }
    if (code || text[index] !== "[") continue
    let labelEnd = index + 1
    let depth = 1
    for (; labelEnd < text.length; labelEnd++) {
      if (text[labelEnd] === "\\") { labelEnd++; continue }
      if (text[labelEnd] === "[") depth++
      if (text[labelEnd] === "]" && --depth === 0) break
    }
    if (depth !== 0 || text[labelEnd + 1] !== "(") continue
    depth = 1
    let destinationEnd = labelEnd + 2
    for (; destinationEnd < text.length; destinationEnd++) {
      if (text[destinationEnd] === "\\") { destinationEnd++; continue }
      if (text[destinationEnd] === "(") depth++
      if (text[destinationEnd] === ")" && --depth === 0) break
    }
    if (depth === 0) { index = destinationEnd; continue }
    const label = text.slice(index + 1, labelEnd).replace(/([\\`*_{}\[\]()!<>])/g, "\\$1")
    let escapes = 0
    for (let previous = index - 2; previous >= 0 && text[previous] === "\\"; previous--) escapes++
    const linkStart = text[index - 1] === "!" && escapes % 2 === 0 ? index - 1 : index
    return text.slice(0, linkStart) + label
  }
  return text
}

function mathSpanEnd(text: string, start: number): number | undefined {
  const opening = /^(\$\$?|\\\(|\\\[)/.exec(text.slice(start))?.[0]
  if (!opening) return undefined
  const closing = opening === "\\(" ? "\\)" : opening === "\\[" ? "\\]" : opening
  let end = text.indexOf(closing, start + opening.length)
  while (end >= 0) {
    let escapes = 0
    for (let previous = end - 1; previous >= 0 && text[previous] === "\\"; previous--) escapes++
    if (escapes % 2 === 0) return end + closing.length - 1
    end = text.indexOf(closing, end + closing.length)
  }
  return text.length - 1
}

interface MarkdownBlock<T> {
  html: string
  node: T
}

/** Retain completed blocks (and their selection/copy state) while the tail grows. */
export function reconcileMarkdownBlocks<T>(previous: MarkdownBlock<T>[], next: MarkdownBlock<T>[]): MarkdownBlock<T>[] {
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix].html === next[prefix].html) prefix++
  return [...previous.slice(0, prefix), ...next.slice(prefix)]
}
