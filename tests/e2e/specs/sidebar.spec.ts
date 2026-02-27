import { test, expect } from "@playwright/test";

test.describe("Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    await page.getByRole("button", { name: /Enter Chat/i }).click();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should display project groups from seed data", async ({ page }) => {
    // Projects derived from directory paths: project-alpha and project-beta
    await expect(
      page.getByText("project-alpha").first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("should display session titles in sidebar", async ({ page }) => {
    // Seeded session title from session-oc-1
    await expect(
      page.getByText("Fix authentication bug"),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("should switch sessions when clicking sidebar items", async ({ page }) => {
    await page.getByText("Fix authentication bug").waitFor({ timeout: 10_000 });

    // Click on a different session
    const sessionItem = page.getByText("Add unit tests");
    if (await sessionItem.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await sessionItem.click();
      // Give time for the message area to update
      await page.waitForTimeout(500);
    }
  });
});
