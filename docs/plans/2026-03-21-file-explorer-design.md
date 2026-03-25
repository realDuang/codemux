# File Explorer Panel Design

> Date: 2026-03-21
> Status: Planning
> References: OpenCode Desktop (`D:\workspace\opencode`), Hello-Halo (`D:\workspace\hello-halo`)

## Overview

Add a right-side file explorer panel to the Chat page with project file browsing, syntax-highlighted preview, multi-tab file viewer, and git diff integration. Feature-parity with OpenCode Desktop, enhanced with performance patterns from Hello-Halo.

### Architecture

The file explorer is a **CodeMux-level feature** (not engine-specific). File operations are handled directly by the gateway server using Node.js `fs` and `child_process` — no engine involvement. The frontend adds a new `file` store, a right panel in Chat.tsx, and tree/preview components.

```
Chat.tsx Layout:
┌──────────┬──────────────────────┬──────────────────┐
│ Sidebar  │   Chat Area          │  File Explorer   │
│ (left)   │   (center, flex-1)   │  (right panel)   │
│          │                      │                  │
│ Sessions │  Messages + Input    │  Tree / Preview  │
│          │                      │  Tabs: Files|Diff│
└──────────┴──────────────────────┴──────────────────┘
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend file ops | Node.js `fs/promises` + `child_process` |
| File icons | `material-icon-theme` npm (MIT, 1,205 SVGs) + `vite-plugin-icons-spritesheet` |
| Syntax highlighting | Existing Shiki pipeline (`src/lib/shiki-highlighter.ts`) |
| Diff rendering | Existing `diff` library (`src/components/share/content-diff.tsx`) |
| State management | SolidJS `createStore` |
| Styling | Tailwind CSS |

---

## Git Changes & Diff Flow (End-to-End)

### Data Flow

```
FileExplorer mounts
  ↓
createEffect on currentDirectory (from session)
  ↓
Parallel: loadDirectory(root) + loadGitStatus(directory)
  ↓
Gateway WS: file.gitStatus → FileService.getGitStatus()
  ↓
Backend runs 3 git commands:
  1. git diff --numstat HEAD           → modified files + line counts
  2. git ls-files --others --exclude-standard  → untracked files
  3. git diff --name-only --diff-filter=D HEAD → deleted files
  ↓
Returns GitFileStatus[] to frontend store
  ↓
UI: "Changes" tab shows filtered tree with A/D/M indicators
```

### "Changes" Tab Behavior

```
┌──────────────────────────────────┐
│ [Files] [Changes (3)]  🔄  ✕   │  ← tab bar with change count badge
├──────────────────────────────────┤
│  📁 src/                    •M  │  ← dir shows colored dot (yellow = has modified children)
│    📄 App.tsx            +5 -2  │  ← file shows A/D/M label + line counts
│    📄 index.ts              M   │
│  📄 README.md               A   │  ← green = added/untracked
│  📄 old-file.ts              D   │  ← red = deleted
├──────────────────────────────────┤
│ [Content] [Diff]                │  ← toggle (only when file has git changes)
│                                  │
│  - old line                      │  ← red background
│  + new line                      │  ← green background
│                                  │
└──────────────────────────────────┘
```

**Filtering logic:**
1. `gitStatus` array contains all changed files with their paths
2. Build `changedFiles: Set<string>` from `gitStatus.map(s => s.path)`
3. Pass as `filter` prop to `FileTree`
4. FileTree shows only files in the set + their parent directories
5. **Auto-expand parent dirs**: For each changed file `src/components/App.tsx`, auto-expand `src/` and `src/components/`

**Status indicators:**
- Files: Text label — `A` (green, added/untracked), `D` (red, deleted), `M` (yellow, modified)
- Directories: Colored dot — merged status of children (if any child is modified, dir shows yellow dot)
- Line counts: `+N -N` shown next to status label (from `git diff --numstat`)

### Clicking a Changed File → Diff Preview

```
User clicks "App.tsx" in Changes tab
  ↓
previewFile(absolutePath, name, relativePath) — opens file content
  ↓
File has git changes? → auto-switch to "Diff" view mode
  ↓
Gateway WS: file.gitDiff → FileService.getGitDiff(directory, path)
  ↓
Backend diff logic:
  1. Try staged:    git diff --cached -- {path}
  2. Try unstaged:  git diff -- {path}
  3. If untracked:  generate synthetic diff (all lines as "+")
  ↓
Returns unified diff string
  ↓
ContentDiff component renders:
  - parsePatch() from 'diff' library
  - Line numbers (old/new)
  - Color coding: red (removed), green (added), gray (unchanged)
  - Prefix symbols: -, +, space
