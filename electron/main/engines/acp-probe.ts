/**
 * ACP Protocol Probe — Standalone script to explore the Copilot CLI ACP interface.
 *
 * Spawns `copilot --acp`, walks through the full protocol lifecycle and
 * dumps every message exchanged so we can design the unified abstraction
 * layer from real data rather than spec assumptions.
 *
 * Usage:  npx tsx electron/main/engines/acp-probe.ts
 */

import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";

// ── JSON-RPC helpers ────────────────────────────────────────────────

let nextId = 1;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function makeRequest(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextId++, method, params: params ?? {} };
}

function makeResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

function makeErrorResponse(id: number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
}

// ── Logging ─────────────────────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), "acp-probe-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const logStream = fs.createWriteStream(
  path.join(LOG_DIR, `probe-${Date.now()}.jsonl`),
  { flags: "a" }
);

function log(direction: "SEND" | "RECV" | "INFO" | "ERROR", data: unknown) {
  const entry = {
    time: new Date().toISOString(),
    direction,
    data,
  };
  logStream.write(JSON.stringify(entry) + "\n");
  const preview =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const maxLen = 500;
  const truncated =
    preview.length > maxLen ? preview.slice(0, maxLen) + "... (truncated)" : preview;
  console.log(`[${direction}] ${truncated}`);
}

// ── Process management ──────────────────────────────────────────────

let child: ChildProcess;
let rl: readline.Interface;

/** Pending request resolvers keyed by JSON-RPC id */
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

/** Collected notifications for later analysis */
const notifications: Array<{ method: string; params: unknown }> = [];

