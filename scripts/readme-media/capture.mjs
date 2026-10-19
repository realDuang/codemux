// ============================================================================
// Records the README demo GIF and feature screenshots from a real CodeMux
// server running scripted demo engines (see demo-host.ts).
//
//   bun run media:readme
//
// Output: assets/screenshots/*.jpg and assets/screenshots/demo.gif
// Needs ffmpeg on PATH. Set PLAYWRIGHT_CHROMIUM_PATH to use a specific browser.
// ============================================================================

// Node globals, plus browser globals used inside page.evaluate / addInitScript callbacks.
/* global process, console, Buffer, setTimeout, document, localStorage, addEventListener, MutationObserver, requestAnimationFrame, getComputedStyle */

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(repo, "assets/screenshots");
const port = process.env.DEMO_PORT ?? "18233";
const base = `http://127.0.0.1:${port}`;
const PROMPT = "Customers say the cart total is wrong when a coupon is applied. Find the bug, fix it, and run the tests.";
const SESSION = "Customers say the cart total";
// SKIP_VIDEO=1 replays the scenario quickly without encoding the GIF (for iterating on screenshots).
const recordVideo = !process.env.SKIP_VIDEO;

// ---------------------------------------------------------------------------
// Demo host
// ---------------------------------------------------------------------------

// The server moves to the next free port when this one is taken, so a busy port would point the browser elsewhere.
await new Promise((free, busy) => {
  const probe = createServer().once("error", () => busy(new Error(`Port ${port} is in use; set DEMO_PORT to a free port.`)));
  probe.listen(Number(port), "127.0.0.1", () => probe.close(free));
});

execFileSync("npx", ["vite", "build", "--config", "scripts/readme-media/vite.demo.config.ts", "--logLevel", "warn"], { cwd: repo, stdio: "inherit" });
if (!process.env.SKIP_WEB_BUILD) execFileSync("bun", ["run", "build:web"], { cwd: repo, stdio: "inherit" });

const host = spawn(process.execPath, [join(repo, "out/readme-demo/demo-host.mjs")], {
  cwd: repo,
  env: { ...process.env, CODEMUX_APP_PATH: repo, DEMO_PORT: port, DEMO_SPEED: process.env.DEMO_SPEED ?? (recordVideo ? "1.3" : "0.3"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ready, fail) => {
  host.stdout.on("data", (chunk) => { if (String(chunk).includes("demo.ready")) ready(); });
  host.once("exit", (code) => fail(new Error(`demo host exited (${code})`)));
});
const stopHost = () => { if (host.exitCode === null) host.kill("SIGTERM"); };
process.on("exit", stopHost);

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });

/** A visible pointer for recordings, since headless capture has no cursor. */
function cursorOverlay() {
  addEventListener("DOMContentLoaded", () => {
    const cursor = document.createElement("div");
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.6.9 3.9 7.4-2.8 1.4-3.9-7.5L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-60px,-60px)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.45))" });
    document.body.appendChild(cursor);
    addEventListener("mousemove", (event) => { cursor.style.transform = `translate(${event.clientX - 3}px,${event.clientY - 2}px)`; }, true);
    addEventListener("mousedown", (event) => {
      const ring = document.createElement("div");
      Object.assign(ring.style, { position: "fixed", left: `${event.clientX - 14}px`, top: `${event.clientY - 14}px`, width: "28px", height: "28px", borderRadius: "50%", border: "2px solid rgba(129,140,248,.9)", zIndex: "2147483646", pointerEvents: "none", transition: "transform .35s ease-out, opacity .35s ease-out" });
      document.body.appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = "scale(1.8)"; ring.style.opacity = "0"; });
      setTimeout(() => ring.remove(), 400);
    }, true);
    // The transient "Jump to latest" pill only adds noise to a recording.
    const hidePill = () => {
      for (const button of document.querySelectorAll("button")) {
        if (button.textContent?.trim() === "Jump to latest") button.style.visibility = "hidden";
      }
    };
    new MutationObserver(hidePill).observe(document.body, { childList: true, subtree: true });
  });
}

async function open(context) {
  const page = await context.newPage();
  // Headless Chromium mis-scales the WebGL terminal renderer; the DOM renderer is exact.
  await page.addInitScript(() => localStorage.setItem("settings:terminal", JSON.stringify({ gpuAcceleration: "dom" })));
  await page.goto(base + "/");
  await page.getByRole("button", { name: "Open local chat" }).click();
  await page.waitForURL(/\/chat/);
  await page.waitForTimeout(1500);
  await dismissHints(page);
  return page;
}

async function dismissHints(page) {
  for (const button of await page.getByRole("button", { name: "Got it" }).all()) await button.click().catch(() => {});
}

