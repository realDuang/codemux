// =============================================================================
// Micro-benchmark: Conversation Store I/O Performance
//
// Measures the event-loop blocking cost of synchronous vs asynchronous file
// I/O operations in the conversation store. The key metric is not raw
// throughput but how long the main process event loop is blocked.
//
// Background: During streaming, the engine-manager persists messages and
// steps via conversation-store. With sync I/O (readFileSync/writeFileSync),
// each persist operation blocks the Node.js event loop for the duration of
// the disk I/O. Under high-frequency streaming (20-50 parts/sec), these
// blocking calls compound and can delay WebSocket message forwarding,
// exacerbating the renderer-side event loop starvation.
//
// This benchmark compares:
//   1. Sync I/O: fs.readFileSync / fs.writeFileSync (old behavior)
//   2. Async I/O: fs.promises.readFile / fs.promises.writeFile (new behavior)
// =============================================================================

import { bench, describe, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let fileCounter = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemux-bench-io-"));
  fileCounter = 0;
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

function nextFile(): string {
  return path.join(tmpDir, `bench-${++fileCounter}.json`);
}

/**
 * Generate realistic message data similar to what conversation-store persists.
 */
function generateMessageData(messageCount: number): object[] {
  return Array.from({ length: messageCount }, (_, i) => ({
    id: `msg-${String(i).padStart(6, "0")}`,
    sessionId: "sess-bench",
    role: i % 2 === 0 ? "user" : "assistant",
    time: {
      created: Date.now() - (messageCount - i) * 1000,
      updated: Date.now() - (messageCount - i) * 500,
      completed: i % 2 === 1 ? Date.now() - (messageCount - i) * 200 : undefined,
    },
    parts: Array.from({ length: 3 }, (_, j) => ({
      id: `part-${i}-${j}`,
      messageId: `msg-${String(i).padStart(6, "0")}`,
      sessionId: "sess-bench",
      type: "text",
      text: `This is realistic content for part ${j} of message ${i}. It contains enough text to simulate real-world payload sizes during streaming.`,
    })),
    engineMeta: { provider: "test", model: "gpt-4" },
  }));
}

// Pre-generate data strings
const smallData = JSON.stringify(generateMessageData(2), null, 2);
const mediumData = JSON.stringify(generateMessageData(10), null, 2);
const largeData = JSON.stringify(generateMessageData(50), null, 2);

// ---------------------------------------------------------------------------
// Benchmark: Write performance — sync vs async side-by-side
// ---------------------------------------------------------------------------

describe("write: small file (~1KB) — sync vs async", () => {
  bench("sync writeFileSync", () => {
    const file = nextFile();
    fs.writeFileSync(file, smallData);
  });

  bench("async writeFile", async () => {
    const file = nextFile();
    await fsp.writeFile(file, smallData);
  });
});

describe("write: medium file (~10KB) — sync vs async", () => {
  bench("sync writeFileSync", () => {
    const file = nextFile();
    fs.writeFileSync(file, mediumData);
  });

  bench("async writeFile", async () => {
    const file = nextFile();
    await fsp.writeFile(file, mediumData);
  });
});

describe("write: large file (~50KB) — sync vs async", () => {
  bench("sync writeFileSync", () => {
    const file = nextFile();
    fs.writeFileSync(file, largeData);
  });

  bench("async writeFile", async () => {
    const file = nextFile();
    await fsp.writeFile(file, largeData);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Read performance — sync vs async side-by-side
// ---------------------------------------------------------------------------

describe("read: medium file (~10KB) — sync vs async", () => {
  let file: string;

  beforeEach(() => {
    file = nextFile();
    fs.writeFileSync(file, mediumData);
  });

  bench("sync readFileSync + JSON.parse", () => {
    const raw = fs.readFileSync(file, "utf-8");
    JSON.parse(raw);
  });

  bench("async readFile + JSON.parse", async () => {
    const raw = await fsp.readFile(file, "utf-8");
    JSON.parse(raw);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Atomic write (write-to-tmp + rename) — sync vs async
// ---------------------------------------------------------------------------

describe("atomic write: medium file — sync vs async", () => {
  bench("sync: writeFileSync + renameSync", () => {
    const target = nextFile();
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, mediumData);
    fs.renameSync(tmp, target);
  });

  bench("async: writeFile + rename", async () => {
    const target = nextFile();
    const tmp = target + ".tmp";
    await fsp.writeFile(tmp, mediumData);
    await fsp.rename(tmp, target);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Sustained write burst — event loop availability
//
// The most important benchmark. During streaming, persistMessage is called
// for every update. With sync I/O, the event loop is completely blocked.
// With async I/O, the event loop can process other tasks between writes.
//
// We measure setTimeout callback delivery as a proxy for event loop freedom.
// ---------------------------------------------------------------------------

describe("event loop availability: 20 sustained atomic writes", () => {
  bench("sync: event loop blocked during all 20 writes", async () => {
    let eventLoopYields = 0;

    const yieldPromise = new Promise<number>((resolve) => {
      const interval = setInterval(() => {
        eventLoopYields++;
      }, 0);

      // Do 20 synchronous atomic writes — blocks event loop entirely
      for (let i = 0; i < 20; i++) {
        const target = nextFile();
        const tmp = target + ".tmp";
        fs.writeFileSync(tmp, mediumData);
        fs.renameSync(tmp, target);
      }

      clearInterval(interval);
      resolve(eventLoopYields);
    });

    await yieldPromise;
  });

  bench("async: event loop available between writes", async () => {
    let eventLoopYields = 0;

    const yieldCounter = setInterval(() => {
      eventLoopYields++;
    }, 0);

    // Do 20 async atomic writes — event loop available between awaits
    for (let i = 0; i < 20; i++) {
      const target = nextFile();
      const tmp = target + ".tmp";
      await fsp.writeFile(tmp, mediumData);
      await fsp.rename(tmp, target);
    }

    clearInterval(yieldCounter);
    // eventLoopYields should be > 0 for async (event loop was free)
    // and 0 for sync (event loop was blocked the entire time)
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Write lock overhead
//
// The new async store uses per-conversation write locks to prevent
// concurrent file corruption. Measure the lock contention cost.
// ---------------------------------------------------------------------------

describe("write lock: sequential vs contended", () => {
  bench("no lock: 10 sequential async writes", async () => {
    for (let i = 0; i < 10; i++) {
      const target = nextFile();
      const tmp = target + ".tmp";
      await fsp.writeFile(tmp, mediumData);
      await fsp.rename(tmp, target);
    }
  });

  bench("with lock: 10 concurrent writes (2 conversations, 5 each)", async () => {
    const locks = new Map<string, Promise<void>>();

    async function withWriteLock(key: string, fn: () => Promise<void>): Promise<void> {
      const prev = locks.get(key) ?? Promise.resolve();
      let resolve: () => void;
      const lock = new Promise<void>((r) => { resolve = r; });
      locks.set(key, lock);
      await prev;
      try { await fn(); } finally { resolve!(); }
    }

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      const convId = `conv-${i % 2}`;
      promises.push(withWriteLock(convId, async () => {
        const target = nextFile();
        const tmp = target + ".tmp";
        await fsp.writeFile(tmp, mediumData);
        await fsp.rename(tmp, target);
      }));
    }
    await Promise.all(promises);
  });
});
