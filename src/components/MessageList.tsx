import { createMemo, Index, Show } from "solid-js";
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

  return (
    <Show
      when={turns().length > 0}
      fallback={
        <div class="text-center text-gray-400 py-8">
          {/* Empty state is handled by parent */}
        </div>
      }
    >
      <div class="flex flex-col gap-5 py-3">
        <Index each={turns()}>
          {(turn, turnIndex) => {
            const isLastTurn = () => turnIndex === turns().length - 1;
            const isWorking = () => isLastTurn() && isLastTurnWorking();

            return (
              <div
                style={{
                  "content-visibility": isLastTurn() ? "visible" : "auto",
                  "contain-intrinsic-size": "auto 200px",
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
  );
}
