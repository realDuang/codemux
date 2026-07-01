import { test, expect } from "@playwright/test";

test.describe("Theme & Language", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL!);
    await page.getByRole("button", { name: /Enter Chat/i }).click();
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should toggle theme between light and dark", async ({ page }) => {
    // ThemeSwitcher is on the Settings page — navigate there first
    await page.getByRole("button", { name: /Settings/i }).click();
    await page.waitForTimeout(500);

    // Normalize starting state to Light so the toggle assertion is deterministic
    // regardless of the app's default theme.
    const themeToggle = page.getByRole("button", { name: /Light|Dark|System|亮色|暗色|跟随系统/i });
    await themeToggle.click();
    await page.waitForTimeout(300);
    const lightOption = page.getByRole("button", { name: /^(Light|亮色)$/i });
    await lightOption.click();
    await page.waitForTimeout(300);
    await expect(page.locator("html")).not.toHaveClass(/dark/, { timeout: 5_000 });

    // Open the theme dropdown again and switch to Dark
    await themeToggle.click();
    await page.waitForTimeout(300);
    const darkOption = page.getByRole("button", { name: /^(Dark|暗色)$/i });
    await darkOption.click();
    await page.waitForTimeout(300);

    // <html> should now have "dark" class
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 5_000 });
  });

  test("should switch language", async ({ page }) => {
    await page.getByRole("button", { name: /Settings|设置|Настройки/i }).click();
    await page.waitForTimeout(500);

    const langSwitcher = page.getByRole("button", { name: /English|简体中文|Русский/i }).first();
    await expect(langSwitcher).toBeVisible({ timeout: 5_000 });

    await langSwitcher.click();
    await page.getByRole("button", { name: /简体中文/i }).click();

    await expect(page.getByRole("button", { name: /简体中文/i }).first()).toBeVisible({ timeout: 5_000 });
  });
});
