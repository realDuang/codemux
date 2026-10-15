import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reconcile } from "solid-js/store";
import { messageStore, setMessageStore } from "../../../../src/stores/message";
import { applyMessageUpdates } from "../../../../src/stores/message-updates";
import type { TextPart, UnifiedMessage } from "../../../../src/types/unified";

function message(id: string, role: "user" | "assistant" = "assistant", sessionId = "session"): UnifiedMessage {
  return { id, sessionId, role, time: { created: 1, completed: 2 }, parts: [] };
}

function text(id: string, messageId: string, value: string): TextPart {
  return { id, messageId, sessionId: "session", type: "text", text: value };
}

describe("applyMessageUpdates", () => {
  beforeEach(() => {
    setMessageStore("message", reconcile({}));
    setMessageStore("part", reconcile({}));
  });

  it("restores a large history in one reactive publication and preserves stable rows while streaming", () => {
    // Node's default Solid export is SSR. Run the actual browser export so a
    // regression cannot pass merely because reactive updates were disabled.
    const fixture = fileURLToPath(new URL("./fixtures/message-updates-reactivity.ts", import.meta.url));
    const output = execFileSync("bun", ["--conditions=browser", fixture], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ messages: 2000, regroupCount: 2 });
  });

  it("merges repeated metadata once while retaining chronological insertion order and session isolation", () => {
    const original = { ...message("existing"), modelId: "model-a" };
    applyMessageUpdates([original, message("isolated", "user", "other")], () => false);
    applyMessageUpdates([
      message("new-a"),
      { ...message("existing"), error: "Earlier failure" },
      message("new-b"),
      { ...message("new-a"), time: { created: 1, completed: 4 } },
    ], () => false);

    expect(messageStore.message.session.map((item) => item.id)).toEqual(["existing", "new-a", "new-b"]);
    expect(messageStore.message.session[0]).toMatchObject({ modelId: "model-a", error: "Earlier failure" });
    expect(messageStore.message.session[1].time.completed).toBe(4);
    expect(messageStore.message.other.map((item) => item.id)).toEqual(["isolated"]);
  });

  it("migrates optimistic user parts and removes temporary messages once per incoming batch", () => {
    setMessageStore("message", "session", [message("old", "user"), message("msg-temp-1", "user")]);
    setMessageStore("part", "msg-temp-1", [text("part-temp-1", "msg-temp-1", "Draft")]);
    applyMessageUpdates([message("real-user", "user"), message("reply")], () => false);

    expect(messageStore.message.session.map((item) => item.id)).toEqual(["old", "real-user", "reply"]);
    expect(messageStore.part["msg-temp-1"]).toBeUndefined();
    expect(messageStore.part["real-user"]).toEqual([text("part-migrated-1", "real-user", "Draft")]);
  });

  it("replaces authoritative parts while preserving newer ordinary streamed parts", () => {
    setMessageStore("part", "native", [text("p", "native", "Old"), text("removed", "native", "Remove")]);
    setMessageStore("part", "ordinary", [text("p", "ordinary", "Current stream")]);
    const native = { ...message("native"), parts: [text("p", "native", "Final")] };
    const ordinary = { ...message("ordinary", "assistant", "other"), parts: [text("p", "ordinary", "Stale"), text("new", "ordinary", "Added")] };

    applyMessageUpdates([native, ordinary], (sessionId) => sessionId === "session");

    expect(messageStore.part.native).toEqual(native.parts);
    expect(messageStore.part.ordinary.map((part) => (part as TextPart).text)).toEqual(["Added", "Current stream"]);
  });
});
