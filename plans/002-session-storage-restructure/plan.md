# 002 — Session Storage Restructure — Plan

## Data model

### Session-id generation

New module: `src/core/sessions/id.ts`

```ts
export function generateSessionId(projectDir: string, feature: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);  // YYYY-MM-DD
  const slug = slugify(feature).slice(0, 50);
  return findUniqueId(projectDir, `${date}-${slug}`);
}

function slugify(s: string): string {
  return s.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .replace(/-+/g, '-');
}

function findUniqueId(projectDir: string, base: string): string {
  const root = join(projectDir, '.diptych', 'sessions');
  if (!existsSync(join(root, base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(join(root, candidate))) return candidate;
  }
  throw new Error(`Could not generate unique session-id from base '${base}'`);
}
```

### Paths module rewrite

`src/core/paths.ts` and `src/core/paths-io.ts` lose `currentDir()`, gain:

```ts
export const ACTIVE_FILE = 'active';
export function diptychDir(projectDir: string): string { return join(projectDir, '.diptych'); }
export function activeFile(projectDir: string): string { return join(diptychDir(projectDir), ACTIVE_FILE); }
export function sessionsRoot(projectDir: string): string { return join(diptychDir(projectDir), 'sessions'); }
export function sessionDir(projectDir: string, sessionId: string): string { return join(sessionsRoot(projectDir), sessionId); }
```

Every file that today calls `currentDir(projectDir)` now calls `sessionDir(projectDir, sessionId)`. The `sessionId` is threaded through function signatures — it belongs on `WorkflowContext` (spec 001 already has `WorkflowContext`; we add `sessionId: string` to it).

### Active-file helpers

New module: `src/core/sessions/active.ts`

```ts
export function readActive(projectDir: string): string | null {
  const p = activeFile(projectDir);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8').trim() || null;
}

export function writeActive(projectDir: string, sessionId: string): void {
  writeFileSync(activeFile(projectDir), sessionId + '\n', { mode: 0o600 });
}

export function clearActive(projectDir: string): void {
  const p = activeFile(projectDir);
  if (existsSync(p)) unlinkSync(p);
}

export function isSessionLive(projectDir: string, sessionId: string): boolean {
  // Read state.json; return true if phase is non-terminal.
  const stateFile = join(sessionDir(projectDir, sessionId), STATE_FILE);
  if (!existsSync(stateFile)) return false;
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    return state.phase !== 'complete' && state.phase !== 'idle';
  } catch { return false; }
}
```

### WorkflowContext update

`src/engine/orchestrator/run.ts` — add `sessionId: string` to `WorkflowContext`. Threading:

- `runWorkflow(opts)` generates or reads the session-id at the top:
  - `start` command: opts has `feature`, no `savedState` → generate new id.
  - `resume` command: opts has `savedState`, id comes from `readActive(projectDir)` via CLI handler.

## Code paths to change

### `src/cli/commands/start.ts`

Before `initStores`:

```ts
const active = readActive(projectDir);
if (active && isSessionLive(projectDir, active)) {
  throw cliError(`Workflow already running: ${active}. Run 'diptych resume' to continue, or delete .diptych/active after verifying the session is truly stopped.`);
}
const sessionId = generateSessionId(projectDir, feature);
mkdirSync(sessionDir(projectDir, sessionId), { recursive: true, mode: 0o700 });
writeActive(projectDir, sessionId);
```

Then pass `sessionId` into the workflow setup (router state, run options).

### `src/cli/commands/resume.ts`

Before (lines 21-22):

```ts
const state = loadState(projectDir);
if (!state) throw cliError('Error: no saved workflow to resume.');
```

After:

```ts
const sessionId = readActive(projectDir);
if (!sessionId) throw cliError('Error: no active session to resume.');
const state = loadState(projectDir, sessionId);
if (!state) throw cliError(`Error: session '${sessionId}' has no state.json — cannot resume.`);
```

### `src/cli/commands/status.ts`

Read-only. Uses `readActive` + `loadState(projectDir, activeId)`.

### `src/core/state/persistence.ts`

`saveState`, `loadState`, `appendEvent` take `sessionId: string` and resolve paths through `sessionDir(projectDir, sessionId)`.

### `src/core/sessions/io.ts`

Today has `saveSession(dir, session)` where the session is a flat JSON. Rewrite: `saveSummary(projectDir, sessionId, summary)` writes `sessions/<id>/summary.json`. Keep the old `saveSession`-shaped function for one release if callers are hard to migrate; spec 009 cleans that up.

### End-of-run in `runWorkflow` (`src/engine/orchestrator/run.ts`)

`saveFinalSession` → `saveSummary`. After writing summary, call `clearActive(projectDir)`.

## Dependencies

**Depends on:** nothing (can run before or after 001). Does not require 001's capability matrix.

**Consumed by:** 003 (jsonl lives in the same session folder), 004 (plannerSessionId persisted to `sessions/<id>/state.json`), 005 (awaiting-continue written to `state.json` in session folder).

## Risk

- **Many callsites.** Every file that imports `currentDir` (estimate ~15-20 files) needs updating. Mechanical refactor but easy to miss one.
- **Test fixtures.** Tests that write to `.diptych/current/` must be updated. Use TDD: update tests to point at `sessions/<id>/` and run them; the red tests tell you exactly which files to fix.
- **Race window.** Between generating id, creating the folder, and writing `active`, another process could race. We accept this — if diptych is run twice within milliseconds, at most one extra empty session folder is created. The `active` file is written atomically (single `writeFileSync`).

## Success verification

- `grep -rn "currentDir\\b" src/` returns zero.
- `grep -rn "CURRENT_DIR\\b\\|/current/" src/` returns zero in active code.
- All 700+ tests pass.
- Manual smoke: `rm -rf .diptych && diptych start "test"` → `ls .diptych/sessions/` shows one folder.
- Manual smoke: with one session running in phase `specifying`, second `diptych start "foo"` exits with FR-004 message.
