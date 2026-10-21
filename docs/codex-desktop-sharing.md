# Unified Codex sharing

CodeMux exposes one **Codex** engine. It can run its own native conversations
and connect to the local Codex Desktop/IDE coordination service. Each
conversation has one execution owner; other clients display that owner's state
and send requests to it. The model provider and credentials remain configured
on the execution host. Copying session files or using
the same provider URL on another device does not establish this live connection.

This integration uses a private protocol inspected against Desktop
26.1007.30912. Runtime checks have covered local Codex CLI 0.154.0 and 0.162.1;
cross-version restoration has explicit limits described below. Method versions, snapshot revisions,
thread identities, and response ownership are checked. Desktop upgrades require
another compatibility check.

## Enable sharing

Open **Settings → Engines → Codex → Share chats with Codex Desktop**. Changes
apply immediately and persist through the running host's settings writer. The
legacy `codexDesktopBridgeEnabled` setting and `CODEMUX_CODEX_DESKTOP_BRIDGE=1`
startup environment variable remain supported; an explicit environment value
still overrides the saved startup value. Sharing is disabled by default.

Turning sharing off detaches the transport and leaves local execution, pending
requests, and already accepted input with the original writer. Local chats remain
usable without the Desktop router. Previously known external chats keep readable
history; input requires their owner to reconnect or a verified native writer
acquisition. Enabling sharing reuses local writers and their canonical message
IDs. It does not start a competing process for an externally owned conversation.

Settings show transport availability. Chat details distinguish known creation
origin, the current execution client, and runtime version. Unknown origins remain
unknown; an observed external executor is not evidence of who created a chat.

The chat header distinguishes the sharing channel from an attached execution
owner. A healthy channel with no current owner shows **Sharing enabled**; it does
not imply that a historical conversation is running. The details list the
executor connection separately. Completed or interrupted history is not marked
as failed merely because its owner is offline.

Compatible follow-ups during execution use native steering. The pending preview
is removed when native acceptance is confirmed, using the sending client's
message identity. Explicit model or mode changes can still wait for the next
turn, and uncertain transport failures are not automatically replayed.

User question receipts retain their raw protocol text but display a question
summary and answer. Native image attachments display independently from the
request text; only structured local attachments authorize local file reads.
Temporary upload images can be recovered from validated inline bytes in the
same native turn, using the full text/path sequence rather than keeping upload
files alive. Images with neither a valid file nor unambiguous native bytes
retain an unavailable attachment card.

In the separated runtime, the Server process owns this bridge and its catalog. Electron passes its local settings/data directory to the supervised Server; standalone Node uses its selected data directory. The bridge uses local Node IPC and adds no Electron or display dependency to the Server. Stopping CodeMux detaches external Desktop conversations and stops only execution processes owned by CodeMux.

New eligible conversations appear automatically in the existing project sidebar.
The first successful catalog initialization saves a cutoff and a canonical
Codex-home source identity in CodeMux's `codex-desktop-catalog.json`. Native
conversations created after that cutoff, conversations already assigned to a
native project, and previously admitted IDs remain enrolled across restarts.
Legacy project assignments are neither read nor migrated. Older conversations
can still be attached manually.

To attach an older Desktop-owned conversation, open **Settings → Engines → Codex**
and use **Import History**. Keep the original conversation available
in Desktop for live input. The picker reads a bounded native catalog without
per-thread owner discovery, subscriptions, or resumption. Opening a selected
conversation follows its live owner when available; otherwise its stored history
can be read without starting another runtime.

New sessions created in CodeMux run through a CodeMux-owned
Codex runtime. They retain the native thread UUID and are advertised to compatible
IPC followers when sharing is enabled. Their saved metadata records the CodeMux
origin and runtime version; legacy `codexDesktopOwner: "codemux"` markers remain
recognized. Restoring a known session requires the original thread; a failed restore must
not create a replacement. If another client already owns that thread, CodeMux
follows that owner instead of starting a competing execution.

