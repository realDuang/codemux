/**
 * Web Mode API Smoke Test
 *
 * Tests the standalone web mode API endpoints to ensure they work correctly.
 * This script:
 * 1. Starts Vite dev server (without OpenCode)
 * 2. Tests key API endpoints
 * 3. Reports results
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

const isWindows = process.platform === "win32";
const BASE_URL = "http://localhost:5174";

// Store auth token and access code for tests that need them
let authToken: string = "";
let accessCode: string = "";

// ANSI colors
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Wait for server to be ready
async function waitForServer(
  url: string,
  maxAttempts = 30,
  interval = 1000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

// Test result type
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

// Run a single test
async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<TestResult> {
  try {
    await testFn();
    log(`  [PASS] ${name}`, "green");
    return { name, passed: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`  [FAIL] ${name}: ${errorMessage}`, "red");
    return { name, passed: false, error: errorMessage };
  }
}

// Assert helper
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// API Tests
async function testSystemInfo(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/system/info`);
  assert(response.ok, `Expected 200, got ${response.status}`);

  const data = await response.json();
  assert(typeof data.localIp === "string", "localIp should be a string");
  assert(typeof data.port === "number", "port should be a number");
}

async function testIsLocal(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/system/is-local`);
  assert(response.ok, `Expected 200, got ${response.status}`);

  const data = await response.json();
  assert(typeof data.isLocal === "boolean", "isLocal should be a boolean");
  // From localhost, should be true
  assert(data.isLocal === true, "isLocal should be true from localhost");
}

async function testLocalAuth(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/auth/local-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName: "CI Test Device" }),
  });

  assert(response.ok, `Expected 200, got ${response.status}`);

  const data = await response.json();
  assert(typeof data.token === "string", "token should be a string");
  assert(data.token.length > 0, "token should not be empty");

  // Save token for subsequent tests
  authToken = data.token;
}

async function testAuthCode(): Promise<void> {
  assert(authToken.length > 0, "authToken should be set from previous test");

  const response = await fetch(`${BASE_URL}/api/auth/code`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  assert(response.ok, `Expected 200, got ${response.status}`);

  const data = await response.json();
  assert(typeof data.code === "string", "code should be a string");
  assert(data.code.length === 6, "code should be 6 digits");

  // Save code for subsequent tests
  accessCode = data.code;
}

async function testAuthVerifyInvalid(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "000000" }),
  });

  assert(response.status === 401, `Expected 401, got ${response.status}`);
}

async function testAuthVerifyValid(): Promise<void> {
  assert(accessCode.length === 6, "accessCode should be set from previous test");

  const response = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: accessCode }),
  });

  assert(response.ok, `Expected 200, got ${response.status}`);

  const data = await response.json();
  assert(typeof data.token === "string", "token should be a string");
  assert(data.token.length > 0, "token should not be empty");
}

async function testDevicesList(): Promise<void> {
  assert(authToken.length > 0, "authToken should be set from previous test");

  const response = await fetch(`${BASE_URL}/api/devices`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  assert(response.ok, `Expected 200, got ${response.status}`);

  const data = await response.json();
  assert(Array.isArray(data.devices), "devices should be an array");
}

async function testTunnelStatus(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/tunnel/status`);
  assert(response.ok, `Expected 200, got ${response.status}`);

  const data = await response.json();
  assert(typeof data.status === "string", "status should be a string");
  assert(
    ["stopped", "starting", "running", "error"].includes(data.status),
    `status should be one of stopped/starting/running/error, got ${data.status}`
  );
}

// Main test runner
async function main() {
  let viteProcess: ChildProcess | null = null;
  const devicesPath = path.join(process.cwd(), ".devices.json");

  try {
    log("\n=== Web Mode API Smoke Test ===\n", "cyan");

    // Clean up any existing test files
    if (fs.existsSync(devicesPath)) {
      fs.unlinkSync(devicesPath);
    }

    // Start Vite server
    log("> Starting Vite dev server...", "cyan");
    viteProcess = spawn("vite", ["--host", "--port", "5174"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      env: {
        ...process.env,
        // Don't need OpenCode API for these tests
        VITE_OPENCODE_API: "http://localhost:4096",
      },
    });

    // Capture output for debugging
    viteProcess.stdout?.on("data", (data) => {
      const output = data.toString();
      if (output.includes("Local:") || output.includes("ready")) {
        log(`  Vite: ${output.trim()}`, "cyan");
      }
    });

    viteProcess.stderr?.on("data", (data) => {
      const output = data.toString();
      // Only show errors, not warnings
      if (output.toLowerCase().includes("error")) {
        log(`  Vite Error: ${output.trim()}`, "red");
      }
    });

    // Wait for server to be ready
    log("> Waiting for server to be ready...", "cyan");
    const serverReady = await waitForServer(`${BASE_URL}/api/system/info`);
    if (!serverReady) {
      throw new Error("Server failed to start within timeout");
    }
    log("  Server is ready!\n", "green");

    // Run tests (order matters - some tests depend on previous ones)
    log("> Running API tests...\n", "cyan");

    const results: TestResult[] = [];

    // System tests (no auth required)
    results.push(await runTest("GET /api/system/info", testSystemInfo));
    results.push(await runTest("GET /api/system/is-local", testIsLocal));

    // Auth tests (in order: local-auth -> get code -> verify)
    results.push(await runTest("POST /api/auth/local-auth", testLocalAuth));
    results.push(await runTest("GET /api/auth/code", testAuthCode));
    results.push(
      await runTest("POST /api/auth/verify (invalid)", testAuthVerifyInvalid)
    );
    results.push(
      await runTest("POST /api/auth/verify (valid)", testAuthVerifyValid)
    );

    // Device tests (requires auth)
    results.push(await runTest("GET /api/devices", testDevicesList));

    // Tunnel tests
    results.push(await runTest("GET /api/tunnel/status", testTunnelStatus));

    // Summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    log("\n=== Test Summary ===", "cyan");
    log(`  Passed: ${passed}`, "green");
    if (failed > 0) {
      log(`  Failed: ${failed}`, "red");
    }
    log("");

    if (failed > 0) {
      cleanup(viteProcess, devicesPath, 1);
      return;
    }

    log("All tests passed!", "green");
    cleanup(viteProcess, devicesPath, 0);
  } catch (error) {
    log(`\nFatal error: ${error}`, "red");
    cleanup(viteProcess, devicesPath, 1);
  }
}

function cleanup(viteProcess: ChildProcess | null, devicesPath: string, exitCode: number) {
  if (viteProcess) {
    log("\n> Shutting down server...", "cyan");
    viteProcess.kill("SIGTERM");
  }

  // Give it a moment to cleanup, then force exit
  setTimeout(() => {
    if (fs.existsSync(devicesPath)) {
      try {
        fs.unlinkSync(devicesPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    process.exit(exitCode);
  }, 500);
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
