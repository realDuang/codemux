import { test, expect } from "@playwright/test";

test.describe("Settings", () => {
  test("should display settings page with engine info", async ({ page }) => {
    // Auth first, then navigate to settings
    await page.goto(process.env.TEST_BASE_URL!);
    await page.getByRole("button", { name: /Enter Chat/i }).click();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });

    // Navigate to settings via SPA sidebar button (preserves store state)
    await page.getByRole("button", { name: /Settings/i }).click();

    // Settings page should have heading
    await expect(
      page.getByText(/settings/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("should show mock engine status", async ({ page }) => {
    // Auth first
    await page.goto(process.env.TEST_BASE_URL!);
    await page.getByRole("button", { name: /Enter Chat/i }).click();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });

    // Wait for sessions to load, proving WebSocket is connected and engines are loaded
    await page.getByText("Fix authentication bug").waitFor({ timeout: 10_000 });

    // Navigate to settings via SPA sidebar button (preserves configStore.engines)
    await page.getByRole("button", { name: /Settings/i }).click();

    // Should show mock engine names (from engine.name: "Mock OpenCode" / "Mock Copilot")
    await expect(
      page.getByText(/Mock OpenCode|Mock Copilot/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