## Existing conversations and settings

Startup migrates legacy `codex-desktop` bindings into `codex` before engine routing
or channels start. Existing conversation IDs, history, archive/removal policy,
native project identity, and catalog source identity are retained. Duplicate
projections of the same native thread in the same Codex home use one visible row;
old IDs remain persistent aliases so existing IM bindings continue to route.
Removing an alias only detaches that old binding. Original index and projection
files are backed up under `conversations/migrations/codex-unified-v1` before the
new index is published. Different homes/sources are never merged by UUID alone.

The previously preferred Codex variant supplies new-chat defaults; legacy settings
keys remain as recovery data. Existing chats retain their own native settings.
Frontend rendering uses only unified capabilities and connection metadata.

## Runtime compatibility and history

Existing conversations use the exact CLI version recorded in their verified native
rollout metadata. CodeMux searches installed executables and retained standalone
releases; it does not download another version, rewrite global configuration, or
remove encrypted history. If the original version is unavailable, history remains
readable and explicit input returns an actionable compatibility error.

New conversations prefer the executable of a currently running local Desktop on
macOS when it can be verified, then fall back to the installed CLI. Runtime pools
retain their selected path/version and refuse an executable changed in place.
The prototype demonstrated that this environment's ModelHub conversations failed
when moving encrypted history between 0.154.0 and 0.162.1 in either direction,
while both same-version controls passed. Exact matching avoids that known failure;
it is not a claim of universal provider or future-version compatibility.

Canonical message projection is shared by local and followed sessions. Public
function/custom tool calls missing from native `thread/read` are reconciled from
that same thread's validated rollout, preserving call IDs, ordering, arguments
and outputs. Native replacements and removed turns win; encrypted reasoning is
never exported as display content.

## New conversation catalog

The metadata catalog polls every two seconds and refreshes earlier on supported
native notifications. It reads only the active native catalog without
resuming conversations or loading their transcripts. Gateway clients receive
catalog updates, and reconnecting clients fetch the latest snapshot. Source IDs
and native UUIDs map to persistent CodeMux conversation IDs; refreshing a list
does not delete and re-import history. Native project membership takes precedence
for display; otherwise the working directory selects an existing project or a
display-only directory group. Conversations in the default workspace stay in its
existing group. This display fallback does not write native project assignments.

Native listing omits some empty conversations. For already admitted IDs only,
the catalog can read native metadata and verify its existing rollout file under
the canonical Codex home. It checks the UUID, dated filename, regular-file type,
and active versus archived location before including the record. It neither
scans arbitrary rollouts nor changes them. This preserves known empty CodeMux
conversations across restarts while retaining the native archive boundary.
A conversation created in CodeMux starts as a local draft: its private runtime
starts the native thread, but CodeMux writes no name, admits nothing to the
catalog, and registers no shared owner. Creating or deleting a draft therefore
does not wait on native storage or Desktop IPC, and an untouched draft never
appears in Codex. The first input (or an explicit rename) publishes it: the
thread ID is admitted to the catalog and, with sharing on, its owner is
registered before the input is sent. Codex persists the thread with that first
item and displays its first prompt until someone renames it. A draft whose
writer is gone, e.g. after a restart, is removed from the local list. Earlier
versions wrote a `New session - <ISO timestamp>` placeholder name; CodeMux still
displays that recognized value as its localized new conversation label.

Opening an enrolled conversation follows its live owner or reads its stored
history. Sending valid input to an ownerless, unarchived conversation can acquire
the original thread through the native writer lock. The runtime must confirm the
same UUID and exclusive input capability before CodeMux advertises ownership.
Another writer's refusal never creates a replacement thread. Existing model,
effort, tier, and history settings are retained by native restoration.

CodeMux-created conversations announce availability after both a user message
and unarchived catalog membership are observed. This is an IPC availability
notification, not an acknowledgement that a particular official Desktop sidebar
has rendered the row.

