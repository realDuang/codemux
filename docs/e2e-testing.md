# E2E Browser Testing (via Halo AI Browser)

Complete methodology for autonomous end-to-end testing of the app through Halo's embedded AI Browser.

## Starting the Dev Server

```bash
# CRITICAL: Must unset ELECTRON_RUN_AS_NODE (inherited from Halo, breaks Electron)
# Setting it to empty string does NOT work — Electron checks for existence, not value.
# Use env -u to truly remove the variable from the child process environment.
env -u ELECTRON_RUN_AS_NODE npx electron-vite dev
```

Run with `run_in_background: true`. Wait for all services (5173, 4200, 4096, 4097).

## browser_evaluate: MUST Pass args

Without `args`, code does NOT execute in page context (always returns `{}`):

```javascript
// WRONG
browser_evaluate({ function: `() => document.title` })

// CORRECT — pass root element as dummy arg
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => document.title`
})
```

## Clicking SolidJS Elements: Use dispatchEvent

SolidJS event delegation stores handlers as `element.$$click` on elements, with a single listener on `document` (bubble phase). Neither `browser_click` nor direct `$$click()` calls work reliably.

**Use `dispatchEvent` — it goes through normal DOM bubbling and is consistently reliable:**

```javascript
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.trim() === 'TARGET_TEXT') {
        let el = node.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          if (el.tagName === 'BUTTON' || el.tagName === 'DIV') {
            el.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, composed: true
            }));
            return "clicked";
          }
          el = el.parentElement;
        }
      }
    }
    return "not found";
  }`
})
```

## Sending Messages

1. Use `browser_fill` on the textarea (triggers SolidJS `onInput` signal)
2. Call textarea's `$$keydown` handler with Enter:

```javascript
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => {
    const ta = document.querySelector('textarea');
    ta.focus();
    const handler = ta.$$keydown;
    const data = ta.$$keydownData;
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    });
    data !== undefined ? handler.call(ta, data, event) : handler.call(ta, event);
    return "sent";
  }`
})
```

## Filling Input Fields (in dialogs, etc.)

```javascript
// Use native setter + dispatchEvent to trigger SolidJS signals
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(input, 'value');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

## Handling window.confirm Dialogs

Delete session uses `window.confirm()` which blocks JavaScript execution and causes
`browser_evaluate` to time out. Override it before triggering delete:

```javascript
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => {
    window.confirm = () => true;
    // Now safe to click delete buttons
    const btn = document.querySelector('button[title="Delete session"]');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    return "deleted";
  }`
})
```

## Interaction Method Matrix

| Operation | Method |
|-----------|--------|
| Navigate to app | `browser_navigate` → dispatchEvent on "Enter Chat" button |
| Switch session | dispatchEvent click on sidebar `div.cursor-pointer` |
| New session | dispatchEvent click on `button[title="New session"]` (index by project) |
| Send message | `browser_fill` + `$$keydown` Enter on textarea |
| Expand steps | dispatchEvent click on `._stepsTriggerButton_*` |
| Expand tool detail | dispatchEvent click on tool call button inside steps |
| Add project | dispatchEvent click "Add Project" → fill dialog → confirm |
| Delete session | Override `window.confirm = () => true` first, then dispatchEvent click on `button[title="Delete session"]` |
| Delete/hide project | dispatchEvent click on `button[title="Hide Project"]` → confirm in HideProjectModal dialog |

## Tool Compatibility

| Tool | Status |
|------|--------|
| `browser_fill` | Works (triggers SolidJS `onInput`) |
| `browser_press_key` | Works for real keyboard events |
| `browser_evaluate` (with args) | Works in page context |
| `browser_evaluate` (no args) | Does NOT execute on page |
| `browser_click` on SolidJS elements | Does NOT trigger delegated events |
| `browser_screenshot` | Often times out |
| `browser_snapshot` | Works, primary inspection method |

## SolidJS Event Delegation

- Delegated events: click, dblclick, input, keydown, keyup, mousedown, mouseup, pointerdown, pointerup, touchstart, touchend, etc.
- Handler storage: `element.$$click`, `element.$$clickData`, `element.$$keydown`, `element.$$input`
- Listener on `document` (bubble phase) via `delegateEvents()`
- Events MUST have `bubbles: true` to reach the document listener
- Disabled elements are skipped
