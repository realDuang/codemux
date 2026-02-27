// ============================================================================
// E2E Test Helpers — Shared utilities for Playwright E2E tests
// ============================================================================

import { expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Navigate to chat page and wait for session list to load */
export async function navigateToChat(page: Page): Promise<void> {
  await page.goto(process.env.TEST_BASE_URL!);
  await page.getByRole("button", { name: /Enter Chat/i }).click();
  await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  // Wait for sessions to load via WebSocket
  await page.getByText("Fix authentication bug").waitFor({ timeout: 10_000 });

  // Wait for initializeSession to fully complete: it auto-selects the first
  // session and loads its messages. The loading spinner must disappear before
  // we can safely interact with sessions / send messages.
  const spinner = page.locator(".animate-spin");
  await spinner.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
    // Spinner may never appear if everything loads instantly
  });
  // Small additional wait for SolidJS reactivity to settle
  await page.waitForTimeout(300);
}

/**
 * Reset test server state: clear all adapter data and re-seed from scratch.
 * Call in beforeAll/beforeEach to get clean seed data.
 */
export async function reseedTestData(page: Page): Promise<void> {
  const baseUrl = process.env.TEST_BASE_URL!;
  await page.evaluate(async (url) => {
    await fetch(`${url}/api/test/reseed`, { method: "POST" });
  }, baseUrl);
}

// ---------------------------------------------------------------------------
// SolidJS Interaction Helpers
// ---------------------------------------------------------------------------

/**
 * Use dispatchEvent for SolidJS-delegated click events.
 * Native Playwright click() doesn't trigger SolidJS event delegation reliably.
 */
export async function solidClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
      );
    }
  }, selector);
}

/**
 * Click a button/element found by its visible text content.
 * Walks up the DOM to find the nearest clickable ancestor (button or div).
 */
export async function solidClickByText(
  page: Page,
  text: string,
  tagName = "BUTTON",
): Promise<boolean> {
  return page.evaluate(
    ({ text, tagName }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.textContent?.trim() === text) {
          let el = node.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!el) break;
            if (el.tagName === tagName) {
              el.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
              );
              return true;
            }
            el = el.parentElement;
          }
        }
      }
      return false;
    },
    { text, tagName },
  );
}

/**
 * Fill an input field using native setter to trigger SolidJS signals.
 * Standard Playwright fill() doesn't always trigger SolidJS reactivity.
 */
export async function solidFillInput(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  await page.evaluate(
    ({ sel, val }) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { sel: selector, val: value },
  );
}

/**
 * Set a <select> element's value and dispatch change event for SolidJS.
 */
export async function solidSelectOption(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  await page.evaluate(
    ({ sel, val }) => {
      const select = document.querySelector(sel) as HTMLSelectElement;
      if (!select) return;
      select.value = val;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { sel: selector, val: value },
  );
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Type text into the chat textarea and submit via Enter.
 * Uses native value setter + dispatchEvent to reliably set the SolidJS signal,
 * then calls the $$keydown handler directly for submission.
 * This avoids focus/overlay issues that make keyboard.type() unreliable.
 */
export async function typeAndSend(page: Page, text: string): Promise<void> {
  const textarea = page.locator("textarea");
  await textarea.waitFor({ timeout: 5_000 });
  await expect(textarea).toBeEnabled({ timeout: 5_000 });

  // Step 1: Set textarea value using Playwright fill() + native setter for double insurance
  await textarea.click();
  await textarea.fill(text);

  // Also fire native setter + input event to guarantee SolidJS signal updates
  await page.evaluate((val) => {
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(ta, val);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);

  // Allow SolidJS reactivity to process
  await page.waitForTimeout(200);

  // Step 2: Submit by calling SolidJS $$keydown handler directly
  // This bypasses focus/overlay issues and is the most reliable submission method
  await page.evaluate(() => {
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    if (!ta) return;
    const handler = (ta as any).$$keydown;
    const data = (ta as any).$$keydownData;
    if (!handler) return;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    data !== undefined ? handler.call(ta, data, event) : handler.call(ta, event);
  });

  // Wait for message to be processed
  await page.waitForTimeout(300);

  // Step 3: If message wasn't sent (textarea still has value), retry with keyboard
  const textareaEmpty = await page.evaluate(() => {
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    return !ta?.value?.trim();
  });

  if (!textareaEmpty) {
    // Fallback: Use keyboard Enter which triggers a real DOM event
    await textarea.focus();
    await textarea.press("Enter");
    await page.waitForTimeout(300);
  }
}

// ---------------------------------------------------------------------------
// Dialog Handling
// ---------------------------------------------------------------------------

/** Override window.confirm to auto-accept (prevents JS execution blocking) */
export async function autoConfirmDialogs(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).confirm = () => true;
  });
}

// ---------------------------------------------------------------------------
// Project Operations
// ---------------------------------------------------------------------------

/**
 * Add a project via the Add Project dialog.
 * Opens the dialog, fills path and engine, then confirms.
 */
