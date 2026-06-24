# Troubleshooting

Symptom-driven guide. Find the line that matches what you see, follow the diagnosis, apply the fix.

Each entry is structured as **Symptom → Likely cause → Fix → Prevention → See also**. Entries are grouped by area; jump to the section that matches the failing surface.

---

## Setup and install

### Symptom: `SyntaxError: Unexpected token` or `engine "node" is incompatible` on `npm install` / `npm run dev`

**Likely cause:** Node version below the required 22.x. diptych is ESM-only and uses `node:` built-ins, top-level `await`, and runtime features that older Node releases do not ship.

**Fix:**
1. Run `node --version` and confirm output starts with `v22.` or higher.
2. If lower, install Node 22 LTS (`nvm install 22 && nvm use 22`, or use `volta`, `fnm`, or your platform package manager).
3. Re-run `npm install` from a clean tree (`rm -rf node_modules package-lock.json && npm install`) so native bindings (better-sqlite3, etc.) re-resolve against the new ABI.
4. Re-run `npm run typecheck` to confirm the toolchain works end-to-end.

**Prevention:** Pin the engine in your shell profile via `nvm`/`fnm`. The `package.json` `engines.node` field already declares the minimum; add a `.nvmrc` if you frequently switch projects.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [CONTRIBUTING.md](../CONTRIBUTING.md).

---

### Symptom: `Cannot find module '...'` or `ERR_MODULE_NOT_FOUND` for an internal import

**Likely cause:** Either dependencies were never installed, or you wrote an import without the mandatory `.js` extension. diptych is ESM-only — Node refuses to resolve extensionless internal imports at runtime.

**Fix:**
1. Run `npm install` if `node_modules/` is missing or `package-lock.json` changed.
2. If the missing module is an internal path (e.g. `./config`), edit the import to include the `.js` extension (`./config.js`), even though the source file is `.ts`. This is required by ESM and enforced across `src/`.
3. Run `npm run typecheck` and `npm run lint` — Biome and `tsc` both flag extensionless imports.

**Prevention:** The CLAUDE.md core conventions require `.js` on every internal import. Configure your editor's TypeScript "auto import" feature to add `.js` automatically (VS Code: `"typescript.preferences.importModuleSpecifierEnding": "js"`).

**See also:** [docs/PRINCIPLES.md](./PRINCIPLES.md), [docs/STRUCTURE.md](./STRUCTURE.md).

---

### Symptom: `EACCES: permission denied, open '.diptych/...'` or config writes silently fail

**Likely cause:** The `.diptych/` directory was created by another user (often `root` after a `sudo` invocation), or sits on a filesystem mounted read-only. diptych writes session state, snapshots, and configuration there continuously.

**Fix:**
1. Inspect ownership: `ls -la .diptych`.
2. If owned by `root` or another account, reclaim it: `sudo chown -R "$USER":"$(id -gn)" .diptych`.
3. Confirm the directory is writable: `touch .diptych/.write-test && rm .diptych/.write-test`.
4. If the filesystem itself is read-only (CI sandbox, Docker volume), run diptych from a writable working directory or fix the mounted workspace permissions.

**Prevention:** Never run diptych under `sudo`. If you accidentally do, immediately `chown` the resulting directory back. CI containers should mount the workspace with read-write permissions for the running user.

