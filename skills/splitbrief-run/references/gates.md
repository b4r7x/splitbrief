# Gates

Validation belongs to the session. At cadence=task the registered checks run after each brief; before each review the reviewer chooses the reviewer checks.
Never accept the implementer's claim as recorded evidence.

## Test check command, first match

A planner `test` check runs one test command, narrowed to its file or pattern. Resolve that command in this order:

1. Config `validation.test_command` from `.splitbrief/config.yaml`.
2. The test script of the project manifest.
3. Planner discovery from instructions, the task, CI and existing tooling.
4. The stack default from the registry below.
5. No command → the test check cannot run. Record it unavailable with its reason.

Record the command and its source in plan.json and the plan block. Run commands from the project root.

## Order, short-circuit, capture

<!-- generated: gate-rules -->
- At workflow.review: task, run the brief checks and the checks of its due criteria after each brief. At workflow.review: end, an ordinary brief runs no check: only a caller that names checks runs them, such as a consult `verify`.
- End-of-run checks are on by default (`validation.end_checks`). With End-of-run checks on, the reviewer makes the plan call before each review. It reads the manifests, scripts, Makefile or justfile, CI configuration and README. It chooses at most 6 reviewer checks (`V1`, `V2`, …), each with a reason. Each reviewer check must verify the change.
- It names the related tests it declines and gives the reason. If it chooses no reviewer check, record its reason. At end cadence, the reviewer checks verify the whole change. A task-cadence review chooses the tests related to the changed files.
- A failed plan call halts the review the same way a failed verdict call does. It is never a pass.
- Run reviewer checks in order, in the run workspace, under the reviewer command policy. It admits any installed program of any language, such as `mvn test`, `bundle exec rspec` or `make check`.
- Refuse shell syntax, an environment prefix, a program run by path (`bin/test`), a shell or wrapper, and inline code. Refuse `npx` without `--no-install`, a download-and-run launcher or a setup command (`npm ci`, `pip install`, `go generate`). Refuse a program that does not verify a change. Refuse a reviewer check whose package script, task file, build wrapper or interpreter script the run changed. Name each refused reviewer check with its reason; a plan or task check is never refused for that. A plan may add a script and check it.
- Stop at the first reviewer check with new failures. Record each later reviewer check as `not run: <id> failed`. Re-run a red reviewer check at the run base with the same command text. A failure also red there is pre-existing. Report it and assign no fix task to it.
- A timeout, or a red with no failure keys, is never pre-existing. Report it as not verified at the run base and send it to the reviewer. Plan checks, task checks and the Apply re-check never re-run at the run base.
- A red required check, or a new or not verified reviewer failure, becomes a pending input. The reviewer addresses every pending input in its review answer and writes the fix tasks. No completed brief reopens. The fix task carries the check id, command, output, file, its own `failureKeys` and all original `redKeys` per check id. Keep every original red key before the base split.
- Keys come from the full process capture. A test row without FAILED or ERROR and a row with warning severity are not failure keys. SPLITBRIEF reads the severity where the tool prints it, not in the message text. An incomplete capture gives one placeholder key. With an incomplete capture, the fix command must pass.
- At either cadence, the brief gate of a fix task runs each carried check once under the same command policy. It makes no base re-run. A red passes only when no carried failure remains. The re-run must still show an original red key that the task does not own. Otherwise, the command must pass.
- A diagnostic key includes its path, position and message. Match exact keys first. Then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. Keys with no file match exactly.
- Every unmatched re-run key counts as another failure. Other failures belong to other fix tasks or the next review. A check with no carried keys, or a re-run with no named failure, must pass its command. Older saved fix tasks without own keys or original red keys still load and must pass their commands.
- The rule covers reviewer, plan and task checks. Each judged re-run gets a fix check verdict row. A green re-run shows that all carried failures are gone. A red without proof shows `your N failures not shown · not proven fixed`. Plan and task checks get only a done row, with no duration. A carried failure that remains fails the gate and retries through its ladder before the next review.
- With End-of-run checks off, no reviewer check runs and one row says so. Plan and task checks still run.
- The next review chooses and runs its reviewer checks again. Log check ids, commands, output, exits and artifact paths in validation.md. Re-run checks when the candidate changes. Earlier green output cannot verify changed code.
- Format the brief changed files with the project formatter after every hand-back. A formatter failure records a warning.
- Display at most 4096 characters per command, and keep the LAST 40 lines of a test command — runners print the pass/fail summary last.
- Narrowing kinds: `path-arg`, `package-arg`, `cargo-target`, `none`.
<!-- /generated -->