export async function addProject(
  page: Page,
  directory: string,
  engine: string,
): Promise<void> {
  // Click "Add Project" button in the sidebar
  await solidClickByText(page, "Add Project");

  // Wait for dialog to appear
  const dialog = page.getByRole("dialog", { name: /Add Project/i });
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Fill in the project path
  await solidFillInput(page, 'input[type="text"]', directory);

  // Select the engine
  await solidSelectOption(page, "select", engine);

  // Click confirm button in dialog
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const buttons = dialog.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.trim() === "Add Project" && !btn.disabled) {
        btn.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
        );
        return;
      }
    }
  });

  // Wait for dialog to close
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
}

/**
 * Create a new session under a specific project by clicking its "New session" button.
 * Finds the project group by name, then clicks the New session button within it.
 */
export async function createSession(page: Page, projectName: string): Promise<void> {
  const clicked = await page.evaluate((name) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim() === name) {
        // Walk up to find the project group container
        let container = node.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!container) break;
          const newBtn = container.querySelector('button[title="New session"]');
          if (newBtn) {
            (newBtn as HTMLElement).dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
            );
            return true;
          }
          container = container.parentElement;
        }
      }
    }
    return false;
  }, projectName);

  if (!clicked) {
    throw new Error(`Could not find project "${projectName}" to create session`);
  }

  // Wait for session creation to propagate
  await page.waitForTimeout(1000);
}

/**
 * Click "Hide Project" for a specific project and confirm deletion.
 */
export async function hideProject(page: Page, projectName: string): Promise<void> {
  const clicked = await page.evaluate((name) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim() === name) {
        let container = node.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!container) break;
          const hideBtn = container.querySelector('button[title="Hide Project"]');
          if (hideBtn) {
            (hideBtn as HTMLElement).dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
            );
            return true;
          }
          container = container.parentElement;
        }
      }
    }
    return false;
  }, projectName);

  if (!clicked) {
    throw new Error(`Could not find project "${projectName}" to hide`);
  }

  // Wait for confirmation dialog
  const confirmDialog = page.getByRole("dialog", { name: /Hide Project/i });
  await expect(confirmDialog).toBeVisible({ timeout: 5_000 });

  // Click "Confirm" button
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const buttons = dialog.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.textContent?.trim() === "Confirm") {
        btn.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
        );
        return;
      }
    }
  });

  // Wait for dialog to close
  await expect(confirmDialog).not.toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// UI State Queries
// ---------------------------------------------------------------------------

/**
 * Get the currently active mode button text (e.g., "Build", "Plan").
 * Active mode has bg-indigo-600, bg-cyan-600, or bg-emerald-600 class.
 */
export async function getActiveMode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const cls = btn.className;
      if (
        cls.includes("bg-indigo-600") ||
        cls.includes("bg-cyan-600") ||
        cls.includes("bg-emerald-600")
      ) {
        return btn.textContent?.trim() || null;
      }
    }
    return null;
  });
}

/**
 * Check if the model selector is locked (copilot engine).
 * Returns true if the selector has opacity-75 and the locked title.
 */
export async function isModelSelectorLocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      if (btn.title === "Model is determined by Copilot CLI config") {
        return true;
      }
    }
    return false;
  });
}

/**
 * Get the currently displayed model name from the model selector.
 */
export async function getModelName(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // The model selector button contains the model name as text
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const cls = btn.className;
      if (
        cls.includes("rounded-md") &&
        cls.includes("text-xs") &&
        cls.includes("font-medium") &&
        (cls.includes("opacity-75") || cls.includes("hover:bg-gray-200"))
      ) {
        return btn.textContent?.trim() || null;
      }
    }
    return null;
  });
}

/**
 * Count the number of project groups visible in the sidebar.
 */
export async function countProjectGroups(page: Page): Promise<number> {
  return page.locator('button[title="Hide Project"]').count();
}

/**
 * Count the number of delete session buttons (proxy for session count).
 */
export async function countSessions(page: Page): Promise<number> {
  return page.locator('button[title="Delete session"]').count();
}

/**
 * Click on a session in the sidebar by its title text.
 */
export async function selectSession(page: Page, sessionTitle: string): Promise<void> {
  await page.evaluate((title) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim() === title) {
        let el = node.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          if (el.classList.contains("cursor-pointer")) {
            el.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
            );
            return;
          }
          el = el.parentElement;
        }
      }
    }
  }, sessionTitle);

  // Wait for loadSessionMessages to complete: the loading spinner (.animate-spin)
  // must disappear before we interact with the message area. This prevents a race
  // where loadSessionMessages overwrites store data written by sendMessage.
  const spinner = page.locator(".animate-spin");
  await spinner.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
    // Spinner may never appear if messages load instantly — that's fine
  });

  // Extra guard: wait for the message area or empty-state to be rendered
  await page.waitForTimeout(200);
}

/**
 * Check if an engine badge with specific text exists in a project group.
 */
export async function hasEngineBadge(
  page: Page,
  projectName: string,
  badgeText: string,
): Promise<boolean> {
  return page.evaluate(
    ({ name, badge }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.textContent?.trim() === name) {
          // Walk up to find the project group header
          let container = node.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!container) break;
            // Look for badge span in the same header row
            const spans = container.querySelectorAll("span");
            for (const span of spans) {
              if (
                span.textContent?.trim() === badge &&
                span.className.includes("rounded-full")
              ) {
                return true;
              }
            }
            container = container.parentElement;
          }
        }
      }
      return false;
    },
    { name: projectName, badge: badgeText },
  );
}
