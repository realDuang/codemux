import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  reseedTestData,
  selectSession,
  getActiveMode,
  switchMode,
  typeAndSend,
} from "../setup/test-helpers";

test.describe("Mode Switching", () => {
  test.beforeEach(async ({ page }) => {
    await reseedTestData(page);
    await navigateToChat(page);
  });

  test("should show Agent as default active mode", async ({ page }) => {
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);

    const mode = await getActiveMode(page);
    expect(mode).toContain("Agent");
  });

  test("should switch from Agent to Plan mode", async ({ page }) => {
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);

    // Verify starting in Agent mode
    let mode = await getActiveMode(page);
    expect(mode).toContain("Agent");

    // Switch to Plan
    await switchMode(page, "Plan");

    mode = await getActiveMode(page);
    expect(mode).toContain("Plan");
  });

  test("should switch from Plan back to Agent mode", async ({ page }) => {
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);

    // Switch to Plan first
    await switchMode(page, "Plan");
    let mode = await getActiveMode(page);
    expect(mode).toContain("Plan");

    // Switch back to Agent
    await switchMode(page, "Agent");
    mode = await getActiveMode(page);
    expect(mode).toContain("Agent");
  });

  test("should preserve mode when switching sessions and back", async ({ page }) => {
    // Select first session and set Plan mode
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);
    await switchMode(page, "Plan");
    let mode = await getActiveMode(page);
    expect(mode).toContain("Plan");

    // Switch to a different session
    await selectSession(page, "Add unit tests");
    await page.waitForTimeout(500);

    // Switch back to original session — mode should still be Plan
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);
    mode = await getActiveMode(page);
    expect(mode).toContain("Plan");
  });

  test("should send message in Plan mode", async ({ page }) => {
    await selectSession(page, "Add unit tests");
    await expect(page.getByText("Start a new conversation")).toBeVisible({ timeout: 10_000 });

    // Switch to Plan mode before sending
    await switchMode(page, "Plan");
    const mode = await getActiveMode(page);
    expect(mode).toContain("Plan");

    // Send a message — mock adapter should respond normally
    await typeAndSend(page, "3+3");
    await expect(
      page.getByText("The answer is 6").first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
