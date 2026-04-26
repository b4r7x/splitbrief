# 03 — Handoff Slash Command

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Expose Handoff Pack generation from an active diptych workflow via a slash command in the TUI.

Command:

```
/handoff <target> [task-id]
```

Examples:

```
/handoff spec-kit
/handoff claude-code T003
/handoff agents-md
/handoff copilot-issue T001
```

## Read First

- `CLAUDE.md`
- `docs/SLASH-COMMANDS.md`                      (full registration pattern, AddCommand section)
- `src/core/slash-commands/catalog.ts`           (existing command entries, createCommands shape)
- `src/core/slash-commands/types.ts`             (SlashCommandDef, CommandContext)
- `src/core/slash-commands/context.ts`           (how CommandContext capabilities are wired)
- `src/core/slash-commands/catalog.test.ts`      (test pattern)
- `src/engine/handoff/types.ts`                  (HandoffTarget, HANDOFF_TARGETS — from brief 01)
- `src/engine/handoff/write.ts`                  (writeHandoffPack — from brief 02)
- `src/stores/project/config.ts`                 (configStore.get().projectDir)
- `src/stores/workflow/lifecycle.ts`             (check if sessionId is exposed — it is not as of writing)

## Files To Touch

- `src/core/slash-commands/types.ts` — extend `CommandContext` with `writeHandoff`
- `src/core/slash-commands/context.ts` — wire `writeHandoff` implementation
- `src/core/slash-commands/catalog.ts` — add `/handoff` entry
- `src/core/slash-commands/catalog.test.ts` — add behavior tests
- `docs/SLASH-COMMANDS.md` — add `/handoff` entry in the command reference section

Do not touch `src/engine/handoff/write.ts` (already implemented in brief 02).
Do not create a new handler file — the async work routes through `CommandContext`.

## CommandContext Extension

Add one capability to the `CommandContext` interface in `src/core/slash-commands/types.ts`:

```ts
writeHandoff: (target: HandoffTarget, taskId?: string) => Promise<{ outputDir: string }>;
```

Wire it in `src/core/slash-commands/context.ts`:

```ts
writeHandoff: async (target, taskId) => {
  const projectDir = configStore.get().projectDir;
  // lifecycleStore does not expose sessionId; use readActive instead
  const sessionId = readActive(projectDir);
  if (!sessionId) throw new Error('No active session for handoff');
  const outDir = join(
    projectDir, '.diptych', 'sessions', sessionId, 'handoffs', target,
  );
  return writeHandoffPack({
    projectDir,
    sessionId,
    target,
    outDir,
    selectedTaskIds: taskId ? [taskId] : undefined,
    mode: 'overwrite',  // slash command always overwrites; session folder is ephemeral
  });
},
```

Import `readActive` from `../../core/sessions/lifecycle.js` (it is already used in
`src/core/slash-commands/context.ts` via the `configStore` projectDir). Import
`src/core/sessions/lifecycle.ts` in `context.ts` for this call — add nothing new to the store.

## Catalog Entry

Add to `createCommands(ctx)` in `src/core/slash-commands/catalog.ts`:

```ts
{
  kind: 'arg',
  name: '/handoff',
  label: 'Handoff',
  description: 'Export Handoff Pack for an external agent →',
  validScreens: ['workflow', 'summary'],
  handler: (args) => {
    if (!args) {
      ctx.setFeedbackError('Usage: /handoff <target> [task-id]');
      return;
    }
    const [target, taskId] = args.trim().split(/\s+/);
    if (!target || !HANDOFF_TARGETS.includes(target as HandoffTarget)) {
      ctx.setFeedbackError(`Unknown target "${target}". Valid: ${HANDOFF_TARGETS.join(', ')}`);
      return;
    }
    ctx
      .writeHandoff(target as HandoffTarget, taskId)
      .then(({ outputDir }) => ctx.setFeedbackMessage(`Handoff written to: ${outputDir}`))
      .catch((err: unknown) =>
        ctx.setFeedbackError(err instanceof Error ? err.message : String(err)),
      );
  },
},
```

Import `HANDOFF_TARGETS` and `HandoffTarget` from `../../engine/handoff/types.js`.

## Behavior

- Valid only on `workflow` and `summary` screens (see `validScreens` above).
- Writes to `.diptych/sessions/<id>/handoffs/<target>/` (ADR-003), **not** to `./handoff/`.
- The CLI command (brief 02) writes to `./handoff/<target>/` — these are distinct surfaces.
- Uses `mode: 'overwrite'` — the session folder is diptych-owned, repeated exports are safe.
- `task-id` is optional; if provided, only that task is included in the pack.
- No active session → error `"No active session for handoff"` via `setFeedbackError`.
- Unknown target → error listing valid targets.

## Constraints

- No agent spawning, no auto-pickup, no watch mode (ADR-011).
- Does not shell out to `diptych handoff` — calls `writeHandoffPack` directly.
- No React/Ink imports in `src/core/slash-commands/` or `src/engine/handoff/`.
- No classes. No barrel `index.ts`.

## Tests (`src/core/slash-commands/catalog.test.ts`)

Add to the existing catalog test file. Stub `ctx.writeHandoff` to return `{ outputDir: '/fake' }`.

Required assertions:
- `/handoff` appears in the catalog with `validScreens` including `workflow` and `summary`.
- `/handoff` with no args calls `setFeedbackError` with usage hint.
- `/handoff unknown-target` calls `setFeedbackError` mentioning valid targets.
- `/handoff spec-kit` calls `writeHandoff('spec-kit', undefined)`.
- `/handoff claude-code T003` calls `writeHandoff('claude-code', 'T003')`.
- Success resolves to `setFeedbackMessage` containing the output path.
- `writeHandoff` rejection propagates to `setFeedbackError`.

## SLASH-COMMANDS.md Entry

Add a `### /handoff <target> [task-id]` section (follow existing format) after `/queue`:

```md
### `/handoff <target> [task-id]`

- **Purpose**: export a Handoff Pack for the active session to `.diptych/sessions/<id>/handoffs/<target>/`.
- **Screens**: `workflow`, `summary`.
- **Args**: `<target>` is one of `spec-kit`, `agents-md`, `claude-code`, `copilot-issue` (required). `[task-id]` is an optional task ID to export a single-task pack (e.g. `T003`).
- **Example**: `/handoff spec-kit`, `/handoff claude-code T003`
- **Implementation**: `src/core/slash-commands/catalog.ts`; calls `ctx.writeHandoff` wired in `src/core/slash-commands/context.ts` → `writeHandoffPack` in `src/engine/handoff/write.ts`.
```

## Acceptance Criteria

- Users can discover `/handoff` in the TUI command palette.
- `/handoff` calls `writeHandoffPack` — no duplicated file-writing logic.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/core/slash-commands/catalog.test.ts
npm run typecheck
npm run lint
npm test
```
