import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  reseedTestData,
  selectSession,
  typeAndSend,
  setSlowMode,
  clickCancelButton,
} from "../setup/test-helpers";

test.describe("Message Cancel", () => {
  test.beforeEach(async ({ page }) => {
    await reseedTestData(page);
    await navigateToChat(page);
  });

  test.afterEach(async ({ page }) => {
    // Always reset slow mode to avoid affecting other tests
    await setSlowMode(page, "opencode", 0);
  });

  test("should not show Stop button when idle", async ({ page }) => {
    await selectSession(page, "Add unit tests");
    await expect(page.getByText("Start a new conversation")).toBeVisible({ timeout: 10_000 });

    // Stop button should not be visible when not generating
    const stopButton = page.locator('button[aria-label="Stop"]');
    await expect(stopButton).not.toBeVisible();
  });

  test("should show Stop button while message is generating", async ({ page }) => {
    await selectSession(page, "Add unit tests");
    await expect(page.getByText("Start a new conversation")).toBeVisible({ timeout: 10_000 });

    // Enable slow mode so the response takes a long time
    await setSlowMode(page, "opencode", 30_000);

    // Send a message — this will hang for 30s unless cancelled
    await typeAndSend(page, "slow test");

    // Stop button should appear while generating
    const stopButton = page.locator('button[aria-label="Stop"]');
    await expect(stopButton).toBeVisible({ timeout: 5_000 });
  });

  test("should cancel a generating message and re-enable input", async ({ page }) => {
    await selectSession(page, "Add unit tests");
    await expect(page.getByText("Start a new conversation")).toBeVisible({ timeout: 10_000 });

    // Enable slow mode
    await setSlowMode(page, "opencode", 30_000);

    // Send a message
    await typeAndSend(page, "cancel me");

    // Wait for Stop button to appear
    const stopButton = page.locator('button[aria-label="Stop"]');
    await expect(stopButton).toBeVisible({ timeout: 5_000 });

    // Click cancel
    await clickCancelButton(page);

    // Stop button should disappear
    await expect(stopButton).not.toBeVisible({ timeout: 5_000 });

    // Textarea should be re-enabled and ready for input
    const textarea = page.locator("textarea");
    await expect(textarea).toBeEnabled({ timeout: 5_000 });
  });
});
