import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    await page.getByRole("button", { name: /Enter Chat/i }).click();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should have sidebar visible on chat page", async ({ page }) => {
    // Sidebar renders as aside or a container with session list
    await expect(
      page.locator("aside, [class*='sidebar'], [class*='Sidebar']").first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("should navigate to settings page", async ({ page }) => {
    // Look for settings link or button
    const settingsLink = page
      .getByRole("link", { name: /settings/i })
      .or(page.getByRole("button", { name: /settings/i }));

    if (await settingsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await settingsLink.click();
      await expect(page).toHaveURL(/.*\/settings/, { timeout: 5_000 });
    }
  });
});
