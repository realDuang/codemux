# VS Code agent sessions

CodeMux can attach to local VS Code Agent Host chats through Microsoft's
Agent Host Protocol (AHP). This is an opt-in connection to the original executor,
not a history import or a second agent running the same conversation.

## Enable

1. Open a compatible VS Code installation and authenticate its desired provider there.
2. Create or open a chat backed by its Agent Host.
3. In CodeMux, open **Settings > Session sources** and enable
   **Connect to Agent Host chats**.
4. Expand the corresponding project in the sidebar and select a chat with the
   **Agent Host** connection-source badge.

The original Copilot integration was exercised against VS Code 1.147.0 using
the AHP 1.1 protocol. Provider routing is tested with authenticated local AHP
fixtures; those tests do not claim live Claude or Codex model execution.
The editor or standalone VS Code Agent Host must publish an authenticated local
endpoint. Legacy
extension-host/Local chats are not converted into Agent Host chats.

Discovery covers the current OS user's default Stable and Insiders user-data
directories. For custom or portable installations, the host setting
`vscodeAgentHostUserDataPaths` can override these search locations with an array
of absolute user-data directory paths. Discovery merges per-instance entries
with the read-only legacy `metadata.json` registry. It accepts both editor and
standalone hosts, through local sockets or authenticated loopback TCP
(`127.0.0.1`, `::1`, or loopback-resolving `localhost`). Relative paths, remote
named pipes, non-loopback TCP, and unauthenticated endpoints are not admitted.

The dedicated Agents window can select a standalone host even when an editor
is open on the same computer. CodeMux attaches to that existing host; it does
not start a replacement or take over execution.

## Providers and ownership

The connection belongs to the **Agent Host**, not to Copilot. One opt-in
setting, discovery loop, and authenticated connection per endpoint serve all
supported providers. Disabling it disconnects all attached Host chats together;
it does not disable any local engine or the separate Codex Desktop connection.

Connection details separate **Connection source**, **Creating app**, and
**Current executor**. AHP chats use `Agent Host` for the source and executor;
the creating app remains unknown. The registry location, editor/standalone
process mode, provider, and currently connected clients do not establish which
application created an individual chat. CodeMux does not infer Agency versus
VS Code from them or from unverified extension metadata. This does not filter
either application's chats out of the catalogue.

The sidebar uses the known creating app when available, otherwise the connection
source, with a corresponding tooltip. Saved AHP records with the old hardcoded
VS Code origin are normalized on load, including when the source is disabled.

The explicit native harness mapping is:

| AHP provider ID | CodeMux engine |
|---|---|
| `copilotcli` | Copilot |
| `claude` | Claude |
| `codex` | Codex |

These are harness IDs documented by Microsoft's agent-host implementation, not
model vendors or extension IDs. A Claude model selected in a `copilotcli` chat
is still a Copilot chat. A chat's advertised `provider` overrides its containing
session's provider, including mixed-provider side chats. The provider must also
be advertised by the connected host. Unknown providers are reported in source
settings but are not shown under a guessed engine identity.

The pinned `@microsoft/agent-host-protocol` 1.1.0 declares this provider override
and the shared chat actions. Only that common conversation surface is used:
provider-specific SDK methods are never invoked for an AHP chat. Available
models come from that chat's own provider, modes from its configuration schema,
reasoning choices from the model schema, and image input requires advertised
vision support. Unsupported or immutable configuration is not emulated.
Authentication and harness availability remain the editor's responsibility.

- New CodeMux conversations continue to use their existing local adapters/SDKs.
- VS Code conversations retain their native chat identity and execution owner.
  Their model and mode controls use that owner's advertised choices.
- VS Code keeps its provider authentication. CodeMux does not copy provider
  tokens or authenticate VS Code through the Copilot SDK.
- Each engine card's SDK authentication status is independent of the VS Code
  connection status. An attached chat can work even if the SDK is signed out.
- Local transport credentials stay in the host process, never in the browser,
  conversation metadata, or connection URLs sent to remote clients.

Messages, streamed responses, tool approvals, questions, cancellation, and queued
prompts use the original Host. Replies completed by another client withdraw stale
prompts. Conflicting live owners are refused rather than selected arbitrarily.
If a write is interrupted before confirmation, its outcome may be unknown:
refresh the conversation before retrying instead of sending it twice.

## Offline, removal, and scope

Stopping the owning Host or disabling the switch disconnects the bridge. Already loaded
history remains readable, but input is unavailable until the original executor
returns. Reconnection preserves identity and reloads authoritative snapshots.
Read-only chats remain readable without acquiring an execution owner.

**Remove from CodeMux** hides the local entry; it does not delete or archive the
VS Code session. The removal is remembered across discovery and restarts.
Rename a primary chat in either application; rename side chats in VS Code.
Stopping CodeMux does not stop the editor Host or cancel its running turns.

Discovery is local to the computer running the CodeMux backend. A phone or remote
browser can access those chats through CodeMux's existing authenticated remote
access, including Microsoft Dev Tunnels. Chats hosted on another computer are not
discovered through the VS Code account.

The bridge is a conversation client, not the complete VS Code workbench:
interactive terminal/editor surfaces and large resource-backed attachments remain
in VS Code. CodeMux displays inline content, image attachments, terminal result
previews, and references for content it cannot render inline.

## Development

The host source lives under `electron/main/session-sources/agent-host`: discovery,
transport, catalogue, projections, and provider normalization are shared.
It implements the `SessionSource` lifecycle/control contract, not `EngineAdapter`.
Normalized conversation events and send options are shared through
`shared/session-backend.ts`, without a source-to-engine implementation dependency.

The engine-side bridge consists of `engines/agent-host-provider-adapter.ts` and
`engines/host-routed-adapter.ts`. `HostRoutedAdapter` composes each supported local engine without changing its
creation/history/model APIs; AHP identities cannot enter SDK resume/create
fallback. Codex retains its native catalogue source and adds the host-owned
entries to that view. Per-session capabilities override local-engine defaults.

`ServiceRuntime` starts engines and session sources as separate lifecycle groups.
Both settle before channels start. Normal shutdown explicitly disconnects sources,
including late-starting connections, without stopping their external execution owners.

The original `ahp:v1:` IDs, Copilot catalogue source ID, stored history, and
`vscodeAgentHostEnabled` / `vscodeAgentHostUserDataPaths` settings are preserved.
Older Copilot records without provider metadata are recognized; new records
persist the native provider. A saved chat whose host changes its provider is
made unavailable rather than silently rebound to a different engine.

The typed `session.source.list` and `session.source.set` gateway requests expose
source state/control independently of the existing `engine.sharing.*` API.
No endpoint credentials or private transport details are exposed.

The unit fixtures use authenticated local WebSocket pipes and loopback TCP
without an account or model invocation:

```powershell
bun run test:unit tests\unit\electron\session-sources\agent-host tests\unit\electron\engines\host-routed-adapter.test.ts tests\unit\shared\service-runtime.test.ts --maxWorkers=2
bun run typecheck
```

For an unpackaged desktop preview using the existing isolated development
profile (separate CodeMux data under `.codemux-dev` and allocated ports):

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
bun run dev:isolated
```

This does not isolate provider accounts or launch a second VS Code: discovery
still attaches only to the current user's existing local Host endpoints after
opt-in. Do not copy the user's production settings/profile into the preview.
