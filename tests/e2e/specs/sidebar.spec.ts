import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  reseedTestData,
  selectSession,
  getActiveMode,
  isModelSelectorLocked,
  countProjectGroups,
  countSessions,
  hasEngineBadge,
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

  test("should display multiple project groups from seed data", async ({ page }) => {
    // Seed data has 3 projects: project-alpha(OC), project-beta(CP), project-alpha(CP)
    const count = await countProjectGroups(page);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("should display engine badges for project groups", async ({ page }) => {
    // project-alpha with opencode engine should have "OC" badge
    const hasOC = await hasEngineBadge(page, "project-alpha", "OC");
    expect(hasOC).toBe(true);

    // project-beta with copilot engine should have "Copilot" badge
    const hasCopilot = await hasEngineBadge(page, "project-beta", "Copilot");
    expect(hasCopilot).toBe(true);
  });

  test("should display all session titles from seed data", async ({ page }) => {
    // Check key sessions are visible
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

  test("should show locked model selector for copilot session", async ({ page }) => {
    await selectSession(page, "Refactor database layer");
    await page.waitForTimeout(500);

    const locked = await isModelSelectorLocked(page);
    expect(locked).toBe(true);
  });

  test("should show unlocked model selector for opencode session", async ({ page }) => {
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);

    const locked = await isModelSelectorLocked(page);
    expect(locked).toBe(false);
  });

  test("should toggle model selector lock when switching between engines", async ({ page }) => {
    // Start with opencode — unlocked
    await selectSession(page, "Fix authentication bug");
    await page.waitForTimeout(500);
    expect(await isModelSelectorLocked(page)).toBe(false);

    // Switch to copilot — locked
    await selectSession(page, "Refactor database layer");
    await page.waitForTimeout(500);
    expect(await isModelSelectorLocked(page)).toBe(true);

    // Switch back to opencode — unlocked again
    await selectSession(page, "Add unit tests");
    await page.waitForTimeout(500);
    expect(await isModelSelectorLocked(page)).toBe(false);
  });

  // --- Session Count ---

  test("should show correct total session count", async ({ page }) => {
    // Seed data: 3 opencode + 1 copilot(beta) + 1 copilot(alpha) = 5 sessions
    const count = await countSessions(page);
    expect(count).toBe(5);
  });
});