**See also:** [docs/BOOTSTRAP.md](./BOOTSTRAP.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `diptych doctor` or `diptych start` says Run Readiness is `blocked`

**Likely cause:** A hard local precondition failed before model calls: invalid or unwritable `.diptych/config.yaml`, not a git repository, an in-progress git operation (merge, rebase, etc.), or a live `.diptych/active` session in the same checkout. `diptych doctor` can also report a missing config because it does not bootstrap setup files.

**Fix:**
1. Read the `Next action` line. It points to `diptych init`, config repair, or cleaning/isolating the repo.
2. For doctor-only missing config warnings, run `diptych init` or `diptych init --reconfigure`.
3. For invalid config, fix `.diptych/config.yaml` and re-run `diptych doctor --json` to verify.
4. For active-session blockers, run `diptych status`, then `diptych resume` or `diptych attach <session-id>` if the run is still live.

**Prevention:** Run `diptych doctor` after changing runner config or before CI starts a headless run.

**See also:** [CLI-REFERENCE.md](./CLI-REFERENCE.md#diptych-doctor), [CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: Run Readiness warns about validation, but tests were not run

**Likely cause:** Readiness is a pre-run posture check, not CI. It inspects `validation.typecheck`, `validation.lint`, `validation.test`, `validation.testCommand`, and obvious package-script availability without executing validation commands.

**Fix:**
1. If checks are disabled intentionally, continue and run your validation manually.
2. If `testCommand` references a missing npm script, add the script or update `.diptych/config.yaml`.
3. To verify the project now, run your real commands directly, such as `npm run typecheck`, `npm run lint`, and `npm test`.

**Prevention:** Keep validation commands cheap and reliable so warnings remain rare.

**See also:** [FEATURES.md](./FEATURES.md#run-readiness--doctor), [WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: Run Readiness warns that the working tree is dirty

**Likely cause:** Files are modified or untracked before Task Briefs exist. Readiness cannot know yet whether those files overlap the future task scope, so ordinary dirty state is a warning rather than a blocker.

**Fix:**
1. Run `git status` and decide whether the local edits should be part of this run.
2. Continue if the edits are intentional and unlikely to overlap.
3. Use `diptych start --worktree <name> "..."` from a clean source checkout when you want isolation.

**Prevention:** Start substantial runs from a clean checkout or a dedicated worktree.

**See also:** [FEATURES.md](./FEATURES.md#diptych-start---worktree-name), [WORKFLOW.md](./WORKFLOW.md).

---

## Cost and billing

### Symptom: Anthropic / OpenAI bill spiked after a single run

**Likely cause:** The planner is configured with an expensive model (commonly Opus) and the implementer uses the same model. Standard and speckit modes call the planner 4 and 6–7 times respectively per task; multiplying that by Opus pricing escalates fast.

**Fix:**
1. Open `.diptych/config.yaml` and inspect `planner.kind` and `planner.model`.
2. Keep Opus for the planner only when you genuinely need its planning quality; for most work Sonnet 4.6 is the better cost/quality point.
3. Switch the implementer to a cheap or local runner: an `api` runner pointed at Ollama / LM Studio, or `cli` with a Haiku-class model.
4. Run `diptych status` to confirm the resolved configuration matches your intent.
5. Set `workflow.maxBudget` so the next runaway is bounded.

**Prevention:** Decouple planner and implementer cost tiers — that asymmetry is the entire point of diptych. Always set `workflow.maxBudget` for production usage.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/ARCHITECTURE.md](./ARCHITECTURE.md), [docs/VISION.md](./VISION.md).

---

### Symptom: Workflow keeps pausing with "budget threshold reached"

**Likely cause:** `workflow.budgetPauseThreshold` (a fraction of `maxBudget`) is set too low for the task at hand, or `maxBudget` is too tight. The orchestrator's budget guard fires whenever the rolling spend crosses the threshold.

**Fix:**
1. Inspect `workflow.maxBudget` and `workflow.budgetPauseThreshold` in `.diptych/config.yaml`.
2. Either raise `maxBudget` (if the task legitimately needs more headroom) or lower `budgetPauseThreshold` (if you want the warning earlier and resume manually each time).
3. If you simply want to silence the pause for one run, pass `--budget <usd>` on the CLI.
4. Inspect `summary.json` after the run for the actual spend distribution and right-size the limits.

**Prevention:** Calibrate budgets against `summary.json` from a few representative runs before locking them down.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), `src/engine/orchestrator/budget/`.

---

### Symptom: Cache hit percentage stuck at 0% in the cost status line

**Likely cause:** The active runner does not surface `cache_read_input_tokens`. CLI runners (`claude-code`, `codex`, `aider`, etc.) often emit aggregate token counts only, with no cache breakdown; the orchestrator reports what it receives.

**Fix:**
1. Confirm runner kind via `diptych status` or `.diptych/config.yaml`.
2. If you require cache visibility, switch the planner / implementer to `kind: api` with Anthropic or to `kind: agent-sdk`. Both expose cache token counts in usage payloads.
3. For CLI runners, accept that the cache % will be `0` (or `n/a`) and rely on the absolute token totals instead.

**Prevention:** Choose `api` or `agent-sdk` runners when cache observability matters for cost analysis.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md), [docs/OTEL.md](./OTEL.md).

---

### Symptom: Pricing column shows `n/a` and totals do not include a USD figure

**Likely cause:** The model identifier returned by the runner is not in the bundled pricing catalog (`src/core/providers/known-models.ts`). diptych refuses to invent prices, so any unknown model defaults to `n/a`.

**Fix:**
1. Check the exact model string in `summary.json` under `runs[].model`.
2. Check whether the provider returns pricing metadata during model discovery; runtime metadata can supply rates for models that are not bundled.
3. If the model is widely used and missing upstream, open a PR adding it to `src/core/providers/known-models.ts`.

**Prevention:** Audit `summary.json` for any `n/a` row after introducing a new model. Treat USD totals as incomplete until pricing comes from models.dev, runtime provider metadata, or `known-models.ts`.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), `src/core/providers/known-models.ts`.

---

## Planner issues

### Symptom: Planner returns vague briefs — generic acceptance criteria, no file references, hand-wavy steps

**Likely cause:** The current workflow mode is too light for the task (`instant` or `quick` skip the iterative refinement passes), or the planner model is undersized for the codebase.

**Fix:**
1. Re-run with a higher mode: `npm run dev -- start --mode standard "..."` or `--mode speckit` for risky / cross-cutting work.
2. Add concrete guidance in the review comment, or rerun with `--mode speckit` when the task needs an explicit clarification/specification pass.
3. Confirm the planner is large enough — Sonnet 4.6 minimum, Opus for unfamiliar codebases.
4. Tune the codebase config (`codebase.tokenBudget`) so the planner sees enough of the codebase to ground its references.

**Prevention:** Default to `standard` mode for ordinary feature work and reserve `instant` / `quick` for trivial edits that genuinely do not need ceremony.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), [docs/REPOMAP.md](./REPOMAP.md).

---

### Symptom: Planner times out before producing a brief

**Likely cause:** There is no default total-call timeout. What you are hitting is the fixed 60-second **stream-idle** guard: an `api`-kind planner aborts when no token (including the first one) arrives for 60s. A cold-loading local model (Ollama/LM Studio pulling a model into memory) easily exceeds that time-to-first-token window. `cli`/`agent-sdk` planners have no built-in cap at all unless you set one.

**Fix:**
1. Warm the model before the run so the first token arrives within 60s — e.g. issue one throwaway request to your local server, or pre-pull the model so it is resident.
2. Set `planner.timeout` (milliseconds) in `.diptych/config.yaml` to put a total wall-clock budget on each planner call (Opus planning passes can take several minutes). This caps the whole call; it does not extend the 60s idle guard.
3. Use `--detach` so the planner runs in the background and the TUI re-attaches when it completes — useful for long invocations.
4. If the planner is genuinely stuck (no token activity), check provider status pages and your network; restart the run.
5. Reduce `codebase.tokenBudget` so the prompt is smaller and the call returns sooner.

**Prevention:** Keep local models warm so time-to-first-token stays under the 60s idle guard, set `planner.timeout` as a total-call ceiling for high-latency planners, and prefer `--detach` for long jobs so terminal disconnects do not interrupt them.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: Planner says "I cannot find the file" or invents file paths

**Likely cause:** The codebase context shipped to the planner is truncated below the relevant file, or `codebase.exclude` patterns are filtering it out.

**Fix:**
1. Inspect the repo-map produced for the run (`.diptych/sessions/<session>/planner-input.json` or equivalent under the session directory).
2. Increase `codebase.tokenBudget` so the relevant tree is included.
3. Trim `codebase.exclude` if a glob is hiding the directory you need (common: `dist/`, `**/*.test.ts`).
4. Use `codebase.include` to pin specific paths that must always appear regardless of token budget.

**Prevention:** When onboarding a new repo, run a single `start` and inspect the repo-map size; tune limits so the planner-relevant code fits.

