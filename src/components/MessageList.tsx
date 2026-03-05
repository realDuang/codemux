import { createMemo, Index, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { messageStore } from "../stores/message";
import { SessionTurn } from "./SessionTurn";
import type { UnifiedMessage } from "../types/unified";

interface MessageListProps {
  sessionID: string;
  isWorking?: boolean;
  scrollContainerRef?: () => HTMLDivElement | undefined;
  onPermissionRespond?: (sessionID: string, permissionID: string, reply: string) => void;
  onQuestionRespond?: (sessionID: string, questionID: string, answers: string[][]) => void;
  onQuestionDismiss?: (sessionID: string, questionID: string) => void;
  onContinue?: (sessionID: string) => void;
}

interface Turn {
  userMessage: UnifiedMessage;
  assistantMessages: UnifiedMessage[];
}

/**
 * Group messages into turns (user message + following assistant messages)
 * A turn starts with a user message and includes all subsequent assistant messages
 * until the next user message
 */
function groupMessagesIntoTurns(messages: UnifiedMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      // Start a new turn
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        userMessage: msg,
        assistantMessages: [],
      };
    } else if (msg.role === "assistant" && currentTurn) {
      // Add to current turn's assistant messages
      currentTurn.assistantMessages.push(msg);
    }
  }

  // Don't forget the last turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

export function MessageList(props: MessageListProps) {
  // Get all messages for this session (sorted by id)
  const messages = createMemo(() => messageStore.message[props.sessionID] || []);

  // Group messages into turns
  const turns = createMemo(() => groupMessagesIntoTurns(messages()));

  // Use sending() (props.isWorking) as the sole source of truth.
  // time.completed on individual assistant messages is unreliable for
  // multi-step tasks — intermediate messages get completed timestamps
  // while the overall task is still running.
  const isLastTurnWorking = createMemo(() => props.isWorking ?? false);

  // Virtual scrolling threshold — only virtualize when there are enough turns
  // to justify the overhead. Small conversations render directly for simplicity.
  const VIRTUALIZE_THRESHOLD = 15;
  const shouldVirtualize = createMemo(() => turns().length >= VIRTUALIZE_THRESHOLD);

  // Virtualizer instance — only active when shouldVirtualize() is true.
  // Uses getter syntax for SolidJS reactivity.
  const virtualizer = createVirtualizer({
    get count() {
      return shouldVirtualize() ? turns().length : 0;
    },
    getScrollElement() {
      return props.scrollContainerRef?.() ?? null;
    },
    estimateSize: () => 150,
    overscan: 5,
    gap: 20, // matches gap-5 (1.25rem = 20px)
    paddingStart: 12, // matches py-3 top (0.75rem = 12px)
    paddingEnd: 12, // matches py-3 bottom
    getItemKey(index) {
      const t = turns()[index];
      return t ? t.userMessage.id : index;
    },
  });

  // Measure element callback — use queueMicrotask for SolidJS compatibility
  const measureElement = (el: HTMLDivElement) => {
    if (!el) return;
    queueMicrotask(() => virtualizer.measureElement(el));
  };

  return (
    <Show
      when={turns().length > 0}
      fallback={
        <div class="text-center text-gray-400 py-8">
          {/* Empty state is handled by parent */}
        </div>
      }
    >
      <Show
        when={shouldVirtualize()}
        fallback={
          /* Non-virtualized path for small conversations */
          <div class="flex flex-col gap-5 py-3">
            <Index each={turns()}>
              {(turn, turnIndex) => {
                const isLastTurn = () => turnIndex === turns().length - 1;
                const isWorking = () => isLastTurn() && isLastTurnWorking();

                return (
                  <SessionTurn
                    sessionID={props.sessionID}
                    userMessage={turn().userMessage}
                    assistantMessages={turn().assistantMessages}
                    isLastTurn={isLastTurn()}
                    isWorking={isWorking()}
                    onPermissionRespond={props.onPermissionRespond}
                    onQuestionRespond={props.onQuestionRespond}
                    onQuestionDismiss={props.onQuestionDismiss}
                    onContinue={props.onContinue}
                  />
                );
              }}
            </Index>
          </div>
        }
      >
        {/* Virtualized path for large conversations */}
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <Index each={virtualizer.getVirtualItems()}>
            {(virtualItem) => {
              const turnIndex = () => virtualItem().index;
              const turn = () => turns()[turnIndex()];
              const isLastTurn = () => turnIndex() === turns().length - 1;
              const isWorking = () => isLastTurn() && isLastTurnWorking();

              return (
                <div
                  ref={measureElement}
                  data-index={virtualItem().index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem().start}px)`,
                  }}
                >
                  <SessionTurn
                    sessionID={props.sessionID}
                    userMessage={turn().userMessage}
                    assistantMessages={turn().assistantMessages}
                    isLastTurn={isLastTurn()}
                    isWorking={isWorking()}
                    onPermissionRespond={props.onPermissionRespond}
                    onQuestionRespond={props.onQuestionRespond}
                    onQuestionDismiss={props.onQuestionDismiss}
                    onContinue={props.onContinue}
                  />
                </div>
              );
            }}
          </Index>
        </div>
      </Show>
    </Show>
  );
}
