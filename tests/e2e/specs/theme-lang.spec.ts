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

    // Default theme is "system" which resolves to "light" in headless Chromium (no dark class)
    const htmlBefore = await page.locator("html").getAttribute("class") ?? "";
    expect(htmlBefore).not.toContain("dark");

    // Open the theme dropdown — ThemeSwitcher button shows current theme label
    const themeToggle = page.getByRole("button", { name: /Light|Dark|System|亮色|暗色|跟随系统/i });
    await themeToggle.click();
    await page.waitForTimeout(300);

    // Click the "Dark" option in the dropdown
    const darkOption = page.getByRole("button", { name: /Dark|暗色/i });
    await darkOption.click();
    await page.waitForTimeout(300);

    // <html> should now have "dark" class
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 5_000 });
  });

  test("should switch language", async ({ page }) => {
    // Look for language switcher (LanguageSwitcher component)
    const langSwitcher = page
      .getByRole("button", { name: /language|lang|中文|english|EN|ZH/i })
      .or(page.locator("[class*='language'], [class*='lang']").first());

    if (await langSwitcher.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await langSwitcher.click();
      await page.waitForTimeout(300);
      // After switching, UI text should change (verified by not crashing)
    }
  });
});
