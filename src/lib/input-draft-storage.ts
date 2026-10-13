export const INPUT_DRAFT_STORAGE_KEY = "codemux:web-input-drafts:v1";
export const MAX_STORED_INPUT_DRAFTS = 30;
export const INPUT_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Reserve at most 1 MiB of UTF-16 storage, leaving room for auth and settings.
export const MAX_STORED_INPUT_DRAFT_CHARS = 512 * 1024;

export type InputDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredDraft {
  text: string;
  updatedAt: number;
}

interface StoredDrafts {
  version: 1;
  deviceId: string;
  drafts: Record<string, StoredDraft>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clearPersistedInputDrafts(storage: InputDraftStorage): void {
  try {
    storage.removeItem(INPUT_DRAFT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing or after a quota error.
  }
}

function readDrafts(storage: InputDraftStorage, deviceId: string, now: number): Record<string, StoredDraft> {
  try {
    const raw = storage.getItem(INPUT_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    if (raw.length > MAX_STORED_INPUT_DRAFT_CHARS) {
      clearPersistedInputDrafts(storage);
      return {};
    }
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || data.version !== 1 || data.deviceId !== deviceId || !isRecord(data.drafts)) {
      clearPersistedInputDrafts(storage);
      return {};
    }
    const drafts = Object.entries(data.drafts).filter((entry): entry is [string, StoredDraft] => {
      const [sessionId, draft] = entry;
      return sessionId.length > 0 && sessionId.length <= 512 && isRecord(draft)
        && typeof draft.text === "string" && draft.text.length > 0
        && typeof draft.updatedAt === "number" && Number.isFinite(draft.updatedAt)
        && draft.updatedAt >= now - INPUT_DRAFT_TTL_MS && draft.updatedAt <= now;
    });
    return Object.fromEntries(drafts.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_STORED_INPUT_DRAFTS));
  } catch {
    clearPersistedInputDrafts(storage);
    return {};
  }
}

function writeDrafts(storage: InputDraftStorage, deviceId: string, drafts: Record<string, StoredDraft>): boolean {
  try {
    if (Object.keys(drafts).length === 0) {
      storage.removeItem(INPUT_DRAFT_STORAGE_KEY);
    } else {
      const data: StoredDrafts = { version: 1, deviceId, drafts };
      storage.setItem(INPUT_DRAFT_STORAGE_KEY, JSON.stringify(data));
    }
    return true;
  } catch {
    // Do not resurrect an older persisted draft when the current write fails.
    clearPersistedInputDrafts(storage);
    return false;
  }
}

/** Read the saved text after a write, including drafts retained by the storage limits. */
export function readPersistedInputDrafts(
  storage: InputDraftStorage,
  deviceId: string,
  now = Date.now(),
): Record<string, string> {
  return Object.fromEntries(Object.entries(readDrafts(storage, deviceId, now))
    .map(([id, draft]) => [id, draft.text]));
}

/** Only text is persisted; image payloads can exceed the browser's localStorage quota. */
export function loadPersistedInputDrafts(
  storage: InputDraftStorage,
  deviceId: string,
  now = Date.now(),
): Record<string, string> {
  const drafts = readDrafts(storage, deviceId, now);
  writeDrafts(storage, deviceId, drafts);
  return Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, draft.text]));
}

export function persistInputDraft(
  storage: InputDraftStorage,
  deviceId: string,
  sessionId: string,
  text: string,
  now = Date.now(),
): boolean {
  const drafts = readDrafts(storage, deviceId, now);
  delete drafts[sessionId];
  if (!text) return writeDrafts(storage, deviceId, drafts);
  const next = { text, updatedAt: now };
  const encodedSize = (entries: Record<string, StoredDraft>) => JSON.stringify({ version: 1, deviceId, drafts: entries }).length;
  if (!sessionId || sessionId.length > 512 || encodedSize({ [sessionId]: next }) > MAX_STORED_INPUT_DRAFT_CHARS) {
    writeDrafts(storage, deviceId, drafts);
    return false;
  }
  const recent = Object.entries(drafts).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_STORED_INPUT_DRAFTS - 1);
  let bounded = Object.fromEntries([[sessionId, next], ...recent]);
  while (encodedSize(bounded) > MAX_STORED_INPUT_DRAFT_CHARS && recent.length > 0) {
    recent.pop();
    bounded = Object.fromEntries([[sessionId, next], ...recent]);
  }
  return writeDrafts(storage, deviceId, bounded);
}
