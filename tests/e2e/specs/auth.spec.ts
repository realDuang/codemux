import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("should open chat directly on the host", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    // Localhost host mode authenticates and lands on chat without the entry page
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should keep the connection center reachable and return to chat", async ({ page }) => {
    await page.goto(`${process.env.TEST_BASE_URL!}/connections`);
    await page.getByRole("button", { name: /Open local chat/i }).click();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should persist authentication across page reloads", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });

    // Reload — token in localStorage should keep us authenticated
    await page.reload();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });
});
