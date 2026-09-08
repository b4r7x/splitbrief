# Gates

Validation commands, baseline, narrowing, and the drift check. Loaded in Phase 0 (resolution + baseline) and after every implementer attempt. Mirrors the SPLITBRIEF CLI (`src/engine/orchestrator/validation/`, `src/engine/orchestrator/drift/`).

## Resolution — first match per stage wins

1. A `## Gates` (or `Validation`) section in the task file itself — a sprint brief or a spec that names its own scoped test, typecheck, and lint commands — then the project's instruction files (CLAUDE.md, AGENTS.md, .cursor/rules, copilot-instructions) naming a typecheck / lint / test command. Source: `task-file` / `instructions`.
2. Manifest scripts: `package.json` scripts named `typecheck`, `lint`, `test` (also `check`, `format:check`); `Makefile` / `justfile` targets with those names; `pyproject.toml` tool sections (pytest, ruff, mypy); `Cargo.toml`; `go.mod`.
3. CI workflow steps: `run:` lines in `.github/workflows/*.yml` that call a test, lint, or type tool.
4. Language defaults (table below).
5. None → the stage is skipped; the plan block prints `lint: none`.

Record every stage as `<stage>: \`<command>\` (<source>)` with source one of `instructions`, `manifest`, `ci`, `default`, or `none` — the same form the plan block prints. Run everything from the project root.

## Language defaults

| Language (marker) | typecheck | lint | test | test file pattern |
|---|---|---|---|---|
| TypeScript (`tsconfig.json`) | `npx tsc --noEmit` | the configured linter only (`biome check .` / `eslint .` when its config exists) | `npm test` | `<name>.test.ts`, `<name>.spec.ts` |
| JavaScript (`package.json`, no tsconfig) | none | configured linter only | `npm test` | `<name>.test.js` |
| Python (`pyproject.toml`, `requirements*.txt`) | none | none | `pytest` | `test_<name>.py` |
| Go (`go.mod`) | `go vet ./...` | none | `go test ./...` | `<name>_test.go` |
| Rust (`Cargo.toml`) | `cargo check` | `cargo clippy --no-deps` | `cargo test` | `<name>_test.rs` and `#[cfg(test)]` in the file |

## Order, short-circuit, capture

typecheck → lint → test. Stop at the first failing stage; later stages are recorded `not run`. Capture typecheck and lint as their first 40 lines, test as its LAST 40 lines (runners print the pass/fail summary last). Append to `validation.md` under `## T00N — attempt N` with each command on its own line above its fenced output.

## Narrowing (test stage only)

When the test command's source is `default`, run it against the brief's affected test file only: `<file>.test.<ext>`, `<file>.spec.<ext>`, or `tests/**/<basename>*` (npm: `npm test -- <path>`; pytest/go/cargo: their path or `-run` filter). None found → skip the stage with `no affected test file found`. Commands from instructions, manifest, or CI run whole.

## Baseline

Before any spawn, run every resolved stage once and record the result in `plan.md` (`baseline: typecheck PASS · lint PASS · test FAIL (3 failed)`). A baseline failure is not the implementer's failure: an attempt fails only on a NEW error or a NEW failing test; the same failure set is `PASS (no new failures)`. A stage that cannot run at all (tool missing, script misdeclared) is a blocker: fix the tooling with at most 2 attempts and record `unblocked: <what>`; otherwise mark it `UNAVAILABLE — <reason>` and continue with the remaining stages. Under `--ask`, present the fix and wait (skipped with `--yes`).

## Drift check (after every attempt)

1. Current set = `git status --porcelain --untracked-files=all` paths (a rename contributes both paths; without `--untracked-files=all` a new directory collapses into one line and hides the files inside it) minus the baseline set recorded in `baseline-tree.txt` minus every path under `.splitbrief/` (the run dir, the logs, and the `current-run` pointer are orchestration, never drift).
2. Allowed set = the brief's `file` + every path bullet under `**Approved out of bounds:**` + the `file` of every brief already `done` in this run.
3. Drift = current − allowed. Every attempt gets a `## T00N — attempt N` entry in `drift.md`: one path per line when there is drift, or `none (changed: <files> — owned by <briefs>)` when there is not. Any path entry fails the attempt; the retry error is `Revert your changes to <path>; only <brief file> may change` per entry.
4. Only path bullets are matched (they contain `/`, `*`, or a file extension). Prose bullets under Out of bounds are reviewer guidance.
5. Without git: `touch baseline-tree.txt` in Phase 0 — its mtime is the anchor — and the current set is `find . -type f -not -path './.splitbrief/*' -newer <run dir>/baseline-tree.txt`; the plan block prints `drift: mtime (no git)`.
6. `splitbrief-review` on a run dir that has a `baseline-tree.txt` subtracts it the same way, so a tree that was already dirty before the run is neither drift nor part of the reviewed diff.

## Recorded Validation Output

The review packet's `## Recorded Validation Output` is the final attempt's captured output per brief, verbatim, with the command line above each block. It is the only source a reviewer may quote for a test, typecheck, or lint claim.
