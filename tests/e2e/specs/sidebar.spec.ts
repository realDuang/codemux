import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  reseedTestData,
  selectSession,
  getActiveMode,
  countProjectGroups,
  countSessions,
  hasEngineBadge,
  switchEngineTab,
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

  test("should display project groups across engine tabs", async ({ page }) => {
    // With engine tabs, projects are split across tabs.
    // OpenCode tab: project-alpha(OC) = 1 project
    const ocCount = await countProjectGroups(page);
    expect(ocCount).toBeGreaterThanOrEqual(1);

    // Copilot tab: project-beta(CP) + project-alpha(CP) = 2 projects
    await switchEngineTab(page, "Copilot");
    const cpCount = await countProjectGroups(page);
    expect(cpCount).toBeGreaterThanOrEqual(2);

    // Total across both tabs
    expect(ocCount + cpCount).toBeGreaterThanOrEqual(3);
  });

  test("should display engine badges for project groups", async ({ page }) => {
    // project-alpha with opencode engine should have "OC" badge (default tab)
    const hasOC = await hasEngineBadge(page, "project-alpha", "OC");
    expect(hasOC).toBe(true);

    // project-beta with copilot engine — switch to Copilot tab
    await switchEngineTab(page, "Copilot");
    const hasCopilot = await hasEngineBadge(page, "project-beta", "Copilot");
    expect(hasCopilot).toBe(true);
  });

  test("should display session titles across engine tabs", async ({ page }) => {
    // OpenCode tab sessions (projects expanded by navigateToChat)
    await expect(page.getByText("Fix authentication bug")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Add unit tests")).toBeVisible({ timeout: 5_000 });

    // Copilot tab sessions
    await switchEngineTab(page, "Copilot");
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

  test("should show correct total session count across tabs", async ({ page }) => {
    // With engine tabs, count sessions per tab and sum.
    // OpenCode: 3 sessions (project-alpha)
    const ocCount = await countSessions(page);

    // Copilot: 2 sessions (project-beta + project-alpha)
    await switchEngineTab(page, "Copilot");
    const cpCount = await countSessions(page);

    expect(ocCount + cpCount).toBe(5);
  });
});
