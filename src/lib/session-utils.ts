const DEFAULT_TITLE_PATTERN = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TRAILING_ELLIPSIS_PATTERN = /(?:\s*(?:…|\.\.\.))+$/;

function stripTrailingEllipsis(value: string): string {
  return value.trim().replace(TRAILING_ELLIPSIS_PATTERN, "").trim();
}

export function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_PATTERN.test(title);
}

export function isPromptFallbackTitle(title: string, firstPrompt?: string): boolean {
  const normalizedTitle = title.trim();
  const normalizedPrompt = firstPrompt?.trim();
  if (!normalizedTitle || !normalizedPrompt) return false;
  if (normalizedTitle === normalizedPrompt) return true;

  const titleBase = stripTrailingEllipsis(normalizedTitle);
  const promptBase = stripTrailingEllipsis(normalizedPrompt);
  if (!titleBase || !promptBase) return false;

  const titleHadEllipsis = titleBase !== normalizedTitle;
  const promptHadEllipsis = promptBase !== normalizedPrompt;
  if (!titleHadEllipsis && !promptHadEllipsis) return false;
  if (titleBase === promptBase) return true;
  if (titleHadEllipsis && promptBase.startsWith(titleBase)) return true;
  return promptHadEllipsis && titleBase.startsWith(promptBase);
}
