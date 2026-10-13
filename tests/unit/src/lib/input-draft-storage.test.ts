import { describe, expect, it } from "vitest";
import {
  clearPersistedInputDrafts,
  INPUT_DRAFT_STORAGE_KEY,
  INPUT_DRAFT_TTL_MS,
  loadPersistedInputDrafts,
  MAX_STORED_INPUT_DRAFT_CHARS,
  MAX_STORED_INPUT_DRAFTS,
  persistInputDraft,
  readPersistedInputDrafts,
  type InputDraftStorage,
} from "../../../../src/lib/input-draft-storage";

function memoryStorage(): InputDraftStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

describe("Web input draft storage", () => {
  describe("loadPersistedInputDrafts", () => {
    it("restores text for the approved device and removes expired drafts", () => {
      const storage = memoryStorage();
      persistInputDraft(storage, "device-1", "expired", "old text", 1);
      persistInputDraft(storage, "device-1", "recent", "unfinished text", INPUT_DRAFT_TTL_MS);

      expect(loadPersistedInputDrafts(storage, "device-1", INPUT_DRAFT_TTL_MS + 2)).toEqual({ recent: "unfinished text" });
      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)).not.toContain("expired");
    });

    it("discards another device's drafts without storing authentication tokens", () => {
      const storage = memoryStorage();
      persistInputDraft(storage, "device-1", "session-1", "private text");

      expect(loadPersistedInputDrafts(storage, "device-2")).toEqual({});
      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)).toBeNull();
    });

    it.each([
      "invalid JSON",
      JSON.stringify({ version: 2, deviceId: "device-1", drafts: {} }),
      JSON.stringify({ version: 1, deviceId: "device-1", drafts: [] }),
      "x".repeat(MAX_STORED_INPUT_DRAFT_CHARS + 1),
    ])("ignores malformed or unsupported persisted content", (raw) => {
      const storage = memoryStorage();
      storage.setItem(INPUT_DRAFT_STORAGE_KEY, raw);

      expect(loadPersistedInputDrafts(storage, "device-1")).toEqual({});
      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)).toBeNull();
    });
  });

  describe("readPersistedInputDrafts", () => {
    it("reads the saved text without rewriting valid storage", () => {
      const storage = memoryStorage();
      persistInputDraft(storage, "device-1", "session-1", "saved text");
      const saved = storage.getItem(INPUT_DRAFT_STORAGE_KEY);
      storage.setItem = () => { throw new Error("Writes unavailable"); };

      expect(readPersistedInputDrafts(storage, "device-1")).toEqual({ "session-1": "saved text" });
      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)).toBe(saved);
    });
  });

  describe("persistInputDraft", () => {
    it("keeps the most recent sessions within the count and encoded-size limits", () => {
      const storage = memoryStorage();
      for (let i = 0; i <= MAX_STORED_INPUT_DRAFTS; i++) {
        expect(persistInputDraft(storage, "device-1", `session-${i}`, "small", i)).toBe(true);
      }
      const countBounded = loadPersistedInputDrafts(storage, "device-1", MAX_STORED_INPUT_DRAFTS);
      expect(Object.keys(countBounded)).toHaveLength(MAX_STORED_INPUT_DRAFTS);
      expect(countBounded["session-0"]).toBeUndefined();
      expect(countBounded[`session-${MAX_STORED_INPUT_DRAFTS}`]).toBe("small");

      const longText = "🙂".repeat(MAX_STORED_INPUT_DRAFT_CHARS / 8);
      for (let i = 0; i < 6; i++) persistInputDraft(storage, "device-1", `large-${i}`, longText, 100 + i);
      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)!.length).toBeLessThanOrEqual(MAX_STORED_INPUT_DRAFT_CHARS);
      expect(loadPersistedInputDrafts(storage, "device-1", 106)["large-5"]).toBe(longText);
    });

    it("rejects oversized text without resurrecting an older version", () => {
      const storage = memoryStorage();
      persistInputDraft(storage, "device-1", "session-1", "old text");
      persistInputDraft(storage, "device-1", "session-2", "other text");

      expect(persistInputDraft(storage, "device-1", "session-1", "x".repeat(MAX_STORED_INPUT_DRAFT_CHARS))).toBe(false);
      expect(loadPersistedInputDrafts(storage, "device-1")).toEqual({ "session-2": "other text" });
    });

    it("removes submitted text while retaining another session's draft", () => {
      const storage = memoryStorage();
      persistInputDraft(storage, "device-1", "session-1", "send this");
      persistInputDraft(storage, "device-1", "session-2", "keep this");
      expect(persistInputDraft(storage, "device-1", "session-1", "")).toBe(true);
      expect(loadPersistedInputDrafts(storage, "device-1")).toEqual({ "session-2": "keep this" });
    });

    it("returns failure and removes stale data when storage runs out of quota", () => {
      const storage = memoryStorage();
      persistInputDraft(storage, "device-1", "session-1", "stale text");
      storage.setItem = () => { throw new Error("QuotaExceededError"); };

      expect(persistInputDraft(storage, "device-1", "session-1", "new text")).toBe(false);
      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)).toBeNull();
    });

    it("contains storage access failures", () => {
      const denied = () => { throw new Error("SecurityError"); };
      const storage = { getItem: denied, setItem: denied, removeItem: denied };
      expect(loadPersistedInputDrafts(storage, "device-1")).toEqual({});
      expect(persistInputDraft(storage, "device-1", "session-1", "text")).toBe(false);
    });
  });

  describe("clearPersistedInputDrafts", () => {
    it("clears drafts without removing settings or credentials", () => {
      const storage = memoryStorage();
      storage.setItem("settings:theme", "dark");
      storage.setItem("opencode_device_token", "saved-token");
      persistInputDraft(storage, "device-1", "session-1", "text");

      clearPersistedInputDrafts(storage);

      expect(storage.getItem(INPUT_DRAFT_STORAGE_KEY)).toBeNull();
      expect(storage.getItem("settings:theme")).toBe("dark");
      expect(storage.getItem("opencode_device_token")).toBe("saved-token");
    });
  });
});