```

### Content/Diff Toggle

When previewing a file that has git changes, the preview header shows a toggle:

```
┌─────────────────────────────────────────┐
│ App.tsx  src/components/App.tsx  [Content|Diff]  ✕  │
└─────────────────────────────────────────┘
```

- **Content mode**: Shows current file content with syntax highlighting (ContentCode)
- **Diff mode**: Shows unified diff with colored line rendering (ContentDiff)
- Toggle only visible when `getFileGitStatus(path)` returns a status
- Clicking a file from "Changes" tab defaults to Diff mode
- Clicking a file from "Files" tab defaults to Content mode

### GitFileStatus Type

```typescript
interface GitFileStatus {
  path: string;                                    // relative to project root
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  added?: number;                                  // lines added
  removed?: number;                                // lines removed
}
```

### Backend Git Commands

```typescript
// 1. Modified files with line counts
git -c core.quotepath=false diff --numstat HEAD
// Output: "5\t2\tsrc/App.tsx" → added=5, removed=2, status="modified"

// 2. Untracked files
git -c core.quotepath=false ls-files --others --exclude-standard
// Output: "new-file.ts" → status="untracked" (treated as "added")
// Count lines: wc -l or readFile + split

// 3. Deleted files
git -c core.quotepath=false diff --name-only --diff-filter=D HEAD
// Output: "old-file.ts" → status="deleted"

