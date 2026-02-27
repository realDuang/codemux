// ============================================================================
// Playwright Extended Fixtures
// Provides pre-configured test utilities for CodeMux E2E tests.
// ============================================================================

import { test as base, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServerInstance } from "./test-server";
import { seedTestData } from "./seed-data";

// Shared test server instance (set by global setup)
let server: TestServerInstance | null = null;

export const test = base.extend<{
  /** Page already navigated to the app */
  appPage: Page;
}>({
  appPage: async ({ page }, use) => {
    if (!server) {
      throw new Error("Test server not started. Ensure global-setup ran.");
    }
    await page.goto(server.baseUrl);
    await use(page);
  },
});

export { expect };

export async function setupTestServer(): Promise<TestServerInstance> {
  server = await startTestServer({ port: 0 });
  seedTestData(server.mockAdapters);
  return server;
}

export async function teardownTestServer(): Promise<void> {
  if (server) {
    await server.stop();
    server = null;
  }
}

export function getServer(): TestServerInstance {
  if (!server) {
    throw new Error("Test server not started");
  }
  return server;
}