Project management is deferred. Production advertises `sessionCatalog: true`
and `catalogManagement: false`; project mutation RPCs are rejected and no project
management controls are shown. Native project metadata does not establish
synchronization with the official Desktop's legacy project sidebar. The bridge
never edits global-state caches or migration flags.

## Supported operations

| Operation | Shared behavior |
| --- | --- |
| Text and history | Native item and turn IDs retained in metadata, stable conversation-scoped display IDs, streamed updates, and authoritative state after reconnect |
| Input during a turn | Forwarded to the same owner's active turn |
| Stop | Interrupts the synchronized active turn |
| Images | Image input and resulting messages are shared |
| Model, effort, permissions, Fast | Updates the owner's settings and waits for its confirmed state; native effort values such as `ultra` are preserved |
| Permission mode | The mode selector shows Codex's presets: Ask for approval (`on-request`, workspace sandbox), Approve for me (`on-request` with `auto_review`), and Full access (`never`, full-access sandbox). Other native combinations show no preset. The collaboration mode is not changed |
| Questions | Answers are forwarded to the original pending request; dismissing an ordinary blocking question stops its turn |
| MCP elicitations | Limited typed forms support accept, decline, and cancel; cancellation resolves the request without stopping its turn |
| Approvals | Supported command, file-change, and permission requests are routed to their owner; decisions must be offered by the pending request |
| Rename | Confirmed titles replace local title overrides; renaming while a turn runs is supported, but pending approvals or questions must be resolved first |
| New CodeMux sessions | A private runtime owns the native thread and publishes its state to shared clients |
| Delete | Empty chats are discarded locally; chats with content are archived natively before local removal |
| `/compact` | Forwarded to the owner when the conversation is idle |

Protocol wrappers also exist for queued follow-ups and editing the last user
turn. Their presence is not a claim that every Desktop control has a matching
CodeMux interface or has passed a live acceptance test.
Tool availability in a CodeMux-created conversation comes from its native
runtime; Desktop-specific app tools require an appropriate Desktop owner.

MCP elicitation forms handle a limited schema: primitive string, boolean, number,
and integer fields, enum arrays, supported common formats, and length/numeric
bounds. Unsupported modes, complex schemas, and specialized authorization flows
offer decline/cancel instead of an unvalidated submission. HTTP(S) links require
a user click. This path has fixture
coverage through state conversion, the adapter, and mocked IPC; it has not been
accepted against a real MCP elicitation server.

### Title synchronization

For a CodeMux-owned thread, the private runtime writes the name, confirms the
native metadata, and publishes the updated snapshot. A metadata-only poll also
notices titles written by another client.

For a Desktop-owned thread, CodeMux first verifies that the followed owner is
still current. A metadata-only app-server verifies that the thread is unarchived,
writes the name once, reads it back, and checks availability again. It never
resumes the thread or starts a turn.

CodeMux then replays the verified unarchived/available state to that same owner,
using its own client identity. Desktop refreshes its resident metadata. This
notification does not itself reliably push a new snapshot, so CodeMux requests
bounded, read-only snapshots until the title matches. It does not call
`thread/archive` or `thread/unarchive`. A stored title whose owner state cannot be
confirmed is reported as unconfirmed, not as a successful synchronized rename.

### Deletion and archived conversations

Delete is the shared conversation's only removal action in CodeMux. The header
has no Archive or Open in Codex shortcut.

CodeMux hides the row as soon as you delete it, then waits for the native
result in the background. If archiving fails, an error is shown and the list is
refreshed, which restores the conversation.

Opening a conversation shows stored history at once when no live owner answers
discovery within 250 ms. The Desktop router reports a missing owner only after
its fixed 10-second deadline, so discovery continues in the background and
switches the view to the live owner if one appears.

- An empty conversation is removed locally. Its native thread is not archived
  or deleted. A source-scoped suppression record prevents polling and restart
  from re-adding that discarded empty conversation.
