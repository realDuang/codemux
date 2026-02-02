import { createMemo, For, Show } from "solid-js";
import { messageStore } from "../stores/message";
import { SessionTurn } from "./SessionTurn";
import type { MessageV2, Permission } from "../types/opencode";

interface MessageListProps {
  sessionID: string;
  isWorking?: boolean;
  onPermissionRespond?: (sessionID: string, permissionID: string, reply: Permission.Reply) => void;
}

interface Turn {
  userMessage: MessageV2.Info;
  assistantMessages: MessageV2.Info[];
}

/**
 * Group messages into turns (user message + following assistant messages)
 * A turn starts with a user message and includes all subsequent assistant messages
 * until the next user message
 */
function groupMessagesIntoTurns(messages: MessageV2.Info[]): Turn[] {
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

  const isLastTurnWorking = createMemo(() => {
    const allTurns = turns();
    if (allTurns.length === 0) return props.isWorking ?? false;

    const lastTurn = allTurns[allTurns.length - 1];
    const lastAssistant = lastTurn.assistantMessages.at(-1);

    if (!lastAssistant) {
      return props.isWorking ?? false;
    }

    return !lastAssistant.time?.completed;
  });

  return (
    <div class="flex flex-col gap-8 py-4">
      <Show
        when={turns().length > 0}
        fallback={
          <div class="text-center text-gray-400 py-8">
            {/* Empty state is handled by parent */}
          </div>
        }
      >
        <For each={turns()}>
          {(turn, turnIndex) => {
            const isLastTurn = () => turnIndex() === turns().length - 1;
            const isWorking = () => isLastTurn() && isLastTurnWorking();

            return (
              <SessionTurn
                sessionID={props.sessionID}
                userMessage={turn.userMessage}
                assistantMessages={turn.assistantMessages}
                isLastTurn={isLastTurn()}
                isWorking={isWorking()}
                onPermissionRespond={props.onPermissionRespond}
              />
            );
          }}
        </For>
      </Show>
    </div>
  );
}
