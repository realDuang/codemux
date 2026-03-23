# Contributing to CodeMux

Thank you for your interest in contributing to CodeMux! This guide will help you get started.

## Development Setup

```bash
# 1. Clone the repository
git clone https://github.com/realDuang/codemux.git
cd codemux

# 2. Install dependencies (requires Bun)
bun install

# 3. Download Cloudflare Tunnel binary (optional, for remote access)
bun run update:cloudflared

# 4. Start the development server
npm run dev
```

### Prerequisites

- **Bun** — Package manager and script runner
- **At least one AI engine CLI** — [OpenCode](https://opencode.ai), [GitHub Copilot](https://github.com/features/copilot), or [Claude Code](https://claude.ai/code)
- **Node.js 20+** — For Electron and build tools

## Key Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Electron app with hot reload |
| `bun run start` | Start web-only mode (no Electron) |
| `npm run typecheck` | TypeScript type checking |
| `bun run test:unit` | Run unit tests |
| `npm run build` | Production build |

## Architecture Overview

CodeMux is a multi-engine AI coding assistant client. The key architectural rule is:

> **Engine-agnostic frontend**: All engine-specific logic lives in adapter layer (`electron/main/engines/`), never in the frontend (`src/`). The frontend renders based solely on unified types.

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.

## Code Conventions

- **File naming**: kebab-case for utilities (`gateway-client.ts`), PascalCase for components (`SessionTurn.tsx`)
- **TypeScript**: Prefer `interface` for objects, `type` for unions. Avoid `any`.
- **SolidJS**: Use `createMemo` for computed values, `batch()` for grouped store updates
- **i18n**: Never hardcode user-facing strings — use `t()` from `useI18n()`
- **Testing**: Tests in `tests/unit/` mirroring source structure. Run with `bun run test:unit`

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add session search functionality
fix: clean up message buffers on cancel
chore: update Shiki language whitelist
docs: add channel development guide
```

## Discussions & Feature Requests

Before starting work on a new feature, check our [**GitHub Discussions**](https://github.com/realDuang/codemux/discussions):

- [**Roadmap**](https://github.com/realDuang/codemux/discussions/61) — See what's planned and in progress
- [**Ideas**](https://github.com/realDuang/codemux/discussions/categories/ideas) — Propose new features or vote on existing ones
- [**Q&A**](https://github.com/realDuang/codemux/discussions/categories/q-a) — Ask questions about the codebase or architecture

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes with tests
3. Run `npm run typecheck && bun run test:unit` before pushing
4. Open a PR against `main` — the template will guide you

## Adding a New Engine

1. Create adapter directory in `electron/main/engines/[engine-name]/`
2. Extend `EngineAdapter` base class from `engine-adapter.ts`
3. Implement converters to normalize engine data into unified types
4. Register in `EngineManager` (`electron/main/gateway/engine-manager.ts`)

## Adding a New Channel

1. Create adapter directory in `electron/main/channels/[channel-name]/`
2. Extend `ChannelAdapter` base class
3. Implement `MessageTransport` and `MessageRenderer` interfaces
4. Register in `ChannelManager`

See `electron/main/channels/feishu/` as a reference implementation.
