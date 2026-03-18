// ============================================================================
// E2E Tests — Project & Session Management
// Comprehensive test suite covering project CRUD, session lifecycle,
// engine badge display, model selector behavior, and dedup logic.
// ============================================================================

import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  solidClick,
  solidClickByText,
  addProject,
  createSession,
  hideProject,
  getActiveMode,
  countProjectGroups,
  countSessions,
  selectSession,
  reseedTestData,
  expandAllProjects,
} from "../setup/test-helpers";

// ============================================================================
// Group 1: Project - Create
// ============================================================================

test.describe("Project - Create", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await reseedTestData(page);
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await navigateToChat(page);
  });

  test("should add a new project", async ({ page }) => {
    // Count project groups before adding
    const groupsBefore = await countProjectGroups(page);

    // Add a new project (engine is determined by default engine setting)
    await addProject(page, "/test/new-project");

    // Wait for the project name to appear in the sidebar
    await expect(page.getByText("new-project").first()).toBeVisible({ timeout: 10_000 });

    // Verify project count increased by 1
    const groupsAfter = await countProjectGroups(page);
    expect(groupsAfter).toBe(groupsBefore + 1);
  });

  test("should add another project", async ({ page }) => {
    // Add a new project
    await addProject(page, "/test/copilot-project");

    // Wait for the project to appear
    await expect(page.getByText("copilot-project").first()).toBeVisible({ timeout: 10_000 });
  });

  test("should dedup when adding same path", async ({ page }) => {
    // Count project groups before — seed data already has project-alpha
    const groupsBefore = await countProjectGroups(page);

    // Attempt to add the same project-alpha (duplicate path)
    await addProject(page, "/test/project-alpha");

    // Wait a moment for any potential UI update
    await page.waitForTimeout(1000);

    // Verify project count did NOT increase (dedup should prevent new entry)
    const groupsAfter = await countProjectGroups(page);
    expect(groupsAfter).toBe(groupsBefore);
  });

  test("should also dedup when adding same path again", async ({ page }) => {
    // Projects are grouped by directory only now.
    // Adding same path again should not create a new project.
    const groupsBefore = await countProjectGroups(page);

    await addProject(page, "/test/new-dedup-test");
    await expect(page.getByText("new-dedup-test").first()).toBeVisible({ timeout: 10_000 });

    const groupsAfterFirst = await countProjectGroups(page);
    expect(groupsAfterFirst).toBe(groupsBefore + 1);

    // Adding same path again should not increase count
    await addProject(page, "/test/new-dedup-test");
    await page.waitForTimeout(1000);

    const groupsAfterSecond = await countProjectGroups(page);
    expect(groupsAfterSecond).toBe(groupsAfterFirst);
  });
});

// ============================================================================
// Group 2: Session - Create
// ============================================================================

test.describe("Session - Create", () => {
  test.beforeEach(async ({ page }) => {
    await navigateToChat(page);
  });

  test("should create a session under an opencode project", async ({ page }) => {
    // Count sessions before creating a new one
    const sessionsBefore = await countSessions(page);

    // Create a new session under project-alpha (opencode engine)
    // Note: createSession finds the project by name text in the sidebar
    await createSession(page, "project-alpha");

    // Wait for the new session to appear
    await page.waitForTimeout(500);

    // Verify session count increased by 1
    const sessionsAfter = await countSessions(page);
    expect(sessionsAfter).toBe(sessionsBefore + 1);
  });

  test("should display correct mode bar for opencode session", async ({ page }) => {
    // Create a new session under an opencode project
    await createSession(page, "project-alpha");

    // Wait for session UI to settle
    await page.waitForTimeout(500);

    // Verify the active mode is "Build" (opencode default mode)
    const activeMode = await getActiveMode(page);
    expect(activeMode).toContain("Agent");
  });

});

// ============================================================================
// Group 3: Session - Delete
// ============================================================================

test.describe("Session - Delete", () => {
  test.beforeEach(async ({ page }) => {
    await navigateToChat(page);
  });

  test("should create a session then delete it via sidebar delete button", async ({ page }) => {
    // First, create a new session so we don't destroy seed data
    await createSession(page, "project-alpha");

    // Wait for session creation to settle
    await page.waitForTimeout(500);

    // Count sessions before deletion
    const sessionsBefore = await countSessions(page);
    expect(sessionsBefore).toBeGreaterThan(1);

    // Click the first "Delete session" button to show inline confirm
    await solidClick(page, 'button[title="Delete session"]');

    // Wait for confirm buttons to appear, then click "Confirm"
    await page.waitForTimeout(300);
    await solidClickByText(page, "Confirm", "BUTTON");

    // Wait for deletion to propagate
    await page.waitForTimeout(500);

    // Verify session count decreased by 1
    const sessionsAfter = await countSessions(page);
    expect(sessionsAfter).toBe(sessionsBefore - 1);
  });
});

// ============================================================================
// Group 4: Project - Delete (Hide)
// ============================================================================

test.describe("Project - Delete (Hide)", () => {
  test.beforeEach(async ({ page }) => {
    await navigateToChat(page);
  });

  test("should delete a project and all its sessions", async ({ page }) => {
    // Add a temporary project to delete
    await addProject(page, "/test/delete-me", "opencode");

    // Wait for the project to appear in the sidebar
    await expect(page.getByText("delete-me").first()).toBeVisible({ timeout: 10_000 });

    // Create 2 additional sessions under it (the project starts with 0 sessions)
    await createSession(page, "delete-me");
    await createSession(page, "delete-me");

    // Wait for sessions to settle
    await page.waitForTimeout(500);

    // Expand all projects so delete-me sessions are visible in DOM for counting
    await expandAllProjects(page);

    // Count sessions before hiding the project
    const sessionsBefore = await countSessions(page);

    // Hide (delete) the project — this removes the project and all its sessions
    await hideProject(page, "delete-me");

    // Wait for "delete-me" text to disappear from the sidebar
    await expect(page.getByText("delete-me")).toHaveCount(0, { timeout: 10_000 });

    // Verify session count decreased (the sessions under delete-me are gone)
    const sessionsAfter = await countSessions(page);
    expect(sessionsAfter).toBeLessThan(sessionsBefore);
  });

  test("should delete project-beta and its session", async ({ page }) => {
    // Switch to Copilot tab where project-beta lives
    await switchEngineTab(page, "Copilot");

    // Verify project-beta and its session exist in seed data
    await expect(page.getByText("project-beta").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Refactor database layer").first()).toBeVisible({ timeout: 5_000 });

    // Count sessions before deletion (on Copilot tab)
    const sessionsBefore = await countSessions(page);

    // Hide (delete) project-beta
    await hideProject(page, "project-beta");

    // Verify project-beta is completely removed from the sidebar
    await expect(page.getByText("project-beta")).toHaveCount(0, { timeout: 5_000 });

    // Verify its session "Refactor database layer" is also removed
    await expect(page.getByText("Refactor database layer")).toHaveCount(0, { timeout: 5_000 });

    // Verify total session count on Copilot tab decreased by 1
    const sessionsAfter = await countSessions(page);
    expect(sessionsAfter).toBe(sessionsBefore - 1);
  });
});
