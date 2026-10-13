/** Normalize a browser entry point without accepting credentials or subpaths. */
export function normalizeAccessUrl(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) {
    throw new Error("Enter an HTTP or HTTPS origin.");
  }

  const url = new URL(value);
  if (
    !url.hostname || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("The access URL cannot contain credentials, a path, a query, or a fragment.");
  }
  return url.origin;
}
