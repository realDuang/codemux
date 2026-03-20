# Default Workspace Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide a persistent default workspace directory so that new users (with no projects) can immediately create sessions — especially via external channels (Feishu, etc.) — without needing to set up a project first.

**Architecture:** Backend utility + project listing enhancement + channel/frontend fallback. All three engine adapters already accept any valid directory path. We add a default workspace at `{userData}/workspace/`, expose it via the project listing API, and update channels/frontend to use it as fallback.

**Tech Stack:** Electron 40, TypeScript 5, SolidJS 1.8, Vitest 4

---

## Context

### Current Behavior

Sessions require a `directory` parameter at creation time. Projects are **derived** (not stored) — `ConversationStore.deriveProjects()` extracts unique directories from all conversations.

| Aspect | Current Behavior |
|--------|-----------------|
| `directory` param | **Required** for session creation across all engines |
| Project derivation | `ConversationStore.deriveProjects()` computes projects from unique conversation directories |
| Frontend fallback | `Chat.tsx`: `directory \|\| projects[0]?.directory \|\| "."` |
| Channel flow | Lists projects → user selects → creates session. Blocks if `projects.length === 0` |
| Engine compatibility | All adapters (OpenCode, Copilot, Claude) accept any valid directory path |

### What Breaks for New Users

1. **Channels (Feishu, etc.)**: `listAllProjects()` returns `[]` → user can't select a project → can't create sessions
2. **Frontend**: Falls back to `"."` (Electron process CWD) which is unstable and meaningless
3. **General**: No designated place for "scratch" or project-agnostic conversations

### Key Files

| File | Role |
|------|------|
| `electron/main/services/conversation-store.ts` | Session persistence, `deriveProjects()` |
| `electron/main/gateway/engine-manager.ts` | `createSession()`, `listAllProjects()` |
| `electron/main/gateway/ws-server.ts` | Gateway request routing |
| `electron/main/channels/channel-adapter.ts` | Channel base class |
| `electron/main/channels/feishu/feishu-adapter.ts` | Feishu channel implementation |
| `electron/main/channels/gateway-ws-client.ts` | Internal WS client (channel → gateway) |
| `src/pages/Chat.tsx` | Frontend session creation + fallback logic |
| `src/components/SessionSidebar.tsx` | Project grouping + session display |
| `src/stores/session.ts` | `SessionInfo`, session store |
| `src/types/unified.ts` | `UnifiedProject` type definition |
| `src/lib/settings.ts` | Settings persistence |
| `src/pages/Settings.tsx` | Settings UI |
| `src/locales/en.ts`, `src/locales/zh.ts` | i18n dictionaries |

---

## Design Decisions

1. **Name**: "Default Workspace" / "默认工作区"
2. **Channel UX (all channels, not just Feishu)**:
   - **Core rule**: When a channel has not obtained a user-selected project, new sessions are always created in the default workspace
   - Project selection lists do **NOT** include the default workspace (users can only pick real projects)
   - P2P / natural-language chats → always use default workspace (no project selection flow)
   - This logic applies to all channels via `ChannelAdapter` base class, not Feishu-specific
3. **Sidebar visibility**: Hidden by default. Users can enable display in Settings. Even when hidden, the default workspace is still usable by channels and frontend fallback.
4. **New setting**: `showDefaultWorkspace: boolean` (default: `false`) — controls whether default workspace sessions appear in the sidebar

---

## Implementation

### Task 1: Default Workspace Utility

**Files:** New file `electron/main/services/default-workspace.ts`

Create utility functions:
```typescript
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

/** Returns the default workspace directory path */
export function getDefaultWorkspacePath(): string {
  return path.join(app.getPath("userData"), "workspace");
}

/** Ensures the default workspace directory exists. Call at app startup. */
export function ensureDefaultWorkspace(): string {
  const dir = getDefaultWorkspacePath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
```

Call `ensureDefaultWorkspace()` during main process initialization in `electron/main/index.ts`.

### Task 2: Type Extension

**Files:** `src/types/unified.ts`

Add `isDefault` flag to `UnifiedProject`:
```typescript
export interface UnifiedProject {
  id: string;
  directory: string;
  name?: string;
  engineType?: EngineType;
  engineMeta?: Record<string, unknown>;
  isDefault?: boolean;  // NEW: marks the default workspace project
}
```

### Task 3: Project Listing Enhancement

**Files:** `electron/main/gateway/engine-manager.ts`

