import { batch } from "solid-js";
import { createStore } from "solid-js/store";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion } from "../types/unified";
import { compareParts } from "../lib/message-parts";

/** A message waiting in the queue (not yet processed by the engine). */
export interface QueuedMessage {
  /** Temporary ID for tracking */
  id: string;
  /** The text content the user typed */
  text: string;
  /** Timestamp when enqueued */
  enqueuedAt: number;
}

// Storage structure — engine-agnostic
export const [messageStore, setMessageStore] = createStore<{
  message: {
    [sessionId: string]: UnifiedMessage[];  // Grouped by sessionId, array in chronological order
  };
  part: {
    [messageId: string]: UnifiedPart[];  // Grouped by messageId, sorted by explicit order or legacy id
  };
  permission: {
    [sessionId: string]: UnifiedPermission[];  // Permission request queue grouped by sessionId
  };
  question: {
    [sessionId: string]: UnifiedQuestion[];  // Question request queue grouped by sessionId
  };
  /** Messages waiting in the queue — not yet rendered as chat turns. */
  queued: {
    [sessionId: string]: QueuedMessage[];
  };
  // Collapse/expand state, indexed by partId or special key
  expanded: {
    [key: string]: boolean;
  };
  // Tracks whether step parts have been loaded for a message (lazy loading)
  stepsLoaded: {
    [messageId: string]: boolean;
  };
  /** Invalidates an in-flight lazy load when a newer projection or step arrives. */
  stepsVersion: {
    [messageId: string]: number;
  };
}>({
  message: {},
  part: {},
  permission: {},
  question: {},
  queued: {},
  expanded: {},
  stepsLoaded: {},
  stepsVersion: {},
});

/** Replace the displayed parts with a complete authoritative message snapshot. */
export function replaceMessageParts(messageId: string, parts: readonly UnifiedPart[]): void {
  setMessageStore("part", messageId, [...parts].sort(compareParts));
}

export function invalidateMessageSteps(messageId: string): void {
  setMessageStore("stepsVersion", messageId, (version = 0) => version + 1);
}

/** Keep expanded steps visible until a lightweight history projection is refreshed. */
export function replaceMessageProjection(message: UnifiedMessage): void {
  batch(() => {
    const incoming = message.parts ?? [];
    const omittedSteps = (message.stepCount ?? 0) > 0
      && incoming.every((part) => part.type === "text" || part.type === "file");
    const retained = omittedSteps
      ? (messageStore.part[message.id] ?? []).filter((part) => part.type !== "text" && part.type !== "file")
      : [];
    replaceMessageParts(message.id, [...incoming, ...retained]);
    invalidateMessageSteps(message.id);
    setMessageStore("stepsLoaded", message.id, !omittedSteps);
  });
}

/** A lazy response replaces its step partition only while its source revision is current. */
export function replaceFetchedMessageSteps(
  messageId: string,
  steps: readonly UnifiedPart[],
  version: number,
): "applied" | "retry" | "superseded" {
  if ((messageStore.stepsVersion[messageId] ?? 0) !== version) {
    return messageStore.stepsLoaded[messageId] ? "superseded" : "retry";
  }
  batch(() => {
    const content = (messageStore.part[messageId] ?? []).filter((part) => part.type === "text" || part.type === "file");
    replaceMessageParts(messageId, [...content, ...steps]);
    setMessageStore("stepsLoaded", messageId, true);
  });
  return "applied";
}

// Helper functions for expanded state management
export function isExpanded(key: string): boolean {
  return messageStore.expanded[key] ?? false;
}

export function setExpanded(key: string, value: boolean): void {
  setMessageStore("expanded", key, value);
}

export function toggleExpanded(key: string): void {
  setMessageStore("expanded", key, !isExpanded(key));
}
