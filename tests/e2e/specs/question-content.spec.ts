import { test, expect } from "@playwright/test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { projectInputs } from "../../../electron/main/session-sources/agent-host/projection";
import { startTestServer, type TestServerInstance } from "../setup/test-server";
import { seedTestData } from "../setup/seed-data";
import { expandAllProjects, selectSession } from "../setup/test-helpers";

const message = [
  "The next test produces a large log and needs your confirmation.",
  "It may consume substantial compute and disk space. Only the selected test will run; other tests remain stopped.",
  "Temporary notebooks will be kept for inspection. No existing notebook will be deleted.",
  `Diagnostic identifier: ${"long-identifier-".repeat(70)}`,
  "Do you approve running this test once?",
].join("\n\n");
let server: TestServerInstance;

test.beforeAll(async () => {
  server = await startTestServer({ port: 0 });
  seedTestData(server.mockAdapters);
  const adapter = server.mockAdapters.get("opencode")!;
  const questions = ["full-question", "legacy-question"].map(id => {
    adapter.seedSession({ id, title: id, engineType: "opencode", directory: "/test/project-alpha",
      time: { created: Date.now(), updated: Date.now() } });
    const chat = { resource: `ahp-chat:/${id}`, title: "", modifiedAt: "2026-11-20T00:00:00Z", status: 6, turns: [],
      activeTurn: { id: "turn", startedAt: "2026-11-20T00:00:00Z", message: { text: "Ask before running", origin: { kind: "user" } },
        responseParts: [{ kind: "inputRequest", request: { id: "approval",
          ...(id === "full-question" ? { message } : {}),
          questions: [
            { id: "choice", kind: "single-select", title: "Test approval", message: "Choose an action", required: true,
              options: [{ id: "run", label: "Run once" }, { id: "stop", label: "Keep stopped" }] },
            { id: "note", kind: "text", title: "Notes", message: "Any additional instructions?" },
          ],
        } }],
      },
    } as ChatState;
    return projectInputs(id, chat, "opencode").questions[0].question;
  });
  adapter.getPendingQuestions = (sessionId?: string) => questions.filter(question => !sessionId || question.sessionId === sessionId);
  await server.registerSessionRoutes();
});

test.afterAll(async () => { await server?.stop(); });

for (const mobile of [false, true]) {
  test(`shows the complete request above its questions on ${mobile ? "mobile" : "desktop"}`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await page.addInitScript(() => localStorage.setItem("settings:theme", JSON.stringify("dark")));
    await page.goto(server.baseUrl);
    await expandAllProjects(page);
    await selectSession(page, "full-question");
    const body = page.locator("[data-question-message]");
    await expect(body).toHaveText(message);
    await expect(body).toHaveCSS("white-space", "pre-wrap");
    const layout = await body.evaluate(element => ({
      width: element.clientWidth, scrollWidth: element.scrollWidth,
      height: element.clientHeight, scrollHeight: element.scrollHeight,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.scrollHeight).toBeGreaterThan(layout.height);
    await expect(page.getByRole("radio", { name: "Run once" })).toBeVisible();
    await expect(page.locator('[data-component="notification-toasts"] > div')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({ path: testInfo.outputPath(`question-${mobile ? "mobile" : "desktop"}.png`) });
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: testInfo.outputPath(`question-end-${mobile ? "mobile" : "desktop"}.png`) });
    await page.getByRole("radio", { name: "Run once" }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Any additional instructions?", { exact: true })).toBeVisible();
    await expect(body).toHaveText(message);
    const submit = page.getByRole("button", { name: "Submit", exact: true });
    await expect(submit).toBeEnabled();
    await expect(submit).toBeInViewport();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Run once" })).toHaveAttribute("aria-checked", "true");
  });
}

test("keeps questions without request-level context unchanged", async ({ page }) => {
  await page.goto(server.baseUrl);
  await expandAllProjects(page);
  await selectSession(page, "legacy-question");
  await expect(page.getByText("Choose an action", { exact: true })).toBeVisible();
  await expect(page.locator("[data-question-message]")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Run once" })).toBeVisible();
});
