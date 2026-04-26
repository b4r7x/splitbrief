# 02 — Handoff CLI

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add a `diptych handoff` CLI command that writes a Handoff Pack folder for an existing diptych session.
The writer service it creates is also the shared writer called by the slash command (brief 03) — there
must be no duplicated file-writing logic.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `src/engine/handoff/types.ts`      (from brief 01 — HandoffInput, HandoffPack, HandoffTarget)
- `src/engine/handoff/render.ts`     (from brief 01 — renderHandoff)
- `src/cli.ts`                       (registers all CLI commands via register* functions)
- `src/cli/commands/status.ts`       (reference pattern for a Commander command)
- `src/core/sessions/io.ts`          (listSessions, listAllSessions)
- `src/core/sessions/lifecycle.ts`   (readActive)
- `src/core/state/persistence.ts`    (loadState — read the tasks from state.tasks)
- `src/core/paths.ts`                (sessionDir, DIPTYCH_DIR)
- `src/core/paths-io.ts`             (ensureSessionDir, writeProjectFile)
- `src/lib/fs.ts`                    (ensureSecureDir, writeSecureFile, SECURE_FILE_MODE)

## Command Shape

```
diptych handoff [<target>] [--session <id>] [--out <dir>] [--task <T001>[,T002,…]] [--mode default|append|overwrite]
```

- `<target>` defaults to `spec-kit`. Valid values: `spec-kit`, `agents-md`, `claude-code`, `copilot-issue`.
- `--session <id>` loads that session's state from `.diptych/sessions/<id>/state.json`.
- If `--session` is omitted, resolve via `readActive(projectDir)`. If no active session exists, exit with usage error: `"No session specified and no active session found. Use --session <id>."`.
- `--out <dir>` sets the output directory. Defaults to `./handoff/<target>/` (project-relative, **not** under `.diptych/`).
- `--task <ids>` filters to a comma-separated subset of task IDs, e.g. `--task T001,T003`. Default is all tasks.
- `--mode default` errors if `--out` already exists; `append` skips files that already exist; `overwrite` replaces all files.

## Files To Touch

- `src/engine/handoff/write.ts` **new** — shared writer service
- `src/engine/handoff/write.test.ts` **new**
- `src/cli/commands/handoff.ts` **new** — Commander command definition
- `src/cli/commands/handoff.test.ts` **new**
- `src/cli.ts` — add `import { registerHandoffCommand } from './cli/commands/handoff.js'` and call `registerHandoffCommand(program)`

Do not create `src/engine/handoff/index.ts` (zero barrels).

## Writer Service

Implement in `src/engine/handoff/write.ts`:

```ts
export type WriteHandoffOptions = {
  projectDir: string;
  sessionId: string;
  target: HandoffTarget;
  outDir: string;               // absolute path to the output folder
  selectedTaskIds?: string[];
  mode: 'default' | 'append' | 'overwrite';
};

export type WriteHandoffResult = {
  outputDir: string;
  files: string[];              // relative paths within outputDir
};

export async function writeHandoffPack(options: WriteHandoffOptions): Promise<WriteHandoffResult>;
```

The writer:
1. Loads `state.json` from `src/core/state/persistence.ts → loadState(projectDir, sessionId)`.
2. Reads optional session artifacts from the session folder:
   - `spec.md` via `readSpecFile(projectDir, sessionId, SPEC_FILE)` (null if absent).
   - `plan.md` via `readSpecFile(projectDir, sessionId, PLAN_FILE)` (null if absent).
3. Reads `.diptych/config.yaml` via `src/core/config/load.ts` to extract `validation` commands (`typecheck`, `lint`, `test`). Pass empty object if config is absent or commands are not declared.
4. Checks for `<projectDir>/constitution.md`; if present, reads its content.
5. Calls `renderHandoff(input)` from `src/engine/handoff/render.ts`.
6. Checks `outDir` against `mode`:
   - `default`: if `outDir` exists, throw `Error('output directory already exists: <path>. Use --mode append or --mode overwrite.')`.
   - `append`: skip files whose path already exists in `outDir`.
   - `overwrite`: write unconditionally.
