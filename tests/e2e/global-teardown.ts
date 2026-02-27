// ============================================================================
// Playwright Global Teardown — Stop test server after all E2E tests
// ============================================================================

async function globalTeardown(): Promise<void> {
  const { server } = await import("./global-setup");
  if (server) {
    await server.stop();
  }
}

export default globalTeardown;
