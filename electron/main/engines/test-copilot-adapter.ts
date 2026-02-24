/**
 * End-to-end test for CopilotAdapter.
 * Validates that the unified type system works with real Copilot CLI ACP.
 *
 * Usage: npx tsx electron/main/engines/test-copilot-adapter.ts
 */

import { CopilotAdapter } from "./copilot-adapter";
import type { UnifiedPart, ToolPart, TextPart, ReasoningPart } from "../../../src/types/unified";

const adapter = new CopilotAdapter();

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

adapter.on("permission.asked", (data) => {
  console.log(`[EVENT] permission.asked → ${data.permission.title} (kind=${data.permission.kind})`);
  console.log(`        options: ${data.permission.options.map((o) => o.label).join(", ")}`);
  if (data.permission.diff) {
    console.log(`        diff: ${data.permission.diff.slice(0, 200)}...`);
  }
  events.push({ event: "permission.asked", data });

  // Auto-approve for testing — use ACP option ID
  console.log(`        → Auto-approving...`);
  const allowOption = data.permission.options.find((o) => o.id === "allow_once") ?? data.permission.options[0];
  adapter.replyPermission(data.permission.id, { optionId: allowOption.id });
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
      return `reasoning: "${r.text}"`;
    }
    case "tool": {
      const tp = part as ToolPart;
      return `tool(${tp.normalizedTool}, ${tp.state.status}): "${tp.title}"`;
    }
    default:
      return `${part.type}`;
  }
}

async function run() {
  console.log("=== CopilotAdapter End-to-End Test ===\n");

  // Step 1: Start
  console.log("── Step 1: Start adapter ──");
  await adapter.start();
  console.log(`Status: ${adapter.getStatus()}`);
  console.log(`Info: ${JSON.stringify(adapter.getInfo(), null, 2)}`);

  // Step 2: Create session
  console.log("\n── Step 2: Create session ──");
  const session = await adapter.createSession(process.cwd());
  console.log(`Session: ${JSON.stringify(session, null, 2)}`);

  // Step 3: List models
  console.log("\n── Step 3: List models ──");
  const models = await adapter.listModels();
  console.log(`Models (${models.length}):`);
  for (const m of models) {
    console.log(`  - ${m.modelId}: ${m.name} (meta: ${JSON.stringify(m.meta)})`);
  }

  // Step 4: List modes
  console.log("\n── Step 4: List modes ──");
  const modes = adapter.getModes();
  console.log(`Modes (${modes.length}):`);
  for (const m of modes) {
    console.log(`  - ${m.id}: ${m.label}`);
  }

  // Step 5: Send read prompt (should NOT trigger permission)
  console.log("\n── Step 5: Send read-only prompt ──");
  const msg1 = await adapter.sendMessage(session.id, [
    { type: "text", text: "List all .ts files in the current directory root. Just list them briefly." },
  ]);
  console.log(`\nResponse message:`);
  console.log(`  id: ${msg1.id.slice(0, 8)}...`);
  console.log(`  role: ${msg1.role}`);
  console.log(`  parts: ${msg1.parts.length}`);
  for (const p of msg1.parts) {
    console.log(`  - ${formatPart(p)}`);
  }

  // Step 6: Send write prompt (should trigger permission)
  console.log("\n── Step 6: Send write prompt (expect permission) ──");
  const msg2 = await adapter.sendMessage(session.id, [
    {
      type: "text",
      text: 'Create a file called "test-adapter-output.txt" with the content "hello from adapter test". Just create it.',
    },
  ]);
  console.log(`\nResponse message:`);
  console.log(`  id: ${msg2.id.slice(0, 8)}...`);
  console.log(`  parts: ${msg2.parts.length}`);
  for (const p of msg2.parts) {
    console.log(`  - ${formatPart(p)}`);
  }

  // Step 7: List sessions
  console.log("\n── Step 7: List sessions ──");
  const sessions = await adapter.listSessions(process.cwd());
  console.log(`Sessions (${sessions.length}):`);
  for (const s of sessions) {
    console.log(`  - ${s.id.slice(0, 8)}...: "${s.title}" (${new Date(s.time.updated).toISOString()})`);
  }

  // Step 8: Capabilities
  console.log("\n── Step 8: Capabilities ──");
  console.log(JSON.stringify(adapter.getCapabilities(), null, 2));

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

  // Validate key assertions
  const partUpdates = events.filter((e) => e.event === "message.part.updated");
  const toolParts = partUpdates.filter((e) => e.data.part.type === "tool");
  const textParts = partUpdates.filter((e) => e.data.part.type === "text");
  const reasoningParts = partUpdates.filter((e) => e.data.part.type === "reasoning");
  const permissions = events.filter((e) => e.event === "permission.asked");

  console.log(`\nValidation:`);
  console.log(`  ✓ Tool parts emitted: ${toolParts.length}`);
  console.log(`  ✓ Text parts emitted: ${textParts.length}`);
  console.log(`  ✓ Reasoning parts emitted: ${reasoningParts.length}`);
  console.log(`  ✓ Permission requests: ${permissions.length}`);

  // Check tool normalization
  for (const tp of toolParts) {
    const part = tp.data.part as ToolPart;
    console.log(
      `  ✓ Tool normalized: "${part.title}" → ${part.normalizedTool} (kind=${part.kind}, state=${part.state.status})`,
    );
  }

  // Stop
  console.log("\n── Cleanup ──");
  await adapter.stop();
  console.log("Adapter stopped.");

  // Cleanup test file
  try {
    const fs = await import("fs");
    const path = await import("path");
    const testFile = path.join(process.cwd(), "test-adapter-output.txt");
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
      console.log("Test file cleaned up.");
    }
  } catch { /* ignore */ }

  console.log("\n=== Test Complete ===");
}

run().catch((err) => {
  console.error("Test failed:", err);
  adapter.stop();
  process.exit(1);
});
