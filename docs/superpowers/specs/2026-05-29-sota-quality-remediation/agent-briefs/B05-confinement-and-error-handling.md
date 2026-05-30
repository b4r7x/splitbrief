# B05 — Critical path-confinement + secure writes + error handling

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Close the codebase's single CRITICAL security hole (snapshot restore/diff write
arbitrary paths without confinement) and harden the surrounding error-handling and
secure-write surface. After this brief: every snapshot restore and diff path is asserted
inside the project root before any filesystem touch; one secure async file writer
(`writeSecureFileAsync`) replaces three ad-hoc tmp-write-then-rename copies; all three
process-spawn entry points fail consistently by throwing (D4); `lib/git.ts` routes every
`simple-git` call through one `runGit` wrapper that yields a typed `GitCommandError`; the
persisted-store reader policy (D3) and its `lib/fs.ts` helpers exist; `CliError` becomes a
real `Error` subclass (D2); and a cluster of low-severity silent-catch / weak-error sites
get justified or fixed. No behavior visible to a healthy run changes except spawn callers
now catch instead of inspecting a returned `{code}` for non-zero failures.

## Wave / ordering

- **Wave:** 3. **Runs after:** B01 (formatting sweep — every file is already reflowed) and
  B02 (type-safety gate + exhaustiveness; B02 has already done the `tree-recorder.ts`
  switch `assertNever` and the stray-`!` cleanups, so build on its edits there). B05 holds
  the lone CRITICAL and is otherwise independent of the refactor briefs, but it must land
  **before B10** splits `snapshots/store.ts` / `snapshots/run.ts` so the secure-write
  producer and the confinement asserts are in place when B10 rebases.
- **Decisions that bind this brief:**
  - **D2** — `class CliError extends Error` is the one sanctioned class (error subclasses
    only). Owner: B05. Affects `cli/errors.ts`.
  - **D3** — single persisted-store reader policy: missing file → empty/default (no warn);
    present-but-unparseable → `warnError(...)` once then empty/default; never throw, never
    silently swallow. Exception: security/integrity-critical reads (snapshot manifests)
    **must throw**. B05 owns the *policy + the `lib/fs.ts` helpers* `readValidatedJson` /
    `readJsonl`; B12/B13 route the duplicate readers through them later.
  - **D4** — spawn contract: `runCommand` / `spawnWithTimeout` / `spawnWithStdin` are made
    **consistent on throwing** on non-zero/127. Update every call site; where a caller
    relied on a non-throwing `{code}` for control flow, preserve that behavior with a local
    try/catch — do not weaken the contract back. Owner: B05.

## File ownership

**Edit (sole owner for this wave):**

- `src/engine/snapshots/run.ts` — EH-01 confinement, DRY-20 (use `writeSecureFileAsync`).
  *Collision (B05 → B10):* you own the critical confinement + secure-write adoption here.
  B10 later imports Accept/Reject result types from core (DRY-21) — do **not** touch the
  result-type definitions or move the file.
- `src/engine/snapshots/diff.ts` — EH-03 confinement.
- `src/engine/detection/cache.ts` — EH-02 (route the cache write through
  `writeSecureFileAsync`).
- `src/lib/fs.ts` — DRY-20 producer (`writeSecureFileAsync`), D3 helpers
  (`readValidatedJson` / `readJsonl`).
- `src/lib/git.ts` — EH-04 (`runGit` wrapper), DRY-60 (`discardChangedFiles` delegates to
  `discardFileChange`).
- `src/core/stats/persistence.ts` — EH-05 (apply D3 policy; collapse dead `isENOENT`).
- `src/lib/process/spawn.ts` — EH-06 / D4 (all three throw) **and every caller** (listed
  in Required changes step 6).
- `src/engine/orchestrator/task/commit.ts` — EH-07 (widen `pre_commit` payload).
- `src/cli/errors.ts` — EH-13 / D2 (`class CliError extends Error`).
- `src/utils/with-timeout.ts` — EH-12 (`withTimeout` rejects with a typed timeout error).
- `src/hooks/use-async-highlight.ts` — EH-11 (justify the best-effort catch).
- `src/engine/hooks/dispatch.ts` — EH-14 (`tryParseResponse` empty catch justified).
- `src/engine/hooks/builtins/block-secrets.ts` — RU-05 (detect via
  `redactSecretsWithMetadata`, 17 rules).
- `src/core/config/errors.ts` — EH-10 (`unsupportedVersion` message wording).

**Edit (shared file — narrow concern only):**

- `src/engine/events/sinks/tree-recorder.ts`
  - **Yours (B05):** EH-14 — justify/replace the three empty `catch {}` blocks at the
    `persist()` helper and the two `workflow_started` / `workflow_resumed` write blocks
    (current lines ~31, ~43, ~58). TS-12 — make the `cost-checkpoint` payload's
    `totalCost` optional/omit instead of the hardcoded `totalCost: 0` (current line ~177).
  - **NOT yours (B02, already landed in wave 1):** the stray `!` on the
    `tree.entries.get(tree.meta.leafId)!` lines (current ~39, ~54) and the final
    `assertNever` exhaustiveness switch. Do not re-do these; if B02 already removed the
    `!`, build on its restructured code.

**Edit (callers of the spawn trio — D4, sole owner of the per-call-site change):**

