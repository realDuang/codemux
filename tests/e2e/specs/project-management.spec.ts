// ============================================================================
// E2E Tests — Project & Session Management
// Comprehensive test suite covering project CRUD, session lifecycle,
// engine badge display, model selector behavior, and dedup logic.
// ============================================================================

import { test, expect } from "@playwright/test";
import {
  navigateToChat,
  solidClick,
  autoConfirmDialogs,
  addProject,
  createSession,
  hideProject,
  getActiveMode,
  countProjectGroups,
  countSessions,
  selectSession,
  hasEngineBadge,
  reseedTestData,
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

  test("should add a new project with opencode engine", async ({ page }) => {
    // Count project groups before adding
    const groupsBefore = await countProjectGroups(page);

    // Add a new project with opencode engine
    await addProject(page, "/test/new-project", "opencode");

    // Wait for the project name to appear in the sidebar
    await expect(page.getByText("new-project").first()).toBeVisible({ timeout: 10_000 });

    // Verify project count increased by 1
    const groupsAfter = await countProjectGroups(page);
    expect(groupsAfter).toBe(groupsBefore + 1);

    // Verify the engine badge shows "OC" (blue badge for opencode)
    const hasBadge = await hasEngineBadge(page, "new-project", "OC");
    expect(hasBadge).toBe(true);
  });

  test("should add a project with copilot engine", async ({ page }) => {
    // Add a new project with copilot engine
    await addProject(page, "/test/copilot-project", "copilot");

    // Wait for the project to appear
    await expect(page.getByText("copilot-project").first()).toBeVisible({ timeout: 10_000 });

    // Verify the engine badge shows "Copilot" (purple badge)
    const hasBadge = await hasEngineBadge(page, "copilot-project", "Copilot");
    expect(hasBadge).toBe(true);
  });

  test("should dedup when adding same path and same engine", async ({ page }) => {
    // Count project groups before — seed data already has project-alpha with opencode
    const groupsBefore = await countProjectGroups(page);

    // Attempt to add the same project-alpha with opencode engine (exact duplicate)
    await addProject(page, "/test/project-alpha", "opencode");

    // Wait a moment for any potential UI update
    await page.waitForTimeout(1000);

    // Verify project count did NOT increase (dedup should prevent new entry)
    const groupsAfter = await countProjectGroups(page);
    expect(groupsAfter).toBe(groupsBefore);
  });

  test("should NOT dedup when adding same path but different engine", async ({ page }) => {
    // Count initial project groups
    const groupsBefore = await countProjectGroups(page);

    // Note: project-alpha already exists with both opencode and copilot in seed data.
    // Use a fresh path to demonstrate that same path + different engines = no dedup.
    await addProject(page, "/test/new-dedup-test", "opencode");

    // Wait for the first project to appear
    await expect(page.getByText("new-dedup-test").first()).toBeVisible({ timeout: 10_000 });

    // Verify project count increased by 1
    const groupsAfterFirst = await countProjectGroups(page);
    expect(groupsAfterFirst).toBe(groupsBefore + 1);

    // Now add the same path but with a different engine (copilot)
    await addProject(page, "/test/new-dedup-test", "copilot");

    // Wait for potential UI update
    await page.waitForTimeout(1000);

    // Verify project count increased by 1 again (total +2 from start)
    // Same path + different engine = separate project groups, no dedup
    const groupsAfterSecond = await countProjectGroups(page);
    expect(groupsAfterSecond).toBe(groupsBefore + 2);
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

    // Override window.confirm to auto-accept (prevents JS blocking)
    await autoConfirmDialogs(page);

    // Click the first "Delete session" button (the newly created session)
    await solidClick(page, 'button[title="Delete session"]');

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
    // Verify project-beta and its session exist in seed data
    await expect(page.getByText("project-beta").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Refactor database layer").first()).toBeVisible({ timeout: 5_000 });

    // Count sessions before deletion
    const sessionsBefore = await countSessions(page);

    // Hide (delete) project-beta
    await hideProject(page, "project-beta");

    // Verify project-beta is completely removed from the sidebar
    await expect(page.getByText("project-beta")).toHaveCount(0, { timeout: 5_000 });

    // Verify its session "Refactor database layer" is also removed
    await expect(page.getByText("Refactor database layer")).toHaveCount(0, { timeout: 5_000 });

    // Verify total session count decreased by 1
    const sessionsAfter = await countSessions(page);
    expect(sessionsAfter).toBe(sessionsBefore - 1);
  });
});