// 4. Individual file diff
git diff -- {path}              // unstaged changes
git diff --cached -- {path}     // staged changes
// For untracked: synthesize diff with all lines as "+"
```

---

## Feature Parity: OpenCode vs CodeMux

### Legend
- ✅ = 1:1 replicated
- ⚠️ = Phase 2
- ❌ = Not applicable

### File Tree

| Feature | OpenCode | Plan | Notes |
|---------|----------|------|-------|
| Recursive tree + expand/collapse | ✅ | ✅ | Collapsible + recursive, same as OpenCode |
| Lazy directory loading | ✅ | ✅ | Load on expand, cache in store |
| File type icons (1,205 SVGs) | ✅ | ✅ | Same source: `material-icon-theme` npm |
| Dual-icon system (color/mono hover swap) | ✅ | ✅ | CSS opacity swap on group-hover |
| .gitignore visual distinction | ✅ | ✅ | `ignored` flag from backend, reduced opacity |
| Smart directory dimming | — | ✅ | From hello-halo: node_modules/dist/.git etc |
| Files/Changes tabs | ✅ | ✅ | Tab-based filtering with git status |
| A/D/M status indicators | ✅ | ✅ | File=text label, Dir=colored dot |
| Auto-expand changed file parents | ✅ | ✅ | `dirsToExpand()` logic |
| Fuzzy file search | ✅ | ✅ | Search bar in panel header |
| Drag & drop to prompt | ✅ | ⚠️ | Phase 2 |
| MAX_DEPTH=128 | ✅ | ✅ | Same constant |

### File Preview

| Feature | OpenCode | Plan | Notes |
|---------|----------|------|-------|
| Syntax highlighting | ✅ Shiki via Pierre | ✅ Existing ContentCode + Shiki | Already have this |
| Line numbers | ✅ | ✅ | `showLineNumbers` prop |
| Multi-tab viewer | ✅ | ✅ | Tab bar with close/switch |
| Scroll position per tab | ✅ rAF-debounced | ✅ | Same pattern: per-tab X/Y |
| Content/Diff toggle | ✅ | ✅ | Only when file has git changes |
| Ctrl+F search within file | ✅ | ✅ | Search overlay on keydown |
| Image preview (zoom/pan) | ✅ Pierre | ✅ | From hello-halo: scroll zoom + drag pan |
| Binary file detection | ✅ 160+ exts | ✅ | 2-tier: extension → 8KB content sample |
| LRU content cache | ✅ 40 entries/20MB | ✅ | Same dual-limit approach |
| Request deduplication | ✅ inflight Map | ✅ | Same pattern |

### Diff View

| Feature | OpenCode | Plan | Notes |
|---------|----------|------|-------|
| Unified diff | ✅ | ✅ | Existing ContentDiff + parsePatch |
| Split (side-by-side) diff | ✅ | ⚠️ | Phase 2 |
| Diff style toggle | ✅ | ⚠️ | Phase 2 (after split built) |
| Word-level highlighting | ✅ | ⚠️ | Phase 2 |
| File-level diff navigation | ✅ | ✅ | Click in Changes tree → show diff |
| Diff stats (+/- counts) | ✅ | ✅ | From git --numstat |
| Inline comments | ✅ | ❌ | OpenCode-specific prompt system |

### Git Integration

| Feature | OpenCode | Plan | Notes |
|---------|----------|------|-------|
| Status display (A/M/D) | ✅ | ✅ | `git diff --numstat` + `ls-files` + `diff --diff-filter=D` |
| Added/removed line counts | ✅ | ✅ | From `--numstat` output |
| Untracked files | ✅ | ✅ | `git ls-files --others` |
| Staged + unstaged diffs | ✅ | ✅ | Try `--cached` first, then plain diff |
| Branch display | ✅ | ⚠️ | Phase 2 |
| Git blame/log/commit | ❌ | ❌ | Neither has this |

### Layout & UX

| Feature | OpenCode | Plan | Notes |
|---------|----------|------|-------|
| Resizable panel (drag handle) | ✅ | ✅ | Port OpenCode's ResizeHandle |
| Collapse threshold (160px) | ✅ | ✅ | Auto-collapse on drag below threshold |
| Panel width persistence | ✅ | ✅ | Save to settings.json |
| CSS transitions (240ms) | ✅ | ✅ | cubic-bezier + will-change + motion-reduce |
| Accessibility (inert/aria) | ✅ | ✅ | `inert` + `aria-hidden` + `pointer-events-none` |
| Mobile hidden (768px) | ✅ | ✅ | `md:` breakpoint |
| Keyboard shortcuts | ✅ | ⚠️ | Phase 2: Ctrl+B toggle, Escape close |

---

## Implementation Patterns (Best of Both Projects)

### From OpenCode ✅

| Pattern | Where Applied |
|---------|---------------|
| `Dynamic` component + `splitProps` for tree nodes | FileTree |
| Indentation formula: `8 + level*12 - (isFile?24:4)` | FileTree |
| Dual-icon system: color/mono swap on hover | FileIcon + FileTree |
| `Collapsible` + recursive rendering | FileTree |
| LRU cache: 40 entries OR 20MB, touch-on-access | File Store |
| Request dedup: inflight Map | File Store |
| rAF-debounced scroll tracking + smart restore | FilePreview |
| ResizeHandle: bidirectional, edge-aware, collapse threshold | ResizeHandle |
| Layout persistence: `createStore` + `persisted()` | Settings |
| CSS transitions: cubic-bezier + `motion-reduce` | Chat layout |
| Accessibility: `inert` + `aria-hidden` | Chat layout |

### From Hello-Halo ✅

| Pattern | Where Applied |
|---------|---------------|
| `readdir({ withFileTypes: true })` for zero-stat scan | FileService |
| 2-tier binary detection: extension → 8KB content sample | FileService |
| `realpathSync()` + sep suffix path traversal prevention | FileService |
| `nodeIndex` Map for O(1) lookups | File Store |
| Three-state empty check (null→[]→data) | FileTree, FileExplorer |
| CSS-only hover: Tailwind `group`/`group-hover` | FileTree |
| Smart directory dimming list (50% opacity) | FileTree |
| `mergeChildren` pattern: preserve expanded state | File Store |
| Image viewer: scroll zoom, drag pan, checkerboard bg | FilePreview |
| Keyboard shortcuts: Escape, Ctrl+W | FileTabs |

---

## New Gateway API Endpoints

| Request Type | Payload | Response | Description |
|---|---|---|---|
| `file.list` | `{ directory: string }` | `FileNode[]` | List directory contents |
| `file.read` | `{ path: string }` | `FileContent` | Read file content |
| `file.gitStatus` | `{ directory: string }` | `GitFileStatus[]` | Git status + line counts |
| `file.gitDiff` | `{ directory: string, path: string }` | `string` | Unified diff for one file |

### Types

```typescript
interface FileNode {
  name: string;
  path: string;          // relative to project root
  absolutePath: string;
  type: "file" | "directory";
  ignored: boolean;      // .gitignore'd
  size?: number;
}

interface FileContent {
  content: string;       // utf-8 text or base64 binary
  binary: boolean;
  size: number;
  mimeType?: string;
  diff?: string;         // unified diff if file has git changes
  patch?: {              // structured patch (from 'diff' library)
    oldFileName: string;
    newFileName: string;
    hunks: Array<{
      oldStart: number; oldLines: number;
      newStart: number; newLines: number;
      lines: string[];
    }>;
  };
}