Append every check and every reviewer check to `validation.md` under `## T00N — attempt N` or `## Review N`, with each command on its own line above its fenced output.

## Language defaults and narrowing

<!-- generated: gates -->
| Language (marker) | test check command | test files |
|---|---|---|
| rust (`Cargo.toml`) | `cargo test` | `tests/*.rs`, inline `#\[cfg\(test\)\]` |
| go (`go.mod`) | `go test ./...` | `*_test.go` |
| python (`pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile`) | `uv run pytest` | `test_*.py`, `*_test.py` |
| typescript (`tsconfig.json`) | `npm test` | `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `__tests__/*.ts` |
| javascript (`package.json`) | `npm test` | `*.test.js`, `*.spec.js`, `*.test.mjs` |

A test check whose command resolves to nothing cannot run. The column shows the default with the language's own tooling present; the resolution order above still wins over it.

A planner `test` check runs only the tests its file affects when the resolved command comes from the stack default, or from the manifest with a recognised stack; a command pinned in config and a chained `package.json` test script run as written.

| Language | test narrowing | allowed commands |
|---|---|---|
| rust | cargo-target | `cargo` |
| go | package-arg | `go` `golangci-lint` `staticcheck` |
| python | path-arg | `pytest` `mypy` `ruff` `flake8` `pyright` `uv` `poetry` `python` |
| typescript | path-arg (after `--`) | `npm` `npx` `node` `tsc` `vitest` `jest` `eslint` `prettier` `biome` |
| javascript | path-arg (after `--`) | `npm` `npx` `node` `vitest` `jest` `eslint` `prettier` `biome` |
<!-- /generated -->

## Baseline

For a new run, create `.splitbrief/runs/<YYYY-MM-DD>-<HHmmss>-<slug>/`; append a suffix on collision.
Write its path to `.splitbrief/current-run`. Record whether `.splitbrief/` is ignored.
Save baseline hashes and bytes before any dispatch. Preserve pre-existing edits.
For a saved run or failed review, retain the original baseline.
A failure also red on the run base copy is pre-existing, not an implementer failure. Record it explicitly; it proves no criterion by itself.
A new failure is a red at the check or command that finds it, including a failure in a file outside the suggestions.
A check or command that cannot run is unavailable, with its reason. A required unavailable check blocks review pass.
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
At cadence=task, the reviewer's related tests cover every changed ordinary file, or the reviewer names each one it declines. Do not reject or roll back an attempt for editing an unplanned file.
Confirm protected operations independently of --ask and --yes. Record confirmation by path and operation for the run.
The confirmation holds for the same path and operation for the rest of the run.
The session's run artifacts are orchestration writes. The implementer never edits `.splitbrief`.

## Checks and cadence

Register each check with id, kind, value and required in plan.json.
Resolve criterion checkIds from the run and task registries. Reject unknown or empty verification selections.
For test checks, run the named test file or pattern. For cmd checks, run the registered command under project policy.
Allow no package installs, git writes, protected mutations without confirmation, or commands outside the workspace.
Render checks are unavailable in these skills. Keep a required render criterion unverified.
At cadence=task, after each task, run its checks and the due checks. A red required check goes to that task's retry ladder.
At cadence=end, an ordinary task runs no check. Only a caller that names checks runs them, such as a consult `verify`.
A due check is a check of the task, or of a criterion whose serving tasks are all done.
Before the final review, run every registered check. Only required checks decide a red.

## Recorded validation output

The packet's Recorded Validation Output carries the current reviewer-check and required-check output, with commands and ids.
Include final task-attempt check output as context. Quote recorded output for every test, type check, lint or other command claim.
A generic green command never proves an unrelated criterion. Missing required evidence keeps that criterion unverified.
