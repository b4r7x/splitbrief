# 01 — Safe Run Snapshots

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add local file-level snapshots so a user can reject a diptych run and restore only files diptych changed, without overwriting later user edits.

## Read First

- `CLAUDE.md`
- `docs/FUTURE.md` section "Cursor-style per-run code snapshot undo"
- `docs/WORKFLOW.md`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/implementers/apply.ts`
- `src/lib/fs.ts`
- `src/lib/git.ts`
- `src/core/slash-commands/catalog.ts`

## Files To Touch

- `src/core/paths.ts`
- `src/engine/snapshots/types.ts` new
- `src/engine/snapshots/store.ts` new
- `src/engine/snapshots/store.test.ts` new
- `src/engine/implementers/apply.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/run/init.ts`
- `src/core/slash-commands/catalog.ts`
- `src/core/slash-commands/catalog.test.ts`
- `src/features/workflow/handlers.ts`
- `src/engine/events/types.ts`
- `docs/WORKFLOW.md`
- `docs/SLASH-COMMANDS.md`

## Snapshot Folder

```text
.diptych/sessions/<id>/snapshots/run/
```

Files:

- `manifest.json`
- `files/<encoded-path>.before`

Add `SNAPSHOTS_DIR = 'snapshots'` to `src/core/paths.ts`.

Manifest:

```ts
type SnapshotManifest = {
  version: 1;
  sessionId: string;
  createdAt: string;
  files: Record<string, SnapshotFile>;
  accepted: boolean;
  rejected: boolean;
};

type SnapshotFile = {
  path: string;
  action: 'create' | 'modify' | 'delete';
  beforeExists: boolean;
  beforeHash: string | null;
  beforeSnapshotPath?: string;
  lastDiptychHash: string | null;
  lastUpdatedAt: string;
};
```

## Safety Rule

On reject:

- restore modified file only if current hash equals `lastDiptychHash`,
- delete created file only if current hash equals `lastDiptychHash`,
- conflict if current hash differs,
- restore safe files and report conflicts.

Never overwrite user edits after diptych's last write.

## Commands

Slash:

```text
/accept-run
/reject-run confirm
```

`/reject-run` without `confirm` should explain the required confirmation.

## Apply Integration

Change `applyCode` signature to accept an optional snapshot context:

```ts
type ApplySnapshotContext = {
  sessionId: string;
  enabled: boolean;
};
```

Update `src/engine/implementers/base.ts` to pass `{ sessionId, enabled: true }` when `sessionId` exists.

Inside `applyCode`:

1. validate task path,
2. capture before state if this path is not yet in manifest,
3. perform existing write/search-replace behavior,
4. hash the resulting file and update `lastDiptychHash`.

Keep existing `applyCode(code, task, projectDir)` tests passing by making the context optional.

## Tests

Use temp directories and real filesystem.

- existing file restore.
- created file delete.
- user edit after diptych write causes conflict and is preserved.
- accepted manifest prevents reject.
- manifest reload works.

## Acceptance Criteria

- Reject restores only safe files.
- Conflicts are visible.
- No git staging/commit.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/snapshots/store.test.ts src/core/slash-commands/catalog.test.ts
npm run typecheck
npm run lint
npm test
```