7. Creates `outDir` with `mkdirSync(outDir, { recursive: true, mode: 0o700 })`.
8. Writes each `HandoffFile` with `writeFileSync(path, content, { mode: 0o600 })`.
9. Returns `{ outputDir: outDir, files: [...relative paths] }`.

The writer must be async to leave headroom for future manifest writing (brief 04), even though current I/O is synchronous.

## Commander Command (`src/cli/commands/handoff.ts`)

Pattern: follow `src/cli/commands/status.ts` exactly for Commander registration.

```ts
export function registerHandoffCommand(program: Command): void {
  program
    .command('handoff [target]')
    .description('Export a Handoff Pack for an external coding agent')
    .option('--session <id>', 'Session ID (default: active session)')
    .option('--out <dir>', 'Output directory (default: ./handoff/<target>/)')
    .option('--task <ids>', 'Comma-separated task IDs to include (default: all)')
    .option('--mode <mode>', 'default | append | overwrite (default: default)', 'default')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (target = 'spec-kit', opts) => { ... });
}
```

The action must:
1. Call `resolveProjectDir(opts.project)` from `src/cli/setup.ts`.
2. Resolve `sessionId` via `opts.session ?? readActive(projectDir)` — error if neither resolves.
3. Validate `target` is one of `HANDOFF_TARGETS` (from `src/engine/handoff/types.ts`); exit with clear error listing valid values if not.
4. Validate `opts.mode` is `default | append | overwrite`; exit with error if not.
5. Derive `outDir`: `opts.out ?? join(projectDir, 'handoff', target)`.
6. Parse `opts.task?.split(',').map(s => s.trim())` into `selectedTaskIds`.
7. Await `writeHandoffPack({ projectDir, sessionId, target, outDir, selectedTaskIds, mode: opts.mode })`.
8. Print `Handoff written to: <outDir>` followed by each file path on its own line.
9. Catch errors and exit non-zero with a human-readable message.

## Constraints

- CLI writes to `./handoff/<target>/` by default (project-relative, NOT under `.diptych/`). The slash command (brief 03) writes to `.diptych/sessions/<id>/handoffs/<target>/` — these are different surfaces, do not conflate them.
- No agent spawning, no auto-pickup, no watch mode (ADR-011).
- CLI works without TUI (no React/Ink imports in `src/cli/` or `src/engine/handoff/`).
- Do not duplicate file-writing logic between CLI and slash command — both call `writeHandoffPack`.
- No classes. No barrel `index.ts`.

## Tests

### `src/engine/handoff/write.test.ts`

Use `mkdtemp` for real temp directories. Use fixture `Task` objects (2–3 tasks, all optional fields populated).

Required assertions:
- `writeHandoffPack` creates `tasks/T001.md` and `README.md` in the output directory.
- `mode: 'default'` throws when output directory already exists.
- `mode: 'append'` skips existing files, writes missing ones.
- `mode: 'overwrite'` replaces existing files.
- Unknown `selectedTaskIds` entry propagates the error from `renderHandoff`.
- Returned `files` list matches written paths.

### `src/cli/commands/handoff.test.ts`

Use a stubbed `writeHandoffPack`. Assert:
- Unknown target exits with error listing valid targets.
- Unknown `--mode` value exits with error.
- `--task T001,T002` is parsed to `['T001', 'T002']`.
- Default target is `spec-kit`.
- Default `outDir` is `<projectDir>/handoff/spec-kit`.

## Acceptance Criteria

- `diptych handoff` works end-to-end without TUI.
- Generated files are deterministic.
- `writeHandoffPack` is the single file-writing entry point.
- Until brief 04 (`04-handoff-manifest-schema.md`) lands, the `briefHash:` field in task
  frontmatter is written as the literal string `<placeholder>`. Brief 04 will backfill it.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/handoff/write.test.ts src/cli/commands/handoff.test.ts
npm run typecheck
npm run lint
npm test
```
