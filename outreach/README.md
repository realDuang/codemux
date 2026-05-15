# CodeMux GitHub Outreach

A **prompt-only** scheduled task that lives inside the codemux repo. It scans
GitHub for conversations where codemux can genuinely help, drafts thoughtful
replies for human review, sends the ones the human has explicitly approved, and
tracks follow-ups on past comments.

No external scripts, no servers — everything is driven by `PROMPT.md` running
through codemux's standard scheduled-task mechanism.

> Approval is mandatory. The agent never posts anything you haven't explicitly
> approved. See **HARD CONSTRAINTS** in `PROMPT.md`.

## Architecture

```
codemux Scheduled Task (e.g. every 2h)
        ↓
   AI Agent (Copilot CLI / Claude Code) reading PROMPT.md
        ↓ uses gh CLI + filesystem tools
   ┌──────────────────────────────────────────────┐
   │ Phase S: Send approved drafts                │
   │   inbox/*.md with approved=true              │
   │   → gh comment → archived/sent/YYYY-MM/      │
   │                                              │
   │ Phase A: Outreach Discovery                  │
   │   gh search → score → draft → inbox/         │
   │                                              │
   │ Phase B: Follow-up Tracking                  │
   │   gh notifications → draft → inbox/          │
   └──────────────────────────────────────────────┘
        ↓
   inbox/  (drafts awaiting your approval)
        ↓
   YOU: review draft, flip `approved: true`
        ↓
   next scheduled run posts it automatically
```

## Files in This Directory

| File | Purpose | In git? |
|------|---------|---------|
| `PROMPT.md` | Full prompt — paste into the codemux scheduled task | ✅ |
| `codemux-features.md` | Feature reference card the agent uses for relevance scoring | ✅ |
| `README.md` | This file | ✅ |
| `templates/state.json` | Initial state file template (copy to your working dir) | ✅ |
| `templates/cooldown.json` | Initial cooldown registry template | ✅ |
| `templates/posted-comments.jsonl` | Empty history file template | ✅ |
| `<workdir>/state.json` | Runtime state — agent updates after each run | ❌ gitignored |
| `<workdir>/cooldown.json` | Anti-spam cooldown registry | ❌ gitignored |
| `<workdir>/posted-comments.jsonl` | History of every draft + posting status | ❌ gitignored |
| `<workdir>/inbox/` | New drafts awaiting your `approved: true` flag | ❌ gitignored |
| `<workdir>/archived/sent/YYYY-MM/` | Successfully posted drafts | ❌ gitignored |
| `<workdir>/archived/runs.log` | One line per run for debugging | ❌ gitignored |

## Quick Setup

Pick a **working directory** for the scheduled task. Anywhere on your machine
works — pick whatever fits your dotfile / config conventions:

- `~/.codemux/outreach/` (Unix / macOS)
- `%USERPROFILE%\.codemux\outreach\` (Windows)
- `<this-directory>` itself — runtime data is `.gitignore`d so the repo stays
  clean. Convenient for testing, but you'll be running the agent inside your
  cloned repo, so weigh that against your preference.

Then bootstrap the working directory:

```bash
# 1. Create the working directory
mkdir -p ~/.codemux/outreach

# 2. Seed runtime files from templates/
cp outreach/templates/state.json ~/.codemux/outreach/state.json
cp outreach/templates/cooldown.json ~/.codemux/outreach/cooldown.json
cp outreach/templates/posted-comments.jsonl ~/.codemux/outreach/posted-comments.jsonl

# 3. Make sure inbox/ and archived/sent/ exist
mkdir -p ~/.codemux/outreach/inbox
mkdir -p ~/.codemux/outreach/archived/sent

