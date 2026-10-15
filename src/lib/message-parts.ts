import type { TextPart, UnifiedMessage, UnifiedPart } from "../types/unified";

export interface TurnPart {
  message: UnifiedMessage;
  part: UnifiedPart;
  index: number;
}

export interface TurnPartSegment {
  kind: "activity" | "response";
  items: TurnPart[];
}

export type CompactTurnSegment =
  | { kind: "message" | "standalone"; id: string; item: TurnPart }
  | { kind: "activity"; id: string; items: TurnPart[] };

/** Native commentary ends an activity slice; reasoning does not split adjacent tools. */
export function groupCompactTurnParts(items: readonly TurnPart[]): CompactTurnSegment[] {
  const result: CompactTurnSegment[] = [];
  let activity: TurnPart[] = [];
  const identity = (item: TurnPart) => `${item.message.id}:${item.part.id}`;
  const flush = () => {
    if (!activity.length) return;
    if (activity.some(({ part }) => part.type === "tool")) {
      result.push({ kind: "activity", id: identity(activity[0]), items: activity });
    } else {
      for (const item of activity) result.push({ kind: "standalone", id: identity(item), item });
    }
    activity = [];
  };
  for (const item of items) {
    const part = item.part;
    if (part.type === "reasoning" || (part.type === "tool" && part.normalizedTool !== "task")) {
      activity.push(item);
      continue;
    }
    flush();
    result.push({ kind: part.type === "text" || part.type === "file" ? "message" : "standalone", id: identity(item), item });
  }
  flush();
  return result;
}

/** A turn can stop receiving text while tools in an earlier message are still running. */
export function shouldHideUnfinishedTool(part: UnifiedPart, isWorking: boolean, message?: UnifiedMessage): boolean {
  if (part.type !== "tool" || (part.state.status !== "pending" && part.state.status !== "running")) return false;
  const ownerIsUnfinished = message?.role === "assistant"
    && message.id === part.messageId
    && message.time.completed === undefined;
  return !isWorking && !ownerIsUnfinished;
}

/** Native item IDs need not sort in the order that the items were produced. */
export function compareParts(a: UnifiedPart, b: UnifiedPart): number {
  if (a.order !== b.order) {
    if (a.order === undefined) return 1;
    if (b.order === undefined) return -1;
    return a.order - b.order;
  }
  return a.id.localeCompare(b.id);
}

/** Update a copied parts array by identity, then keep its chronological order. */
export function upsertPart(parts: UnifiedPart[], part: UnifiedPart): void {
  const existingIndex = parts.findIndex((existing) => existing.id === part.id);
  if (existingIndex !== -1) {
    parts[existingIndex] = part;
    const previous = parts[existingIndex - 1];
    const next = parts[existingIndex + 1];
    if ((!previous || compareParts(previous, part) <= 0)
      && (!next || compareParts(part, next) <= 0)) return;
    parts.splice(existingIndex, 1);
  }

  let left = 0;
  let right = parts.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (compareParts(parts[mid], part) < 0) left = mid + 1;
    else right = mid;
  }
  parts.splice(left, 0, part);
}

/** Explicit response phases keep every item; older streams retain their last-text layout. */
export function selectResponseParts(parts: readonly TextPart[]): TextPart[] {
  const visible = parts.filter((part) => !part.synthetic && (part.displayText ?? part.text).length > 0);
  let lastLegacy: TextPart | undefined;
  for (const part of visible) {
    if (part.phase === undefined) lastLegacy = part;
  }
  return visible.filter((part) => part.phase === "partial" || part.phase === "final" || part === lastLegacy);
}

/** Keep native responses between activities while preserving the legacy trailing response. */
export function groupTurnParts(items: readonly TurnPart[]): TurnPartSegment[] {
  const responseParts = new Set(selectResponseParts(
    items.map(({ part }) => part).filter((part): part is TextPart => part.type === "text"),
  ));
  const legacyResponse = items.find(({ part }) => part.type === "text" && part.phase === undefined && responseParts.has(part));
  const timeline = legacyResponse
    ? [...items.filter((item) => item !== legacyResponse), legacyResponse]
    : items;
  const segments: TurnPartSegment[] = [];
  for (const item of timeline) {
    const kind = (item.part.type === "text" && responseParts.has(item.part))
      || (item.part.type === "file" && item.message.role === "assistant") ? "response" : "activity";
    const previous = segments.at(-1);
    if (previous?.kind === kind) previous.items.push(item);
    else segments.push({ kind, items: [item] });
  }
  return segments;
}
