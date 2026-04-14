# Research: Chat-First TUI Redesign

**Date**: 2026-03-31
**Spec**: [spec.md](./spec.md)

## 1. cfonts — ASCII Art Banner

**Decision**: Use `cfonts.render()` to get string output, inject into Ink `<Text>` component.

**Rationale**: cfonts supports ESM, has `.render()` that returns `{ string, array, lines }` without printing to stdout. This lets us embed the banner in an Ink component. The `tiny` font is compact and fits the minimalist aesthetic.

**Alternatives considered**:
- `figlet` — more fonts but no gradient/color support, output less polished
- Custom hardcoded ASCII — brittle, not maintainable
- No banner — loses the visual identity on home screen

**Integration pattern**:
```typescript
import cfonts from 'cfonts';
const banner = cfonts.render('diptych', { font: 'tiny', colors: ['cyan'] }).string;
// Use in Ink: <Text>{banner}</Text>
```

**Compatibility**: No known issues with Ink 6 or React 19. Standalone utility, no framework coupling.

## 2. fullscreen-ink — Alternate Screen Buffer

**Decision**: Use `fullscreen-ink` for alternate screen buffer with `exitOnCtrlC: false` for custom shutdown handling.

**Rationale**: Provides `withFullScreen()` wrapper and `useScreenSize()` hook. Handles alt buffer enter/exit, terminal restore on crash.

**Known issue**: Ink 6 has a regression where a blank row appears at the terminal bottom in fullscreen mode (issue #752). Workaround: account for -1 row in height calculations.

**Alternatives considered**:
- Raw ANSI escape sequences (`\x1b[?1049h/l`) — fragile, no resize handling
- No fullscreen — works but less professional
- `blessed` / `neo-blessed` — wrong framework (not React)

**Integration pattern**:
```typescript
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
const ink = withFullScreen(<App />, { exitOnCtrlC: false });
await ink.start();
await ink.waitUntilExit();
```

**Fallback**: If fullscreen-ink is incompatible, use Ink's normal `render()` with `useStdout()` for dimensions. The `--no-fullscreen` flag already provides this path.

## 3. ink-multiline-input — Multiline Text Entry

**Decision**: Use `ink-multiline-input` as primary, with single-line `TextInput` fallback.

**Rationale**: Released Jan 2026, actively maintained. Controlled component with `value`/`onChange`/`onSubmit` props. Supports `keyBindings` for custom submit key (Ctrl+Enter), `rows`/`maxRows` for sizing.

**Alternatives considered**:
- Custom implementation (~200 LOC) — feasible but unnecessary if package works
- Single-line only + `$EDITOR` — functional but worse UX
- `ink-mde` — too heavy (full markdown editor)

**Integration pattern**:
```typescript
<MultilineInput
  value={text}
  onChange={setText}
  onSubmit={handleSubmit}
  rows={3}
  maxRows={6}
  keyBindings={{ submit: (key) => key.ctrl && key.return }}
/>
```

**Risk**: Package is very new (2 months old). If incompatible, fall back to custom implementation using Ink's `useInput()` + `usePaste()` hooks.

## 4. Shiki Theme Selection — Syntax Highlighting

**Decision**: Use Shiki's `github-dark` as default theme. Allow user override via config. Do NOT try to auto-detect terminal light/dark mode.

**Rationale**: Terminal dark/light detection in Node.js has no reliable cross-platform API. The `dark-mode` package is macOS-only. Most developer terminals are dark. The simpler approach: default to `github-dark`, let users set `shikiTheme: github-light` in config if they use a light terminal.

**Available Shiki themes**: github-dark, github-light, github-dark-dimmed, dracula, nord, one-dark-pro, vitesse-dark, vitesse-light, solarized-dark, solarized-light, min-dark, min-light, plus 20+ more.

**Alternatives considered**:
- Auto-detect via macOS `dark-mode` package — platform-specific, fragile
- Query terminal via OSC 11 escape sequence — unreliable across terminals
- Always use `css-variables` theme — doesn't apply to terminal ANSI output

## 5. ANSI Theme System — Terminal-Adaptive Colors

**Decision**: Use named ANSI color strings (`'red'`, `'green'`, `'cyan'`, etc.) for the `terminal` theme. These map to ANSI 0-15 and respect the user's terminal color scheme. Use ANSI 256 grayscale (232-255) for structural depth.

**Rationale**: Ink's `<Text color="cyan">` uses Chalk under the hood, which maps to ANSI escape codes. When you use named colors, the terminal applies its own palette. Catppuccin cyan looks different from Dracula cyan — but both look native.

**Mapping**:
| Semantic Role | ANSI Name | Code | Purpose |
|--------------|-----------|------|---------|
| accent | cyan | 6 | Primary interactive color |
| planner | magenta | 5 | Planner output label |
| implementer | cyan | 6 | Implementer output label |
| validator | green | 2 | Validation results |
| success | green | 2 | Pass states |
| error | red | 1 | Fail states |
| warning | yellow | 3 | Retries, escalations |
| text | white | 7 | Default text |
| textDim | gray | 8 (bright black) | Secondary text |

**Mono theme**: Hand-picked hex values for users who want consistent colors regardless of terminal. Based on Tokyo Night palette for good contrast.

## 6. Approval Flow Replacement

**Decision**: Replace modal `ApprovalPrompt` component with input bar commands. Delete `src/ui/prompt.tsx` and `src/ui/question-prompt.tsx`.

**Rationale**: The current `onApprovalNeeded` callback returns `Promise<{ approved, comment? }>`. This blocks the orchestrator. In the new design, the input bar handles approval via text commands (`approve`, `edit`, `comment <text>`, `quit`). The Promise-based contract can remain — the input bar resolves the Promise when the user types a command.

**Impact on orchestrator**: Zero changes to `engine/orchestrator.ts`. The `onApprovalNeeded` callback signature stays the same. Only the UI implementation changes — instead of rendering a modal that resolves the Promise, the input bar resolves it.

## 7. Screen Router

**Decision**: Custom `useRouter()` hook with simple state machine. No external routing library.

**Rationale**: 3 screens, 4 transitions. External routers (ink-router, ink-navigation) are overkill and add dependencies for trivial logic.

**State machine**:
```
home ──[submit feature]──> workflow
workflow ──[complete]──> summary
summary ──[enter/q]──> home
summary ──[resume]──> workflow
```

**Data passing**: Router carries `routeData: { feature?: string, summary?: Summary }` — typed union per screen.

## 8. Session Storage

**Decision**: JSON files in `.diptych/sessions/`, one file per session. File name: `{timestamp}-{slugified-feature}.json`.

**Rationale**: Lightweight, human-readable, no database dependency. Timestamp prefix enables natural sort order. Slugified feature name enables easy identification.

**Structure**: `{ feature, startedAt, completedAt?, status, summary?, stateVersion }`.

**Max sessions displayed**: 10 most recent on home screen. No cleanup of old files — user can delete manually.
