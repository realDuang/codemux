// ============================================================================
// Playwright Global Setup — Start test server before all E2E tests
// ============================================================================

import { startTestServer, type TestServerInstance } from "./setup/test-server";
import { seedTestData } from "./setup/seed-data";

export let server: TestServerInstance | null = null;

async function globalSetup(): Promise<void> {
  server = await startTestServer({ port: 0 });
  seedTestData(server.mockAdapters);
  await server.registerSessionRoutes();

  // Store URLs in environment so tests can access them
  process.env.TEST_BASE_URL = server.baseUrl;
  process.env.TEST_WS_URL = server.wsUrl;
}

export default globalSetup;
