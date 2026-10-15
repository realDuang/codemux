import { afterEach, describe, expect, it, vi } from "vitest"
import { Marked } from "marked"
import {
  createMarkdownStreamScheduler,
  createMarkdownCodeExtension,
  getOpenMarkdownFence,
  markdownRenderer,
  previewStreamingMarkdown,
  reconcileMarkdownBlocks,
} from "../../../../src/lib/markdown-stream"

const markdown = new Marked({ renderer: markdownRenderer })

describe("createMarkdownStreamScheduler", () => {
  afterEach(() => vi.useRealTimers())

  it("keeps a continuously arriving response visible at 50 ms intervals", () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const visible: { time: number; text: string }[] = []
    const stream = createMarkdownStreamScheduler(frame => visible.push({ time: Date.now(), text: frame.text }))
    for (let index = 0; index < 60; index++) {
      stream.update({ text: "x".repeat(index + 1), isStreaming: true })
      vi.advanceTimersByTime(5)
    }
    expect(visible.map(frame => frame.time)).toEqual([0, 50, 100, 150, 200, 250, 300])
    expect(visible[3].text).toHaveLength(30)
    expect(visible.at(-1)?.text).toHaveLength(60)
    stream.dispose()
  })

  it("flushes the final unmodified frame immediately and cancels an older pending preview", () => {
    vi.useFakeTimers()
    const visible = vi.fn()
    const stream = createMarkdownStreamScheduler(visible)
    stream.update({ text: "**Par", isStreaming: true })
    vi.advanceTimersByTime(10)
    stream.update({ text: "**Partial", isStreaming: true })
    stream.update({ text: "**Partial", isStreaming: false })
    expect(visible).toHaveBeenLastCalledWith({ text: "**Partial", isStreaming: false })
    expect(visible).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(100)
    expect(visible).toHaveBeenCalledTimes(2)
    stream.dispose()
  })

  it("discards pending rendering when the message leaves the screen", () => {
    vi.useFakeTimers()
    const visible = vi.fn()
    const stream = createMarkdownStreamScheduler(visible)
    stream.update({ text: "first", isStreaming: true })
    stream.update({ text: "second", isStreaming: true })
    stream.dispose()
    vi.advanceTimersByTime(100)
    expect(visible).toHaveBeenCalledTimes(1)
  })
})

describe("previewStreamingMarkdown", () => {
  it.each([
    ["**Still writing", "<strong>Still writing</strong>"],
    ["A *partial emphasis", "<em>partial emphasis</em>"],
    ["The `unfinished_call()", "<code>unfinished_call()</code>"],
    ["**Text with `code", "<strong>Text with <code>code</code></strong>"],
    ["~~Removed text", "<del>Removed text</del>"],
  ])("renders incomplete syntax in %s without modifying the final source", (source, fragment) => {
    expect(markdown.parse(previewStreamingMarkdown(source))).toContain(fragment)
    expect(markdown.parse(source)).not.toContain(fragment)
  })

  it("keeps code punctuation literal inside an unfinished fence", () => {
    const source = "A result.\n\n```ts\nconst value = '**not bold';"
    const html = markdown.parse(previewStreamingMarkdown(source)) as string
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain("**not bold")
    expect(html).not.toContain("<strong>")
  })

  it.each([
    ["Read [the docs](https://exa", "<p>Read the docs</p>"],
    ["Look at ![chart](https://image.exa", "<p>Look at chart</p>"],
    ["Read [**literal** label](https://example.com/path(", "<p>Read **literal** label</p>"],
    [String.raw`An escaped \![label](unfinished`, "<p>An escaped !label</p>"],
  ])("shows the label without activating an unfinished link or image: %s", (source, fragment) => {
    const html = markdown.parse(previewStreamingMarkdown(source)) as string
    expect(html).toContain(fragment)
    expect(html).not.toMatch(/<(?:a|img)\b/)
    expect(html).not.toContain("https://")
  })

  it.each([
    "An **already complete** sentence.",
    "An escaped \\*literal marker.",
    "A snake_case_identifier remains plain.",
    "```ts\nconst stars = '**';\n```",
    "Earlier *literal paragraph\n\nCurrent paragraph.",
    "A complete [link](https://example.com/path(nested)) remains linked.",
    "A literal `[label](unfinished` code span.",
    String.raw`An escaped \[label](unfinished remains literal.`,
    "A formula $x^*+y$ remains unmodified.",
    String.raw`A formula \(f([x](unfinished)\) remains unmodified.`,
    "An unfinished formula $x^*+y remains source.",
  ])("leaves complete syntax and earlier blocks unchanged: %s", source => {
    expect(previewStreamingMarkdown(source)).toBe(source)
  })
})

