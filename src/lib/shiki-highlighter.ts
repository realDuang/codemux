/**
 * Shared Shiki highlighter singleton with language whitelist.
 *
 * Only high-frequency languages are bundled to reduce the renderer JS size
 * (~4.89 MB → ~1.2 MB). Unsupported languages fall back to "plaintext".
 */

import type { HighlighterGeneric } from "shiki";

/** Core languages that cover 95%+ of typical AI coding assistant output. */
const CORE_LANGUAGES = [
  "bash", "shellscript", "console", "shell",
  "typescript", "tsx", "javascript", "jsx",
  "python", "json", "yaml", "toml",
  "markdown", "html", "css", "scss",
  "sql", "graphql",
  "go", "rust", "java", "c", "cpp", "csharp",
  "ruby", "php", "swift", "kotlin",
  "dockerfile", "xml", "ini", "diff",
  "powershell", "bat",
  "plaintext", "text",
] as const;

const CORE_LANGUAGE_SET = new Set<string>(CORE_LANGUAGES);

/** Check whether a language is in the bundled whitelist. */
export function isSupportedLang(lang: string): boolean {
  return CORE_LANGUAGE_SET.has(lang);
}

/** Resolve a language id — returns the id if supported, "plaintext" otherwise. */
export function resolveLang(lang: string | undefined): string {
  if (!lang) return "plaintext";
  return isSupportedLang(lang) ? lang : "plaintext";
}

let instance: HighlighterGeneric<any, any> | null = null;
let initPromise: Promise<HighlighterGeneric<any, any>> | null = null;

/**
 * Get or create the shared Shiki highlighter instance.
 * Uses createHighlighter with the whitelisted languages and dual themes.
 */
export async function getHighlighter(): Promise<HighlighterGeneric<any, any>> {
  if (instance) return instance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { createHighlighter } = await import("shiki");
      const highlighter = await createHighlighter({
        themes: ["github-light", "one-dark-pro"],
        langs: [...CORE_LANGUAGES],
      });
      instance = highlighter;
      return highlighter;
    } catch (err) {
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Highlight code using the shared singleton.
 * Resolves language against the whitelist (unsupported → plaintext).
 */
export async function highlightCode(
  code: string,
  lang: string | undefined,
  options?: {
    transformers?: any[];
    transparentBg?: boolean;
  },
): Promise<string> {
  const highlighter = await getHighlighter();
  const resolvedLang = resolveLang(lang);

  let html = highlighter.codeToHtml(code, {
    lang: resolvedLang,
    themes: {
      light: "github-light",
      dark: "one-dark-pro",
    },
    transformers: options?.transformers,
  });

  if (options?.transparentBg) {
    html = html.replace(/style="background-color:[^"]*"/, 'style="background-color:transparent"');
  }

  return html;
}
