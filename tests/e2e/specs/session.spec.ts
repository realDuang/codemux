import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  reseedTestData,
  selectSession,
  typeAndSend,
} from "../setup/test-helpers";

test.describe("Session – Loading", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await reseedTestData(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await navigateToChat(page);
  });

  test("should load existing messages for a seeded session", async ({ page }) => {
    await selectSession(page, "Fix authentication bug");

    // Should display the seeded assistant response text
    await expect(
      page.getByText(/token validation|auth middleware/i),
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Session – Messaging", () => {
  test.beforeEach(async ({ page }) => {
    await reseedTestData(page);
    await navigateToChat(page);
  });

  test("should send a math message and receive computed response", async ({ page }) => {
    await selectSession(page, "Add unit tests");

    // Wait for session messages to finish loading (empty session shows "Start a new conversation")
    await expect(page.getByText("Start a new conversation")).toBeVisible({ timeout: 10_000 });

    await typeAndSend(page, "2+2");

    // Wait for user message to confirm submission worked
    await expect(page.getByText("2+2").first()).toBeVisible({ timeout: 5_000 });

    // Mock adapter returns "The answer is 4"
    await expect(
      page.getByText("The answer is 4").first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("should send a text message and receive echo response", async ({ page }) => {
    await selectSession(page, "Improve error handling");

    // Wait for session messages to finish loading (empty session shows "Start a new conversation")
    await expect(page.getByText("Start a new conversation")).toBeVisible({ timeout: 10_000 });

    await typeAndSend(page, "Hello world");

    // Wait for user message
    await expect(page.getByText("Hello world").first()).toBeVisible({ timeout: 5_000 });

    // Mock adapter returns "This is a mock response to: Hello world"
    await expect(
      page.getByText("This is a mock response to: Hello world").first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
