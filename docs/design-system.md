# Design System — "Graphite"

CodeMux's UI language: a calm graphite workbench where colour is reserved for
state, and a small set of "terminal" details (mono metadata, hairline grids,
light sweeps) carry the tech feel. All tokens live in `src/index.css`.

## Principles

1. **Neutral first.** Surfaces are low-chroma graphite; hierarchy comes from
   hairlines and elevation, not from coloured boxes.
2. **Colour means something.** Indigo = primary/active, violet → cyan gradient =
   brand and "live" moments, emerald/amber/red = status.
3. **Mono for machine data.** Paths, model IDs, token counts, durations and
   section eyebrows use Geist Mono (`cm-mono`, `cm-eyebrow`).
4. **Motion only for liveness.** Sweeps, pings and spinners signal that an agent
   is working; everything respects `prefers-reduced-motion`.

## Palette

Tailwind's `gray` and `slate` scales are remapped to one graphite ramp (hue 265,
near-zero chroma), and `blue` to an electric indigo, so existing utility classes
follow the system automatically. `800–950` are deliberately deep for dark mode.

Semantic tokens (light / dark values switch under `.dark`):

| Token | Use |
|---|---|
| `--cm-canvas` | App background, titlebar, sidebar |
| `--cm-surface` / `-2` / `-3` | Raised panels → nested fills → chips |
| `--cm-hairline` / `-strong` | 1px borders and dividers |
| `--cm-text` / `-muted` / `-faint` | Primary → secondary → metadata text |
| `--cm-accent` / `--cm-accent-soft` | Primary interactive colour + tint |
| `--cm-accent-2` | Cyan secondary accent (working indicators) |
| `--cm-gradient` / `--cm-gradient-soft` | Signature violet → cyan |
| `--cm-shadow-sm/md/lg`, `--cm-glow` | Elevation |
| `--cm-code-bg` | Code blocks, terminals, diffs |

The legacy `--color-*` and `--sl-color-*` variables alias these tokens.

## Type

- UI: **Geist Variable** (bundled via `@fontsource-variable/geist`) with CJK
  system fallbacks.
- Mono: **Geist Mono Variable** (`@fontsource-variable/geist-mono`).

Fonts are bundled so Electron works offline.

## Primitives (global classes)

| Class | What it does |
|---|---|
| `cm-mono` | Mono face + tabular numbers for metadata |
| `cm-eyebrow` | Tiny uppercase mono section label |
| `cm-kbd` | Keyboard hint chip |
| `cm-gradient-text` | Signature gradient text fill |
| `cm-btn-primary` | Gradient primary button with inner highlight |
| `cm-brand-mark` | Logo tile with hairline ring + glow |
| `cm-grid-bg` / `cm-aurora` | Faded hairline grid / soft colour wash for empty states |
| `cm-live-dot` | Status dot with a ping halo (uses `currentColor`) |
| `cm-scanline` | Light sweep along the bottom edge of a working surface |
| `cm-gradient-border` | 1px gradient border on `:focus-within` / `data-active` |
| `cm-select` | Restyled native `<select>` |

Shared components: `BrandMark` (titlebar brand) and `EmptyHero` (empty states,
optional live engine status chips).

## Conversation layer

The chat transcript (`src/components/conversation.css`) has its own reading
variables, `--conversation-*`, which are bound to the Graphite tokens rather
than redefined:

| Variable | Bound to |
|---|---|
| `--conversation-text` / `-muted` / `-subtle` | `--cm-text` / `-muted` / `-faint` |
| `--conversation-bg` / `-surface` | `--cm-surface` / `--cm-surface-2` |
| `--conversation-border` / `-rail` | `--cm-hairline-strong` |
| `--conversation-code-bg` | `--cm-code-bg` (code blocks, toolbars, tool I/O) |
| `--conversation-focus` | `--cm-accent` |

Renderer modules (`SessionTurn`, `ToolActivityGroup`, `ContextGroup`,
`TokenUsage`, `share/*`) only consume `--conversation-*`, so the transcript can be
re-themed in one place.

## Patterns

- **Conversation turn**: the user message is a right-aligned graphite bubble
  (hairline, tucked bottom-right corner). Activity triggers are flat rows;
  activity expands onto a left hairline rail. The response flows directly on
  the canvas with no card around it.
- **Live state**: a working trigger gets a cyan/violet ping dot (violet while
  reasoning) and a light sweep along its base, and the activity rail below it
  turns into the signature gradient.
- **Reasoning**: the "Thinking" icon is violet, and the readable summary hangs
  off a faint violet rail.
- **Metadata in mono**: durations, tool targets, tool counts, token usage,
  code language labels, table headers and section labels.
- **Errors**: a small uppercase mono `ERROR` chip in danger tint instead of
  plain red text; banners use tinted fills.
- **Code blocks**: `--cm-code-bg` body and toolbar, a gradient dot ahead of the
  uppercase language label.
- **Composer**: one elevated card; the mode switch is a segmented control; focus
  shows an accent border and a soft ring; send uses the mode colour (gradient for
  the default mode); stop shows a spinning gradient ring; "Jump to latest" is a
  glass pill.
- **Lists**: active rows get a subtle fill, an inset hairline and a 2px gradient
  rail on the left.
