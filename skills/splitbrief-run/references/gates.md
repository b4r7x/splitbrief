# Gates

Validation belongs to the session. Run it after every task and before every review.
Resolve commands from the current engine contracts. Never accept the implementer's claim as recorded evidence.

## Resolution, first match per stage

1. Config overrides from `.splitbrief/config.yaml`.
2. Project manifest scripts.
3. Planner discovery from instructions, the task, CI and existing tooling.
4. Stack defaults from the registry below.
5. No command → record the stage as skipped.

Record each command and source in plan.json and the plan block. Run commands from the project root.

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

For a new run, create `.splitbrief/runs/<YYYY-MM-DD>-<HHmmss>-<slug>/`; append a suffix on collision.
Write its path to `.splitbrief/current-run`. Record whether `.splitbrief/` is ignored.
Save baseline hashes and bytes before any dispatch. Preserve pre-existing edits.
For a saved run or failed review, retain the original baseline and its validation results.
Run resolved stages once before execution. Record commands, output, exits and failure sets.
An unchanged baseline failure is not a new implementer failure. Record it explicitly; it proves no criterion by itself.
New failures still fail the attempt, including failures in files outside the suggestions.
A stage that cannot run is unavailable, with its reason. A required unavailable check blocks review pass.
Ask the planner to repair defective tooling through a task. Keep the requirement that the command verifies.
Apply the approval options in references/family-map.md before ordinary tooling repairs.
Never install packages or write git state as a tooling repair.

## Baseline fingerprints

<!-- generated: baseline-rule -->
- Fingerprint `sha256`, one line per file in `baseline-sha.txt`.
- Before the first spawn, record one `sha256 <path>` line per file in `baseline-sha.txt`. A path is changed when its hash differs from its baseline line or when it has no baseline line; a file already dirty at run start is reported changed once a brief modifies it.
<!-- /generated -->

Use `git status --porcelain --untracked-files=all` to list candidate paths. A rename contributes both paths.
Compare fingerprints to find this run's changes, including changes to initially dirty files.
Save baseline bytes under baseline/ as well as hashes. Hashes alone cannot reconstruct the run diff.
Exclude run artifacts from the changed set. Preserve the original baseline through resume and fix cycles.

## Suggested files and protected operations

<!-- generated: suggested-files -->
- Suggested files are guidance. Edit another ordinary project file when needed; name it with a reason in touchedNotSuggested.
- Protected writes always need user confirmation: dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`.
- Only an explicit user approval confirms a path and operation. A task request alone grants no confirmation.
<!-- /generated -->

Write each task's actual changed paths to touched-files.md. Record touchedNotSuggested entries with reasons.
Run affected tests for every changed ordinary file. Do not reject or roll back an attempt for editing an unplanned file.
Confirm protected operations independently of --ask and --yes. Record confirmation by path and operation for the run.
The confirmation holds for the same path and operation for the rest of the run.
The session's run artifacts are orchestration writes. The implementer never edits `.splitbrief`.

## Checks and boundaries

Register each check with id, kind, value and required in plan.json.
Resolve criterion checkIds from the run and task registries. Reject unknown or empty verification selections.
For test checks, run the named test file or pattern. For cmd checks, run the registered command under project policy.
Allow no package installs, git writes, protected mutations without confirmation, or commands outside the workspace.
Render checks are unavailable in these skills. Keep a required render criterion unverified.
Run typecheck, lint, affected tests and task checks after every task.
Run the full suite at each planner-declared batch boundary. Triage failure into appended fix tasks with new ids.
Run the full suite and all required checks before every review.
Log check ids, commands, output, exits and artifact paths in validation.md.
Re-run checks when the candidate changes. Earlier green output cannot verify changed code.

## Recorded validation output

The packet's Recorded Validation Output carries current full-suite and required-check output, with commands and check ids.
Include final task-attempt validation as context. Quote recorded output for all test, typecheck and lint claims.
A generic green stage never proves an unrelated criterion. Missing required evidence keeps that criterion unverified.
