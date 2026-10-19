#!/usr/bin/env bash
set -euo pipefail

# The caller exclusively owns this existing space and completes its lifecycle afterward.
task_space_id=${1:?Usage: bash check-turn-errors.sh TASK_SPACE_ID [FIXTURE_URL]}
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

# Only the validated numeric ID and JSON-encoded loopback URL are interpolated.
ego-browser nodejs <<EOF
const taskSpaceId = $task_space_id;
const fixtureUrl = $fixture_url_json;
await useOrCreateTaskSpace(Number(taskSpaceId));
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const screenshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-turn-errors-'));
const sessionId = 'ui-parity-codex';
const results = [];
let screenshotIndex = 0;
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
async function screenshot(label) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(screenshotDirectory, String(++screenshotIndex) + '-' + label + '.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}
async function pressControl(selector) {
  await js('document.querySelector(' + JSON.stringify(selector) + ')?.scrollIntoView({block:"center"})');
  const rect = await js('document.querySelector(' + JSON.stringify(selector) + ')?.getBoundingClientRect().toJSON()');
  assert(rect && rect.width > 0 && rect.height > 0, 'Control is not visible: ' + selector);
  await click(selector);
  await wait(0.1);
}
async function fixtureState() {
  const response = await fetch(fixtureUrl + '/__fixture/state?session=' + encodeURIComponent(sessionId));
  assert(response.ok, 'Fixture state request failed');
  return response.json();
}
async function selectSession() {
  await gotoAndWait(fixtureUrl + '/', { timeout: 20 });
  await js('localStorage.setItem("settings:lastSessionId", ' + JSON.stringify(JSON.stringify(sessionId)) + '); localStorage.setItem("settings:locale", JSON.stringify("en"));');
  await gotoAndWait(fixtureUrl + '/chat', { timeout: 20 });
  const enter = await js('[...document.querySelectorAll("button")].some(button => button.innerText.trim() === "Open local chat")');
  if (enter) await click('xpath=//button[normalize-space(.)="Open local chat"]');
  await until(() => js('document.querySelector("h1")?.innerText === "UI parity - Codex CLI"'), 'Requested fixture did not load');
  // Allow the initial WebSocket recovery to restore history after first paint.
  await wait(1.5);
}
async function recoveredState() {
  return js('(' + function () {
    const turn = document.querySelector('[data-component="session-turn"]');
    const trigger = turn?.querySelector('[data-component="turn-steps-trigger"]');
    const row = turn?.querySelector('details[data-tool-id$=":failed"]');
    const group = row?.closest('[data-component="tool-activity-group"]');
    const groupTrigger = group?.querySelector(':scope > button');
    const errorBadge = element => Boolean(element && [...element.querySelectorAll('span')].some(span => span.textContent.trim() === 'Error'));
    return {
      outerExpanded: trigger?.getAttribute('aria-expanded'), outerError: errorBadge(trigger),
      groupId: group?.getAttribute('data-group-id'), groupExpanded: groupTrigger?.getAttribute('aria-expanded'),
      groupError: errorBadge(groupTrigger), rowError: errorBadge(row?.querySelector('summary')),
      rowOpen: row?.open, detail: row?.innerText,
      finalVisible: document.body.innerText.includes('The response keeps its own place between activity groups.'),
    };
  }.toString() + ')()');
}
async function checkRecovered(label) {
  const outer = '[data-component="session-turn"] [data-component="turn-steps-trigger"]';
  const expanded = await js('document.querySelector(' + JSON.stringify(outer) + ')?.getAttribute("aria-expanded")');
  if (expanded !== 'true') await pressControl(outer);
  const groupIds = await js('[...document.querySelectorAll("[data-component=tool-activity-group][data-grouped]")].map(group => group.getAttribute("data-group-id"))');
  assert(groupIds.length > 0, 'Recovered fixture has no command groups');
  for (const id of groupIds) {
    const selector = '[data-group-id=' + JSON.stringify(id) + '] > button';
    if (await js('document.querySelector(' + JSON.stringify(selector) + ')?.getAttribute("aria-expanded") !== "true"')) await pressControl(selector);
  }
  const state = await until(async () => {
    const value = await recoveredState();
    return value.groupId && value.rowError ? value : false;
  }, 'The individual failed tool did not render');
  assert(!state.outerError && !state.groupError && state.finalVisible, 'Recovered tool failure marked an aggregate as failed', state);
  const rowSelector = 'details[data-tool-id$=":failed"] > summary';
  if (!state.rowOpen) await pressControl(rowSelector);
  const detail = await recoveredState();
  assert(detail.detail.includes('Partial output before the fixture error.') && detail.detail.includes('The optional fixture resource is unavailable.'), 'Failed tool lost its output or error detail', detail);
  const detailScreenshot = await screenshot(label + '-detail');
  const groupSelector = '[data-group-id=' + JSON.stringify(state.groupId) + ']';
  await pressControl(groupSelector + ' > button');
  const collapsed = await js('(' + function (selector) {
    const group = document.querySelector(selector);
    const trigger = group?.querySelector(':scope > button');
    return { expanded: trigger?.getAttribute('aria-expanded'), text: group?.innerText,
      error: Boolean(trigger && [...trigger.querySelectorAll('span')].some(span => span.textContent.trim() === 'Error')) };
  }.toString() + ')(' + JSON.stringify(groupSelector) + ')');
  assert(collapsed.expanded === 'false' && !collapsed.error && !collapsed.text.includes('The optional fixture resource is unavailable.') && !collapsed.text.includes('Partial output before the fixture error.'), 'Collapsed group exposed a recoverable error summary', collapsed);
  results.push({ case: label, individualError: true, aggregateError: false, screenshots: [detailScreenshot, await screenshot(label + '-collapsed')] });
}

try {
  const tabs = (await listTabs()).filter(tab => tab.url.startsWith(fixtureUrl + '/'));
  if (tabs.length) await switchTab(tabs[0].targetId);
  else await openOrReuseTab(fixtureUrl + '/', { wait: true, timeout: 20 });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const reset = await fetch(fixtureUrl + '/__fixture/reset?session=' + encodeURIComponent(sessionId), { method: 'POST' });
  assert(reset.ok, 'Fixture reset failed');
  const initial = await fixtureState();
  assert(initial.messages.some(message => !message.error && message.parts.some(part => part.type === 'tool' && part.state.status === 'error')), 'Fixture must contain a recovered tool error without a turn error');
  await selectSession();
  await checkRecovered('recovered');
  await selectSession();
  await checkRecovered('reloaded');

  // Stop only after the actual streamed command succeeds: turn failure has its own source.
  await fillInput('textarea', 'Verify terminal turn error independently from successful commands.');
  await pressControl('button[aria-label="Send message"]');
  await until(async () => {
    const fixture = await fixtureState();
    return fixture.active.includes(sessionId) && fixture.messages.at(-1)?.parts.some(part => part.type === 'tool' && part.state.status === 'completed' && part.state.output === 'FIXTURE_OK');
  }, 'The streamed command did not complete before interruption');
  await pressControl('button[aria-label="Stop"]');
  const terminal = await until(async () => {
    const fixture = await fixtureState();
    return !fixture.active.includes(sessionId) && fixture.messages.at(-1)?.error ? fixture.messages.at(-1) : false;
  }, 'Stopping the stream did not produce its terminal message error');
  assert(terminal.parts.filter(part => part.type === 'tool').every(part => part.state.status === 'completed'), 'Terminal fixture unexpectedly contains a failed command');
  const terminalState = await until(() => js('(' + function () {
    const turn = [...document.querySelectorAll('[data-component="session-turn"]')].at(-1);
    const trigger = turn?.querySelector('[data-component="turn-steps-trigger"]');
    const error = Boolean(trigger && [...trigger.querySelectorAll('span')].some(span => span.textContent.trim() === 'Error'));
    return error && !trigger.hasAttribute('data-working') ? { error, text: trigger.innerText } : false;
  }.toString() + ')()'), 'A genuine terminal turn error did not mark the outer steps');
  results.push({ case: 'terminal-error', toolStatus: 'completed', turnError: terminal.error, ...terminalState, screenshot: await screenshot('terminal') });
  cliLog({ passed: true, results, taskSpaceId, lifecycle: 'Caller retains ownership and completes the task space after its larger workflow.' });
} catch (error) {
  cliLog({ passed: false, error: String(error.message || error), results, screenshot: await screenshot('failure') });
  throw error;
}
EOF
