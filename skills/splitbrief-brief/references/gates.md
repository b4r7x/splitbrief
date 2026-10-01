# Gates

Validation commands, baseline, narrowing, and the drift check. Loaded in Phase 0 (resolution + baseline) and after every implementer attempt. Mirrors the SPLITBRIEF CLI (`src/engine/orchestrator/validation/`, `src/engine/orchestrator/drift/`).

## Resolution — first match per stage wins

1. A `## Gates` (or `Validation`) section in the task file itself — a sprint brief or a spec that names its own scoped test, typecheck, and lint commands — then the project's instruction files (CLAUDE.md, AGENTS.md, .cursor/rules, copilot-instructions) naming a typecheck / lint / test command. Source: `task-file` / `instructions`.
2. Manifest scripts: `package.json` scripts named `typecheck`, `lint`, `test` (also `check`, `format:check`); `Makefile` / `justfile` targets with those names; `pyproject.toml` tool sections (pytest, ruff, mypy); `Cargo.toml`; `go.mod`.
3. CI workflow steps: `run:` lines in `.github/workflows/*.yml` that call a test, lint, or type tool.
4. Language defaults (table below).
5. None → the stage is skipped; the plan block prints `lint: none`.

Record every stage as `<stage>: \`<command>\` (<source>)` with source one of `instructions`, `manifest`, `ci`, `default`, or `none` — the same form the plan block prints. Run everything from the project root.

## Order, short-circuit, capture

<!-- generated: gate-rules -->
- Order: typecheck → lint → test. Stop at the first failing stage; every later stage is recorded `not run`.
- Capture at most 4096 characters per stage, and keep the test stage's LAST 40 lines — runners print the pass/fail summary last.
- Narrowing kinds: `path-arg`, `package-arg`, `name-filter`, `none`.
<!-- /generated -->

Append every stage to `validation.md` under `## T00N — attempt N` with each command on its own line above its fenced output.

## Language defaults and narrowing

<!-- generated: gates -->
| Language (marker) | typecheck | lint | test | test files |
|---|---|---|---|---|
| rust (`Cargo.toml`) | `cargo check` | `cargo clippy --no-deps` | `cargo test` | inline `#\[cfg\(test\)\]` |
| go (`go.mod`) | `go vet ./...` | `golangci-lint run` | `go test ./...` | `*_test.go` |
| python (`pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile`) | `mypy .` | `ruff check .` | `uv run pytest` | `test_*.py`, `*_test.py` |
| typescript (`tsconfig.json`) | `npx tsc --noEmit` | `npx biome check .` | `npm test` | `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `__tests__/*.ts` |
| javascript (`package.json`) | none | `npx biome check .` | `npm test` | `*.test.js`, `*.spec.js`, `*.test.mjs` |

A stage whose command resolves to nothing is skipped. The columns show the default with the language's own tooling present; the resolution order above still wins over them.

The test stage runs only the tests affected by the brief's files and by every file the attempt changed when the resolved command comes from the stack default, or from the manifest with a recognised stack; a command pinned in config runs unnarrowed.

| Language | test narrowing | allowed commands |
|---|---|---|
| rust | name-filter (`--`) | `cargo` |
| go | package-arg | `go` `golangci-lint` `staticcheck` |
| python | path-arg | `pytest` `mypy` `ruff` `flake8` `pyright` `uv` `poetry` `python` |
| typescript | path-arg (after `--`) | `npm` `npx` `node` `tsc` `vitest` `jest` `eslint` `prettier` `biome` |
| javascript | path-arg (after `--`) | `npm` `npx` `node` `vitest` `jest` `eslint` `prettier` `biome` |
<!-- /generated -->

## Baseline

Before any spawn, run every resolved stage once and record the result in `plan.md` (`baseline: typecheck PASS · lint PASS · test FAIL (3 failed)`). A baseline failure is not the implementer's failure, and the comparison is by failure set, not by stage colour: a stage red at baseline exempts the attempt only when the set of (file, message-line) failures after the attempt is a subset of the baseline set. The same set is `PASS (no new failures)`; a new failure in a file the brief never touched fails the stage. A stage that cannot run at all (tool missing, script misdeclared) is a blocker: fix the tooling with at most 2 attempts and record `unblocked: <what>`; otherwise mark it `UNAVAILABLE — <reason>` and continue with the remaining stages. Under `--ask`, present the fix and wait (skipped with `--yes`).

## Baseline fingerprints

<!-- generated: baseline-rule -->
- Fingerprint `sha256`, one line per file in `baseline-sha.txt`.
- Before the first spawn, record one `sha256 <path>` line per file in `baseline-sha.txt`. A path is changed when its hash differs from its baseline line or when it has no baseline line; a file already dirty at run start is reported changed once a brief modifies it.
<!-- /generated -->

In a git repo `git status --porcelain --untracked-files=all` lists the candidate paths cheaply (a rename contributes both paths; without `--untracked-files=all` a new directory collapses into one line and hides the files inside it); the fingerprints, not git, decide. `splitbrief-review` on a run dir that has a `baseline-sha.txt` reads it the same way, so a tree that was already dirty before the run is neither drift nor part of the reviewed diff.

## Drift check (after every attempt)

<!-- generated: scope-rule -->
- Suggested set = the brief's `files` + every path under **In bounds** and **Approved out of bounds** + the `files` of every brief already `done`. It is guidance: the implementer may edit another ordinary project file when the change needs it, and names it with the reason
- Touched, not suggested = the changed set minus the baseline set minus the suggested set, with the run directory excluded. Each such path is recorded for the reviewer and its tests run; it never fails the attempt. Only a write to a protected path (dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`) waits for the user to confirm it.
<!-- /generated -->

Every attempt gets a `## T00N — attempt N` entry in `drift.md`: one path per line when there is drift, or `none (changed: <files> — owned by <briefs>)` when there is not. Paths under `.splitbrief/` are never drift — the run dir, the logs and the `current-run` pointer are orchestration. A bullet licenses the paths it names: every backticked token in it, or, with no backticks, every concrete path in its prose — a token counts when it contains `/`, `\` or `*`. So `` `src/x.ts` — the union collapse `` licenses `src/x.ts`; a bullet naming no such token licenses nothing and is reviewer guidance.

## Recorded Validation Output

The review packet's `## Recorded Validation Output` is the final attempt's captured output per brief, verbatim, with the command line above each block. It is the only source a reviewer may quote for a test, typecheck, or lint claim.
