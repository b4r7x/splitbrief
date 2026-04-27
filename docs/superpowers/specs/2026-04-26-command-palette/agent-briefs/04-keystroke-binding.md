# 04 — Keystroke Binding

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 04 of 5** — Command Palette spec, 2026-04-26.
Depends on Brief 03 (palette component) being merged first. This brief verifies and tightens existing bindings, does not create new ones.

## Intent

Confirm that `Ctrl+K` correctly opens the command palette from any screen and any input mode, document what the existing code already does, and close any gaps in the gating logic. Add a test that verifies the binding fires correctly and that the palette does not open when the overlay stack is already occupied by an exclusive overlay.

## Scope

**In bounds:**
- `src/hooks/use-app-keys.ts` — verify and potentially tighten `handleShortcutKeys`
- `src/hooks/use-app-keys.test.ts` (new file) — tests for keystroke gating
- `src/core/slash-commands/keybindings.ts` — confirm entry exists (read-only if already correct)

**Out of bounds:**
- Do not change how the palette component renders.
- Do not add any new keyboard shortcuts (`:` binding is deferred — ADR-001).
- Do not touch `use-workflow-keys.ts` (it does not need to handle `Ctrl+K` — the app-level handler does).
- Do not add npm dependencies.

## Code Context

Read all of these before writing anything:

- `src/hooks/use-app-keys.ts` — full file. The relevant line is 82: `if (key.ctrl && input === 'k') return { type: 'open-overlay', overlay: 'command-palette' };`. The handler fires in `{ isActive: !isOpen }` context (line 71), meaning it will not fire when any overlay is already open. This is correct for the palette.
- `src/core/slash-commands/keybindings.ts` — the entry `{ id: 'command-palette', key: 'Ctrl+K', description: 'Command palette', screens: ALL_SCREENS }` already exists at line 13. No change needed.
- `src/stores/ui/overlay.ts` — understand `exclusive` flag: when `overlayExclusive` is true, the Escape handler is suppressed (line 64 of `use-app-keys.ts`). The `Ctrl+K` handler is in a separate `useInput` block with `{ isActive: !isOpen }` — this means `Ctrl+K` is already blocked when any overlay (including an exclusive one) is open.
- `src/stores/navigation/router.ts` — `InputMode` type (`'normal' | 'review' | 'question'`). The `Ctrl+K` binding does NOT gate on input mode — it fires from any input mode when no overlay is open. This is intentional: review mode and question mode should still allow the palette.

## Findings and Decisions

After reading `use-app-keys.ts`:

1. `Ctrl+K` is at line 82 inside `handleShortcutKeys`, which runs in the `{ isActive: !isOpen }` block. This is correct — palette does not open over another overlay.
2. The binding fires on all screens (`ALL_SCREENS`) because `handleShortcutKeys` has no screen guard for `Ctrl+K`. This is correct — ADR-001 says palette opens from any screen.
3. Input mode gating: `Ctrl+K` fires regardless of input mode. This is acceptable — even in review or question mode the user might want to use the palette. The palette's own Esc handler will close it cleanly.
4. No code change is required in `use-app-keys.ts` unless a gap is found during testing.

## Implementation Plan

### Verification

Run the existing test suite first:

```bash
npm test -- src/hooks/
npm run typecheck
```

If no existing tests cover `use-app-keys.ts`, proceed to write them.

### Tests to write (`src/hooks/use-app-keys.test.ts`)

Use Ink's test renderer to simulate key presses. The pattern mirrors other key handler tests in the codebase.

Test cases:

1. `Ctrl+K` when no overlay is open → `overlayStore.open('command-palette')` is called.
2. `Ctrl+K` when `overlayActive !== 'none'` → overlay does NOT open (the `useInput` is inactive).
3. `Ctrl+/` (the `\x1f` character) → `overlayStore.open('help')` is called.
4. `Ctrl+Q` → `exit()` is called.
5. `Ctrl+C` single press → `abortStore.markPending()` is called (workflow phase is live).
6. `Ctrl+C` double press within 2 seconds → `exit()` is called.
7. Escape when overlay is open and not exclusive → `overlayStore.close()` is called.
8. Escape when overlay is exclusive → `overlayStore.close()` is NOT called (exclusive flag suppresses it).

### If a gap is found

If during testing `Ctrl+K` fires when it shouldn't (e.g. when input mode is 'question' and it should be blocked), add the guard to `handleShortcutKeys` in `use-app-keys.ts`:

```ts
// Only add this if tests reveal a real problem — do not add speculatively
if (key.ctrl && input === 'k') {
  // could add: if (inputMode === 'question') return NONE;
  return { type: 'open-overlay', overlay: 'command-palette' };
}
```

Do not add the guard speculatively. Add it only if a test fails because of the gap.

## Validation

- All tests in `src/hooks/use-app-keys.test.ts` pass.
- `npm run typecheck` passes.
- `npm run lint` passes.
- Manual verification: run `npm run dev -- start "test"`, press `Ctrl+K` → palette opens; press `Esc` → palette closes; press `Ctrl+K` while another overlay is open → no second overlay opens.

## Constraints

- Do not speculate. Only add code if tests reveal a real gap.
- ESM `.js` import suffixes.
- No class keyword.
- No barrel imports.

## Escalation

If the `useInput` block structure in `use-app-keys.ts` is more complex than described (e.g. the `isActive` condition has changed), read the current file carefully before modifying anything. Describe the discrepancy in comments in the test file and escalate to the user if a change would break other bindings.

## Evidence Requirements

- `npm test -- src/hooks/use-app-keys.test.ts` passes (all 8 test cases listed in the plan).
- `npm run typecheck` passes.
- `npm run lint` passes.
