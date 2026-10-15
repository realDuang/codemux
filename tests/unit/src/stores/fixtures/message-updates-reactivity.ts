import assert from "node:assert/strict";
import { createMemo, createRoot } from "solid-js";
import { messageStore } from "../../../../../src/stores/message";
import { applyMessageUpdates } from "../../../../../src/stores/message-updates";
import type { UnifiedMessage } from "../../../../../src/types/unified";

createRoot((dispose) => {
  let regroupCount = 0;
  const grouped = createMemo(() => {
    regroupCount++;
    return (messageStore.message.session ?? []).map((item) => item.role);
  });
  const history: UnifiedMessage[] = Array.from({ length: 2000 }, (_, index) => ({
    id: `message-${index}`,
    sessionId: "session",
    role: index % 100 === 0 ? "user" : "assistant",
    time: { created: index, completed: index + 1 },
    parts: [],
  }));

  applyMessageUpdates(history, () => true);

  assert.equal(grouped().length, 2000);
  assert.equal(regroupCount, 2);
  const first = messageStore.message.session[0];
  const last = messageStore.message.session.at(-1);
  applyMessageUpdates([{ ...history.at(-1)!, time: { created: 1999, completed: 3000 } }], () => true);
  assert.equal(messageStore.message.session[0], first);
  assert.equal(messageStore.message.session.at(-1), last);
  assert.equal(messageStore.message.session.at(-1)?.time.completed, 3000);
  assert.equal(regroupCount, 2);
  console.log(JSON.stringify({ messages: grouped().length, regroupCount }));
  dispose();
});