- A conversation with content is archived through its actual native owner or a
  metadata client with permission to archive it. Only a confirmed native archive
  removes the local record and message/step mirrors. Failure preserves the local
  conversation. Explicit re-import can restore the local entry after Codex has
  returned it to the active state; polling alone does not undo a deletion.
- Archived Codex conversations are excluded from discovery, import, stored
  listings, browser notifications, and history reads. Identity-only removal
  notifications clear already open clients. Native archive metadata can still be
  read internally to verify an operation; archived transcripts are not hydrated
  for client history reads.

Deletion checks the native history and current pending work instead of trusting
an old local message count. A running turn or pending interaction must finish
first. An idle foreign Desktop owner may still hold the native writer; an archive
refusal leaves the CodeMux conversation intact. No false archive notification is
sent to force that owner to release its writer. Native permanent deletion is not
part of this integration.

Editing the last user turn has a typed Desktop IPC wrapper, but the shared
adapter, CodeMux-owned runtime handlers, and common gateway do not expose that
operation. Shared text sending and steering append input; they do not edit
committed history. Shared rollback and fork controls remain outside acceptance.

Stopping the shared service or quitting CodeMux detaches its followers and stops
only its own private execution runtime. It does not stop official Desktop or
interrupt Desktop-owned tasks.
The execution owner and local IPC router must remain available for live use.
The gateway closes upgraded WebSocket connections before awaiting HTTP server
shutdown, so an attached browser does not prevent CodeMux from exiting.

## Browser and phone access

Browser clients connect to the same CodeMux gateway, not directly to the private
Codex IPC socket. See [Custom browser access](custom-access.md) for an existing
LAN address or HTTPS domain, WebSocket forwarding, device authorization, and
revocation. The ModelHub key and runtime credentials remain on the host.

PWA installation, iOS/Android background behavior, Web Push, and the official
ChatGPT mobile Remote experience are outside this integration's acceptance.
An authenticated browser route and a working local shared engine do not establish
those mobile capabilities.

## Production validation

```sh
bun run codex:sharing:verify --write --questions
```

This opt-in run creates a dedicated native conversation and checks independent
execution, active-turn sharing, both input directions, native composer queues,
questions, cancellation, reconnect, and disabling sharing during execution. The
read-only default probes only the existing router. Native history is retained;
no other client is stopped. [Prototype evidence](codex-sharing-prototype.md)
records the official Desktop/UI round trip and version-control findings.

## Additional local validation

Use a dedicated test conversation. Write-enabled checks append test turns and
can temporarily change that conversation's settings. They print summary metadata
without original conversation content, credentials, or owner IDs. Commands are
not automatically retried after an uncertain result.

### Existing Desktop-owned thread

Each command is read-only without `--write`:

```sh
bun run codex:desktop:smoke --thread <thread-id>
bun scripts/codex-desktop-feature-smoke.ts --thread <thread-id>
bun scripts/codex-desktop-interaction-smoke.ts --thread <thread-id>
bun scripts/codex-desktop-approval-smoke.ts --thread <thread-id>
```

The corresponding opt-in write checks are:

```sh
bun run codex:desktop:smoke --thread <thread-id> --write --steer --interrupt
bun scripts/codex-desktop-feature-smoke.ts --thread <thread-id> --write --image
bun scripts/codex-desktop-interaction-smoke.ts --thread <thread-id> --write --cancel-question
bun scripts/codex-desktop-approval-smoke.ts --thread <thread-id> --write
```

The feature, interaction, and approval scripts have a 180-second budget and
reserve time to restore and verify native settings. The feature check repeats
the original model; it reports `not-different-model` and does not establish a
successful switch to a different model. The approval check temporarily selects
the built-in read-only profile with user approval, and approves only its one
verified stdout-only `printf`. Its failure cleanup can interrupt only the
explicitly identified test turn.

### Real gateway

```sh
CODEMUX_DESKTOP_TEST_THREAD=<thread-id> \
  bunx vitest run --config vitest.desktop-live.config.ts
```

