# Unified Codex sharing prototype

This document records the prototype checkpoint from 2026-10-15. It tested whether
an ordinary, already-used Codex execution could join live Desktop sharing without
copying its thread, restarting its writer, or creating duplicate CodeMux
conversations. Production now uses the unified engine described in
[Unified Codex sharing](codex-desktop-sharing.md).

## Reproduce the production acceptance

The experimental launcher has been absorbed into the production unified engine.
The implementation below records the original prototype findings. Run the
maintained real-session acceptance through the production adapter:

```sh
bun run codex:sharing:verify --write --questions
```

The command creates one dedicated test thread, retains its native history,
prints bounded stage metadata, and never stops an unrelated execution client.
See [Unified Codex sharing](codex-desktop-sharing.md) for the production lifecycle
and migration behavior.

## Historical prototype acceptance

The inspected environment is Codex CLI 0.162.1 and Desktop 26.1007.30912.
Protocol-level checks use a real app-server, model responses, the existing native
IPC router, and independent follower connections. Only the standalone verifier's
Electron logging shell is replaced; the app prototype uses the normal Node host.

| Case | Status |
| --- | --- |
| Ordinary conversation completes a turn before sharing is enabled | Passed |
| Attach during an active ordinary turn without changing its UUID or turn ID | Passed |
| New follower reads old history and stops the original active turn | Passed |
| Original runtime sends a reply observed by the follower | Passed |
| Follower sends a reply observed by the original runtime | Passed |
| Same-turn steering and cancellation in both directions | Passed |
| Follower reconnect preserves complete, unique history | Passed |
| Sharing detaches during a turn without stopping the original runtime | Passed |
| Built-in question answer and cancellation synchronize | Passed |
| Real CodeMux composer and gateway display the shared conversation | Passed |
| Official Desktop UI reads the live CodeMux-owned conversation | Passed by user screenshot |
| Native queue-state request, generated response, and same-ID replay | Passed after adding queue receipt/drain/broadcast |
| Native queue request with custom permission selection | Passed, including generated response and replay deduplication |
| Official Desktop UI sends through its normal composer | Passed after queue and permission-selection integration; user confirmed normal reply |
| CodeMux UI receives the official message and sends a reverse reply | Passed; both exact reply markers occur once in the same native thread |
| Official Desktop UI displays the reverse CodeMux reply | Passed; user confirmed CODEMUX_UI_V3_BACK_OK in the same conversation |
| Image input and generated image interpretation response | Input delivered; model response failed with upstream 429 |
| Approval request and independent allow-once response | Passed; native output and final response verified |
| Completed approval command retained in hydrated tool steps | Failed: native thread/read omitted the custom exec item |

These results describe the prototype checkpoint. Production adds validated
rollout reconciliation for missing public tool records, exact-version runtime
selection, saved binding migration, and persistent sharing settings. The table
does not claim fresh acceptance of those later changes.

The first run exposed a redundant no-owner discovery: two native discovery
windows exceeded the verifier's 20-second limit. The redundant lookup was
removed, while the registration path still validates the owner. Cold attach and
reconnect checks now use the existing 60-second cold-read budget.

## Runtime-version control

Opening a stopped test thread in the official application exposed a separate
history compatibility failure. The application was running `/usr/local/bin/codex`
0.154.0, while the prototype used the independently installed 0.162.1. Three
controlled cases used fresh dedicated threads, the same GPT-6.1-Sol model and
ultra effort, unchanged encrypted-content hashes, and strict native UUID
restoration. No IPC or official UI was involved in these controls.

| First runtime | Resuming runtime | Second response |
| --- | --- | --- |
| 0.162.1 | 0.162.1 | Passed |
| 0.162.1 | 0.154.0 | Failed: invalid_encrypted_content / -4003 |
| 0.154.0 | 0.154.0 | Passed |
| 0.154.0 | 0.162.1 | Failed: invalid_encrypted_content / -4003 |

Switching binary versions in either direction reproduced the observed failure in this environment.
Keeping the original owner alive avoids this particular runtime handoff. This
does not establish compatibility for arbitrary versions, providers, or models.

The official composer's separate `no-client-found` error was traced to its
`acceptLocally` path: even plain text first publishes
`thread-follower-set-queued-follow-ups-state` v1. Direct `turn/start` probes do
not cover this path. The same queue request reproduced the error against the
live prototype owner before the missing handler was implemented.

The implemented handler preserves the original client message ID, resolves
permission selection through the same execution runtime, starts or steers the
original turn according to native intent, and publishes the native v2 queue
broadcast. A receipt does not consume input before admission. The real official
composer then produced `DESKTOP_UI_V3_OK`; the CodeMux page displayed it and sent
`CODEMUX_UI_V3_BACK_OK`. Native readback contained each reply exactly once and
the same thread remained idle afterward.
The user also confirmed the reverse reply appeared in the official Desktop UI.

The prototype's final local regression run passed 5,381 tests across 172 files,
typechecking, and the Desktop/Web production build. Current production checks
must be run against the final production revision.

## Limits

An independent IPC follower is not proof that the official Desktop UI has
consumed a snapshot. The official application must open the selected dedicated
thread for that separate acceptance check. The prototype did not establish
unconditional sidebar discovery or support for every Desktop-only app tool.
Historical engine settings and IM bindings were outside the prototype's scope;
their production migration is documented in the unified sharing guide.

Creation provenance is recorded only when known. Attaching an external thread
does not prove which application originally created it.
