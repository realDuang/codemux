import fs from "node:fs/promises";
import { lock } from "proper-lockfile";

export interface RuntimeLockOptions {
  onCompromised?: (error: Error) => void;
}

export interface RuntimeLock {
  readonly dataPath: string;
  release(): Promise<void>;
}

export async function acquireRuntimeLock(
  dataPath: string,
  options: RuntimeLockOptions = {},
): Promise<RuntimeLock> {
  await fs.mkdir(dataPath, { recursive: true });
  const canonicalPath = await fs.realpath(dataPath);

  let unlock: () => Promise<void>;
  try {
    unlock = await lock(canonicalPath, {
      // All hosts use the same timings; allow brief event-loop stalls before takeover.
      stale: 30_000,
      update: 10_000,
      retries: 0,
      // Preserve the library's fail-closed default when no host callback is supplied.
      ...(options.onCompromised ? { onCompromised: options.onCompromised } : {}),
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
      throw Object.assign(new Error(
        `CodeMux runtime data directory is already in use: ${canonicalPath}. Stop the other CodeMux host before starting this one.`,
        { cause: error },
      ), { code: "ELOCKED" });
    }
    throw error;
  }

  let releasePromise: Promise<void> | undefined;
  return {
    dataPath: canonicalPath,
    release() {
      releasePromise ??= unlock();
      return releasePromise;
    },
  };
}
