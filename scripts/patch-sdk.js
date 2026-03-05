// Patch @anthropic-ai/claude-agent-sdk to pass cwd from SDKSessionOptions to ProcessTransport
// The V2 API (unstable_v2_createSession) internally creates a SessionImpl (SQ) which
// constructs a ProcessTransport (V4) without passing cwd, so the CLI subprocess
// inherits the parent process's cwd instead of the intended project directory.

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sdkPath = join(
  __dirname,
  "..",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "sdk.mjs",
);

let content = readFileSync(sdkPath, "utf8");

// The target: in SessionImpl (minified as SQ), the V4 constructor call ends with
// "resumeSessionAt:void 0})" but does NOT include "cwd:Q.cwd".
// We add it to pass the working directory through.

const target = "resumeSessionAt:void 0});";
const replacement = "resumeSessionAt:void 0,cwd:Q.cwd});";

if (content.includes(replacement)) {
  console.log("[patch-sdk] Already patched, skipping.");
  process.exit(0);
}

if (!content.includes(target)) {
  console.error("[patch-sdk] ERROR: target string not found in sdk.mjs");
  console.error("[patch-sdk] SDK may have been updated. Check if patch is still needed.");
  process.exit(1);
}

content = content.replace(target, replacement);
writeFileSync(sdkPath, content);
console.log("[patch-sdk] Successfully patched sdk.mjs: cwd now passed to ProcessTransport");