interface GitFileStatus {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  added?: number;        // lines added
  removed?: number;      // lines removed
}
```

---

## New Files

| File | Purpose |
|---|---|
| `electron/main/services/file-service.ts` | Backend file operations (list, read, git) |
| `src/stores/file.ts` | File explorer reactive store |
| `src/components/FileExplorer.tsx` | Main panel container |
| `src/components/FileTree.tsx` | Recursive tree view |
| `src/components/FileIcon.tsx` | Icon resolver (material-icon-theme) |
| `src/components/FilePreview.tsx` | File content/diff preview |
| `src/components/ResizeHandle.tsx` | Drag-to-resize panel borders |
| `src/components/file-icons/sprite.svg` | Generated icon sprite (build artifact) |
| `src/components/file-icons/types.ts` | Generated icon type definitions |
| `src/assets/icons/file-types/` | SVG source dir (from npm package) |

## Modified Files

| File | Changes |
|---|---|
| `src/pages/Chat.tsx` | Add right panel + toggle button |
| `src/types/unified.ts` | Add FileNode, FileContent, GitFileStatus, request types |
| `electron/main/gateway/ws-server.ts` | Add file request handlers |
| `src/lib/gateway-client.ts` | Add file API methods |
| `src/lib/gateway-api.ts` | Add file API wrappers |
| `src/locales/en.ts` | Add fileExplorer translations |
| `src/locales/zh.ts` | Add fileExplorer translations |
| `electron.vite.config.ts` | Add icons-spritesheet plugin |
| `package.json` | Add material-icon-theme, vite-plugin-icons-spritesheet |

---

## Task List

### Phase 1: Core (17 tasks)

| # | ID | Task | Depends On |
|---|---|---|---|
| 1 | p1-file-service | Backend File Service | — |
| 2 | p1-gateway-types | Gateway Protocol Types | p1-file-service |
| 3 | p1-gateway-handlers | Gateway WS Handlers | p1-gateway-types |
| 4 | p1-gateway-client | Frontend Gateway Client/API | p1-gateway-handlers |
| 5 | p1-file-store | File Explorer Store | p1-gateway-client |
| 6 | p1-file-icon | FileIcon Component (material-icon-theme) | — |
| 7 | p1-resize-handle | ResizeHandle Component | — |
| 8 | p1-file-tree | FileTree Component | p1-file-icon, p1-file-store |
| 9 | p1-file-preview | FilePreview Component | p1-file-store |
| 10 | p1-file-tabs | File Tabs System | p1-file-store |
| 11 | p1-file-search | In-File Search (Ctrl+F) | p1-file-preview |
| 12 | p1-file-explorer | FileExplorer Container | p1-file-tree, p1-file-preview, p1-file-tabs, p1-resize-handle |
| 13 | p1-chat-layout | Chat.tsx Right Panel | p1-file-explorer, p1-i18n |
| 14 | p1-i18n | Internationalization | — |
| 15 | p1-settings-persist | Panel Width/State Persistence | p1-file-store |
| 16 | p1-tests | Unit Tests | p1-file-service, p1-file-store |
| 17 | p1-integration | Integration & Polish | p1-chat-layout, p1-file-search, p1-settings-persist, p1-tests |

### Phase 2: Enhanced (5 tasks)

| # | ID | Task |
|---|---|---|
| 18 | p2-file-watcher | Real-time file change detection (chokidar) |
| 19 | p2-drag-to-prompt | Drag files to PromptInput (@mention) |
| 20 | p2-split-diff | Side-by-side diff + word-level highlighting |
| 21 | p2-keyboard-shortcuts | Panel toggle (Ctrl+B), tree arrow navigation |
| 22 | p2-tab-dnd | Tab drag-drop reorder (solid-dnd) |

---

## Dependency Graph

```
Independent:
  p1-file-service ─┐
  p1-file-icon     │ (can start in parallel)
  p1-resize-handle │
  p1-i18n ─────────┤

Sequential chain:  │
  p1-file-service  │
    → p1-gateway-types
      → p1-gateway-handlers
        → p1-gateway-client
          → p1-file-store ─┬→ p1-file-tree (+ p1-file-icon)
                           ├→ p1-file-preview → p1-file-search
                           ├→ p1-file-tabs
                           └→ p1-settings-persist
                              │
          p1-file-tree ────┐  │
          p1-file-preview ─┼→ p1-file-explorer
          p1-file-tabs ────┤     │
          p1-resize-handle ┘     │
                                 │
          p1-file-explorer ──┐   │
          p1-i18n ───────────┼→ p1-chat-layout
                             │      │
          p1-chat-layout ────┤
          p1-file-search ────┼→ p1-integration
          p1-settings-persist┤
          p1-tests ──────────┘

Phase 2 (all depend on p1-integration):
  → p2-file-watcher
  → p2-drag-to-prompt
  → p2-split-diff
  → p2-keyboard-shortcuts
  → p2-tab-dnd
```