Set `CODEMUX_DESKTOP_TEST_WRITE=1` to additionally send one echo through the real
gateway. Its two WebSocket clients use a temporary token, loopback listener, and
temporary CodeMux storage. The running application's data and ports are not used.

### New CodeMux-owned thread

```sh
CODEMUX_DESKTOP_TEST_CREATE=1 \
  bunx vitest run --config vitest.desktop-live.config.ts
```

This separate opt-in creates one native thread, sends one no-tools echo, checks
an independent IPC follower, reconnects it, and restarts the private service to
verify restoration of the same UUID, model, and history. It does not require or
modify the existing Desktop test conversation. The new native history is retained.

Optional `CODEMUX_DESKTOP_TEST_HOLD_MS` keeps the owner alive after the echo and
prints a thread link for a manual Desktop check. It defaults to zero and accepts
at most 600000 milliseconds. The test does not open a window or change focus.

### Automatic discovery and ownerless continuation

```sh
CODEMUX_DESKTOP_TEST_CATALOG=1 \
  bunx vitest run --config vitest.desktop-live.config.ts
```

This opt-in uses a fresh native thread with the default history mode, temporary
CodeMux storage, and two authenticated gateway clients. It checks automatic
discovery, external rename polling, refusal of a competing writer, continuation
after the original writer exits, and stable IDs/history after a service and Store
restart. Native listing is scoped to its temporary working directory. It sends
bounded no-tools echo prompts and never changes project records.

`CODEMUX_DESKTOP_TEST_CATALOG_HOLD_MS` can retain the temporary gateway for up to
300000 milliseconds for a browser check. The temporary token stays in a mode-0600
file; stdout contains only the local URL and file path. Cleanup confirms that
every test-owned native process exits.

## Historical validation and compatibility limits

Local acceptance on 2026-10-12 and 2026-10-13 used ModelHub, Codex Desktop
26.1007.30912, and Codex CLI 0.154.0. The installed Apple Silicon preview passed
4,169 unit tests (three skipped), TypeScript checking, the production build,
and strict deep signature verification. The final repository candidate passed
4,178 unit tests (three skipped), TypeScript checking, and the production build.

Real runtime and installed-app checks covered:

- Text submission from two clients, streaming updates, same-turn steering,
  interruption, and authoritative history after reconnect.
- Shared native effort, plan/default mode, Fast settings, image input, a blocking
  question, and one command approval. Temporary settings were restored.
- New conversation discovery, external title changes, exclusive-writer refusal,
  ownerless continuation, and private-service restart with the same UUID and
  history. Reading stored history did not start an execution runtime.
- Project-sidebar creation while another client read the new conversation.
  Regression tests reproduce both completed and pending owner-discovery misses
  that previously caused creation to dereference a missing live session.
- Mocked IPC reconnection with a retained native writer, foreign-owner changes
  during reconnect, rejection of bulk project deletion involving shared chats,
  and full-message part removal while a history request is in flight.
- Empty deletion that removed both clients' rows while leaving the native thread
  active; content deletion that confirmed native archive before clearing both
  clients' rows and transcripts; archived catalog/history exclusion; stale local
  mirror cleanup; and suppression across an application restart.
- Two browser clients, including a 390 by 844 viewport. The user also confirmed
  that official Desktop displayed replies from a CodeMux-created conversation.
  These are browser-emulation and Desktop checks, not physical-phone acceptance.

Retained native histories matched their pre-upgrade snapshots. The official
Codex application bundle, its global-state caches, and migration flags were not
modified. Existing remote-access configuration was retained.

The bridge uses a private protocol and requires compatibility validation after
upstream updates. These checks do not establish every approval variant, live MCP
elicitation, switching to a different model, shared rollback/fork/edit controls,
project mutation synchronization, automatic rendering in every official Desktop
sidebar, or physical-phone PWA/background behavior. A live foreign owner can
refuse archive; CodeMux must report failure and keep the local conversation.
