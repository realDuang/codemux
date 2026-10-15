import type { TextCitation, TextPart } from "../../../../src/types/unified";

const MEMORY_CITATION_TAG = "<oai-mem-citation>";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeCitation(entry: unknown): TextCitation | undefined {
  const record = asRecord(entry);
  if (!record || typeof record.note !== "string" || !record.note.trim()) return undefined;
  const path = typeof record.path === "string" ? record.path : undefined;
  const start = Number.isInteger(record.lineStart) ? record.lineStart : undefined;
  const end = Number.isInteger(record.lineEnd) ? record.lineEnd : undefined;
  const reference = path ? `${path}${start === undefined ? "" : `:${start}${end === undefined ? "" : `-${end}`}`}` : undefined;
  return { note: record.note.trim(), ...(reference ? { reference } : {}) };
}

/** Find metadata only at a line boundary outside literal fenced code. */
function findMetadataStart(text: string): number | undefined {
  let offset = 0;
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split(/(?<=\n)/)) {
    const content = line.trimStart();
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (!fence && !/^(?: {4}|\t)/.test(line)) {
      if (content.startsWith(MEMORY_CITATION_TAG)) {
        const start = offset + line.length - content.length;
        const closing = text.indexOf("</oai-mem-citation>", start);
        if (closing === -1 || !text.slice(closing + "</oai-mem-citation>".length).trim()) return start;
      }
      const tail = content.trimEnd();
      if (tail !== MEMORY_CITATION_TAG && tail.startsWith("<oai-mem-") && MEMORY_CITATION_TAG.startsWith(tail) &&
          !text.slice(offset + line.length).trim()) {
        return offset + line.length - content.length;
      }
    }
    offset += line.length;
  }
  return undefined;
}

function parseTrailingCitations(metadata: string): TextCitation[] {
  const entries = metadata.match(/<citation_entries>\s*([\s\S]*?)\s*<\/citation_entries>/)?.[1];
  if (!entries) return [];
  return entries.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(.+):(\d+)-(\d+)\|note=\[([\s\S]*)\]$/);
    if (!match) return [];
    const citation = normalizeCitation({
      path: match[1], lineStart: Number(match[2]), lineEnd: Number(match[3]), note: match[4],
    });
    return citation ? [citation] : [];
  });
}

/** Retain wire text for deltas while separating the metadata used by the footer. */
export function normalizeCodexResponseContent(
  text: string,
  memoryCitation?: unknown,
  questions?: unknown,
): Pick<TextPart, "text" | "displayText" | "citations"> {
  const metadataStart = findMetadataStart(text);
  const record = asRecord(memoryCitation);
  const entries = Array.isArray(record?.entries) ? record.entries : [];
  const structured = entries.flatMap((entry) => {
    const citation = normalizeCitation(entry);
    return citation ? [citation] : [];
  });
  const citations = structured.length > 0
    ? structured
    : metadataStart === undefined ? [] : parseTrailingCitations(text.slice(metadataStart));
  const unique = citations.filter((entry, index) => citations.findIndex((other) =>
    other.reference === entry.reference && other.note === entry.note) === index);
  const questionText = (Array.isArray(questions) ? questions : []).flatMap((entry) => {
    const question = asRecord(entry);
    if (typeof question?.title !== "string" || !question.title.trim()) return [];
    const escape = (value: string) => value.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
    const options = Array.isArray(question.options)
      ? question.options.filter((option): option is string => typeof option === "string").map((option) => `- ${escape(option)}`)
      : [];
    return [[escape(question.title), options.join("\n")].filter(Boolean).join("\n\n")];
  }).join("\n\n");
  const visibleText = metadataStart === undefined ? text : text.slice(0, metadataStart).trimEnd();
  return {
    text,
    displayText: questionText ? [visibleText, questionText].filter(Boolean).join("\n\n")
      : metadataStart === undefined ? undefined : visibleText,
    citations: unique.length === 0 ? undefined : unique,
  };
}
