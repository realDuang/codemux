# CodeMux — Reference Card for Outreach Agent

This is a condensed feature reference for evaluating whether codemux is genuinely
relevant to a given GitHub issue / discussion. Read this before scoring relevance.

Repository: https://github.com/realDuang/codemux

## What codemux IS

A multi-engine AI coding client (Electron desktop app + web). It hosts multiple
AI coding agents through one unified UI:

- **OpenCode** (HTTP REST + SSE)
- **GitHub Copilot CLI** (JSON-RPC over stdio) — codemux is the FIRST and CURRENTLY ONLY
  open-source GUI for Copilot CLI
- **Claude Code** (Claude Agent SDK over stdio)
- **Codex** (JSON-RPC over stdio, app-server protocol) — experimental

All four engines share a normalized type system, so tool calls / file diffs /
streaming output render identically in the UI regardless of engine.

## What codemux IS NOT

- Not another chat wrapper around an LLM API
- Not a chat-only client (it does full agentic coding: shell, edits, search)
- Not a generic AI assistant (it's specifically for coding workflows)

## Killer features (use these to match incoming issues)

1. **Multi-engine in one UI** — switch between OpenCode/Copilot/Claude/Codex without
   losing session, with each engine keeping its full capabilities
2. **Orchestration (multi-agent teams)** — assign roles (explorer / researcher /
   reviewer / designer / coder) → each role maps to a specific engine. Decompose a
   task with one engine, run subtasks in parallel via DAG scheduling, all in an
   isolated git worktree
3. **First open-source GUI for Copilot CLI** — visualizes Copilot's full agentic flow
   that's otherwise terminal-only
4. **Full chain-of-thought visualization** — every tool call, every diff, every shell
   command is rendered as expandable steps (not just final answer)
5. **Remote access from any device** — zero-config Cloudflare Tunnel (quick or named),
   browser access from phone/tablet, IM bot channels (Feishu / DingTalk / Telegram /
   WeCom / Teams) with real-time streaming + structured rich content
6. **Multimodal input** — paste/drag/upload images for any engine to analyze (JPEG/PNG/
   GIF/WebP, up to 4 per message)
7. **Scheduled tasks** — automate recurring agent tasks (interval / daily / weekly)
8. **Git worktree parallel sessions** — work on multiple branches simultaneously, each
   with its own AI sessions, merge back via merge / squash / rebase
9. **Slash commands & engine skills** — /cancel, /status, /mode, /model + each engine's
   native commands and project/personal skills, all in one autocomplete UI
10. **Per-engine model selection** — pick different models for each engine; supports
    custom model IDs for Claude Code and Codex
11. **Token usage tracking** — input/output/cache tokens per engine with cost breakdown
12. **Live todo panel + permission approvals + interactive questions** — full agent UX

## Strong relevance signals (score 8-10)

The user's issue / discussion involves:
- Wanting a GUI for Copilot CLI / Codex CLI / Claude Code CLI
- Comparing or struggling to switch between AI coding agents
- Wanting multi-agent / agent-team / role-based AI workflows
- Remote access to AI coding (mobile / tablet / web)
- IM bot integration for AI coding (Feishu / Telegram / etc.)
- Visualizing AI agent thinking / tool calls / diffs
- Token cost optimization across multiple AI providers

## Medium relevance (score 5-7) — proceed with caution

- General AI coding tool comparison threads
- Cursor / Cline / Continue / Aider feature requests where codemux has the feature
- Asking about cross-platform AI coding setup

## Low / no relevance (score < 5) — SKIP

- LLM API billing or model behavior questions (not a tooling problem)
- IDE plugin requests (codemux is a standalone client, not an IDE plugin)
- Issues specifically about a single engine's bug (file with that engine, not codemux)
- Anything where mentioning codemux would be off-topic spam

## Tone reference

- Author / maintainer voice: technically substantive, no marketing language
- Use lower-case names ("codemux") not capitalized branding
- Always link to specific docs / source code, not just the repo root