function sendRequest(method: string, params?: unknown): Promise<unknown> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + "\n";
  log("SEND", req);
  child.stdin!.write(line);
  return new Promise((resolve, reject) => {
    pending.set(req.id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(req.id)) {
        pending.delete(req.id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${req.id})`));
      }
    }, 60_000);
  });
}

function sendRawResponse(line: string) {
  log("SEND", JSON.parse(line));
  child.stdin!.write(line);
}

function handleIncoming(line: string) {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    log("ERROR", { raw: line, error: "Failed to parse JSON" });
    return;
  }

  log("RECV", msg);

  // Response to our request
  if ("id" in msg && msg.id != null && !("method" in msg)) {
    const p = pending.get(msg.id as number);
    if (p) {
      pending.delete(msg.id as number);
      if ("error" in msg && msg.error) {
        p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
    return;
  }

  // Notification from agent (no id, has method)
  if ("method" in msg && !("id" in msg && msg.id != null)) {
    notifications.push({ method: msg.method, params: msg.params });
    // Handle specific agent-to-client requests if they have an id
    return;
  }

  // Request from agent to client (has both method and id)
  if ("method" in msg && "id" in msg && msg.id != null) {
    handleAgentRequest(msg as JsonRpcRequest);
    return;
  }
}

/**
 * Handle reverse requests from the agent (permission, file ops, terminal).
 * For the probe we auto-approve everything and log the data.
 */
function handleAgentRequest(req: JsonRpcRequest) {
  log("INFO", `Agent request: ${req.method} (id=${req.id})`);

  switch (req.method) {
    case "requestPermission":
    case "session/request_permission": {
      // Auto-approve the permission request
      // Real ACP uses: { accepted: true/false }
      log("INFO", `Auto-approving permission: ${JSON.stringify((req.params as any)?.toolCall?.title)}`);
      sendRawResponse(makeResponse(req.id, { accepted: true }));
      break;
    }

    case "fs/read_text_file": {
      const params = req.params as any;
      const filePath = params?.path;
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const limit = params?.limit;
        const startLine = params?.line ?? 1;
        let result = content;
        if (limit || startLine > 1) {
          const lines = content.split("\n");
          const start = Math.max(0, startLine - 1);
          const end = limit ? start + limit : lines.length;
          result = lines.slice(start, end).join("\n");
        }
        sendRawResponse(makeResponse(req.id, { content: result }));
      } catch (e: any) {
        sendRawResponse(
          makeErrorResponse(req.id, -32000, `File read error: ${e.message}`)
        );
      }
      break;
    }

    case "fs/write_text_file": {
      // For safety, don't actually write — just log and acknowledge
      log("INFO", `[DRY-RUN] Would write to: ${(req.params as any)?.path}`);
      sendRawResponse(makeResponse(req.id, {}));
      break;
    }

    case "terminal/create": {
      // Stub: return a fake terminal id
      sendRawResponse(
        makeResponse(req.id, { terminalId: `probe-term-${Date.now()}` })
      );
      break;
    }

    case "terminal/output": {
      sendRawResponse(
        makeResponse(req.id, { output: "", truncated: false, exitStatus: null })
      );
      break;
    }

    case "terminal/wait_for_exit": {
      sendRawResponse(
        makeResponse(req.id, { exitStatus: { code: 0, signal: null } })
      );
      break;
    }

    case "terminal/kill":
    case "terminal/release": {
      sendRawResponse(makeResponse(req.id, {}));
      break;
    }

    default: {
      log("INFO", `Unknown agent request method: ${req.method}`);
      sendRawResponse(
        makeErrorResponse(req.id, -32601, `Method not found: ${req.method}`)
      );
    }
  }
}

// ── Main probe sequence ─────────────────────────────────────────────

async function runProbe() {
  console.log("=== ACP Protocol Probe ===");
  console.log(`Logs: ${LOG_DIR}\n`);

  // Spawn copilot in ACP mode
  child = spawn("copilot", ["--acp", "--allow-all"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  child.stderr?.on("data", (data: Buffer) => {
    log("ERROR", `stderr: ${data.toString().trim()}`);
  });

  child.on("error", (err) => {
    log("ERROR", `Process error: ${err.message}`);
    process.exit(1);
  });

  child.on("close", (code) => {
    log("INFO", `Process exited with code ${code}`);
    writeSummary();
    process.exit(0);
  });

  // Read NDJSON from stdout
  rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on("line", handleIncoming);

  // Wait a moment for process to start
  await sleep(1000);

  try {
    // ── Step 1: Initialize ──────────────────────────────────────
    console.log("\n── Step 1: Initialize ──");
    const initResult = await sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "acp-probe", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    log("INFO", { step: "initialize", result: initResult });

    // ── Step 2: Create session ──────────────────────────────────
    console.log("\n── Step 2: Create Session ──");
    const cwd = process.cwd();
    const sessionResult = (await sendRequest("session/new", {
      cwd,
      mcpServers: [],
    })) as any;
    const sessionId = sessionResult?.sessionId;
    log("INFO", { step: "session/new", sessionId, fullResult: sessionResult });

    if (!sessionId) {
      log("ERROR", "No sessionId returned from session/new");
      cleanup();
      return;
    }

    // ── Step 3: Send a simple prompt ────────────────────────────
    console.log("\n── Step 3: Send Prompt (simple question) ──");
    const promptResult = await sendRequest("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "List all .ts files in the current directory. Just list them, don't read them.",
        },
      ],
    });
    log("INFO", { step: "session/prompt", result: promptResult });

    // Wait a bit for any trailing notifications
    await sleep(2000);

    // ── Step 4: Send a prompt that triggers write (permission) ──
    console.log("\n── Step 4: Send Prompt (trigger write for permission) ──");
    notifications.length = 0; // Reset notification collection
    const toolPromptResult = await sendRequest("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: 'Create a file called "acp-test-output.txt" in the current directory with the content "hello from acp probe". Just create it, nothing else.',
        },
      ],
    });
    log("INFO", { step: "session/prompt (write)", result: toolPromptResult });

    await sleep(2000);

    // ── Step 5: List sessions ───────────────────────────────────
    console.log("\n── Step 5: List Sessions ──");
    try {
      const listResult = await sendRequest("session/list", { cwd });
      log("INFO", { step: "session/list", result: listResult });
    } catch (e: any) {
      log("INFO", { step: "session/list", error: e.message, note: "May not be supported" });
    }

    // ── Step 6: Check available models ──────────────────────────
    console.log("\n── Step 6: Check models ──");
    // Models may be returned in session/new response or via a separate method
    log("INFO", {
      step: "models",
      note: "Models from session/new response",
      models: sessionResult?.models,
    });

    // ── Step 7: Check available modes ───────────────────────────
    console.log("\n── Step 7: Check modes ──");
    log("INFO", {
      step: "modes",
      note: "Modes from session/new response",
      modes: sessionResult?.modes,
    });

  } catch (err: any) {
    log("ERROR", { step: "probe", error: err.message, stack: err.stack });
  }

  // Wait for stragglers then clean up
  await sleep(3000);
  cleanup();
}

function cleanup() {
  writeSummary();
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 1000);
}

function writeSummary() {
  const summaryPath = path.join(LOG_DIR, `summary-${Date.now()}.json`);
  const summary = {
    totalNotifications: notifications.length,
    notificationTypes: [...new Set(notifications.map((n) => n.method))],
    notificationsByType: Object.fromEntries(
      [...new Set(notifications.map((n) => n.method))].map((method) => [
        method,
        {
          count: notifications.filter((n) => n.method === method).length,
          samples: notifications
            .filter((n) => n.method === method)
            .slice(0, 3), // First 3 samples
        },
      ])
    ),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nSummary written to: ${summaryPath}`);
  log("INFO", { summary });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log("\nInterrupted, cleaning up...");
  cleanup();
});

runProbe();
