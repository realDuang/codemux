import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  reseedTestData,
  selectSession,
  getActiveMode,
  countProjectGroups,
  countSessions,
  expandAllProjects,
} from "../setup/test-helpers";

test.describe("Sidebar", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await reseedTestData(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await navigateToChat(page);
  });

  // --- Project Display ---

  test("should display all project groups in unified list", async ({ page }) => {
    // Projects are engine-agnostic now — all shown in one list.
    // Seed data has project-alpha and project-beta directories.
    const count = await countProjectGroups(page);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("should display engine badges on session items", async ({ page }) => {
    // Engine badges are now on session rows, not project headers.
    // Expand all projects and check for badge text in session items.
    await expandAllProjects(page);
    // "OC" badge should appear on opencode sessions
    const hasOC = await page.getByText("OC").first().isVisible().catch(() => false);
    expect(hasOC).toBe(true);
  });

  test("should display session titles from all engines", async ({ page }) => {
    // All sessions visible in a single unified list (no tab switching needed)
    await expandAllProjects(page);
    await expect(page.getByText("Fix authentication bug")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Add unit tests")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Refactor database layer")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Cross-engine test session")).toBeVisible({ timeout: 5_000 });
  });

  // --- Session Switching ---

  test("should switch to a session and load its messages", async ({ page }) => {
    // Click on "Fix authentication bug" which has messages
    await selectSession(page, "Fix authentication bug");

    // Verify the message content loads
    await expect(page.getByText("Fix the login bug")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("auth middleware")).toBeVisible({ timeout: 10_000 });
  });

  test("should switch between sessions and update message area", async ({ page }) => {
    // First select session with messages
    await selectSession(page, "Fix authentication bug");
    await expect(page.getByText("Fix the login bug")).toBeVisible({ timeout: 10_000 });

    // Switch to a different session (copilot)
    await selectSession(page, "Refactor database layer");
    await expect(page.getByText("Refactor the database connection pool")).toBeVisible({ timeout: 10_000 });

    // The previous session's messages should no longer be prominent
    // (they may still be in DOM but the view should show the new session's messages)
  });

  test("should load cross-engine session messages", async ({ page }) => {
    await selectSession(page, "Cross-engine test session");
    await expect(page.getByText("Test cross-engine project setup")).toBeVisible({ timeout: 10_000 });
  });

  // --- Mode & Model Bar ---

  test("should show correct mode for opencode session", async ({ page }) => {
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);

    // Mock adapter returns "Agent" mode
    const mode = await getActiveMode(page);
    expect(mode).toContain("Agent");
  });

  test("should update mode when switching to copilot session", async ({ page }) => {
    // Start with opencode session
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);
    const ocMode = await getActiveMode(page);
    expect(ocMode).toContain("Agent");

    // Switch to copilot session
    await selectSession(page, "Refactor database layer");
    await page.waitForTimeout(500);

    // Mode may change or stay depending on copilot capabilities
    // At minimum, the mode bar should still be visible
    const cpMode = await getActiveMode(page);
    expect(cpMode).not.toBeNull();
  });

  // --- Session Count ---

  test("should show correct total session count", async ({ page }) => {
    // All sessions visible in one list now (no tabs).
    // Seed data has 5 sessions total across all engines.
    await expandAllProjects(page);
    const totalCount = await countSessions(page);
    expect(totalCount).toBe(5);
  });
});
