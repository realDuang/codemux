/**
 * Gateway WebSocket Demo — Multi-Engine E2E
 *
 * Demonstrates the full gateway stack without Electron:
 *   EngineManager → GatewayServer (WS) → ws client
 *
 * Tests: list engines, list models, create session, send message (with streaming),
 *        list sessions, list messages, engine capabilities
 *
 * Usage: npx tsx electron/main/gateway/test-gateway-ws.ts
 */

import WebSocket from "ws";
import { EngineManager } from "./engine-manager";
import { GatewayServer } from "./ws-server";
import { OpenCodeAdapter } from "../engines/opencode-adapter";

// --- Config ---
const OC_PORT = 14096; // OpenCode serve port (high port to avoid conflicts)
const WS_PORT = 14097; // Gateway WS port

// --- Setup ---
const engineManager = new EngineManager();
const gateway = new GatewayServer(engineManager);
const ocAdapter = new OpenCodeAdapter({ port: OC_PORT });
engineManager.registerAdapter(ocAdapter);

// --- Helpers ---
let reqCounter = 0;

function sendRequest(ws: WebSocket, type: string, payload: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = `req_${++reqCounter}`;
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${type}`)), 120_000);

    const handler = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "response" && msg.requestId === requestId) {
          ws.off("message", handler);
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.payload);
          }
        }
      } catch { /* ignore non-JSON */ }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type, requestId, payload }));
  });
}

function hr(title: string) {
  console.log(`\n${"─".repeat(3)} ${title} ${"─".repeat(40 - title.length)}`);
}

// --- Main ---
async function main() {
  console.log("=== Gateway WebSocket Demo ===\n");

  // 1. Start OpenCode adapter
  hr("Step 1: Start OpenCode engine");
  await ocAdapter.start();
  console.log(`OpenCode engine running on port ${OC_PORT}`);

  // 2. Start Gateway WS server
  hr("Step 2: Start Gateway WS server");
  gateway.start({ port: WS_PORT });
  console.log(`Gateway WS server on ws://127.0.0.1:${WS_PORT}`);

  // 3. Connect WS client
  hr("Step 3: Connect WS client");
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => { console.log("WS connected"); resolve(); });
    ws.on("error", reject);
  });

  // Collect notifications
  const notifications: any[] = [];
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "response") {
        notifications.push(msg);
        const preview = JSON.stringify(msg.payload).slice(0, 80);
        console.log(`  [PUSH] ${msg.type}: ${preview}...`);
      }
    } catch { /* ignore */ }
  });

  // 4. List engines
  hr("Step 4: List engines");
  const engines = await sendRequest(ws, "engine.list");
  for (const e of engines) {
    console.log(`  ${e.type}: ${e.name} (${e.status})`);
  }

  // 5. Engine capabilities
  hr("Step 5: Engine capabilities (opencode)");
  const caps = await sendRequest(ws, "engine.capabilities", { engineType: "opencode" });
  console.log(`  providerModelHierarchy: ${caps.providerModelHierarchy}`);
  console.log(`  messageCancellation: ${caps.messageCancellation}`);
  console.log(`  permissionAlways: ${caps.permissionAlways}`);
  console.log(`  modes: ${(caps.availableModes || []).map((m: any) => m.id).join(", ")}`);

  // 6. List models
  hr("Step 6: List models (opencode)");
  const models = await sendRequest(ws, "model.list", { engineType: "opencode" });
  console.log(`  ${models.length} models loaded`);
  for (const m of models.slice(0, 5)) {
    console.log(`    - ${m.modelId}: ${m.name} (${m.providerName})`);
  }
  if (models.length > 5) console.log(`    ... and ${models.length - 5} more`);

  // 7. List projects
  hr("Step 7: List projects (opencode)");
  const projects = await sendRequest(ws, "project.list", { engineType: "opencode" });
  console.log(`  ${projects.length} projects`);
  for (const p of projects.slice(0, 3)) {
    console.log(`    - ${(p.id ?? "?").slice(0, 8)}...: ${p.directory}`);
  }

  // 8. Create session
  hr("Step 8: Create session");
  const session = await sendRequest(ws, "session.create", {
    engineType: "opencode",
    directory: process.cwd(),
  });
  console.log(`  Session: ${session.id}`);
  console.log(`  Title: ${session.title}`);
  console.log(`  Directory: ${session.directory}`);

  // 9. Send message (with streaming notifications)
  hr("Step 9: Send message");
  const prompt = "What is the capital of France? Answer in one word.";
  console.log(`  Sending: "${prompt}"`);
  console.log(`  Waiting for response (streaming notifications will appear above)...`);

  const response = await sendRequest(ws, "message.send", {
    sessionId: session.id,
    content: [{ type: "text", text: prompt }],
  });
  console.log(`\n  Response:`);
  console.log(`    id: ${(response.id ?? "?").slice(0, 12)}...`);
  console.log(`    role: ${response.role}`);
  console.log(`    parts: ${response.parts?.length ?? 0}`);
  for (const part of (response.parts || [])) {
    if (part.type === "text") {
      console.log(`    - text: "${part.text}"`);
    } else {
      console.log(`    - ${part.type}`);
    }
  }

  // 10. List sessions
  hr("Step 10: List sessions");
  const sessions = await sendRequest(ws, "session.list", { engineType: "opencode" });
  console.log(`  ${sessions.length} sessions`);
  for (const s of sessions.slice(0, 3)) {
    console.log(`    - ${(s.id ?? "?").slice(0, 12)}...: "${s.title ?? "(untitled)"}"`);
  }

  // 11. List messages
  hr("Step 11: List messages in session");
  const messages = await sendRequest(ws, "message.list", { sessionId: session.id });
  console.log(`  ${messages.length} messages`);
  for (const m of messages) {
    console.log(`    - ${m.role}: ${m.parts?.length ?? 0} parts (${(m.id ?? "?").slice(0, 12)}...)`);
  }

  // 12. Summary
  hr("Summary");
  console.log(`  Total push notifications received: ${notifications.length}`);
  const byType: Record<string, number> = {};
  for (const n of notifications) {
    byType[n.type] = (byType[n.type] || 0) + 1;
  }
  console.log(`  By type: ${JSON.stringify(byType)}`);

  // Cleanup
  hr("Cleanup");
  ws.close();
  gateway.stop();
  await ocAdapter.stop();
  console.log("  Done.\n");

  console.log("=== Demo Complete ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  gateway.stop();
  ocAdapter.stop().then(() => process.exit(1));
});