describe("reconcileMarkdownBlocks", () => {
  const blocks = (sources: string[]) => sources.map(source => ({
    html: markdown.parse(source) as string,
    node: { selected: false, copied: false },
  }))

  it("retains completed paragraphs and code interaction state while only the tail grows", () => {
    const previous = blocks(["Completed paragraph.", "```ts\nconst count = 1\n```", "Ongoing"])
    previous[0].node.selected = true
    previous[1].node.copied = true
    const next = blocks(["Completed paragraph.", "```ts\nconst count = 1\n```", "Ongoing answer."])
    const reconciled = reconcileMarkdownBlocks(previous, next)
    expect(reconciled[0].node).toBe(previous[0].node)
    expect(reconciled[1].node).toBe(previous[1].node)
    expect(reconciled[0].node.selected).toBe(true)
    expect(reconciled[1].node.copied).toBe(true)
    expect(reconciled[2].node).toBe(next[2].node)
  })

  it("replaces an earlier block when later markdown changes its interpretation", () => {
    const previous = blocks(["[Reference][guide]"])
    const next = blocks(["[Reference][guide]\n\n[guide]: https://example.com"])
    expect(next[0].html).toContain('href="https://example.com"')
    expect(reconcileMarkdownBlocks(previous, next)[0].node).toBe(next[0].node)
    expect(reconcileMarkdownBlocks(next, [])).toEqual([])
  })
})

describe("markdownRenderer", () => {
  it("displays literal HTML wrappers, event handlers and scripts without executing them", () => {
    const html = markdown.parse('<div><img src=x onerror="alert(1)"><script>alert(2)</script></div>') as string
    expect(html).toContain("&lt;div&gt;")
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;")
    expect(html).toContain("onerror=&quot;alert(1)&quot;")
    expect(html).not.toMatch(/<(?:div|img|script)\b/)
  })

  it("preserves normal Markdown links and validates unsafe link and image schemes", () => {
    const safe = markdown.parse('[docs](https://example.com "Docs")') as string
    expect(safe).toContain('href="https://example.com" title="Docs"')
    expect(safe).toContain('rel="noopener noreferrer"')
    const unsafe = markdown.parse("[bad](javascript:alert) ![image](data:text/html,payload)") as string
    expect(unsafe).toContain('<a href=""')
    expect(unsafe).not.toContain("javascript:")
    expect(unsafe).not.toContain("<img")
    expect(markdown.parse("[bad](<java\tscript:alert>)")).toContain('href=""')
  })
})

describe("createMarkdownCodeExtension", () => {
  it("renders generated code HTML while leaving identically-shaped source HTML escaped", async () => {
    const renderer = new Marked({ renderer: markdownRenderer }, createMarkdownCodeExtension(async code => `<pre><code>${code}</code></pre>`))
    const html = await renderer.parse("```text\nconst count = 1\n```\n\n<pre><script>alert(1)</script></pre>")
    expect(html).toContain("<pre><code>const count = 1</code></pre>")
    expect(html).toContain("&lt;pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/pre&gt;")
    expect(html).not.toContain("<script>")
  })

  it("retains surrounding paragraphs and other code when one highlighter fails", async () => {
    const renderer = new Marked({ renderer: markdownRenderer }, createMarkdownCodeExtension(async (code, language) => {
      if (language === "broken") throw new Error("Highlight failed")
      return `<pre data-highlighted="true"><code>${code}</code></pre>`
    }))
    const html = await renderer.parse([
      "Before the code.",
      '```broken\n<img src=x onerror="alert(1)">\n```',
      "After the code.",
      "```text\nStill highlighted\n```",
    ].join("\n\n"))
    expect(html).toContain("<p>Before the code.</p>")
    expect(html).toContain("<p>After the code.</p>")
    expect(html).toContain('<pre><code class="language-broken">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;\n</code></pre>')
    expect(html).toContain('<pre data-highlighted="true"><code>Still highlighted</code></pre>')
    expect(html).not.toContain("<img")
  })
})


describe("Markdown media", () => {
  it.each([["sound.wav", "audio"], ["clip.mp4", "video"]])("uses native controls for %s without an unauthenticated local request", (path, tag) => {
    const html = markdown.parse(`![Preview](/workspace/${path})`) as string;
    expect(html).toContain(`<${tag} controls preload="metadata"`);
    expect(html).toContain(`data-local-src="/workspace/${path}"`);
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain("<img");
  });
});


describe("code item boundaries", () => {
  it("distinguishes an unfinished fence from a previously completed block", () => {
    expect(getOpenMarkdownFence("```js\nconst done = true;\n```\n\n```ts\nconst pending =")).toBe("```");
    expect(getOpenMarkdownFence("```js\nconst done = true;\n```\n\nText")).toBeUndefined();
    expect(getOpenMarkdownFence("~~~text\n```\n")).toBe("~~~");
  });
});