Modify `listAllProjects()` to always include the default workspace:
```typescript
listAllProjects(): UnifiedProject[] {
  const projects = conversationStore.deriveProjects();
  const defaultDir = getDefaultWorkspacePath().replaceAll("\\", "/");
  const alreadyExists = projects.some(
    p => p.directory.replaceAll("\\", "/") === defaultDir
  );
  if (!alreadyExists) {
    projects.push({
      id: `dir-${defaultDir}`,
      directory: defaultDir,
      name: "Default Workspace",  // i18n handled on frontend via isDefault flag
      isDefault: true,
    });
  } else {
    const existing = projects.find(
      p => p.directory.replaceAll("\\", "/") === defaultDir
    );
    if (existing) existing.isDefault = true;
  }
  return projects;
}
```

### Task 4: Frontend Fallback

**Files:** `src/pages/Chat.tsx`

Update `handleNewSession` fallback chain:
```typescript
// Before:
const dir = directory || sessionStore.projects[0]?.directory || ".";

// After:
const defaultProject = sessionStore.projects.find(p => p.isDefault);
const dir = directory || defaultProject?.directory || sessionStore.projects[0]?.directory || ".";
```

### Task 5: Channel Adapter Updates

**Files:** `electron/main/channels/feishu/feishu-adapter.ts`, `electron/main/channels/channel-adapter.ts`, `electron/main/channels/gateway-ws-client.ts`

**Core rule**: When no project is selected by the user, use default workspace.

**a. Project listing in channels — exclude default workspace:**
```typescript
// When showing project list to user, filter out default workspace
const projects = await this.gatewayClient.listAllProjects();
const realProjects = projects.filter(p => !p.isDefault);
```

**b. Fallback to default workspace:**
```typescript
// When creating a session without a selected project
const allProjects = await this.gatewayClient.listAllProjects();
const defaultProject = allProjects.find(p => p.isDefault);
const directory = selectedProject?.directory || defaultProject?.directory;
```

**c. P2P / natural-language chats**: Always use default workspace directly without project selection flow.

**d. Feishu-specific changes:**
- When no real projects exist: skip project selection, auto-create in default workspace
- `createNewSessionForProject` and temp session creation: use default workspace as fallback directory
- `flattenProjectsByEngine`: filter out `isDefault` projects before presenting to user

### Task 6: i18n Strings

**Files:** `src/locales/en.ts`, `src/locales/zh.ts`

```typescript
// en.ts
settings: {
  // ... existing
  showDefaultWorkspace: "Show default workspace in sidebar",
}
sidebar: {
  // ... existing
  defaultWorkspace: "Default Workspace",
}

// zh.ts
settings: {
  // ... existing
  showDefaultWorkspace: "在侧边栏显示默认工作区",
}
sidebar: {
  // ... existing
  defaultWorkspace: "默认工作区",
}
```

### Task 7: Sidebar Display

**Files:** `src/components/SessionSidebar.tsx`

- Read `showDefaultWorkspace` setting
- Filter out projects with `isDefault: true` when setting is `false`
- When shown, sort default workspace **last** among project groups
- Use i18n name (`t().sidebar.defaultWorkspace`) instead of directory-derived name

### Task 8: Settings Toggle

**Files:** `src/pages/Settings.tsx`, `src/lib/settings.ts`

- Add `showDefaultWorkspace` to settings schema (default: `false`)
- Add toggle switch in Settings page under a suitable section
- Persist via `saveSetting("showDefaultWorkspace", value)`

### Task 9: Unit Tests

**Files:** `tests/unit/electron/services/default-workspace.test.ts`, update existing tests

- Test `getDefaultWorkspacePath()` returns expected path
- Test `ensureDefaultWorkspace()` creates directory
- Test `listAllProjects()` always includes default workspace
- Test channel project filtering excludes default workspace
- Test frontend fallback uses default workspace directory

---

## Edge Cases

| Case | Handling |
|------|----------|
| User deletes workspace directory | Recreate on next access via `ensureDefaultWorkspace()` |
| AI creates files in workspace | Expected — it's a valid working directory |
| Multiple engines in same workspace | Fine — directory is engine-agnostic |
| Existing users (already have projects) | No migration needed; additive change |
| Web mode (no Electron) | Future: use `path.join(process.cwd(), ".codemux", "workspace")` |

## Task Dependencies

```
default-workspace-util ──┐
                         ├──→ engine-manager-project-listing ──┬──→ frontend-fallback
unified-type-update ─────┤                                     └──→ channel-updates
                         │
i18n-strings ────────────┘──→ settings-toggle
                              sidebar-display
                              unit-tests
```
