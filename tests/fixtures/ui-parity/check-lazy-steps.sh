#!/usr/bin/env bash
set -euo pipefail

# The caller owns this existing task space and completes its lifecycle afterward.
task_space_id=${1:?Usage: bash check-lazy-steps.sh TASK_SPACE_ID [FIXTURE_URL]}
fixture_url=${2:-${UI_PARITY_URL:-http://127.0.0.1:60790}}
case "$task_space_id" in ''|*[!0-9]*) echo 'TASK_SPACE_ID must be an existing numeric agent-owned space.' >&2; exit 2 ;; esac
fixture_url_json=$(python3 - "$fixture_url" <<'PY'
import json, sys
from urllib.parse import urlsplit
url = urlsplit(sys.argv[1])
if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.username or url.password:
    raise SystemExit('Use the loopback UI parity fixture URL.')
print(json.dumps(sys.argv[1].rstrip('/')))
PY
)

# Only the validated ID and JSON-encoded loopback URL are interpolated.
# Browser operations remain in the ego-browser heredoc, never a generated JS file.
ego-browser nodejs <<EOF
const taskSpaceId = $task_space_id;
const fixtureUrl = $fixture_url_json;
await useOrCreateTaskSpace(Number(taskSpaceId));
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const screenshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-lazy-steps-'));
let screenshotIndex = 0;
async function screenshot() {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(screenshotDirectory, String(++screenshotIndex) + '.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

async function pressControl(selector) {
  const lookup = selector.startsWith('xpath=')
    ? 'document.evaluate(' + JSON.stringify(selector.slice(6)) + ',document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue'
    : 'document.querySelector(' + JSON.stringify(selector) + ')';
  await js('(' + lookup + ')?.scrollIntoView({block:"center"})');
  await cdp('Page.captureScreenshot', { format: 'png' });
  const rect = await js('(' + lookup + ')?.getBoundingClientRect().toJSON()');
  assert(rect && rect.width > 0 && rect.height > 0, 'Control is not visible: ' + selector);
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, button: 'left', clickCount: 1 };
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
  await wait(0.1);
  await cdp('Page.captureScreenshot', { format: 'png' });
}

const results = [];
function assert(condition, message, state) {
  if (!condition) throw new Error(message + (state ? ': ' + JSON.stringify(state) : ''));
}
async function until(check, message) {
  const deadline = Date.now() + 10000;
  do {
    const result = await check();
    if (result) return result;
    await wait(0.1);
  } while (Date.now() < deadline);
  throw new Error(message);
}
async function fixtureState(sessionId) {
  const response = await fetch(fixtureUrl + '/__fixture/state?session=' + encodeURIComponent(sessionId));
  assert(response.ok, 'Fixture state request failed');
  return response.json();
}
async function readTurn() {
  return js('(' + function () {
    const turn = document.querySelector('[data-component="session-turn"]');
    const triggers = turn ? [...turn.querySelectorAll('[data-component="turn-steps-trigger"], button[class*="stepsTriggerButton"]')] : [];
    const trigger = triggers[0];
    const controls = (trigger?.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const text = document.body.innerText;
    return {
      triggerCount: triggers.length,
      expanded: trigger?.getAttribute('aria-expanded'),
      controls: controls.map(id => {
        const element = document.getElementById(id);
        return { id, exists: Boolean(element), hidden: element?.hidden, visible: visible(element) };
      }),
      visibleSteps: turn ? [...turn.querySelectorAll('[data-component="tool-activity-group"], [data-component="reasoning"], [data-component="tool"], [data-component="tool-running"]')].filter(visible).length : 0,
      responseVisible: text.includes('LAZY_HISTORY_RESPONSE'),
      commentaryVisible: text.includes('LAZY_HISTORY_COMMENTARY'),
      partialVisible: text.includes('LAZY_HISTORY_PARTIAL'),
      noticeVisible: text.includes('LAZY_HISTORY_NOTICE'),
      text,
    };
  }.toString() + ')()');
}
async function selectSession(sessionId) {
  const fixture = await fixtureState(sessionId);
  const expectedTitle = fixture.sessions.find(session => session.id === sessionId)?.title;
  assert(expectedTitle, 'Fixture session is missing: ' + sessionId);
  await gotoAndWait(fixtureUrl + '/', { timeout: 20 });
  // Use the app's normal saved-session preference, then let its real boot path restore it.
  await js('localStorage.setItem("settings:lastSessionId", ' + JSON.stringify(JSON.stringify(sessionId)) + '); localStorage.setItem("settings:locale", JSON.stringify("en"));');
  await gotoAndWait(fixtureUrl + '/chat', { timeout: 20 });
  const enter = await js('[...document.querySelectorAll("button")].some(button => button.innerText.trim() === "Enter Chat")');
  if (enter) await pressControl('xpath=//button[normalize-space(.)="Enter Chat"]');
  await until(async () => await js('document.querySelector("h1")?.innerText === ' + JSON.stringify(expectedTitle)), 'Requested lazy fixture did not load: ' + sessionId);
  // The initial WebSocket recovery restores history again after the first paint.
  await wait(1.5);
  await js('document.querySelector(".conversation-viewport").scrollTop = 0');
  await cdp('Page.captureScreenshot', { format: 'png' });
}
async function assertLoaded(sessionId, expanded, compact) {
  const state = await readTurn();
  assert(state.triggerCount === 1, 'The history steps trigger disappeared after loading', state);
  assert(state.expanded === String(expanded), 'The history steps trigger has the wrong state', state);
  assert(state.controls.length > 0 && state.controls.every(control => control.exists && control.hidden === !expanded), 'aria-controls must refer to the actual hidden containers', state);
  assert(state.responseVisible, 'Collapsing history hid the final response', state);
  assert(expanded ? state.visibleSteps > 0 : state.visibleSteps === 0, 'Step visibility disagrees with the outer disclosure', state);
  if (compact) assert(state.commentaryVisible && state.partialVisible && state.noticeVisible, 'Compact history hid response, commentary or notice content', state);
  const fixture = await fixtureState(sessionId);
  const requests = Object.values(fixture.messageStepRequests).reduce((sum, count) => sum + count, 0);
  assert(requests === 1, 'History steps were fetched more than once', { sessionId, requests });
  const { text, ...compactState } = state;
  return { ...compactState, requests };
}

try {
  const initial = await fixtureState('ui-parity-lazy-codex');
  assert(initial.lazySteps, 'Start the fixture with UI_PARITY_LAZY_STEPS=1');
  const fixtureTabs = (await listTabs()).filter(tab => tab.url.startsWith(fixtureUrl + '/'));
  if (fixtureTabs.length) {
    await switchTab(fixtureTabs[0].targetId);
    for (const tab of fixtureTabs.slice(1)) await closeTab(tab.targetId);
  } else await openOrReuseTab(fixtureUrl + '/', { wait: true, timeout: 20 });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const triggerSelector = '[data-component="turn-steps-trigger"], button[class*="stepsTriggerButton"]';
  for (const engine of ['codex', 'codex-desktop', 'opencode', 'copilot', 'claude']) {
    const sessionId = 'ui-parity-lazy-' + engine;
    const compact = engine === 'codex' || engine === 'codex-desktop';
    const reset = await fetch(fixtureUrl + '/__fixture/reset?session=' + encodeURIComponent(sessionId), { method: 'POST' });
    assert(reset.ok, 'Fixture reset failed');
    await selectSession(sessionId);
    const before = await readTurn();
    assert(before.triggerCount === 1 && before.expanded === 'false' && before.visibleSteps === 0 && before.responseVisible, 'Lazy history must begin with only its response visible', before);
    const initialRequests = Object.values((await fixtureState(sessionId)).messageStepRequests).reduce((sum, count) => sum + count, 0);
    assert(initialRequests === 0, 'History steps were fetched before the first expansion', { sessionId, requests: initialRequests });
    await pressControl(triggerSelector);
    await until(async () => Object.values((await fixtureState(sessionId)).messageStepRequests).some(count => count === 1), 'message.steps was not requested');
    await until(async () => (await readTurn()).visibleSteps > 0, 'Loaded history steps did not render');
    const expanded = await assertLoaded(sessionId, true, compact);

    const reasoningTrigger = '[data-component="reasoning"] button[data-slot="collapsible-trigger"]';
    await pressControl(reasoningTrigger);
    assert(await js('document.querySelector(' + JSON.stringify(reasoningTrigger) + ').getAttribute("aria-expanded") === "true"'), 'Restored reasoning did not expand');
    await pressControl(reasoningTrigger);
    assert(await js('document.querySelector(' + JSON.stringify(reasoningTrigger) + ').getAttribute("aria-expanded") === "false"'), 'Restored reasoning did not collapse');

    await pressControl(triggerSelector);
    const collapsed = await assertLoaded(sessionId, false, compact);
    const screenshotPath = await screenshot();
    await pressControl(triggerSelector);
    await assertLoaded(sessionId, true, compact);
    await pressControl(triggerSelector);
    await assertLoaded(sessionId, false, compact);
    results.push({ sessionId, expanded, collapsed, screenshot: screenshotPath });
    cliLog({ checked: sessionId, passed: true, screenshot: screenshotPath });
  }

  // A normal compact transcript keeps its independent activity groups and no outer history disclosure.
  await gotoAndWait(fixtureUrl + '/', { timeout: 20 });
  await js('localStorage.setItem("settings:lastSessionId", JSON.stringify("ui-parity-codex"));');
  await gotoAndWait(fixtureUrl + '/chat', { timeout: 20 });
  await until(async () => await js('document.querySelectorAll("[data-component=tool-activity-group]").length >= 2'), 'Inline compact activity groups did not load');
  await wait(1.5);
  await js('document.querySelector(".conversation-viewport").scrollTop = 0');
  await cdp('Page.captureScreenshot', { format: 'png' });
  const inlineBefore = await js('({ groups: document.querySelectorAll("[data-component=tool-activity-group]").length, outer: document.querySelectorAll("[data-component=turn-steps-trigger], button[class*=stepsTriggerButton]").length, answer: document.body.innerText.includes("The response keeps its own place between activity groups.") })');
  assert(inlineBefore.outer === 0 && inlineBefore.answer, 'Inline compact grouping gained a history disclosure or lost its response', inlineBefore);
  const groupSelector = '[data-component="tool-activity-group"][data-grouped] > button';
  await pressControl(groupSelector);
  assert(await js('document.querySelector(' + JSON.stringify(groupSelector) + ').getAttribute("aria-expanded") === "true"'), 'Inline activity group did not expand');
  await pressControl(groupSelector);
  const inlineAfter = await js('({ groups: document.querySelectorAll("[data-component=tool-activity-group]").length, expanded: document.querySelector("[data-component=tool-activity-group][data-grouped] > button").getAttribute("aria-expanded"), answer: document.body.innerText.includes("The response keeps its own place between activity groups.") })');
  assert(inlineAfter.groups === inlineBefore.groups && inlineAfter.expanded === 'false' && inlineAfter.answer, 'Inline activity grouping changed', inlineAfter);
  results.push({ sessionId: 'ui-parity-codex', before: inlineBefore, after: inlineAfter, screenshot: await screenshot() });
  cliLog({ passed: true, results, taskSpaceId, lifecycle: 'Caller retains ownership and completes the task space after its larger workflow.' });
} catch (error) {
  cliLog({ passed: false, error: String(error.message || error), results });
  throw error;
}
EOF