**See also:** [docs/REPOMAP.md](./REPOMAP.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: Briefs lack file references, tests, or constraints — quality gate complains

**Likely cause:** The brief quality gate is rejecting the planner's draft because required fields are empty. Smaller planners often skip these in initial passes.

**Fix:**
1. Read the gate's rejection message — it lists the missing sections.
2. Bump the planner model up a tier; Sonnet handles the contract reliably, smaller models often do not.
3. Switch to `--mode speckit` so the planner runs the iterative refinement passes that backfill missing sections.
4. If a specific section is consistently missing, use `/revise-spec <comment>` or `/revise-plan <comment>` to force a targeted regeneration.

**Prevention:** Treat the brief quality gate output as a smoke test for planner model fitness — repeated rejections mean the model is too small.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

## Implementer issues

### Symptom: Implementer modified files outside the brief's declared scope

**Likely cause:** The model wandered. Drift detection should flag it during the final-review phase, but if you see drift only after merging it means the report was ignored or the brief scope strings were too broad or too short.

**Fix:**
1. Inspect `.diptych/sessions/<id>/drift-report.json` for in-bounds and out-of-bounds touched paths.
2. If the changes are legitimate (the brief was incomplete), add the paths to `scope.approvedOutOfBounds` in the brief and re-run the final review.
3. If the changes are wrong, revert via the snapshot system: `diptych snapshot restore <snapshot-id>`.
4. For repeat offenders, raise the implementer model or tighten the brief's scope language.

**Prevention:** Always check the drift report before accepting a task or making any manual commit. Treat unexpected out-of-bounds files as a planning bug, not implementation noise.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Implementer keeps failing the same task in a loop

**Likely cause:** The task is genuinely too hard for the implementer model, or the brief contains contradictory constraints. The orchestrator escalates after a configured retry count, but until escalation kicks in you see the same failure repeat.

**Fix:**
1. Watch the escalation counter in the TUI status line — escalation triggers automatically after N retries.
2. Inspect `evidence.json` and the task log to see whether failures are typecheck, test, or runtime.
3. If escalation triggered and produced no improvement, manually edit the brief: tighten scope, split into subtasks, or pin the implementer to a stronger model for that task only.
4. As a last resort, mark the task `skipped` and re-plan with `--mode speckit`.

**Prevention:** Configure `workflow.maxRetries` and `escalation.intermediateProvider` + `escalation.intermediateModel` so escalation lands on a model strictly stronger than the default.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/task/loop.ts`.

---

### Symptom: Implementer ignores constraints listed in the brief

**Likely cause:** The implementer model is too small to follow long constraint lists. Tiny models drop instructions silently.

**Fix:**
1. Switch the implementer to Sonnet 4.6 or Haiku 4.5 — both follow constraint blocks reliably.
2. If you must use a smaller model, split the brief into smaller tasks with fewer constraints each.
3. Add a final-review step that explicitly checks each constraint as a yes/no question; failures roll the task back.

**Prevention:** Match implementer capability to brief complexity. Keep constraint lists short (under ~7 items) for sub-Sonnet models.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md).

---

### Symptom: Code does not typecheck after a task; workflow blocked

**Likely cause:** The validation step (typecheck / lint / test) ran against the implementer's output and failed. The orchestrator refuses to advance the task until validation passes. If optional product-level commits are enabled, those are blocked too.

**Fix:**
1. Open `evidence.json` for the task; the `validation` section lists the exact failing command and stderr.
2. If the failure is a real implementation bug, retry the task — the implementer sees the previous failure as feedback.
3. If validation is misconfigured (wrong command, missing dependency), fix the `validation` block in `.diptych/config.yaml` (`validation.typecheck`, `validation.lint`, `validation.test`, `validation.testCommand`) and re-run.
4. As a last resort, set `validation.typecheck: false` / `validation.lint: false` / `validation.test: false` in config to disable the failing check while you debug — you are then responsible for running the check manually.

**Prevention:** Keep `validation.testCommand` minimal but reliable: at least `npm run typecheck`. Slow test suites should not block per-task validation; move them to CI.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

## Workflow issues

### Symptom: a session is reported active but nothing is running

**Likely cause:** Each session writes a per-session lockfile at `.diptych/sessions/<id>/lockfile.json` that records the PID, heartbeat, and exit marker. If `.diptych/active` still points at a non-terminal `state.json`, older versions could treat that pointer as live even when the lockfile already had `exitedAt`.

**Fix:**
1. Run `diptych ps` to list known sessions; it reads each lockfile, checks whether the PID is alive, and marks stale entries as `crashed` or exited.
2. Run `diptych start ...` again. Current versions clear `.diptych/active` automatically when the active lockfile has exited or the PID is gone.
3. If you want to resume that interrupted session instead of starting fresh, run `diptych continue <session-id>`.
4. If the lock is fresh and a real process is alive, you have a genuine concurrent session. Attach to that one rather than starting another.

**Prevention:** Prefer clean TUI cancellation or `diptych continue` for interrupted work. For long-running jobs, use `--detach` so the server survives terminal closure and exits cleanly.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: Workflow stalls indefinitely at an approval gate

**Likely cause:** The TUI is waiting for input but the input mode is wrong, or a non-interactive run reached an approval gate that needs a response.

**Fix:**
1. In the TUI, focus the composer (Tab if focus is elsewhere) and submit `approve` / `comment ...` / `reject`.
2. If you ran with `--json`, the NDJSON stream cannot accept replies. Workflow review gates are auto-approved in headless JSON mode; file-write tiered approvals fail closed with `APPROVAL_REQUIRED` unless their tiers allow the write. Use `--rpc` from the start when a client needs to answer approvals programmatically, or resume with `diptych continue --rpc <session-id>` when the session is resumable. For unattended runs, use `--mode quick` or configure approval tiers so file writes do not prompt.
3. Check `workflow.approve` in config; `workflow.approve: none` skips the spec and plan approval gates but not the standard/speckit brief-review gate, `workflow.approve: spec` (default) blocks only on the spec, `workflow.approve: all` blocks on both spec and plan. For file-write tiered approval, see the `approval.tiers` config block.

**Prevention:** Decide up front whether a run is interactive, `--json`, or `--rpc`; configure approval policy to match.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

---

### Symptom: Brief review keeps showing the same brief after I requested changes

**Likely cause:** The comment-driven regen path was not triggered — usually because the comment was attached to the wrong artifact or the planner returned the same content unchanged (cache hit, identical prompt).

**Fix:**
1. Confirm the comment was attached to the brief (not the spec) and that you submitted `comment "<text>"` rather than `approve`.
2. Inspect `planner.review` activity in the session log; it should record a new planner call after your comment.
3. If the planner returned identical output, your comment may have been too vague — restate it as a concrete, falsifiable change.
4. As a workaround, use `/revise-spec <comment>` or `/revise-plan <comment>` to force a clearer regeneration prompt.

**Prevention:** Write review comments as imperatives ("rename `foo` to `bar`", "remove constraint about X"), not impressions ("seems off").

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md).

---

## Approval gates

### Symptom: `APPROVAL_REQUIRED` (headless run paused, or stuck on a sticky/confirm tier)

**Likely cause:** A `--json` run hit a file-write tiered approval that has no reply channel; an RPC client did not answer the prompt; or an interactive run has `approval.headless: true` set, which forces fail-closed on any tier that would ordinarily prompt.

**Fix:**
1. If the session is resumable, continue it with an interactive TUI (`diptych continue <session-id>`) or RPC (`diptych continue --rpc <session-id>`).
2. Or set the offending file-write tier to `auto` in `.diptych/config.yaml` under `approval.tiers.<class>: auto`.
3. For CI runs that should never prompt, make sure every tier is set to `auto` (or remove the `approval` block entirely for fully non-interactive runs). Set `approval.headless: true` only when you want fail-closed behaviour on unexpected prompts.

**Prevention:** Audit `approval.tiers` before running `--json` or unattended RPC. Any tier left at `sticky` or `confirm` can require an approval response.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval, [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `invalid_confirm_phrase` — confirm tier rejected my input

**Likely cause:** The `confirm` tier requires typing the literal string `I confirm` (capital I, space, lowercase confirm) followed by a non-empty reason. Any deviation — wrong case, extra space, empty reason — results in rejection.

**Fix:**
1. When the confirm prompt appears, type exactly: `I confirm` (no quotes) and press Enter.
2. On the next step, enter a non-empty reason string and press Enter.
3. Pressing Escape at either step cancels (denies) the action — not an error, just a cancel.

**Prevention:** The phrase is always displayed in the prompt. Read it before typing.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval.tiers.

---

## Snapshots

### Symptom: `snapshot create` fails with "lock held"

**Likely cause:** Another diptych process — or a previous run that crashed — is holding the snapshot lock. The lock is considered stale after 60 seconds.

**Fix:**
1. Wait 60 seconds and retry; stale locks expire automatically.
2. If a real concurrent operation is running, finish it first (or attach with `diptych attach` to see what it is doing).
3. If no other process exists and the lock is older than 60s, remove it manually: `rm .diptych/sessions/<session-id>/snapshots/.lock`.
4. Re-run the snapshot operation.

**Prevention:** Avoid running multiple `diptych start` invocations against the same workspace simultaneously — use worktrees instead.

**See also:** [docs/WORKTREES.md](./WORKTREES.md), `src/engine/snapshots/` (lock implementation).

---

### Symptom: `snapshot restore` reports conflicts on every file

**Likely cause:** You modified the working tree after the snapshot was taken; restore refuses to overwrite divergent changes by default.

**Fix:**
1. Stash or commit your local changes first if you want to keep them: `git stash`.
2. Re-run restore; it should now apply cleanly.
3. If you want to discard local changes outright, restore with `--force`.
4. If only some files conflict, restore with `--force` only when you intend to overwrite all conflicted files. Selective restore is not currently exposed by the CLI.

**Prevention:** Snapshot before risky implementer runs, restore promptly, and avoid manual edits in the meantime.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `.diptych/snapshots/` directory grows to many gigabytes

**Likely cause:** The baseline + delta snapshot scheme keeps a full baseline plus per-task deltas; long sessions touching large files (build outputs, lockfiles, generated assets) accumulate quickly.

**Fix:**
1. The snapshot system always excludes `.git`, `.diptych`, `node_modules`, and `.trees`; for additional paths, add them to `.gitignore` so the snapshot walker skips them automatically.
2. For terminal cleanup, archive the session and delete its snapshot directory: `rm -rf .diptych/sessions/<session-id>/snapshots`.

**Prevention:** Keep build outputs and lockfiles in `.gitignore` — the snapshot walker respects it. Delete old session snapshot directories after you no longer need restore points.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/INVARIANTS.md](./INVARIANTS.md).

---

## Drift

### Symptom: Drift report flags files I never touched

**Likely cause:** Drift matching uses substring comparison against the brief's declared paths; loose globs and short tokens produce false positives.

**Fix:**
1. Inspect `.diptych/sessions/<id>/drift-report.json` and confirm whether the file was actually modified (run `git diff` against the pre-task snapshot).
2. If the match is spurious, tighten the brief's scope strings (use full paths, not bare filenames).
3. If the file is intentionally out of scope, add it to `scope.approvedOutOfBounds` in the brief.
4. For repeat offenders, tighten future brief scope strings or add intentional shared files to `approvedOutOfBounds`.

**Prevention:** Write brief scope sections with full project-relative paths (`src/engine/orchestrator/run/workflow.ts`), never bare names (`workflow.ts`).

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Chain-drift detection flags every task

**Likely cause:** `workflow.driftChainThreshold` is set too low for your codebase — small overlaps in touched files trip the chain heuristic. If unset, the chain threshold defaults to `0.6`; there is no config-level off switch.

**Fix:**
1. Inspect `.diptych/sessions/<id>/drift-chains.json`; `summary.json.chainDriftSummary` is only the aggregate/top emitted chain summary.
2. Raise `workflow.driftChainThreshold` in config (try 0.75 or 0.85) until only meaningful chains trip it.
3. Set it to `1.0` to make emissions least likely, or add a real disable flag before documenting off semantics.

**Prevention:** Tune the threshold against a representative session before relying on it as a gate.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Edits to `drift.ts` do not change behavior

**Likely cause:** Drift logic exists at two layers. Per-task chain analysis runs from `src/engine/orchestrator/task/step.ts` through `src/engine/orchestrator/drift/chain.ts` and persists to `drift-chains.json`. The final deterministic drift report runs from `src/engine/orchestrator/final-review.ts` through `src/engine/orchestrator/drift/analyze.ts`, persists to `drift-report.json`, and is summarized in `summary.json`.

**Fix:**
1. For repeated off-scope edits across tasks, inspect `drift-chains.json` and `src/engine/orchestrator/drift/chain.ts`.
2. For final review drift findings, inspect `drift-report.json` and `src/engine/orchestrator/drift/analyze.ts`.
3. Use `summary.json` only for the aggregate drift summary.
4. Edit the correct file, re-run, and re-verify in `drift-chains.json`, `drift-report.json`, or the drift summary in `summary.json`.

**Prevention:** Before editing drift code, grep for the symptom string in both files and confirm which one emits it.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md), `src/engine/orchestrator/`.

---

## Handoff

### Symptom: Handoff pack missing `manifest.json`

**Likely cause:** `writeHandoffPack()` generates `manifest.json` after rendering. If the manifest is missing, handoff failed before `writeManifest()` completed.

**Fix:**
1. Inspect the command error output, selected output path, renderer path safety checks, and renderer load result.
2. Re-run the planner pass that produces brief 04.
3. If you wrote a custom renderer, verify it reads from the brief-hash-versioning output rather than older artifacts.
4. Re-run handoff: `diptych handoff <target>`.

**Prevention:** Treat handoff renderers as downstream consumers — never run handoff before all prerequisite briefs have completed.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md).

---

### Symptom: Custom handoff renderer is not picked up

**Likely cause:** The renderer file does not export a default function, has the wrong file extension, or cannot be loaded by the current runtime. Handoff loads only runtime-loadable `.ts` and `.js` files exporting a default function.

**Fix:**
1. For `.js`, ensure the file exports `export default function render(input) { ... }` (or async).
2. For `.ts`, type the function with `RendererFunction` or annotate `input` and return; `.ts` also needs runtime loader support.
3. Place the file at `.diptych/handoff-renderers/<target>.ts` (or `.js`). The loader scans that directory automatically — there is no `handoff.renderersDir` config field.
4. Re-run `diptych handoff <target> --allow-custom-renderer`, or set `trust.customRenderers: true` in `.diptych/config.yaml`. Loader errors report the import or default-export failure reason. Unknown-target errors include the target name.

**Prevention:** Copy from a known-good renderer template when starting a new one rather than writing from scratch.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `Handoff target not recognized: <name>`

**Likely cause:** The target is neither in the built-in `HANDOFF_TARGETS` list nor mapped to a custom renderer.

**Fix:**
1. Run `diptych handoff --list` to enumerate known targets.
2. If the name is a typo, correct it.
3. If you want a new target, add a runtime-loadable custom renderer at `.diptych/handoff-renderers/<target>.ts` or `.js` — `diptych handoff --list` can discover it without trusting it.
4. Execute it with `diptych handoff <target> --allow-custom-renderer`, or set `trust.customRenderers: true` in config.

**Prevention:** Define custom renderers as soon as you adopt a new downstream consumer, and document the available targets in your team handbook.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/handoff/`.

---

## MCP server

Diptych MCP exposes read-only session resources and five constrained evidence tools. The tools only update `.diptych/sessions/<id>/evidence.json` for existing sessions/tasks; they do not write project files, run shells, or dispatch implementers. General tool calls remain inside the configured planner or implementer runner.

### Symptom: `diptych mcp serve` exits immediately or refuses to bind

**Likely cause:** The default port is in use, or there is no active session for the server to attach to.

**Fix:**
1. Pass `--port <n>` with a free port (default may be occupied by another diptych or unrelated service).
2. Pass `--session <id>` explicitly — `diptych mcp serve` attaches to a specific session, not "the current workspace".
3. Confirm the session exists with `diptych ps`.
4. Check that no other `diptych mcp serve` is running for the same session: `pgrep -fa 'diptych mcp serve'`.

**Prevention:** Always pass `--port` and `--session` explicitly in scripts; never rely on defaults for production usage.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: MCP client reports "auth token rejected"

**Likely cause:** The token is mistyped or stale. `diptych mcp serve` prints a fresh token on startup; clients must use that exact value.

**Fix:**
1. Re-read the startup banner — the token is printed once at server start.
2. Copy it verbatim (no surrounding whitespace, no quotes) into your client config.
3. If you lost the banner, restart the server: `diptych mcp serve --port <p> --session <s>` and capture the new token.
4. Update the client config with the new bearer token.

**Prevention:** Start MCP from a wrapper script that captures the startup banner and writes the generated token into your client config. The token is generated in memory for each server run and is not pinned by environment variable.

**See also:** [docs/API-KEYS.md](./API-KEYS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: Expected MCP resources are missing or empty

**Likely cause:** Resources are synthesized from the served session artifacts. `resources/list` omits missing concrete artifacts; reading a missing concrete resource returns resource-not-found. The virtual `tasks` resource returns an empty JSON array when `tasks.md` is absent. MCP evidence tools can update the evidence ledger, but no MCP tool can create missing planning artifacts.

**Fix:**
1. Confirm session status with `diptych ps`.
2. If the session is still planning, wait for the artifacts to materialize.
3. Use `diptych explain --session <id>` or inspect `.diptych/sessions/<id>/` directly to confirm what exists.
4. If artifacts exist but the MCP server does not expose them, restart `diptych mcp serve` to re-scan.

**Prevention:** Start MCP after the session has produced at least its first brief.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: MCP `Resource not found` (error `-32002`)

**Likely cause:** The resource URI references a session ID or artifact that the running MCP server is not serving. This happens when the session was started after the server, or you referenced the wrong session ID.

**Fix:**
1. Confirm the session ID exists: `diptych ps`.
2. If the session was created after the server started, restart `diptych mcp serve` — the server does not hot-reload new sessions.
3. To serve all sessions known at server startup, use `diptych mcp serve --all-sessions --port 4321`; restart the server to include sessions created later.

**Prevention:** Start or restart the MCP server after all relevant sessions exist.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: MCP HTTP 401 (Bearer token rejected)

**Likely cause:** The token printed in the server startup banner is generated once per server invocation and kept in memory only. It rotates on every restart. A stale token from a previous run will always be rejected.

**Fix:**
1. Re-read the token from the server startup banner: `diptych mcp serve --port 4321` prints `Token: <value>` on start.
2. Copy the token exactly — no surrounding quotes or whitespace.
3. Update your MCP client config with the new token value.

**Prevention:** Keep the terminal that started `diptych mcp serve` visible, or have a wrapper script tee the startup banner to a file before handing the token to your client config.

**See also:** [docs/API-KEYS.md](./API-KEYS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `Port 4321 already in use` (starting `diptych mcp serve`)

**Likely cause:** Another process (a previous `diptych mcp serve`, or an unrelated service) is already bound to port 4321, which is the MCP server's default port.

**Fix:**
1. Pass a different port: `diptych mcp serve --port 4444`.
2. Or find and stop the conflicting process: `lsof -ti:4321 | xargs kill` (macOS/Linux).

**Prevention:** Always pass `--port` explicitly in scripts; do not rely on the default when running multiple MCP servers.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

## Worktrees

### Symptom: Two worktrees collide on a dev server port

**Likely cause:** Worktree isolation is filesystem-only; runtime port allocation is not per-worktree. Both worktrees launch their dev server on the same port and the second one fails to bind.

**Fix:**
1. Override the port per-worktree via env (`PORT=3001 npm run dev`) or per-worktree config file.
2. For full runtime isolation, run each worktree inside its own devcontainer (each container has its own loopback).
3. As a stopgap, only run the dev server in one worktree at a time.

**Prevention:** Set `PORT` from a worktree-local `.env.local` so each worktree picks a distinct port automatically.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: `git worktree remove` refuses with "contains modified or untracked files"

**Likely cause:** The worktree has uncommitted work; git refuses to delete it to avoid data loss.

**Fix:**
1. Run `git status` inside the worktree and decide whether to keep the work.
2. If the changes matter, commit (manually — diptych does not commit for you) or `git stash` them.
3. If the changes are scratch and safe to drop, remove with `--force`: `git worktree remove --force <path>`.
4. Run `git worktree prune` to clean dangling metadata.

**Prevention:** Before removing a worktree, always run `git status` inside it as a sanity check.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: `node_modules` clashes between worktrees (wrong versions, missing bindings)

**Likely cause:** A shared `node_modules/` (via symlink or hoisted install) is reused across worktrees that have diverging `package.json` files.

**Fix:**
1. Run `npm install` inside each worktree so it gets its own `node_modules/`.
2. If disk space is a concern, use a per-worktree install but enable the npm cache (`npm config set cache ~/.npm`) so artifacts are deduplicated at the cache layer.
3. For pnpm users, the content-addressable store gives the same benefit automatically.

**Prevention:** Treat each worktree as a fully independent checkout. Never symlink `node_modules/` across worktrees.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: `Branch diptych/<slug> already exists.`

**Likely cause:** A previous diptych run created that branch and it was never deleted. diptych refuses to overwrite an existing branch when creating a worktree.

**Fix:**
1. If the branch contains work you still want: `git branch -D diptych/<slug>` (or rename it first).
2. Alternatively, pass a different slug: `diptych start --worktree <other-name> "..."`.

**Prevention:** Run `diptych worktree list` and clean up idle branches with `diptych worktree remove <slug> --delete-branch` after merging or abandoning work.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: `Worktree ".trees/<slug>" has a live session <id>.`

**Likely cause:** You tried to remove a worktree that still has an active diptych session.

**Fix:**
1. Attach to the running session and stop it: `diptych attach <id>` then Ctrl-C.
2. Or force-remove once you're certain the session can be discarded: `diptych worktree remove <slug> --force`.

**Prevention:** Always run `diptych ps` before removing a worktree to confirm no session is active inside it.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: `Worktree ".trees/<slug>" has uncommitted changes.`

**Likely cause:** The worktree has local modifications; `diptych worktree remove` refuses by default to avoid accidental data loss.

**Fix:**
1. `cd .trees/<slug>` and either commit or `git stash` your changes.
2. If the changes are disposable: `diptych worktree remove <slug> --force`.

**Prevention:** Treat worktrees as ephemeral; merge or discard changes before removal.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

## Server-client and detach

### Symptom: `diptych attach` exits with "connection refused" or "no such session"

**Likely cause:** The server process died (OOM, terminal closed without `--detach`, host reboot) and the session metadata is now stale.

**Fix:**
1. Run `diptych ps` and confirm the session's PID is alive.
2. If the PID is dead, the run is over; archive the session and start fresh.
3. If the PID is alive but the socket is gone, the IPC layer crashed — continue from saved state with `diptych continue <session>`.
4. Check OS logs for OOM kills if this happens repeatedly.

**Prevention:** Use `--detach` for any long-running session so the server lives independently of the terminal.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: TUI input is dropped or duplicated when multiple clients are attached

**Likely cause:** Single-writer constraint. Only one attached client should send input to a session at a time.

**Fix:**
1. Detach all but one client.
2. For multi-viewer setups, use `diptych status`, `diptych ps`, and the session artifacts instead of extra interactive attach clients.
3. If you need to hand off control between people, the current writer must `detach` before the next one attaches as writer.

**Prevention:** Establish a convention: only one teammate is the active writer per session at any time.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `attach` is slow because the entire event log replays

**Likely cause:** The session's `session.jsonl` has grown large; the client replays from the start to reconstruct UI state.

**Fix:**
1. Use `diptych status` or `diptych ps` to confirm you are attaching to the intended session.
2. For very long sessions, detach and resume from a checkpoint when the workflow reaches a stable boundary.
3. Keep the existing session directory intact; `attach` only accepts `--project` plus the optional session id.

**Prevention:** Keep sessions short — split long-running multi-feature work across multiple sessions rather than one mega-session.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `timeout waiting for server to start` (when using `--detach`)

**Likely cause:** The background server process failed to write its lockfile within the expected window (3 seconds). This can happen if the process itself crashed immediately, if the disk is full, or if there is a port conflict on the IPC socket.

**Fix:**
1. Check `.diptych/sessions/<id>/server.log` for the crash reason.
2. Confirm no port or socket conflict: another `diptych` process may already be using the same IPC socket.
3. Retry `diptych start --detach "..."` — transient startup failures are rare.

**Prevention:** Use `--detach` for long jobs on reliable infrastructure; avoid running multiple diptych instances against the same session directory simultaneously.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: TUI shows `ipc_reconnect_attempt` / `ipc_reconnect_failed` events

**Likely cause:** The IPC client lost its connection to the server and is retrying with exponential backoff (up to 5 attempts). If all attempts fail, an `ipc_reconnect_failed` event fires and the TUI shows the session as disconnected.

**Fix:**
1. If `ipc_reconnect_failed` fires, the server process has most likely crashed — run `diptych attach <id>` to see the post-mortem from `server.log`.
2. If you see reconnect attempts but eventual success, the server hiccuped (GC pause, brief overload) — no action needed.
3. Check OS-level OOM logs if crashes repeat: `dmesg | grep -i kill` (Linux) or Console.app (macOS).

**Prevention:** Run on a machine with enough RAM for your planner model's context window. Prefer `--detach` for long sessions so the server survives terminal disconnects.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

## TUI

### Symptom: TUI layout is broken — overlapping panes, truncated text

**Likely cause:** Terminal width below 60 columns. Ink can render but diptych's layout assumes a minimum width.

**Fix:**
1. Resize the terminal to at least 80 columns (120 recommended).
2. If you are on a tiny window, run without the TUI instead: `diptych start --json "..."` for NDJSON output, or `diptych start --rpc "..."` for an interactive NDJSON protocol.
3. For tmux/screen users, increase the pane width or detach from the multiplexer.

**Prevention:** Default to a wide terminal for diptych sessions, or use `--json`/`--rpc` when working in narrow contexts.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: Snapshot diffs render without colors

**Likely cause:** ANSI color is disabled — either you passed `--no-color`, the `NO_COLOR` env var is set, or the terminal does not advertise color support.

**Fix:**
1. Confirm `echo $NO_COLOR` is empty.
2. Confirm `$TERM` advertises color (`xterm-256color` or similar): `echo $TERM`.
3. Drop `--no-color` from your command if you added it.
4. For pipe / file redirection, color is auto-suppressed by design; run the diff in a color-capable TTY or set `FORCE_COLOR=1` to keep ANSI codes when capturing the output.

**Prevention:** Configure your terminal as a `xterm-256color` (or modern) `$TERM` and leave `NO_COLOR` unset.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: A slash command is not in the command palette

**Likely cause:** The command's `validScreens` does not include the screen you are currently on. Slash commands are scoped per-screen by the catalog.

**Fix:**
1. Inspect the screen indicator in the TUI status bar.
2. Open `src/core/runtime/commands/registry.ts` and check the command's `validScreens` array.
3. Navigate to a screen where the command is valid.
4. If you authored the command, add the missing screen to its `validScreens`.

**Prevention:** When adding a new slash command, list every screen it should be available on — defaulting to too few is more common than too many.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), `src/core/runtime/commands/registry.ts`.

---

### Symptom: `Failed to open editor: …` or `Editor exited with …` (when editing at a review gate)

**Likely cause:** Spec, plan, and brief review edits use the external editor command resolved as `VISUAL`, then `EDITOR`, then `vi`, and then spawn it. The failure is in launching or running that resolved command, not a missing variable:
- The resolved binary is not on `PATH` (e.g. `VISUAL=code` or `EDITOR=code` on a machine without VS Code) — the spawn errors and you get `Failed to open editor: …`.
- The editor exits non-zero or is killed by a signal — you get `Editor exited with status … . Edit cancelled.` or `Failed to open editor: Editor exited with …` depending on the review gate.
- A GUI editor returns immediately without blocking (e.g. `code` without `--wait`), so the edit is treated as cancelled.

**Fix:**
1. Confirm the resolved editor command is installed and on `PATH`. Check `VISUAL` first, then `EDITOR`; if both are empty, diptych uses `vi`.
2. For GUI editors, use the blocking flag so diptych waits for you to save and close: `export VISUAL='code --wait'`.
3. For a one-off run with a known-good editor: `VISUAL=vi diptych start "..."`.

**Prevention:** Point `VISUAL` or `EDITOR` at a terminal editor (`vi`, `nano`) or a GUI editor with its wait flag in your `.bashrc` / `.zshrc`; leaving both unset is fine — diptych uses `vi`.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §Review gates.

---

### Symptom: Cost status line shows blank or `--` instead of token / dollar values

**Likely cause:** The active runner does not emit `cost_update` events; the TUI displays nothing rather than fabricating values.

**Fix:**
1. Confirm the runner kind via `diptych status`. CLI runners often skip cost events.
2. Switch to `kind: api` for USD pricing when the provider/model is priced. `agent-sdk` can report token usage, but it remains unpriced because it is a meta/subscription runner.
3. If you must use a CLI runner and want approximate costs, post-process `summary.json` after the run rather than relying on the live status.

**Prevention:** Use `api` runners when live USD cost feedback matters.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/OTEL.md](./OTEL.md).

---

## Hooks

### Symptom: A user-declared hook fails the workflow

**Likely cause:** The hook command exited non-zero. diptych treats non-zero hook exits as failures and halts the workflow at the hook's gate.

**Fix:**
1. Open `evidence.json` for the affected task; the hook section captures stdout, stderr, and exit code.
2. Reproduce the hook locally with the same inputs to debug.
3. Fix the hook script (or the upstream condition it asserts) and re-run the workflow.
4. If the hook is advisory, change it to exit `0` and emit a warning instead of failing.

**Prevention:** Treat hooks as deterministic and idempotent; test them in isolation before wiring them into the workflow.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: Hook errors with "command not found" even though the binary exists

**Likely cause:** The hook runs in a minimal environment without your interactive shell's `PATH` extensions.

**Fix:**
1. Use the absolute path to the binary in the hook command (`/usr/local/bin/foo` rather than `foo`).
2. Or, set `PATH` explicitly in the hook command: `PATH=$PATH:/usr/local/bin foo args`.
3. Or, configure the hook's `env.PATH` if your hook config supports per-hook env.

**Prevention:** Always use absolute paths in hook commands; never assume the interactive shell's `PATH`.

**See also:** [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

---

## Git operations

### Symptom: `git commit` is blocked when running under diptych

**Likely cause:** This repository's agent workflow blocks staging and commits so the human owner reviews the final diff manually. Product-level `commitStrategy` settings may create checkpoints in user projects, but agents working in this repo must not stage or commit. A pre-tool-use hook (`.claude/hooks/block-git-commits.sh`) enforces the repo rule.

**Fix:**
1. Exit the diptych session.
2. Review the changes (`git status`, `git diff`).
3. If you are the human owner, stage and commit yourself (`git add ...`, `git commit -m "..."`). Agents working in this repository must not stage or commit.
4. If you need diptych to coexist with auto-commit tooling, run the auto-commit step outside this repository's agent session.

**Prevention:** Treat the post-session commit step as a manual review checkpoint, not a chore to automate away.

**See also:** [CLAUDE.md](../CLAUDE.md) ("CRITICAL — NEVER COMMIT, NEVER STAGE"), `.claude/hooks/block-git-commits.sh`.

---

### Symptom: Per-task commit messages have unfamiliar format

**Likely cause:** When commits are eventually made (manually, by you), the recommended convention is to prefix with the task ID so commits map back to briefs. This is a convention, not enforcement.

**Fix:**
1. Use the task ID from the brief as a commit prefix: `git commit -m "T03: rename foo to bar"`.
2. Adjust to your project's convention if you prefer (Conventional Commits, ticket IDs, etc.) — diptych does not enforce a format.
3. Document the convention in your CONTRIBUTING.md so future contributors follow it.

**Prevention:** Agree on a commit convention up front and apply it consistently.

**See also:** [CONTRIBUTING.md](../CONTRIBUTING.md).

---

### Symptom: Want to skip per-task validation

**Likely cause:** Per-task validation is mandatory by design — it is the contract that makes briefs trustworthy. Skipping it weakens the entire workflow.

**Fix:**
1. The closest escape hatch is to set specific validation toggles to `false` in `.diptych/config.yaml` — e.g. `validation.test: false` to drop slow tests, or `validation.lint: false` to skip the linter. There is no `--no-validate` CLI flag.
2. Better: fix the underlying validation failure rather than bypassing it.
3. Better still: relax `validation.testCommand` (e.g. drop slow tests from the per-task check, leave them for CI).

**Prevention:** Treat validation toggles as a temporary debugging tool, not a permanent workflow option. If you find yourself disabling checks routinely, your validation config is wrong.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

## CI and headless

### Symptom: `diptych start --json` output is interleaved with logs

**Likely cause:** Logs go to stderr, JSON goes to stdout. If you captured both streams together, they interleave. Console OTel (`OTEL_TRACES_EXPORTER=console`, `DIPTYCH_OTEL_EXPORTER=console`, or `--otel-exporter console`) also writes spans to stdout and can interleave with `--json`.

**Fix:**
1. Redirect stderr separately: `diptych start --json "feature" 2>diptych.log >diptych.json`.
2. Or, parse line-by-line and reject any line that does not begin with `{`.
3. Do not combine console OTel with NDJSON output; use a non-console provider bootstrap or disable OTel for JSON automation.

**Prevention:** In CI, redirect stdout and stderr to distinct files.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: Headless run exits 0 even though the drift report flagged issues

**Likely cause:** Drift is not a hard failure by design — it is reported, not enforced. The exit code reflects only fatal failures (validation, runner errors).

**Fix:**
1. Inspect `drift-report.json` for per-finding details and `summary.json.driftSummary` for the final deterministic drift aggregate; `evidence.json` only contains the evidence ledger.
2. To gate CI on drift, post-process `summary.json` and exit non-zero from your wrapper script when drift exceeds your threshold.
3. Use `driftSummary.score`, `driftSummary.errorCount`, or `driftSummary.warningCount` as the numeric signal; use `chainDriftSummary.score` only when gating repeated cross-task drift chains.

**Prevention:** Wire drift checks into your CI script explicitly; do not assume diptych will fail the build for you.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Want CI to fail when drift exceeds a threshold

**Likely cause:** No built-in flag enforces a drift threshold; you wire it yourself.

**Fix:**
1. In your CI script, after `diptych start --json ...`, resolve the session id from readiness/session output, `.diptych/active`, or wrapper state, then parse `.diptych/sessions/<id>/summary.json`.
2. Read `driftSummary.score`, `driftSummary.errorCount`, or `driftSummary.warningCount`; use `chainDriftSummary.score` only for chain-drift gating.
3. Exit non-zero from the wrapper if the score exceeds your threshold:
   `node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1])); process.exit((s.driftSummary?.score ?? 0) > 0.7 ? 1 : 0)" .diptych/sessions/<id>/summary.json`.
4. Tune the threshold against representative runs.

**Prevention:** Bake the drift gate into your CI workflow definition so it is uniform across branches.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

## Config and migration

### Symptom: Config rejected with a Zod schema error mentioning `version`

**Likely cause:** Your `.diptych/config.yaml` has an unsupported `version` or an old field shape that cannot be migrated in memory.

**Fix:**
1. Read the error — it states the expected `version` and the field that broke.
2. For supported older shapes, start diptych normally; the loader migrates them in memory and later config writes use the current shape.
3. If the version is unsupported, regenerate from scratch (`diptych init --reconfigure`) and merge your customizations back manually.
4. Keep a copy of the old config under version control in case you need to diff.

**Prevention:** After a version bump, run `diptych doctor` and follow any config warning it reports.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/MIGRATION.md](./MIGRATION.md).

---

### Symptom: A config override (CLI flag, env var) does not take effect

**Likely cause:** Only specific startup options are overrideable. Diptych loads project `.diptych/config.yaml`, applies explicit CLI runner/workflow flags for that invocation, and reads documented environment variables for provider keys, context length, OTel, terminal behavior, and editor selection. It does not load a global config file.

**Fix:**
1. Inspect `.diptych/config.yaml` for persistent values.
2. Check the command line for one-shot overrides such as `--planner`, `--implementer`, `--model`, or `--mode`.
3. Check the documented environment variables in `docs/CONFIGURATION.md`, especially provider API keys and `DIPTYCH_CONTEXT_LENGTH`.

**Prevention:** Put durable settings in `.diptych/config.yaml`. Keep CLI flags for one-off runs and environment variables for secrets or process-level behavior.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/BOOTSTRAP.md](./BOOTSTRAP.md).
