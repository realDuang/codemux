/**
 * End-to-end test for OpenCodeAdapter.
 * Validates that the adapter correctly manages the OpenCode process
 * and translates HTTP REST + SSE events to unified types.
 *
 * Prerequisites: `opencode` must be installed and configured (API key set).
 *
 * Usage: npx tsx electron/main/engines/test-opencode-adapter.ts
 */

import { OpenCodeAdapter } from "./opencode-adapter";
import type { UnifiedPart, ToolPart, TextPart, ReasoningPart } from "../../../src/types/unified";

const adapter = new OpenCodeAdapter({ port: 4199 }); // Use unique port to avoid conflict

// Collect events
const events: Array<{ event: string; data: any }> = [];

adapter.on("status.changed", (data) => {
  console.log(`\n[EVENT] status.changed → ${data.status}${data.error ? ` (${data.error})` : ""}`);
  events.push({ event: "status.changed", data });
});

adapter.on("session.created", (data) => {
  console.log(`[EVENT] session.created → ${data.session.id}`);
  events.push({ event: "session.created", data });
});

adapter.on("message.part.updated", (data) => {
  const part = data.part;
  const summary = formatPart(part);
  console.log(`[EVENT] message.part.updated → ${summary}`);
  events.push({ event: "message.part.updated", data });
});

adapter.on("message.updated", (data) => {
  const msg = data.message;
  console.log(
    `[EVENT] message.updated → role=${msg.role}, parts=${msg.parts.length}, id=${msg.id.slice(0, 8)}...`,
  );
  events.push({ event: "message.updated", data });
});

adapter.on("session.updated", (data) => {
  console.log(`[EVENT] session.updated → ${data.session.id.slice(0, 8)}... title="${data.session.title ?? ""}"`);
  events.push({ event: "session.updated", data });
});

adapter.on("permission.asked", (data) => {
  console.log(`[EVENT] permission.asked → ${data.permission.title} (kind=${data.permission.kind})`);
  console.log(`        options: ${data.permission.options.map((o) => o.label).join(", ")}`);
  events.push({ event: "permission.asked", data });

  // Auto-approve for testing
  console.log(`        → Auto-approving (once)...`);
  adapter.replyPermission(data.permission.id, { optionId: "once" });
});

function formatPart(part: UnifiedPart): string {
  switch (part.type) {
    case "text": {
      const t = part as TextPart;
      const preview = t.text.length > 80 ? t.text.slice(0, 80) + "..." : t.text;
      return `text(${t.text.length} chars): "${preview}"`;
    }
    case "reasoning": {
      const r = part as ReasoningPart;
      const preview = r.text.length > 80 ? r.text.slice(0, 80) + "..." : r.text;
      return `reasoning: "${preview}"`;
    }
    case "tool": {
      const tp = part as ToolPart;
      return `tool(${tp.normalizedTool}, ${tp.state.status}): "${tp.originalTool}"`;
    }
    case "step-start":
      return `step-start`;
    case "step-finish":
      return `step-finish`;
    default:
      return `${part.type}`;
  }
}