/** Move the visible pointer to an element, then click it. */
async function point(page, locator, { click = true, delay = 350 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No box for ${locator}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  await page.waitForTimeout(delay);
  if (click) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function expandProject(page) {
  const row = page.getByRole("complementary").getByText("acme-shop", { exact: true });
  await row.waitFor();
  const sessions = page.getByRole("complementary").locator('div[title^="conv_"]');
  if (await sessions.first().isVisible().catch(() => false)) return;
  await row.click();
  await sessions.first().waitFor({ timeout: 5000 });
}

async function openSession(page, title) {
  // Search instead of relying on the remembered expand/collapse state of the project.
  const search = page.getByPlaceholder(/Search sessions/);
  await search.fill(title);
  await page.getByRole("complementary").locator('div[title^="conv_"]', { hasText: title }).first().click();
  await page.getByText(/Show steps|Hide steps/).first().waitFor({ timeout: 10_000 });
  await search.fill("");
  await page.waitForTimeout(600);
}

const tidy = (page) => page.evaluate(() => {
  for (const element of document.querySelectorAll("button")) {
    if (element.textContent?.trim() === "Jump to latest") element.style.visibility = "hidden";
  }
});

async function shot(page, name, options = {}) {
  await tidy(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 88, ...options });
  console.log(`  ✓ ${name}.jpg`);
}

const FILES = 'button[title="Toggle file explorer"]';
const TERMINAL = 'button[title^="Toggle terminal"]';

/** Open or close a header panel toggle, whatever state the app remembered. */
async function setPanel(page, selector, wanted, pointer = false) {
  const button = page.locator(selector);
  const isOpen = ((await button.getAttribute("class")) ?? "").includes("bg-blue-500/10");
  if (isOpen === wanted) return;
  if (pointer) await point(page, button); else await button.click();
  await page.waitForTimeout(900);
}

const changesTab = (page) => page.locator("button").filter({ hasText: /^Changes\s*\d*$/ }).first();

/** Click `toggle` only when `target` is not already visible (disclosure state persists). */
async function reveal(page, target, toggle) {
  if (await target.isVisible().catch(() => false)) return;
  await toggle.click();
  await target.waitFor({ timeout: 5000 });
}

async function showDiffSteps(page) {
  const steps = page.getByText(/^Changed files/).first();
  await reveal(page, steps, page.getByText("Show steps").first());
  const edited = page.getByText("Edited src/cart.ts", { exact: true });
  await reveal(page, edited, steps);
  await reveal(page, page.getByText("Updated src/cart.ts", { exact: true }), edited);
}

await mkdir(out, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Demo GIF: new session → agent fixes a bug → approve → tests → diff
// ---------------------------------------------------------------------------

console.log("Recording demo…");
const video = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await video.addInitScript(cursorOverlay);
const page = await open(video);
await expandProject(page);
await page.mouse.move(640, 420);
// Let the start-up "Connection restored" toast fade before recording.
await page.waitForTimeout(3500);

const frames = [];
const cdp = await video.newCDPSession(page);
cdp.on("Page.screencastFrame", async (frame) => {
  frames.push({ data: frame.data, time: frame.metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
});
if (recordVideo) await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
await page.waitForTimeout(1200);

await page.getByRole("complementary").getByText("acme-shop", { exact: true }).hover();
await point(page, page.locator('button[title="New session"]').nth(1));
await setPanel(page, FILES, false);
await setPanel(page, TERMINAL, false);
await page.waitForTimeout(700);
await point(page, page.locator("textarea").first());
await page.keyboard.type(PROMPT, { delay: recordVideo ? 28 : 0 });
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
const allow = page.getByRole("button", { name: "Allow Once" });
await allow.waitFor({ timeout: 60_000 });
await page.waitForTimeout(1300);
await point(page, allow, { delay: 500 });
await page.mouse.move(900, 300, { steps: 20 });
await page.getByText("Show steps").first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(2200);
await point(page, page.getByText("Show steps").first());
await page.waitForTimeout(600);
await point(page, page.getByText(/^Changed files/).first());
await page.waitForTimeout(500);
await point(page, page.getByText("Edited src/cart.ts", { exact: true }));
await page.waitForTimeout(500);
await page.mouse.wheel(0, 260);
await page.waitForTimeout(2400);
await setPanel(page, FILES, true, true);
await point(page, changesTab(page));
await page.waitForTimeout(3000);
if (recordVideo) await cdp.send("Page.stopScreencast");
const storage = await video.storageState();
await video.close();

if (recordVideo) {
const frameDir = await mkdtemp(join(tmpdir(), "codemux-frames-"));
const list = [];
for (const [index, frame] of frames.entries()) {
  const file = join(frameDir, `${String(index).padStart(5, "0")}.png`);
  await writeFile(file, Buffer.from(frame.data, "base64"));
  const next = frames[index + 1]?.time ?? frame.time + 2;
  list.push(`file '${file}'`, `duration ${Math.max(0.01, next - frame.time).toFixed(3)}`);
}
list.push(`file '${join(frameDir, `${String(frames.length - 1).padStart(5, "0")}.png`)}'`);
await writeFile(join(frameDir, "list.txt"), list.join("\n"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(frameDir, "list.txt"),
  "-vf", "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
  join(out, "demo.gif")]);
await rm(frameDir, { recursive: true, force: true });
console.log(`  ✓ demo.gif (${frames.length} frames)`);
}

// ---------------------------------------------------------------------------
// 2. Feature screenshots (same device identity as the recording)
// ---------------------------------------------------------------------------

console.log("Capturing screenshots…");
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, storageState: storage });
const ui = await open(desktop);
await openSession(ui, SESSION);
await setPanel(ui, FILES, false);
await setPanel(ui, TERMINAL, false);
await showDiffSteps(ui);
await ui.getByText("Found it.").first().evaluate((element) => element.scrollIntoView({ block: "start" }));
await ui.mouse.move(700, 400);
await ui.mouse.wheel(0, -60);
await shot(ui, "chat-steps");

await ui.getByText("Ran npm test", { exact: true }).click();
await ui.waitForTimeout(500);
await setPanel(ui, FILES, true);
await changesTab(ui).click();
await ui.waitForTimeout(600);
await ui.locator("aside, div").filter({ hasText: /^cart\.ts/ }).last().click().catch(() => {});
await ui.getByText(/^cart\.ts$/).last().click();
await ui.waitForTimeout(1200);
await shot(ui, "main-chat");

await ui.locator("button").filter({ hasText: /^Files$/ }).first().click();
await ui.waitForTimeout(500);
await reveal(ui, ui.getByText("checkout", { exact: true }), ui.getByText("src", { exact: true }));
await ui.getByText(/^cart\.ts$/).last().click();
await ui.waitForTimeout(1500);
await shot(ui, "project-preview");

// Integrated terminal, running real commands in the demo repository.
await ui.goto(base + "/chat");
await ui.waitForTimeout(1500);
await openSession(ui, "Add input validation");
await setPanel(ui, FILES, false);
await setPanel(ui, TERMINAL, true);
await ui.waitForTimeout(1200);
const terminal = ui.locator(".xterm-helper-textarea").first();
await terminal.focus();
for (const command of ["git status --short", "git diff --stat", "git log --oneline -3", "ls src"]) {
  await ui.keyboard.type(command, { delay: 15 });
  await ui.keyboard.press("Enter");
  await ui.waitForTimeout(600);
}
await shot(ui, "terminal");
await setPanel(ui, TERMINAL, false);

// Scheduled task editor.
await ui.getByText("Morning code review").hover();
await ui.locator('button[title="Edit Task"]').first().click();
await ui.waitForTimeout(800);
await shot(ui, "scheduled-task");
await ui.getByRole("button", { name: "Cancel" }).click();

// IM channel settings.
await ui.getByText("Settings", { exact: true }).click();
await ui.waitForTimeout(1200);
await ui.getByRole("heading", { name: "Feishu / Lark Bot" }).evaluate((element) => {
  // Put the "Channels" section label near the top of the settings scroller.
  let scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const top = scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 190;
  scroller.scrollTo({ top, behavior: "instant" });
});
await ui.waitForTimeout(800);
await shot(ui, "channels");

// Remote access with a LAN address, then the device list.
await ui.goto(base + "/");
await ui.getByRole("button", { name: "Remote Access" }).first().click();
await ui.locator('input[placeholder^="http://192"]').fill("http://192.168.1.20:8233");
await ui.getByRole("button", { name: "Save" }).click();
await ui.waitForTimeout(600);
await ui.locator('button[role="switch"], input[type=checkbox]').first().click();
await ui.waitForTimeout(1200);
await ui.getByRole("button", { name: "Web App" }).click();
await ui.waitForTimeout(1500);
await shot(ui, "remote-access");
await ui.getByText("Authorized Devices").first().click();
await ui.waitForTimeout(1500);
await shot(ui, "devices-management");
await desktop.close();

// Phone layout of the same conversation.
// Open the conversation at desktop width (sidebar visible), then shrink to a phone viewport.
const phone = await browser.newContext({ viewport: { width: 1280, height: 844 }, deviceScaleFactor: 3, hasTouch: true, storageState: storage });
const mobile = await open(phone);
await openSession(mobile, SESSION);
await setPanel(mobile, FILES, false);
await setPanel(mobile, TERMINAL, false);
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.waitForTimeout(1500);
await showDiffSteps(mobile);
await mobile.getByText("Edited src/cart.ts", { exact: true }).scrollIntoViewIfNeeded();
await shot(mobile, "mobile");
await phone.close();

await browser.close();
stopHost();
console.log(`Done → ${out}`);
