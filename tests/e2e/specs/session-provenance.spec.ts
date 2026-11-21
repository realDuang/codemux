import { test, expect } from "@playwright/test";
import { startTestServer, type TestServerInstance } from "../setup/test-server";
import { seedTestData } from "../setup/seed-data";
import { expandAllProjects, selectSession } from "../setup/test-helpers";

let server: TestServerInstance;

test.beforeAll(async () => {
  server = await startTestServer({ port: 0, sessionSources: [{
    id: "vscode", peerName: "Agent Host", kind: "attach", enabled: true,
    available: false, status: "unavailable", providers: [],
  }] });
  seedTestData(server.mockAdapters);
  const adapter = server.mockAdapters.get("opencode")!;
  for (const [id, title, connection] of [
    ["source-only", "Shared host chat", { source: "Agent Host", executor: "Agent Host", shared: true, available: true }],
    ["known-creator", "Known creator chat", { source: "Agent Host", origin: "Verified app", executor: "Agent Host", shared: true, available: true }],
    ["legacy-origin", "Existing origin chat", { origin: "Codex", executor: "CodeMux", shared: false, available: true }],
  ] as const) {
    adapter.seedSession({ id, title, engineType: "opencode", directory: "/test/project-alpha",
      time: { created: Date.now(), updated: Date.now() }, connection });
  }
  await server.registerSessionRoutes();
});

test.afterAll(async () => { await server?.stop(); });

test.beforeEach(async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByText("project-alpha").first()).toBeVisible();
  await expandAllProjects(page);
});

for (const locale of [
  { code: "en", source: "Connection source", origin: "Creating app", unknown: "Unknown", executor: "Current executor", via: "Connected via Agent Host" },
  { code: "zh", source: "接入来源", origin: "创建应用", unknown: "未知", executor: "当前执行端", via: "通过 Agent Host 接入" },
  { code: "ru", source: "Источник подключения", origin: "Приложение создания", unknown: "Неизвестно", executor: "Текущий исполнитель", via: "Подключено через Agent Host" },
]) {
  test(`separates connection source from unknown creator in ${locale.code}`, async ({ page }, testInfo) => {
    await selectSession(page, "Shared host chat");
    await page.evaluate(code => {
      localStorage.setItem("settings:locale", JSON.stringify(code));
      localStorage.setItem("settings:theme", JSON.stringify(code === "en" ? "light" : "dark"));
    }, locale.code);
    await page.reload();
    const badge = page.locator("[data-session-origin]").filter({ hasText: "Agent Host" });
    await expect(badge).toHaveAttribute("title", locale.via);
    await page.locator("[data-session-connection]").click();
    const details = page.locator('[role="region"]').filter({ has: page.locator("dl") });
    for (const [label, value] of [[locale.source, "Agent Host"], [locale.origin, locale.unknown], [locale.executor, "Agent Host"]]) {
      await expect(details.locator("dt").filter({ hasText: label }).locator("+ dd")).toHaveText(value);
    }
    await expect(details).not.toContainText("VS Code");
    if (locale.code === "zh") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "dark" });
      const bounds = await details.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    }
    await expect(page.locator('[data-component="notification-toasts"] > div')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`provenance-${locale.code}.png`) });
  });
}

test("keeps verified creators and existing origin-only badges distinct from connection sources", async ({ page }) => {
  await selectSession(page, "Known creator chat");
  await expect(page.locator('[data-session-origin]').filter({ hasText: "Verified app" }))
    .toHaveAttribute("title", "Created in Verified app");
  await page.locator("[data-session-connection]").click();
  const details = page.locator('[role="region"]').filter({ has: page.locator("dl") });
  await expect(details.locator("dt").filter({ hasText: "Creating app" }).locator("+ dd")).toHaveText("Verified app");
  await expect(details.locator("dt").filter({ hasText: "Connection source" }).locator("+ dd")).toHaveText("Agent Host");
  await page.keyboard.press("Escape");
  await selectSession(page, "Existing origin chat");
  await expect(page.locator('[data-session-origin]').filter({ hasText: "Codex" }))
    .toHaveAttribute("title", "Created in Codex");
  await page.locator("[data-session-connection]").click();
  await expect(details.locator("dt").filter({ hasText: "Connection source" })).toHaveCount(0);
  await expect(details.locator("dt").filter({ hasText: "Current executor" }).locator("+ dd")).toHaveText("CodeMux");
});

test("describes the source as an access channel rather than a creating app", async ({ page }, testInfo) => {
  await page.goto(`${server.baseUrl}/settings`);
  const panel = page.locator("[data-session-source-settings]");
  await expect(panel.getByRole("switch", { name: "Connect to Agent Host chats" })).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText("They may have been created by different apps");
  await expect(panel).toContainText("Start the original executor on this computer to reconnect");
  await panel.screenshot({ path: testInfo.outputPath("source-settings.png") });
});