- `src/engine/availability.ts`, `src/engine/providers/discovery.ts`,
  `src/engine/hooks/builtins/prettier-on-change.ts`,
  `src/engine/orchestrator/validation.ts`, `src/engine/claude-invoke.ts`,
  `src/engine/streaming/spawn-collect.ts`, `src/engine/runners/command-based.ts`
  (via `spawnWithShellFallback`). See step 6 for exactly what each must change.

**Tests to add/update:** `src/lib/fs.test.ts`, `src/lib/git.test.ts`,
`src/lib/process/spawn.test.ts`, `src/engine/snapshots/run.test.ts`,
`src/engine/snapshots/diff.test.ts`, `src/core/stats/persistence.test.ts`,
`src/engine/orchestrator/validation.test.ts`,
`src/engine/hooks/builtins/block-secrets.test.ts`, `src/utils/with-timeout.test.ts`
(all already exist — extend them), and `src/cli/errors.test.ts` /
`src/engine/orchestrator/task/commit.test.ts` if present (otherwise fold the assertions
into the nearest existing suite).

**Create:** none required beyond test files. All new symbols are exports added to existing
modules.

**Delete:** none.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| EH-01 | **crit** | `engine/snapshots/run.ts:245-305` | `assertPathConfined(path, projectDir)` in the `rejectRunSnapshot` per-path loop before any `hashFile`/`unlink`/`writeFile`, and inside `restoreBaselineFile` before writing the target. |
| EH-02 | high | `engine/detection/cache.ts:107-117` | Replace the manual tmp-write-then-rename in `saveDetectionCache` with `writeSecureFileAsync` (mode + symlink guard). |
| EH-03 | high | `engine/snapshots/diff.ts:116-150` | `assertPathConfined(path, projectDir)` for each `filteredPaths` entry before `hashFile(join(projectDir, path))` / building `currentFilePath`. |
| EH-04 | high | `lib/git.ts:74-81,129-196` | Wrap every `simple-git` call through one `runGit(intent, fn)` that rethrows as `GitCommandError`; covers the currently-unguarded `getCurrentDiff`, `createTaggedStash`, `branchExists`, `createBranch`/`checkoutLocalBranch`, `discardFileChange`, `isTracked`, `discardChangedFiles`. |
| EH-05 | high | `core/stats/persistence.ts:15-26` | Apply D3 policy in `readStats`; collapse the internally-dead `if (isENOENT(err)) return empty; return empty;` into one return and `warnError` only when a present file is unparseable. |
| EH-06 | med | `lib/process/spawn.ts:177,233-244` | Make `runCommand` & `spawnWithTimeout` throw on non-zero/127 like `spawnWithStdin` already does (D4); update all callers. |
| EH-07 | med | `engine/orchestrator/task/commit.ts:48-51` | Widen the `pre_commit` hook payload beyond the single `task.file` to the full staged-changes set. |
| EH-10 | low | `core/config/errors.ts:56-61` | `unsupportedVersion` message → "Supported: 1 (migrated), 2 (deprecated), 3". |
| EH-11 | low | `hooks/use-async-highlight.ts:11-12` | Replace the bare `.catch(() => {})` with a one-line justified best-effort catch (comment naming why highlight failure is non-fatal; keep silent — no warn spam in a render loop). |
| EH-12 | low | `utils/with-timeout.ts:11` | `withTimeout` rejects with a typed `timeoutError.elapsed(ms)` instead of `new Error('timeout')`. |
| EH-13 | low | `cli/errors.ts:5-7` | `class CliError extends Error { readonly exitCode }`; `isCliError` → `instanceof CliError` (D2). |
| EH-14 | low | `events/sinks/tree-recorder.ts:31,43,58` + `hooks/dispatch.ts:96` | Justify each best-effort empty catch with a one-line comment; route the tree-recorder persistence-failure catches through `warnError` (they already document "must not crash the workflow"). `dispatch.ts:96` `tryParseResponse` catch: justify (malformed hook stdout → treat as no decision). |
| TS-12 | med | `engine/events/sinks/tree-recorder.ts:176-182` | Make `CostCheckpointPayload.totalCost` optional and omit it here rather than emitting a misleading `totalCost: 0`. |
| DRY-20 | high | `engine/snapshots/store.ts:45-56` + `run.ts:67-74` | Introduce `writeSecureFileAsync` in `lib/fs.ts`; route `writeManifest` and `writeRunLedger` through it (producer side). |
| DRY-34 | med | `ipc/replay.ts`+`sessions/{io,tree/io}.ts`+`stats/persistence.ts`+`state/persistence.ts` | Add `readValidatedJson` / `readJsonl` helpers to `lib/fs.ts` encoding the D3 policy; adopt them in `stats/persistence.ts` (B05's own file). Bulk routing of the other readers is B12/B13 — do **not** rewrite them here. |
| DRY-60 | low | `lib/git.ts:187-196` | `discardChangedFiles` reuses the per-file tracked/untracked logic from `discardFileChange` instead of duplicating `checkout`/`clean`. |
| RU-05 | med | `engine/hooks/builtins/block-secrets.ts:6-11` | Detect secrets via `redactSecretsWithMetadata` (17 rules) instead of the local 4-pattern array. |

## Required changes

Do them in this order. Read each current file before editing (line anchors below were
verified against live source but B01/B02 may have shifted them slightly — match on text,
not line number).

### 1. `lib/fs.ts` — add the secure-write producer and the D3 reader helpers

The file already exports `SECURE_FILE_MODE`, `SECURE_DIR_MODE`, `ensureSecureDir`,
`writeSecureFile` (sync), `readJsonSafe`, `readJsonSafeAsync`, `fsError`. Add:

1a. **`writeSecureFileAsync`** — the async twin of the sync `writeSecureFile` (which lives
at `fs.ts:46-65`). Same contract: ensure the secure dir, refuse to write through a
symlink, write to a random tmp name then `rename`, then `chmod` to `SECURE_FILE_MODE`.
Use `node:fs/promises` (`lstat`, `writeFile`, `rename`, `chmod`) and reuse
`ensureSecureDir` + `fsError.symlinkWrite`. Signature:

```ts
export async function writeSecureFileAsync(filePath: string, content: string): Promise<void>
```

Mirror the sync symlink check: `lstat` the target; if it is a symlink, throw
`fsError.symlinkWrite(filePath)`; swallow a non-symlink `lstat` error (target absent is
fine). Tmp name pattern identical to the sync version
(`.${basename}.tmp.${randomBytes(8).toString('hex')}`).

1b. **`readValidatedJson<T>`** — D3-policy JSON reader:

```ts
export function readValidatedJson<T>(
  filePath: string,
  parse: (value: unknown) => T | null,
  fallback: T,
  label: string,
): T
```

Behavior: if the file does not exist → return `fallback` (no warn). If it exists but
`readFileSync`/`JSON.parse` throws, or `parse(value)` returns `null` → `warnError(label,
err?)` once then return `fallback`. Use `existsSync` to distinguish missing from corrupt
(matches `core/state/persistence.ts:loadState` and `sessions/io.ts:readSummaryFile`). Pass
the Zod `safeParse` result through `parse` at the call site (the caller does
`SchemaName.safeParse(v).success ? data : null`). Import `warnError` from `./warn.js`.

1c. **`readJsonl<T>`** — D3-policy JSONL reader:

```ts
export function readJsonl<T>(
  filePath: string,
  parseLine: (value: unknown) => T | null,
  label: string,
): T[]
```

Behavior: missing file → `[]` (no warn). Present → split on `\n`, skip blank lines, and
for each line `JSON.parse` + `parseLine`; on a per-line parse failure `warnError(label,
err)` and skip that line (do not abort the whole file — matches
`sessions/tree/io.ts:readTreeEntries`). Return the collected array.

> Scope note: B05 only *creates* `readValidatedJson` / `readJsonl` and *adopts them in
> `core/stats/persistence.ts`* (step 4). The other readers named in DRY-34
> (`ipc/replay.ts`, `sessions/io.ts`, `sessions/tree/io.ts`, `state/persistence.ts`) are
> routed by B12/B13 — leave them as-is.

### 2. `lib/git.ts` — one `runGit` wrapper (EH-04) + `discardChangedFiles` delegation (DRY-60)

The file already has `gitError.commandFailed`, `GitCommandError`, and a private
`toGitCommandError(intent, err)`. Several functions already wrap (`getGitStatus`,
`stageAll`, `commitChanges`, `getCurrentCommitSha`, `getCurrentChangedFiles`,
`getCommittedFilesSince`). The unguarded ones are the targets.

2a. Add a single generic wrapper next to `toGitCommandError`:

```ts
async function runGit<T>(intent: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toGitCommandError(intent, err);
  }
}
```

2b. Convert the currently-unguarded `simple-git` calls to go through `runGit`, giving each
a human-readable `intent`. The functions to wrap (verified unguarded in current source):

- `getCurrentDiff` (`git.ts:74-81`) — wrap the `Promise.all([git.diff(['--cached']),
  git.diff()])`; intent `'diff'`.
- `createTaggedStash` (`129-137`) — wrap the `stash create` / `tag` / `reset` body; intent
  `'stash create'`. (It calls `stageAll`, which already wraps — fine.)
- `branchExists` (`139-143`) — wrap `git.branch(['--list', name])`; intent
  `'branch --list'`.
- `createBranch` (`150-163`) — wrap `git.checkoutLocalBranch(name)`; intent
  `'checkout -b'`. Leave the `branchNameCollision` throw untouched.
- `discardFileChange` (`165-176`) — wrap the `checkout`/`clean`; intent
  `` `discard ${file}` ``.
- `isTracked` (`178-185`) — leave its `try { … return true } catch { return false }`
  intact; that catch is intentional boolean detection, not error-swallowing. Add a
  one-line comment saying so.
- `discardChangedFiles` (`187-196`) — see 2c.

For the already-wrapped functions you may optionally refactor them to call `runGit(intent,
() => …)` for consistency, but that is not required — they already satisfy EH-04. Do not
change their `intent` strings if you do (tests may assert on them).

2c. **DRY-60:** rewrite `discardChangedFiles` so the per-file tracked/untracked decision
reuses `discardFileChange` rather than re-implementing `checkout`/`clean`:

```ts
export async function discardChangedFiles(dir: string, files: string[]): Promise<void> {
  for (const file of files) {
    await discardFileChange(dir, file, (await isTracked(dir, file)) ? 'tracked' : 'untracked');
  }
}
```

`discardFileChange` now wraps via `runGit`, so `discardChangedFiles` inherits typed errors.

### 3. `lib/process/spawn.ts` — D4: all three throw (EH-06)

`spawnWithStdin` (`spawn.ts:201-249`) already throws `processError.notFound` on 127 and
`processError.exitCode` on non-zero. Bring the other two in line.

3a. **`runCommand`** (`spawn.ts:105-131`): change the return type from `Promise<{ stdout;
stderr; code }>` to `Promise<{ stdout: string; stderr: string; code: 0 }>` *or* keep
`{stdout, stderr}` only — but the cleanest D4 form is: in `onClose`, if `code === 127`
throw `processError.notFound(command)`, else if `code !== 0` throw
`processError.exitCode({ command, code, stderr, output: stdout })`, else return `{ stdout,
stderr, code: 0 }`. Keep `onError: () => null` (ENOENT still surfaces as the raw
`ErrnoException`, matching `spawnWithTimeout` and the existing `runCommand` ENOENT test).

3b. **`spawnWithTimeout`** (`spawn.ts:151-185`): in `onClose`, if it did **not** time out
and `code === 127` throw `processError.notFound(opts.command, opts.notFoundMessage)`, and
if it did not time out and `code` is non-zero throw `processError.exitCode({ command:
opts.command, code, stderr: stderrOutput, output })`. **Preserve the timeout path**: when
`timeoutSignal.aborted` is true, still resolve with `{ output, code: code ?? 1, timedOut:
true, stderr }` — callers (e.g. `dispatch.ts`) branch on `result.timedOut`, so a timeout
must remain a non-throwing result. The `SpawnResult` shape stays the same.

> Rationale: `spawnWithShellFallback` (`spawn.ts:187-199`) catches ENOENT to retry via the
> user shell; that still works because ENOENT is the raw error, not a thrown
> `processError`. A genuine non-zero exit from the shelled command now throws — acceptable
> per D4.

3c. Update `lib/process/spawn.test.ts`:
- `runCommand` "returns nonzero exit code on failure" (`spawn.test.ts:33-36`) → assert it
  now `rejects` with a `process-output` error: `await
  expect(runCommand('node',['-e','process.exit(42)'])).rejects.toMatchObject({ kind:
  'process-output' })`.
- `runCommand` happy-path/stderr tests (`7-11`, `27-31`) still pass (exit 0).
- `spawnWithTimeout` "times out" test (`86-96`) still asserts `result.timedOut === true`
  and must **not** throw — verify it still resolves.
- Add a `spawnWithTimeout` non-zero-exit test asserting it rejects with `process-output`
  when not timed out.

### 4. Spawn-caller updates (D4) — preserve control flow

Go through every caller and adapt. The full caller list (grep
`runCommand|spawnWithTimeout|spawnWithStdin|spawnWithShellFallback` under `src/`, exclude
`spawn.ts` and `*.test.*`):

| Caller | Current behavior | Required change |
|---|---|---|
| `engine/availability.ts:18-19` `probeCommand` | reads `{stdout, code}`, `if (code!==0) return {available:false}` | The `try/catch` already returns `{available:false, version:null}`. A non-zero `--version` now throws → caught → same result. Drop the `code` read; keep `try { const {stdout} = await runCommand(...); return {available:true, version:parseVersion(stdout)} } catch { return {available:false, version:null} }`. |
| `engine/providers/discovery.ts:39` `discoverSubprocessModels` | reads `{stdout}` only; catch warns unless ENOENT | No change needed (already only uses `stdout`, already catches). Verify it compiles against the new return type. |
| `engine/hooks/builtins/prettier-on-change.ts:12-14` | reads `{code, stderr}`; `code===0` allow else warn | Wrap so a non-zero exit (now thrown `process-output`) becomes the same warn. Replace the `result.code` branch: `try { await runCommand('npx',['prettier','--write',abs],{...}); return {kind:'allow'} } catch (err) { return {kind:'warn', message: toErrorMessage(err)} }`. The existing outer catch already produces the warn — collapse into it. |
| `engine/orchestrator/validation.ts:171-197` `runValidationStep` | reads `{stdout, stderr, code}`; branches on `code===127` (skip), `code===0` (pass), non-zero (fail with stderr) | **Critical caller relying on `{code}` for control flow.** Keep a local `try/catch`: on success treat as pass (`{passed:true, stage, output: sanitizeValidationOutput(stdout)}`). In `catch`: if `isENOENT(err)` or `processError.isNotFound(err)` → `{passed:true, output: '${cmd} not found, skipping ${stage}'}` (covers 127); else if `processError.isExitCode(err)` → build the failing result from the error's `data` (`{passed:false, stage, output: sanitizeValidationOutput(String(data.output ?? '')), error: sanitizeValidationOutput(String(data.stderr ?? '').trim())}`); else rethrow. Import `processError` from `../../lib/process/errors.js`. This preserves the existing 127-skip and non-zero-fail semantics under the throwing contract. |
| `engine/claude-invoke.ts:159,186` (`spawnWithStdin`) | already throws; result destructured | No change. |
| `engine/streaming/spawn-collect.ts:29` (`spawnWithStdin`) | already throws | No change. |
| `engine/runners/command-based.ts:66-92` (`spawnWithShellFallback`) | timeout branch checks `result.timedOut`, then `result.code === 127`, then **tolerates any non-zero exit** by returning `result.output` | Under D4 `spawnWithTimeout` now throws on 127 (as `processError.notFound`) and on non-zero (as `processError.exitCode`). This **unifies** the timeout branch with the already-throwing non-timeout `spawnAndCollect` branch (lines 93-110) — desired, not a regression. Concretely: the `result.timedOut` check stays (timeout still resolves). The `if (result.code === 127)` block becomes dead (the spawn already throws notFound) — **delete it**. Do **not** add a try/catch to re-tolerate non-zero: that would re-create the split D4 removes and diverge the two branches again. Let a non-zero `process-output` throw propagate, matching `spawnAndCollect`. After deletion the branch is just: assign `stdout = result.output; stderr = result.stderr;`. Update `command-based`/`cli` runner tests that asserted a non-zero exit still returned output — they must now assert it throws. |

Update `engine/orchestrator/validation.test.ts`: its mock `runCommand` returns
`{stdout,stderr,code}` objects today. For the test cases that simulate a failing command
(non-zero code) or a not-found command (code 127), change the mock to **throw**
`processError.exitCode(...)` / `processError.notFound(...)` (or a raw `{code:'ENOENT'}`
error) so the test exercises the new catch path. Cases that simulate success keep
returning `{code:0,...}`.

### 5. `engine/snapshots/run.ts` — EH-01 (critical) + DRY-20

5a. Import `assertPathConfined` from `'../../lib/path-confinement.js'` and
`writeSecureFileAsync` from `'../../lib/fs.js'`.

5b. **`writeRunLedger`** (`run.ts:67-74`): replace the manual
`writeFile(tmp, …, {mode}); rename(tmp, target)` with
`await writeSecureFileAsync(target, \`${JSON.stringify(ledger, null, 2)}\n\`)`. Drop the
now-unused `tmp` local and the `rename`/`writeFile`/`SECURE_FILE_MODE` imports if nothing
else in the file uses them (note: `ensureSecureDir` becomes unnecessary too because
`writeSecureFileAsync` calls it — remove it from this function and from the import if
unused elsewhere in the file). Verify no other function in `run.ts` still needs `rename`,
`writeFile`, `unlink`, `mkdir`, `readFile` before pruning — `restoreBaselineFile` uses
`mkdir`/`readFile`/`writeFile`, and the reject loop uses `unlink`, so keep those.

5c. **`restoreBaselineFile`** (`run.ts:163-193`): before
`await writeFile(targetPath, contents)`, assert
`assertPathConfined(opts.path, opts.projectDir)`. `opts.path` is the project-relative path
from the manifest; `targetPath = join(opts.projectDir, opts.path)`. The assert must run
**before** the `mkdir(dirname(targetPath))` and the write. (Leave the file write itself as
a plain `writeFile` — baseline blobs are not secret-mode files; the security fix is
confinement, not mode.)

5d. **`rejectRunSnapshot`** per-path loop (`run.ts:255-305`): at the top of the
`for (const path of [...paths].sort())` body — before the first
`hashFile(join(projectDir, path))` and before any `unlink(join(projectDir, path))` — call
`assertPathConfined(path, projectDir)`. This guards the `unlink` (deletion) branches as
well as the restore branches. Because the whole function can now throw a
`path-confined-*` error, that is the correct fail-closed behavior: a manifest containing a
traversal path must abort the reject rather than delete/overwrite outside the root.

5e. Add tests in `snapshots/run.test.ts`: craft a manifest/ledger whose `fileHashes`
contains a path like `../escape.txt` (or an absolute path) and assert `rejectRunSnapshot`
throws a path-confinement error (`pathConfinementError` / `kind: 'path-confined-escape'`
or `'path-confined-absolute'`) and that no file outside the project dir is written or
deleted. Keep the existing happy-path reject tests green.

### 6. `engine/snapshots/diff.ts` — EH-03

In `computeSnapshotDiff` (`diff.ts:97-157`), inside the
`for (const path of filteredPaths)` loop, add `assertPathConfined(path, projectDir)` as
the first statement (before `hashFile(join(projectDir, path))`). Import `assertPathConfined`
from `'../../lib/path-confinement.js'`. A traversal/absolute path in the manifest or the
caller-supplied `opts.paths` must abort the diff. Add a `diff.test.ts` case asserting a
`../escape` path throws.

### 7. `engine/detection/cache.ts` — EH-02

In `saveDetectionCache` (`cache.ts:102-117`), replace the manual `mkdir` + `writeFile(tmp)`
+ `rename` block with `await writeSecureFileAsync(path, JSON.stringify(cache))`. Keep the
surrounding `try { … } catch { /* cache write failure is non-critical */ }` — adopting the
secure writer must not change the non-critical swallow (this is telemetry cache, D3
default-ish). Update imports: drop `mkdir`/`rename`/`writeFile` from the
`node:fs/promises` import (`loadDetectionCache` uses `readFile`, `invalidateCache` uses
`unlink` — keep those). Add `import { writeSecureFileAsync } from '../../lib/fs.js';`.

### 8. `engine/snapshots/store.ts` — DRY-20 (producer adoption, narrow)

Only touch `writeManifest` (`store.ts:45-56`). Replace its tmp-write-then-rename with
`await writeSecureFileAsync(target, \`${JSON.stringify(manifest, null, 2)}\n\`)`. Remove
the now-unused `ensureSecureDir`/`rename`/local `tmp` from that function. **Do not** touch
`readManifest` — per D3 it is a security/integrity-critical read and must keep throwing
(it already does, via the `snapshot-manifest-not-found` error and the bare
`SnapshotManifestSchema.parse`). Leave everything else in `store.ts` for B10. If
`ensureSecureDir`/`SECURE_FILE_MODE`/`rename` are still used elsewhere in `store.ts` (they
are — `writeFile`/`rename` patterns may appear in other functions B10 will split), keep
the imports.

### 9. `core/stats/persistence.ts` — EH-05 + DRY-34 adoption

Rewrite `readStats` (`persistence.ts:15-26`) to use `readValidatedJson`:

```ts
export function readStats(projectDir: string): Stats {
  return readValidatedJson(
    statsPath(projectDir),
    (v) => { const r = StatsSchema.safeParse(v); return r.success ? r.data : null; },
    emptyStats(),
    'stats: unreadable file',
  );
}
```

This collapses the dead `if (isENOENT(err)) return emptyStats(); return emptyStats();`
(both arms identical) into one fallback and warns only on a present-but-corrupt file (D3).
Drop the now-unused `readFileSync` and `isENOENT` imports; import `readValidatedJson` from
`'../../lib/fs.js'`. Add/adjust a `persistence.test.ts` case: a corrupt `stats.json`
yields `emptyStats()` and a warn; a missing file yields `emptyStats()` with no warn.

### 10. `engine/orchestrator/task/commit.ts` — EH-07

In the `per-task` branch of `validateCommitAndAdvance`, the `pre_commit` hook
(`commit.ts:47-65`) currently runs **before** `gitOps.stageAll(projectDir)` (which is at
`commit.ts:68`), and its payload carries only `file: task.file`. So a `pre_commit` hook
that inspects `git diff --cached` sees an empty/stale index, and a hook reading the event
payload sees only one file. EH-07 = "widen pre_commit payload to full staged set." Verified
constraints: `HookContext` is exactly `{ projectDir, sessionId }`
(`src/engine/hooks/types.ts`); `runPreHooks(hooks, event, eventPayload, ctx)`
(`src/engine/hooks/run-pre-hook.ts`); the `git_commit` `EngineEvent` carries `file`
(singular) + `message` and is owned by B03 — do **not** add a field to it.

Two-part fix:

1. **Stage before the hook.** Move `await gitOps.stageAll(projectDir)` so it runs *before*
   the `if (config.hooks)` block (i.e. before `runPreHooks`), so any hook inspecting the
   git index sees every file the commit will include. Then in the existing
   `try { … }` block, replace the leading `gitOps.stageAll` with just
   `gitOps.commitChanges(projectDir, commitMsg)` (stage already done). Keep the
   `publishGitCommit` call. Guard the early-staging so a failure still goes through the
   existing `catch` → `publishWarningFromError`.
2. **Pass the staged set to the hook context.** Add an optional `files?: string[]` to
   `HookContext` in `src/engine/hooks/types.ts` (this is the hook context type, **not** the
   events schema — not owned by another brief; adding an optional field is safe and
   non-breaking). Resolve the staged files via `getCurrentChangedFiles(projectDir)` (add it
   to the existing `lib/git.js` import) after staging, wrapped so a git failure degrades to
   the single file:
   `let files: string[] = [task.file]; try { files = await getCurrentChangedFiles(projectDir); } catch { /* keep task.file */ }`,
   and pass `{ projectDir, sessionId, files }` as the `ctx` arg to `runPreHooks`.

This makes the full staged set visible both to index-inspecting hooks (part 1) and to
payload/context-reading hooks (part 2) with no `EngineEvent` schema change. Add a
`commit.test.ts` (or extend the existing pre_commit hook test) asserting the `pre_commit`
hook is invoked with `ctx.files` containing more than just `task.file` when multiple files
are staged, and that the index is staged before the hook runs. Keep all existing commit
tests green.

### 11. `cli/errors.ts` — EH-13 / D2

Replace the `Object.assign` factory with a real subclass (D2 sanctions `extends Error`):

```ts
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function cliError(message: string, exitCode = 1): CliError {
  return new CliError(message, exitCode);
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}

export function rethrowAsCli(err: unknown): never {
  if (isCliError(err)) throw err;
  throw cliError(toErrorMessage(err), 1);
}
```

Keep the exported `cliError`/`isCliError`/`rethrowAsCli` function names — there are ~40
call sites (`grep -rn "cliError\|isCliError\|rethrowAsCli" src`) and they must keep
working unchanged. `cli.ts:63` (`if (isCliError(err))`) keeps working via `instanceof`.
The exported `type CliError = …` becomes the class type automatically. No call-site edits
needed.

### 12. `utils/with-timeout.ts` — EH-12

`timeoutError` currently exposes only `idle`. Add an `elapsed` member and use it in
`withTimeout`:

```ts
export const timeoutError = {
  idle: (message = 'Idle timeout') => error('idle-timeout', message, { message }),
  isIdle: matches('idle-timeout'),
  elapsed: (ms: number) => error('timeout-elapsed', `Timed out after ${ms}ms`, { ms }),
  isElapsed: matches('timeout-elapsed'),
} as const;
```

In `withTimeout` (`with-timeout.ts:9-17`) replace `reject(new Error('timeout'))` with
`reject(timeoutError.elapsed(ms))`. Extend the existing `src/utils/with-timeout.test.ts`
with a case asserting a slow promise rejects with `kind: 'timeout-elapsed'` carrying
`data.ms`.

### 13. `hooks/use-async-highlight.ts` — EH-11

The `highlight(...).then(...).catch(() => {})` (`use-async-highlight.ts:10-12`) swallows
silently. This is a render-loop best-effort — warning on every failed highlight would spam.
Keep it silent but **justify** it: replace `.catch(() => {})` with
`.catch(() => { /* highlight is best-effort; on failure leave the raw code unhighlighted */ })`.
No `warnError` here (would flood). No behavior change.

### 14. `engine/hooks/dispatch.ts` — EH-14 (one catch)

`tryParseResponse` (`dispatch.ts:90-98`) has an empty `catch {}` when `JSON.parse` fails.
Justify it inline: `} catch { /* malformed hook stdout → treat as no decision (allow) */ }`.
No `warnError` (hooks may legitimately print non-JSON). No behavior change.

### 15. `engine/events/sinks/tree-recorder.ts` — EH-14 (three catches) + TS-12

15a. **EH-14:** the three persistence `catch {}` blocks — in `persist()` (~line 31) and the
two write blocks in `workflow_started` (~43) and `workflow_resumed` (~58). The file header
already says "persistence failures must not crash the workflow." Route each through
`warnError` so corruption is observable but non-fatal:
`} catch (err) { warnError('session-tree: persist failed', err); }` (and analogous
messages for the meta/entry writes). Import `warnError` from
`'../../../lib/warn.js'`. Keep the swallow semantics (no rethrow).

15b. **TS-12:** the `cost_update` case builds a `CostCheckpointPayload` with `totalCost: 0`
(~lines 176-182), a misleading hardcoded zero (the recorder has no cost figure at this
point). `CostCheckpointPayload` is a **Zod-inferred type** —
`CostCheckpointPayloadSchema` at `src/core/sessions/tree/entry-types.ts:57-65`, where
`totalCost: z.number().nonnegative()`. Change that field to
`totalCost: z.number().nonnegative().optional()` and build the payload here **without**
`totalCost` (keep `inputTokens`, `outputTokens`, `phase`). Verified consumers:
`reconstruct.ts:68` only stores `cost.payload` wholesale (it never computes on
`totalCost`), and `reconstruct.test.ts:106` feeds a fixture that still includes
`totalCost: 2` — so making the field optional is backward-compatible and breaks nothing.
(`reconstruct.ts` is deleted later by B14, but it exists now and stays green.) **Do not**
touch the recovery-outcome enums in `entry-types.ts` (lines ~43/243/263) — those are B03's
bounded exclusion.

15c. **Do not** touch the `tree.entries.get(...)!` stray `!` (B02) or the final
`assertNever` switch (B02). If B02 already restructured those lines, edit around its
version.

### 16. `core/config/errors.ts` — EH-10

In `configError.unsupportedVersion` (`errors.ts:56-61`), change the message from
`` `Unsupported config version: ${String(version)}. Expected 2 or 3.` `` to
`` `Unsupported config version: ${String(version)}. Supported: 1 (migrated), 2 (deprecated), 3.` ``.
(Per CLAUDE.md: configs write `version: 3`; `version: 2` is accepted+migrated; `1` is the
legacy migrate path.) Keep the `kind`/`data` unchanged. If a test asserts the old message,
update it.

### 17. `engine/hooks/builtins/block-secrets.ts` — RU-05

Replace the local 4-entry `SECRET_PATTERNS` array and the `for` loop with the shared
17-rule detector. `redactSecretsWithMetadata(content)` (in `src/utils/redact.ts`) returns
`{ text, redacted }`; `redacted === true` means a secret matched. Rewrite `blockSecrets`:

```ts
import { redactSecretsWithMetadata } from '../../../utils/redact.js';
// ...
const { redacted } = redactSecretsWithMetadata(content);
if (redacted) {
  return { kind: 'deny', message: `secret detected in ${file}` };
}
return { kind: 'allow' };
```

Delete the local `SECRET_PATTERNS` constant. The deny message loses the per-pattern name
(the shared detector does not expose which rule matched) — that is acceptable; the message
still names the file. Update `block-secrets.test.ts`: keep the cases that feed an AWS
key / GitHub PAT / OpenAI key / Anthropic key (all covered by the 17 rules) asserting
`deny`; the "clean file → allow" case is unchanged. Add at least one case for a rule only
the 17-set covers (e.g. a `xai-…`, `gsk_…`, or a `Bearer <token>` string) asserting
`deny`, proving the widened coverage.

## Out of scope (owned elsewhere — do NOT touch)

- `engine/runners/factory.ts` — **NOT B05.** The collision map row attributes "structured
  agent-sdk error (EH-09)" to B05, but the authoritative traceability lists **EH-09 →
  B07** (and the coverage summary confirms B05 does not own EH-09, B07 does, cross-listed
  with DRY-06). Do not edit `factory.ts`. (B02 did its switch; B07 does EH-09/DRY-06 +
  signatures.)
- `engine/snapshots/store.ts` everything except `writeManifest` — the 5-way SRP split,
  `captureFile`/`buildManifest` dedup (DRY-45), `createSnapshot` dedup, Accept/Reject type
  import → owned by **B10**.
- `engine/snapshots/run.ts` result-type definitions / importing Accept/Reject from core
  (DRY-21) and any file move → **B10**.
- `tree-recorder.ts` stray `!` (lines ~39, ~54) and the `assertNever` switch → **B02**.
- `ipc/replay.ts`, `core/sessions/io.ts`, `core/sessions/tree/io.ts`,
  `core/state/persistence.ts` reader bodies — adopting `readValidatedJson`/`readJsonl`
  there is **B12/B13**. You only build the helpers + adopt in `core/stats/persistence.ts`.
- `engine/providers/pricing.ts` (any concern) → B07/B10.
- `core/state/machine.ts`, `stores/project/config.ts`, `stores/navigation/router.ts`,
  `core/runtime/commands/registry.ts`, `scripts/check-invariants.ts` → other briefs per
  the collision map.
- `engine/codebase/repomap.ts` (EH-17) → B10; `core/runtime/commands/registry.ts` (EH-15)
  → B11; `engine/ipc/protocol.ts` (EH-16) → B03; `engine/mcp/tool/operations.ts` (EH-08)
  → B09. None of these are B05.
- The events schema / `EngineEvent` definitions (B03). For EH-07 and TS-12, change only
  `CostCheckpointPayload` in `core/sessions/tree/entry-types.ts` (a tree payload type, not
  the `EngineEvent` schema) and the `pre_commit` staging logic — do not add new
  `EngineEvent` fields.

## Acceptance criteria

- [ ] Every finding ID above is addressed in the code: EH-01,02,03,04,05,06,07,10,11,12,
  13,14; TS-12; DRY-20,34,60; RU-05.
- [ ] **CRITICAL (EH-01):** `rejectRunSnapshot` and `restoreBaselineFile` call
  `assertPathConfined` before any `hashFile`/`unlink`/`mkdir`/`writeFile`; a manifest with
  a `../` or absolute path makes both `rejectRunSnapshot` (EH-01) and `computeSnapshotDiff`
  (EH-03) throw a `path-confined-*` error and write/delete nothing outside the project dir.
- [ ] `writeSecureFileAsync` exists in `lib/fs.ts` (symlink-guarded, tmp+rename+chmod
  0o600) and is the writer for `writeManifest`, `writeRunLedger`, and
  `saveDetectionCache`. No remaining hand-rolled tmp-write-then-rename in those three.
- [ ] `readValidatedJson` and `readJsonl` exist in `lib/fs.ts` and encode D3 (missing →
  fallback no-warn; corrupt → warn once + fallback; JSONL skips bad lines). `readStats`
  uses `readValidatedJson` and the dead identical-arm `isENOENT` branch is gone.
- [ ] `runCommand`, `spawnWithTimeout`, and `spawnWithStdin` all throw on 127/non-zero
  (D4); `spawnWithTimeout` still resolves (does not throw) on a true timeout. Every caller
  is updated and compiles; `validation.ts:runValidationStep` preserves its 127-skip /
  non-zero-fail semantics via a local try/catch; `availability.ts` and
  `prettier-on-change.ts` produce the same outcome as before through their catch blocks.
- [ ] `lib/git.ts`: every previously-unguarded `simple-git` call is wrapped by `runGit` and
  throws `GitCommandError` with a descriptive intent; `discardChangedFiles` delegates to
  `discardFileChange` (DRY-60); `isTracked`'s boolean-detection catch is preserved + a
  comment justifies it.
- [ ] `CliError` is `class CliError extends Error` with `readonly exitCode`; `isCliError`
  is `instanceof CliError`; all ~40 call sites still compile unchanged; `cli.ts` error
  handler still reads `err.exitCode`.
- [ ] `withTimeout` rejects with `timeoutError.elapsed(ms)` (kind `timeout-elapsed`).
- [ ] `block-secrets` detects via `redactSecretsWithMetadata` (17 rules); the local
  4-pattern array is deleted; widened-coverage test passes.
- [ ] `pre_commit` hooks see the full staged set (EH-07): files are staged before the
  `pre_commit` hook runs and/or the resolved staged list is passed into the hook context;
  no new `EngineEvent` field was added.
- [ ] `CostCheckpointPayload.totalCost` is optional and omitted in the `cost_update`
  recorder (TS-12); no misleading `totalCost: 0`.
- [ ] The empty best-effort catches (EH-11 highlight, EH-14 dispatch parse, EH-14
  tree-recorder ×3) are each justified inline; tree-recorder persistence failures go
  through `warnError`.
- [ ] `unsupportedVersion` message reads "Supported: 1 (migrated), 2 (deprecated), 3"
  (EH-10).
- [ ] No new `!`/broad `as`/`any`/barrels/non-`Error` classes/memoization introduced;
  `.js` extensions on every import; `src/engine/` imports nothing from `react`/`ink`/
  `src/features`/`src/components`/`src/hooks`; no decorative comments (the catch
  justifications are single-line and load-bearing, which is permitted).
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (added/updated where behavior changed).

## Tests

```bash
npm test -- src/lib/fs.test.ts src/lib/git.test.ts src/lib/process/spawn.test.ts \
  src/engine/snapshots/run.test.ts src/engine/snapshots/diff.test.ts \
  src/engine/snapshots/store.test.ts src/core/stats/persistence.test.ts \
  src/engine/orchestrator/validation.test.ts \
  src/engine/hooks/builtins/block-secrets.test.ts src/utils/with-timeout.test.ts \
  src/engine/detection/cache.test.ts src/engine/orchestrator/task

npm run typecheck
npm run lint
```
