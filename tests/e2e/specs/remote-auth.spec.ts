import { test, expect } from "@playwright/test";

const TEST_CODE = "123456";
const WRONG_CODE = "000000";

test.describe("Remote Authentication", () => {
  test.beforeEach(async ({ page, request }) => {
    const baseUrl = process.env.TEST_BASE_URL!;
    // Reset auth state and switch to remote mode
    await request.post(`${baseUrl}/api/test/reset-auth`);
    await request.post(`${baseUrl}/api/test/set-local`, {
      data: { isLocal: false },
    });
    // Clear any stored tokens from previous tests
    await page.goto(baseUrl);
    await page.evaluate(() => {
      localStorage.removeItem("opencode_device_token");
      localStorage.removeItem("opencode_device_id");
    });
    // Reload so the app picks up isLocal=false with no cached token
    await page.reload();
  });

  test.afterEach(async ({ request }) => {
    const baseUrl = process.env.TEST_BASE_URL!;
    // Restore local mode for other specs
    await request.post(`${baseUrl}/api/test/set-local`, {
      data: { isLocal: true },
    });
  });

  test("should show 6-digit code input for remote access", async ({
    page,
  }) => {
    // Should NOT show "Enter Chat" (that's local/host mode)
    await expect(
      page.getByRole("button", { name: /Enter Chat/i }),
    ).not.toBeVisible({ timeout: 5_000 });

    // Should show login form with code input
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Access Code")).toBeVisible();
  });

  test("submit button should be disabled until 6 digits entered", async ({
    page,
  }) => {
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    const submitButton = page.getByRole("button", { name: /Connect/i });

    // Initially disabled
    await expect(submitButton).toBeDisabled();

    // Type 5 chars — still disabled
    await codeInput.fill("12345");
    await expect(submitButton).toBeDisabled();

    // Type 6th char — enabled
    await codeInput.fill(TEST_CODE);
    await expect(submitButton).toBeEnabled();
  });

  test("should show error for wrong access code", async ({ page }) => {
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(WRONG_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    // Should show error message
    await expect(page.getByText(/Invalid/i)).toBeVisible({ timeout: 5_000 });
  });

  test("should complete remote auth flow after host approval", async ({
    page,
    request,
  }) => {
    const baseUrl = process.env.TEST_BASE_URL!;

    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    // Enter valid code and submit
    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    // Should transition to "Waiting for Approval" view
    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Get the pending request and approve it via admin API
    const pendingRes = await request.get(
      `${baseUrl}/api/admin/pending-requests`,
    );
    const { requests } = await pendingRes.json();
    expect(requests.length).toBeGreaterThan(0);

    await request.post(`${baseUrl}/api/admin/approve`, {
      data: { requestId: requests[0].id },
    });

    // Should navigate to /chat after next poll cycle (~2s)
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should show denied state when host denies request", async ({
    page,
    request,
  }) => {
    const baseUrl = process.env.TEST_BASE_URL!;

    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Deny the request
    const pendingRes = await request.get(
      `${baseUrl}/api/admin/pending-requests`,
    );
    const { requests } = await pendingRes.json();
    await request.post(`${baseUrl}/api/admin/deny`, {
      data: { requestId: requests[0].id },
    });

    // Should show denied state
    await expect(
      page.getByText("Access Denied"),
    ).toBeVisible({ timeout: 10_000 });

    // Should show "Try Again" button
    await expect(
      page.getByRole("button", { name: /Try Again/i }),
    ).toBeVisible();
  });

  test("should allow retrying after denial", async ({ page, request }) => {
    const baseUrl = process.env.TEST_BASE_URL!;

    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Deny the request
    const pendingRes = await request.get(
      `${baseUrl}/api/admin/pending-requests`,
    );
    const { requests } = await pendingRes.json();
    await request.post(`${baseUrl}/api/admin/deny`, {
      data: { requestId: requests[0].id },
    });

    await expect(
      page.getByText("Access Denied"),
    ).toBeVisible({ timeout: 10_000 });

    // Click "Try Again" — should return to code input form
    await page.getByRole("button", { name: /Try Again/i }).click();

    await expect(page.locator("input[maxlength='6']")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Connect/i }),
    ).toBeVisible();
  });

  test("should allow cancelling while waiting for approval", async ({
    page,
  }) => {
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Cancel button should be visible and functional
    const cancelButton = page.getByRole("button", { name: /Cancel/i });
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    // Should return to code input form
    await expect(page.locator("input[maxlength='6']")).toBeVisible();
  });
});
