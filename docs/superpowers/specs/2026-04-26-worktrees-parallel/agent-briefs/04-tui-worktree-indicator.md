# 04 — TUI Worktree Indicator

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

When diptych is running inside a diptych-managed linked worktree, the TUI header must show the worktree name so the user can distinguish multiple open terminal windows.

Format: `[<worktree-slug>] <feature>` — rendered as a prefix label in the feature name area of the header, colored amber. When running in the main worktree, the header is unchanged.

## Read First

- `CLAUDE.md`
- `src/features/workflow/components/header.tsx` — existing header component
- `src/features/workflow/screen.tsx` — how the header is used
- `src/stores/navigation/router.ts` — `routerStore` and the `workflow` screen state shape
- `src/engine/git/worktree.ts` — `detectWorktree` (brief 01 output)
- `src/cli/commands/start.ts` — where session setup happens; worktree detection should run here
- `docs/HOOKS.md` — zero memoization, no `forwardRef`
- `docs/STORES.md` — store patterns

## Files To Touch

- `src/stores/navigation/router.ts` — add `worktreeName?: string` to the `workflow` screen state
- `src/cli/commands/start.ts` — detect worktree slug at startup; pass into router init
- `src/features/workflow/components/header.tsx` — render the worktree label when present

Do not touch the orchestrator, engine git files (except to import), or other TUI screens.

## Contract

### Router state extension

In `src/stores/navigation/router.ts`, extend the `workflow` screen discriminant to include:

```ts
// Added to the workflow screen shape:
worktreeName?: string; // slug of the linked worktree, or absent when in main tree
```

This field is set once at startup (from `start.ts`) and never mutated.

### Detection in `start.ts`

After `resolveProjectDir` resolves `projectDir` (which may be a worktree root if `--worktree` was used), add:

```ts
import { simpleGit } from 'simple-git';
import { detectWorktree } from '../../engine/git/worktree.js';

const git = simpleGit(projectDir);
const worktreeName = await detectWorktree(projectDir, git).catch(() => null);
```

Pass `worktreeName` into the `routerStore.init` call for the `workflow` screen:

```ts
routerStore.init({ screen: 'workflow', feature, sessionId, worktreeName: worktreeName ?? undefined });
```

`detectWorktree` errors are silenced (`.catch(() => null)`) — the indicator is cosmetic; a failure must not block the session.

### Header rendering

In `src/features/workflow/components/header.tsx`, read `worktreeName` from the router store:

```ts
const worktreeName = routerStore.use(s => s.screen === 'workflow' ? s.worktreeName : undefined);
```

Prepend the label to the feature text before truncation:

```ts
const featureLabel = worktreeName ? `[${worktreeName}] ${feature}` : feature;
```

Apply amber color to the `[<worktreeName>]` portion only. Use the existing `useTheme()` hook; add `amber` to the theme palette if it does not already exist (use hex `#f59e0b`). If the theme does not support custom amber, use `t.textDim` as a fallback — do not block on theme changes.

The combined `featureLabel` string is passed to `truncateWithEllipsis(featureLabel, featureWidth)` as before, so the label gracefully truncates when the terminal is narrow.

Split the label into two `<Text>` elements — one for the amber `[<slug>]` prefix and one for the remaining feature text — to apply color independently:

```tsx
{worktreeName && (
  <Text color={amberColor}>[{worktreeName}]</Text>
)}
<Text color={t.text}>{truncateWithEllipsis(feature, featureWidth - labelWidth)}</Text>
```

Where `labelWidth = worktreeName ? worktreeName.length + 3 : 0` (brackets + space).

## Rules

1. `detectWorktree` is called once at startup in `start.ts`; it is not called inside the React component.
2. No memoization (`useMemo`, `useCallback`, `React.memo`) per project convention.
3. If `worktreeName` is absent (main worktree or detection failed), the header is pixel-identical to its current state. This is a strict no-regression requirement.
4. The amber color (`#f59e0b`) must not be hardcoded in multiple places — define it as a named constant in the header file or the theme.
5. Do not add a worktree indicator to any screen other than the workflow screen.

## Tests

`src/features/workflow/components/header.test.tsx` (create if it does not exist) — use Ink's `render` from `ink-testing-library` or equivalent:

- When `worktreeName` is absent, header renders the feature name without any bracket prefix.
- When `worktreeName` is `"my-feature"`, header renders `[my-feature]` prefix before the feature name.
- When the combined label exceeds `featureWidth`, the feature name is truncated but the bracket prefix is preserved.
- `detectWorktree` returning `null` (main tree) results in no worktree label in the header.

For the `start.ts` integration:

- When `detectWorktree` resolves to a slug, `routerStore.init` receives `worktreeName` equal to that slug.
- When `detectWorktree` rejects, `routerStore.init` receives `worktreeName: undefined` (not `null`).

## Acceptance Criteria

- Running inside `.trees/my-feature` shows `[my-feature]` in the TUI header.
- Running in the main working tree shows no bracket prefix.
- Header layout is unchanged in the main tree (no visual regression).
- `detectWorktree` errors are silenced; they do not crash the session or the TUI.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/features/workflow/components/header.test.tsx src/cli/commands/start.test.ts
npm run typecheck
npm run lint
```
