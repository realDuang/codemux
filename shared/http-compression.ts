import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const MIN_COMPRESSION_BYTES = 1024;
const COMPRESSIBLE_TYPES = /^(?:text\/|application\/(?:javascript|json|manifest\+json|wasm)$|image\/svg\+xml$)/;

interface StaticContent {
  body: Buffer;
  encoding?: "br" | "gzip";
  vary: boolean;
  acceptable: boolean;
}

function encodingQualities(header: string | undefined): Map<string, number> {
  const qualities = new Map<string, number>();
  for (const entry of header?.split(",") ?? []) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
    const name = coding.trim();
    if (!name) continue;
    const qualityParameter = parameters.find(parameter => /^\s*q\s*=/.test(parameter));
    const match = qualityParameter?.trim().match(/^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/);
    qualities.set(name, qualityParameter === undefined ? 1 : match ? Number(match[1]) : 0);
  }
  return qualities;
}

/** Encode only public static content; API and streaming responses bypass this helper. */
export async function encodeStaticContent(
  body: Buffer,
  contentType: string,
  acceptEncoding: string | undefined,
): Promise<StaticContent> {
  const vary = COMPRESSIBLE_TYPES.test(contentType.split(";")[0]);
  const qualities = encodingQualities(acceptEncoding);
  const wildcard = qualities.get("*") ?? 0;
  const identity = qualities.get("identity") ?? (wildcard === 0 && qualities.has("*") ? 0 : 1);
  const brotli = vary ? qualities.get("br") ?? wildcard : 0;
  const gzipQuality = vary ? qualities.get("gzip") ?? wildcard : 0;
  const quality = Math.max(brotli, gzipQuality);

  if (quality === 0) return { body, vary, acceptable: identity > 0 };
  if (identity > 0 && (body.length < MIN_COMPRESSION_BYTES ||
    (qualities.has("identity") && identity > quality))) {
    return { body, vary, acceptable: true };
  }

  const encoding = brotli >= gzipQuality ? "br" : "gzip";
  // Brotli's default quality 11 adds noticeable cold-request latency.
  const compressed = encoding === "br"
    ? await compressBrotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : await compressGzip(body);
  if (compressed.length >= body.length && identity > 0) {
    return { body, vary, acceptable: true };
  }
  return { body: compressed, encoding, vary, acceptable: true };
}
