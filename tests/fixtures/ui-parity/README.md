# Conversation UI parity fixture

Run from the repository root:

```sh
bun tests/fixtures/ui-parity/server.ts
```

To verify compiled assets without hot reload, run `bun run build:web` first,
then `UI_PARITY_PRODUCTION=1 bun tests/fixtures/ui-parity/server.ts`.

Open `http://127.0.0.1:60790` in an agent-owned ego-browser task space. Override
the port with `UI_PARITY_PORT=60791` if needed; occupied ports fail rather than
silently switching. This serves the real Web entry, Chat, shared renderer,
stores, auth client, and gateway client through Vite. It reuses the existing
in-memory E2E server and mock adapters; no engine CLI, installed application,
production data directory, or official Desktop is touched.

Five sessions are named `UI parity - OpenCode`, `UI parity - Copilot`,
`UI parity - Claude`, `UI parity - Codex CLI`, and `UI parity - Codex Desktop`.
The first three intentionally have no text phases or summary-heading metadata.
The last two use normalized commentary/partial/final phases and heading-prefixed
summaries. These are synthetic unified fixtures, not captured wire traffic or
evidence of a real provider run.

Each initial conversation includes readable reasoning, grouped read/search
tools, command output, a diff, a failed tool with partial output, an unknown tool
fallback, a long code line, a wide table, KaTeX, Mermaid, local image/audio,
an unavailable image, source navigation to line 124 of a 220-line file, source
notes, and an image attachment. File requests use the existing file service and
are restricted to the temporary directory printed at startup.

Send any prompt using the actual composer to run a synthetic stream: pending
tool, running tool and multiline reasoning, completed tool, 160 text updates at
40 ms intervals, an unfinished code fence, then completion. Stop interrupts the
same mock stream and retains its partial output. Reload restores the fixture's
current message identities and final state.

Fixture-only HTTP hooks, using session IDs from `/__fixture/state`:

- `GET /__fixture/state?session=ui-parity-codex`: inspect normalized input and status.
- `POST /__fixture/reset?session=ui-parity-codex`: restore the initial fixture.
- `POST /__fixture/history?session=ui-parity-codex`: add 30 deterministic older turns.
- `POST /__fixture/disconnect?session=ui-parity-codex`: close fixture sockets and exercise reconnect.

Reset/history hooks update the backend and broadcast normal message/part
notifications. Reload after reset/history when checking a replaced transcript,
because ordinary notifications intentionally do not delete unrelated messages
already cached by the client. Hooks reject changes while a stream is active.
Stop the process with Ctrl-C when the ego-browser workflow is finished.

Meaningful existing regression suites:

```sh
bun run test:unit tests/unit/src/lib/message-parts.test.ts tests/unit/src/lib/reasoning-display.test.ts tests/unit/src/lib/markdown-stream.test.ts tests/unit/src/lib/markdown-interactions.test.ts tests/unit/src/lib/stream-scroll.test.ts tests/unit/src/lib/clipboard.test.ts tests/unit/src/components/share/markdown-diagrams.test.ts tests/unit/src/stores/file-preview-navigation.test.ts
```

Also run the affected engine converter/adapter suites and typecheck/build.
Browser acceptance must inspect screenshots and use real keyboard/pointer
inputs at 390×844, 768 px, and 1280×900 in both themes. Check code/table copying,
wrapping, table expansion, independent disclosure state, completed source
navigation, response selection during streaming, and scroll recovery. Unit
tests and this replay do not replace authentic engine, installed Electron, or
official application comparison evidence.

For an explicitly authorized native image replay, set `UI_PARITY_IMAGE_REPLAY`
to a local JSON file containing one normalized assistant message with inlineAssets.
It replaces only the Codex Desktop fixture response; no personal chat is loaded
by default. The fixture gives this record synthetic timestamps after its user
prompt while retaining its text and image bytes.

## Lazy history disclosure regression

Start with `UI_PARITY_LAZY_STEPS=1` to add five `UI parity lazy history` sessions.
Their stored messages retain all parts, but `message.list` returns only text/file
parts and `stepCount`; `message.steps` supplies the original reasoning, tools,
and notice. The ordinary inline fixtures remain unchanged. The state hook also
reports `messageStepRequests` by message ID. Lazy reset seeds history without
notifications, so reload afterward to exercise the actual loading path.

Run the pointer regression in an existing, exclusively owned ego-browser space:

```sh
UI_PARITY_LAZY_STEPS=1 UI_PARITY_PORT=60793 bun tests/fixtures/ui-parity/server.ts
bash tests/fixtures/ui-parity/check-lazy-steps.sh 265 http://127.0.0.1:60793
```

Replace `265` with the caller's existing task-space ID. The script changes only
the loopback fixture's saved session/locale preferences, clicks the real turn
and reasoning controls, checks their ARIA targets and rendered content, and
captures screenshots for visual review. It verifies repeated collapse/reopen,
one steps request, visible responses, unchanged inline compact grouping, and
the ordinary OpenCode disclosure. It leaves task-space lifecycle completion to
the caller's larger browser workflow and never creates or claims a new space.