async function run() {
  console.log("=== OpenCodeAdapter End-to-End Test ===\n");

  // Step 1: Start
  console.log("── Step 1: Start adapter ──");
  try {
    await adapter.start();
  } catch (err: any) {
    console.error(`Failed to start OpenCode: ${err.message}`);
    console.error("Make sure 'opencode' is installed and port 4097 is free.");
    process.exit(1);
  }
  console.log(`Status: ${adapter.getStatus()}`);
  console.log(`Info: ${JSON.stringify(adapter.getInfo(), null, 2)}`);

  // Step 2: List models
  console.log("\n── Step 2: List models ──");
  const modelResult = await adapter.listModels();
  const models = modelResult.models;
  console.log(`Models (${models.length}):`);
  for (const m of models.slice(0, 5)) {
    console.log(`  - ${m.modelId}: ${m.name} (provider: ${m.providerName})`);
  }
  if (models.length > 5) {
    console.log(`  ... and ${models.length - 5} more`);
  }

  // Step 3: List modes
  console.log("\n── Step 3: List modes ──");
  const modes = adapter.getModes();
  console.log(`Modes (${modes.length}):`);
  for (const m of modes) {
    console.log(`  - ${m.id}: ${m.label}`);
  }

  // Step 4: Create session
  console.log("\n── Step 4: Create session ──");
  const session = await adapter.createSession(process.cwd());
  console.log(`Session: ${JSON.stringify(session, null, 2)}`);

  // Step 5: Send a read-only prompt
  console.log("\n── Step 5: Send read-only prompt ──");
  console.log("Sending: 'What is 2 + 2? Just answer the number.'");
  const msg1 = await adapter.sendMessage(session.id, [
    { type: "text", text: "What is 2 + 2? Just answer the number, nothing else." },
  ]);
  console.log(`\nResponse message:`);
  console.log(`  id: ${(msg1.id ?? "?").slice(0, 8)}...`);
  console.log(`  role: ${msg1.role}`);
  console.log(`  parts: ${msg1.parts.length}`);
  for (const p of msg1.parts) {
    console.log(`  - ${formatPart(p)}`);
  }

  // Step 6: List sessions
  console.log("\n── Step 6: List sessions ──");
  const sessions = await adapter.listSessions(process.cwd());
  console.log(`Sessions (${sessions.length}):`);
  for (const s of sessions.slice(0, 5)) {
    console.log(`  - ${s.id.slice(0, 8)}...: "${s.title ?? "(no title)"}" (${new Date(s.time.updated).toISOString()})`);
  }
  if (sessions.length > 5) {
    console.log(`  ... and ${sessions.length - 5} more`);
  }

  // Step 7: List messages for session
  console.log("\n── Step 7: List messages ──");
  const messages = await adapter.listMessages(session.id);
  console.log(`Messages in session: ${messages.length}`);
  for (const m of messages) {
    console.log(`  - ${m.role}: ${m.parts.length} parts (${(m.id ?? "?").slice(0, 8)}...)`);
  }

  // Step 8: Capabilities
  console.log("\n── Step 8: Capabilities ──");
  console.log(JSON.stringify(adapter.getCapabilities(), null, 2));

  // Step 9: Health check
  console.log("\n── Step 9: Health check ──");
  const healthy = await adapter.healthCheck();
  console.log(`Healthy: ${healthy}`);

  // Step 10: Projects
  console.log("\n── Step 10: List projects ──");
  const projects = await adapter.listProjects();
  console.log(`Projects (${projects.length}):`);
  for (const p of projects.slice(0, 5)) {
    console.log(`  - ${p.id.slice(0, 8)}...: ${p.name ?? p.directory}`);
  }

  // Summary
  console.log("\n── Summary ──");
  console.log(`Total events captured: ${events.length}`);
  const byType = events.reduce(
    (acc, e) => {
      acc[e.event] = (acc[e.event] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log(`Events by type: ${JSON.stringify(byType)}`);

  // Validate
  console.log(`\nValidation:`);
  console.log(`  ${adapter.getStatus() === "running" ? "✓" : "✗"} Engine status is running`);
  console.log(`  ${models.length > 0 ? "✓" : "✗"} Models loaded: ${models.length}`);
  console.log(`  ${session.id ? "✓" : "✗"} Session created: ${session.id.slice(0, 8)}...`);
  console.log(`  ${msg1.parts.length > 0 ? "✓" : "✗"} Message has ${msg1.parts.length} parts`);
  console.log(`  ${healthy ? "✓" : "✗"} Health check passed`);

  const partUpdates = events.filter((e) => e.event === "message.part.updated");
  const toolParts = partUpdates.filter((e) => e.data.part.type === "tool");
  const textParts = partUpdates.filter((e) => e.data.part.type === "text");
  console.log(`  ✓ Tool part events: ${toolParts.length}`);
  console.log(`  ✓ Text part events: ${textParts.length}`);

  // Cleanup
  console.log("\n── Cleanup ──");
  await adapter.stop();
  console.log("Adapter stopped.");

  console.log("\n=== Test Complete ===");
}

run().catch((err) => {
  console.error("Test failed:", err);
  adapter.stop();
  process.exit(1);
});
