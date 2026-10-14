export function publicAssetUrl(name: string): string {
  if (import.meta.env.DEV) return `/assets/${name}`;

  // Production chunks and public assets share out/web/assets in both clients.
  return new URL(name, import.meta.url).href;
}
