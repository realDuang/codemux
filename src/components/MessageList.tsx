import { Index, Suspense, createMemo, For } from "solid-js";
import { Part } from "./share/part";
import { messageStore } from "../stores/message";
import type { MessageV2 } from "../types/opencode";

interface MessageListProps {
  sessionID: string;
}

export function MessageList(props: MessageListProps) {
  // 获取该会话的所有消息（已按 id 排序）
  const messages = createMemo(() => messageStore.message[props.sessionID] || []);

  return (
    <div class="flex flex-col gap-6 py-4">
      <Index each={messages()}>
        {(message, msgIndex) => {
          // 获取该消息的所有 parts（已按 id 排序）
          const parts = createMemo(() => messageStore.part[message().id] || []);

          // 过滤 parts（与 opencode desktop 一致）
          const filteredParts = createMemo(() => {
            const allParts = parts();

            const filtered = allParts.filter((x, index) => {
              // 过滤内部状态和不需要显示的 part
              if (x.type === "step-start" && index > 0) return false;
              if (x.type === "snapshot") return false;
              if (x.type === "patch") return false;
              if (x.type === "step-finish") return false;
              if (x.type === "text" && x.synthetic === true) return false;
              if (x.type === "tool" && x.tool === "todoread") return false;
              if (x.type === "text" && !x.text) return false;
              if (
                x.type === "tool" &&
                (x.state.status === "pending" || x.state.status === "running")
              )
                return false;
              return true;
            });

            // 对 assistant 消息，重新排序：reasoning -> tools -> text
            // 这样确保思考过程在前，最终答复在后
            if (message().role === "assistant") {
              const reasoning = filtered.filter((p) => p.type === "reasoning");
              const tools = filtered.filter((p) => p.type === "tool");
              const text = filtered.filter((p) => p.type === "text");
              const others = filtered.filter(
                (p) => p.type !== "reasoning" && p.type !== "tool" && p.type !== "text"
              );

              return [...others, ...reasoning, ...tools, ...text];
            }

            return filtered;
          });

          return (
            <div class="flex flex-col gap-2">
              <Suspense>
                <Index each={filteredParts()}>
                  {(part, partIndex) => {
                    // 判断是否是最后一条消息的最后一个 part
                    const isLast = createMemo(
                      () =>
                        messages().length === msgIndex + 1 &&
                        filteredParts().length === partIndex + 1,
                    );

                    return (
                      <Part
                        last={isLast()}
                        part={part()}
                        index={partIndex}
                        message={message()}
                      />
                    );
                  }}
                </Index>
              </Suspense>
            </div>
          );
        }}
      </Index>
    </div>
  );
}
