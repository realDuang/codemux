import { createStore } from "solid-js/store";
import type { UnifiedMessage, UnifiedPart, UnifiedPermission } from "../types/unified";

// Storage structure — engine-agnostic
export const [messageStore, setMessageStore] = createStore<{
  message: {
    [sessionId: string]: UnifiedMessage[];  // Grouped by sessionId, array sorted by id
  };
  part: {
    [messageId: string]: UnifiedPart[];  // Grouped by messageId, array sorted by id
  };
  permission: {
    [sessionId: string]: UnifiedPermission[];  // Permission request queue grouped by sessionId
  };
  // Collapse/expand state, indexed by partId or special key
  expanded: {
    [key: string]: boolean;
  };
}>({
  message: {},
  part: {},
  permission: {},
  expanded: {},
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
