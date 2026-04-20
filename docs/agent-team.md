# Agent Team

Agent Team is a multi-agent orchestration layer that lets a single user prompt fan
out into a DAG of subtasks executed by one or more engine sessions. It fuses two
designs:

1. **fridayliu/feat/agentteam** — Light/Heavy brain split with a DAG executor,
   guardrails, and a user-channel relay for human-in-the-loop Heavy Brain runs.
2. **PR #117 (realDuang/feat/agent-team)** — role-based orchestrator with
   plan-confirmation UI, role→engine mapping settings, and team worktrees.

Both histories are preserved via a merge commit; the merged system keeps
fridayliu's Light/Heavy brain core and absorbs PR #117's plan-confirm, role, and
team-worktree concepts.

## Two Brains

| Brain  | Entry file                                   | Behavior                                                                 |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------ |
| Light  | `electron/main/services/agent-team/light-brain.ts` | One-shot planner: asks an engine to produce a DAG, then executes it.  |
| Heavy  | `electron/main/services/agent-team/heavy-brain.ts` | Persistent orchestrator: drives dispatch iteratively; supports UserChannel relays for clarification from the human. |

Both brains share:

- **DAG executor** (`dag-executor.ts`) — honors `dependsOn`, runs tasks in
  parallel up to a concurrency cap.
- **TaskExecutor** (`task-executor.ts`) — runs a single task inside a dedicated
  engine session, retries once on transient failure, and now calls an optional
  `RoleResolver` to map `task.role` → `{engineType, modelId}` before dispatch.
- **Guardrails** (`guardrails.ts`) — rate limits, loop detection, max turns.

## Plan Confirmation

The Light Brain pauses between planning and execution when
`teamRun.requirePlanConfirmation` is true (default for Light, off for Heavy).

Flow:

1. Light Brain generates a DAG and sets `teamRun.status = "awaiting-confirmation"`.
2. Gateway emits `team.run.updated`; UI shows the plan in `TeamRunCard` with a
   "Confirm & execute" button.
3. User inspects/edits tasks in `TeamRunCard`, then fires
   `gateway.confirmTeamPlan(runId, tasks)`.
4. The service's `confirmPlan(runId, tasks)` resolves the pending gate;
   Light Brain resumes with the user-edited DAG.

Rejection (run cancellation) rejects the pending gate and marks the run failed.

Gateway keys: `TEAM_CONFIRM_PLAN`. Relevant types live in `src/types/unified.ts`.

## Role Resolution

Tasks can declare a semantic role instead of a concrete engine:

```ts
{ role: "explorer", ... }   // read-only investigation, prefer fast engine
{ role: "coder", ... }      // read/write, prefer capable engine
```

Built-in roles (see `DEFAULT_ROLE_MAPPINGS` in
`electron/main/services/agent-team/index.ts`):

| role       | read-only | intended use                         |
| ---------- | --------- | ------------------------------------ |
| explorer   | yes       | codebase reconnaissance              |
| researcher | yes       | external docs / web research         |
| reviewer   | yes       | code review pass                     |
| designer   | no        | design/architecture drafts           |
| coder      | no        | implementation                       |

Mappings are persisted in `settings.json` under `team.roleMappings`. They can be
overridden at runtime via `AgentTeamService.updateRoleMappings()` / gateway
`TEAM_UPDATE_ROLE_MAPPINGS`.

Resolution order in `TaskExecutor`:

1. If `task.engineType` is explicitly set → use it verbatim.
2. Else if `task.role` is set and `resolveRole` returns a mapping → use it.
3. Else fall back to the run's `defaultEngineType`.

## Team Worktree

Read/write tasks share a single git worktree so successive tasks see each
other's edits. `TeamRun.teamWorktreeName` / `teamWorktreeDir` carry the
shared worktree through the run, and `DAGExecutor.runSingleTask`
routes each task based on its read/write intent:

- **Write-capable task** (`needsWorktree !== false`, or role mapping
  has `readOnly: false`) → runs with `directory = teamWorktreeDir`
  and `defaultWorktreeId = teamWorktreeName`, so all writers share a
  single worktree.
- **Read-only task** (`needsWorktree === false`, or role mapping has
  `readOnly: true`) → runs in the run's primary directory, avoiding
  contention with writers.

When `teamWorktreeDir` is unset, all tasks use the run's directory
and existing `run.worktreeId`.

The gateway `WORKTREE_CREATE` handler whitelists `team-*` names so the
orchestrator can provision worktrees even when the global worktree
feature flag is off.

## Result Aggregation to Parent

When a run reaches a terminal state (`completed` / `failed`) and has a
`parentSessionId`, `AgentTeamService.relayResultsToParentSession()`
sends the aggregated `finalResult` + failed-task list as a user message
to the parent session. The parent engine then summarizes for the user,
keeping everything in one conversation.

Gated by `TeamRun.aggregateToParent` (defaults to `true`; set `false`
to disable). Failures are swallowed with a warn log so a broken parent
session cannot corrupt run state.

## Sidebar Grouping

Chat wraps `connectTeamHandlers()` to mirror every TeamRun update into
PR #117's orchestration sidebar registry (`registerTeam` +
`associateRunWithTeam` + `associateChildSession`), so Light/Heavy brain
child sessions collapse under their parent session in
`SessionSidebar` with the same UX as PR #117's orchestrator-service
flow.

## Service Coexistence

During the merge we kept PR #117's `orchestrator-service.ts` (role-based
orchestrator) alongside fridayliu's `agent-team/index.ts` (Light/Heavy brain).
Both are wired into `ws-server.ts` and both have a UI surface in `Chat.tsx`.
This lets the two flows ship side-by-side; a future cleanup pass can decide
whether to delete the PR #117 service once the Light/Heavy flow owns all the
PR #117 use cases.

## Request Types

| Gateway key                    | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `TEAM_RUN_CREATE`              | Create a new team run                      |
| `TEAM_RUN_LIST`                | List all runs                              |
| `TEAM_RUN_CANCEL`              | Cancel an active run                       |
| `TEAM_RUN_DELETE`              | Delete a completed run                     |
| `TEAM_CONFIRM_PLAN`            | Resolve the plan-confirmation gate         |
| `TEAM_GET_ROLE_MAPPINGS`       | Read current role→engine mappings          |
| `TEAM_UPDATE_ROLE_MAPPINGS`    | Persist role→engine mapping edits          |

See `src/types/unified.ts` for the payload schemas.

## Tests

Primary specs:

- `tests/unit/electron/services/agent-team/index.test.ts` — lifecycle,
  persistence, role mappings, plan-confirm gate.
- `tests/unit/electron/services/agent-team/light-brain.test.ts` — planning,
  awaiting-confirmation pause/resume, rejection.
- `tests/unit/electron/services/agent-team/heavy-brain.test.ts` — dispatch,
  UserChannel relays.
- `tests/unit/electron/services/agent-team/task-executor.test.ts` — role
  resolution, retry, error surfacing.
- `tests/unit/electron/services/agent-team/dag-executor.test.ts` — DAG order,
  concurrency cap.
