# Message Enqueue E2E Test Prompt

Manual test for the message enqueue feature — verifying that users can send
follow-up messages while the engine is busy, and each gets an independent
assistant response (separate Turn in the UI).

## Design Principles

- **Idempotent**: Only creates files under `/tmp/codemux-enqueue-*`, all deleted by the agent before finish. Zero trace left.
- **Location-independent**: No references to project files or directory structure.
- **Multi-tool**: First message triggers 5+ tool calls (write → read → edit → read → shell), keeping the engine busy for 20-30 seconds.
- **Verifiable ordering**: Each message has a distinct expected answer, making it easy to confirm responses aren't merged or reordered.

## Coverage Matrix

| # | What is tested | Expected behavior |
|---|---|---|
| 1 | Normal multi-step send | Agent performs write/read/edit/read/rm sequence |
| 2 | Enqueue while busy | Second message accepted during step 1 processing |
| 3 | Second enqueue (rapid) | Third message accepted immediately after second |
| 4 | Independent turns | Each message gets its own User → Assistant turn |
| 5 | Response isolation | Each Assistant's steps only contain its own operations |
| 6 | Cancel (manual) | Stop button cancels current + all queued |

## Prompt

Copy and paste the **first message** below. Then, while the agent is still
working (wait 3-5 seconds for tool calls to begin), send the **second message**.
Immediately after, send the **third message**.

### Message 1 (multi-step file operations)

```
Execute these steps in order, showing the result of each:
1. Write a file /tmp/codemux-enqueue-1.txt with content "step1:created"
2. Read it back and show the content
3. Edit the file to change "step1:created" to "step1:verified"
4. Read it again and confirm the change
5. Delete /tmp/codemux-enqueue-1.txt
6. Write a file /tmp/codemux-enqueue-1b.txt with content "step6:bonus"
7. Read it back
8. Delete /tmp/codemux-enqueue-1b.txt
```

### Message 2 (send while Message 1 is processing)

```
Write a file /tmp/codemux-enqueue-2.txt with content "second-message". Read it back, then delete it. Show the content.
```

### Message 3 (send immediately after Message 2)

```
What is 6 * 7?
```

## Expected Result

Six independent turns, strictly alternating:

```
[User 1]      → file operations request
[Assistant 1] → steps show write/read/edit/read/rm for enqueue-1.txt and enqueue-1b.txt
[User 2]      → second file request
[Assistant 2] → steps show write/read/rm for enqueue-2.txt
[User 3]      → "What is 6 * 7?"
[Assistant 3] → "42"
```

### What to check

- [ ] **Send button**: While engine is busy and text is entered, button shows **Send** (not Stop)
- [ ] **Immediate feedback**: Each user message bubble appears instantly after pressing Enter
- [ ] **6 independent turns**: No merged responses, no orphaned user messages
- [ ] **Response isolation**: Assistant 1's steps only reference `enqueue-1.txt`/`enqueue-1b.txt`, Assistant 2's only reference `enqueue-2.txt`
- [ ] **No queued indicators**: No "Queued" badges, amber borders, or pulse dots in the UI
- [ ] **Clean finish**: All `/tmp/codemux-enqueue-*` files deleted, sending state cleared
- [ ] **Console clean**: No unhandled rejections or WebSocket errors in DevTools

### Cancel test (optional)

While Message 1 is processing and Message 2 is queued:
1. Clear the input box
2. Click Stop

Expected:
- Current generation stops immediately
- Message 2 does not produce an assistant response
- Button returns to Send state
- New messages can be sent normally

## Cross-Engine Testing

Run this test on each engine to verify consistent behavior:
- [ ] **Copilot** — turn separation via `session.idle` per queued message
- [ ] **Claude Code** — turn separation via `result` message + `stream()` loop
- [ ] **OpenCode** — turn separation via independent SSE messages (native)
