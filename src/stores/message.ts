import { createStore } from "solid-js/store";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission, UnifiedQuestion } from "../types/unified";

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
    [messageId: string]: UnifiedPart[];  // Grouped by messageId, array sorted by id
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
}>({
  message: {},
  part: {},
  permission: {},
  question: {},
  queued: {},
  expanded: {},
  stepsLoaded: {},
});

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
