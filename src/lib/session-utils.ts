const DEFAULT_TITLE_PATTERN = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_PATTERN.test(title);
}
