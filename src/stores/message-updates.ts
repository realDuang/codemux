import { batch } from "solid-js";
import { unwrap } from "solid-js/store";
import { compareParts } from "../lib/message-parts";
import type { UnifiedMessage } from "../types/unified";
import { messageStore, replaceMessageProjection, setMessageStore } from "./message";

interface MessageUpdatePlan {
  existing: readonly UnifiedMessage[];
  indexes: Map<string, number>;
  pending: Map<string, UnifiedMessage>;
  temporary: Map<string, UnifiedMessage>;
  authoritative: boolean;
  removedTemporary: boolean;
}

/** Publish a notification slice with one reactive propagation and one ID index per session. */
export function applyMessageUpdates(
  updates: readonly UnifiedMessage[],
  isAuthoritative: (sessionId: string) => boolean,
): void {
  batch(() => {
    const plans = new Map<string, MessageUpdatePlan>();
    for (const message of updates) {
      const sessionId = message.sessionId;
      let plan = plans.get(sessionId);
      if (!plan) {
        const existing = unwrap(messageStore.message[sessionId] ?? []);
        plan = {
          existing,
          indexes: new Map(existing.map((item, index) => [item.id, index])),
          pending: new Map(),
          temporary: new Map(existing.filter((item) => item.id.startsWith("msg-temp-")).map((item) => [item.id, item])),
          authoritative: isAuthoritative(sessionId),
          removedTemporary: false,
        };
        plans.set(sessionId, plan);
      }

      if (message.role === "user") {
        const temporary = [...plan.temporary.values()];
        if (temporary.length > 0) {
          if (!message.parts?.length) {
            for (const item of temporary) {
              const parts = messageStore.part[item.id];
              if (!parts?.length) continue;
              setMessageStore("part", message.id, parts.map((part) => ({
                ...part,
                id: part.id.replace(/^part-temp-/, "part-migrated-"),
                messageId: message.id,
              })));
              break;
            }
          }
          for (const item of temporary) {
            plan.indexes.delete(item.id);
            plan.pending.delete(item.id);
            setMessageStore("part", item.id, undefined!);
          }
          plan.temporary.clear();
          plan.removedTemporary = true;
        }
      }

      if (plan.authoritative) {
        replaceMessageProjection(message);
      } else if (message.parts?.length) {
        const existingParts = messageStore.part[message.id];
        if (!existingParts?.length) {
          setMessageStore("part", message.id, [...message.parts].sort(compareParts));
        } else {
          const existingIds = new Set(existingParts.map((part) => part.id));
          const added = message.parts.filter((part) => !existingIds.has(part.id));
          if (added.length > 0) {
            setMessageStore("part", message.id, [...existingParts, ...added].sort(compareParts));
          }
        }
      }

      const previous = plan.pending.get(message.id)
        ?? plan.existing[plan.indexes.get(message.id) ?? -1];
      plan.pending.set(message.id, { ...previous, ...message });
      if (message.id.startsWith("msg-temp-")) plan.temporary.set(message.id, message);
    }

    for (const [sessionId, plan] of plans) {
      if (plan.removedTemporary) {
        const retained = plan.existing.filter((message) => plan.indexes.has(message.id));
        const messages = retained.map((message) => plan.pending.get(message.id) ?? message);
        for (const [id, message] of plan.pending) {
          if (!plan.indexes.has(id)) messages.push(message);
        }
        setMessageStore("message", sessionId, messages);
        continue;
      }

      if (!messageStore.message[sessionId]) setMessageStore("message", sessionId, []);
      let nextIndex = plan.existing.length;
      for (const [id, message] of plan.pending) {
        // Update existing objects in place: streaming one message must not invalidate
        // every historical turn merely by replacing the session's entire array.
        setMessageStore("message", sessionId, plan.indexes.get(id) ?? nextIndex++, message);
      }
    }
  });
}
