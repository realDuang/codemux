import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("should show entry page on first visit", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    // Entry page shows "Open local chat" for localhost host mode
    await expect(
      page.getByRole("button", { name: /Open local chat/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("should authenticate and redirect to chat", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    await page.getByRole("button", { name: /Open local chat/i }).click();
    // Should navigate to /chat after local auth succeeds
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should persist authentication across page reloads", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    await page.getByRole("button", { name: /Open local chat/i }).click();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });

    // Reload — token in localStorage should keep us authenticated
    await page.reload();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });
});