# 4. Copy the feature reference card so the agent can read it
cp outreach/codemux-features.md ~/.codemux/outreach/codemux-features.md
```

`codemux-features.md` is treated as data the agent reads each run — keep a copy
inside the working directory so the prompt's relative path resolves correctly.

## Setting Up the Scheduled Task

1. Open codemux → Sidebar → **Scheduled Tasks** → **New Task**
2. Fill in:
   - **Title**: `GitHub Outreach`
   - **Description**: `Find, draft, and (after approval) post replies to relevant GitHub conversations`
   - **Engine**: `Copilot CLI` (recommended — best GitHub context, free tier covers this)
     - Alternative: `Claude Code` (better long-form reasoning, costs more)
   - **Working Directory**: the path you chose above (e.g. `~/.codemux/outreach`)
   - **Frequency**: start with `manual` for the first 3-5 runs to debug; switch
     to `interval: 2 hours` once you trust the output
   - **Prompt**: paste the entire contents of `PROMPT.md`
3. Save and run once manually.

> Whenever you tweak `PROMPT.md` in the repo, re-paste it into the scheduled
> task. The task stores its own copy of the prompt at creation time.

## Two Ways to Approve a Draft

The agent enforces "no posting without approval". You can grant approval in two
ways:

### Option A — File flag (works between runs, fully async)

1. Open the draft (path is your working dir + `inbox/<file>.md`)
2. Read the `## Reply Draft` section, edit if needed
3. In the frontmatter, change `approved: false` to `approved: true`
4. Save the file
5. Next scheduled run's Phase S will post it automatically

### Option B — Chat instruction (works in a live codemux session)

Open a regular codemux chat (no scheduled task), point the same prompt at the
same working directory, and just tell the agent:

```
Read inbox/, walk me through each pending draft (URL + 2-3 line outline only,
not the full body). For each, ask me approve / edit / skip. After I approve one,
flip its approved flag and post it immediately, then move on to the next.
```

The agent will treat each "approve" you say as equivalent to flipping the flag
and will post via `gh` right then.

## Daily Workflow (suggested)

```
Morning:   ls <workdir>/inbox/
           → see what was drafted overnight
           → spend 5 min reviewing, flip approved on the good ones

Lunchtime: scheduled task runs Phase S, posts the approved ones
           you get GitHub notifications when people reply

Evening:   ls <workdir>/archived/sent/
           → confirm what got posted today
           → eyeball any thread that already has replies
```

## Tuning the Prompt

`PROMPT.md` is yours — edit it freely (in the repo, ideally on a branch), then
re-paste into the scheduled task.

Common tweaks:

- **Too few drafts** → relax the relevance threshold (currently `< 7` is skipped)
- **Too many low-quality drafts** → raise it to `< 8`
- **Wrong topics** → add or remove search queries in section A1
- **Want fewer follow-ups** → raise the conversation round limit (currently 2)
- **Need different cap** → change `cap at 5 per run` in section A3

## Safety Rails (already enforced by PROMPT.md)

- ❌ Cannot post anything without `approved: true` (file flag or chat instruction)
- ❌ Cannot reply on the codemux repo itself
- ❌ Cannot write outside the working directory
- ❌ Cannot run destructive commands (no `gh repo delete`, no destructive `gh api`)
- 🟡 Cap at 5 outreach drafts per run
- 🟡 7-day per-repo cooldown (agent maintains in `cooldown.json`)
- 🟡 2-round per-conversation cap, 3rd round flagged `needs_human_takeover: true`
- 🟡 Issues with `bug` / `feature-request` labels get a -1 relevance penalty

## Recovering From Mistakes

**A bad draft got posted**: delete it via GitHub UI (or `gh issue/discussion`-comment
delete API), then add a manual cooldown entry to your `cooldown.json` so the
agent doesn't re-engage that thread:

```json
{
  "conversation_cooldowns": {
    "https://github.com/owner/repo/issues/123": {
      "blocked_until": "2099-01-01T00:00:00Z",
      "reason": "manual block — bad post"
    }
  }
}
```

**A send failed**: the draft stays in `inbox/` with `send_error: <message>` set.
Inspect, fix the underlying issue (e.g. token scope, network), clear `send_error`
manually, and the next run's Phase S will retry.

**Want to pause everything**: change the scheduled task frequency to `manual`.
Drafts already in `inbox/` with `approved: true` will only be sent on manual
runs.

## Troubleshooting

**Agent says "no new candidates"**: normal early on while search queries are
calibrated. Adjust queries in PROMPT.md section A1.

**Agent uses wrong tone in drafts**: rewrite the "Voice and Format" section in
PROMPT.md with examples of tone you want.

**Agent posts something without approval**: this should be impossible — Hard
Constraint #1 forbids it. If you see it happen, check that PROMPT.md hasn't been
truncated when pasted into the scheduled task. The constraint must be intact.

**Cooldown not respecting manual edits**: the agent reads `cooldown.json` at
start of every run, so manual edits take effect on the next run.

**`posted: true` but no archive entry**: the move step failed. Look in `inbox/`
for files with `posted: true` and move them manually to
`archived/sent/YYYY-MM/`.
