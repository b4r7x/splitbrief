# Troubleshooting

Symptom-driven guide. Find the line that matches what you see, follow the diagnosis, apply the fix.

Each entry is structured as **Symptom → Likely cause → Fix → Prevention → See also**. Entries are grouped by area; jump to the section that matches the failing surface.

Stable `stateId` and runner `state` values with copyable remediations are indexed under [Run readiness and doctor diagnostics](#run-readiness-and-doctor-diagnostics). Use `splitbrief doctor --json` for automation.

---

## Run readiness and doctor diagnostics

`splitbrief doctor` and the readiness gate on `start` emit the same remediation strings in human output and JSON. During workflow commands, runner subprocess failures normalize to `RunnerOutcome` `state` values in `session.jsonl` with the same copyable remediation pattern.

The two commands share the strings but not the verdict: `doctor` diagnoses and exits `0` on warnings, while `start` fails closed on a configured `kind: cli` runner that is denied admission — no trusted executable identity, a version not proven compatible, or a definitively negative authentication fact (no credential, or the tool answering signed-out). Those refusals land in both transports: start exits `1` with the remediation quoted, before creating a session, instead of aborting mid-run.

Unverified authentication is the one state where the verdict also splits by transport. A credential that exists but no call has proven reports readiness status `unverified` (stateId `auth-unknown`, severity warning), and a headless start (`--json`, `--rpc`, `--detach`) refuses it unless `--allow-unverified-auth` is passed, while an interactive start discloses the unverified state and proceeds. `doctor` on a TTY reports it as a warning and exits `0`; its human output says so in one line — `No trusted readiness identity for <tool>: headless start would be refused; use --allow-unverified-auth or complete verification — interactive start proceeds.` — and `doctor --json` or a non-TTY stdin replays the headless blocker instead. See [CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-doctor).

### `splitbrief doctor --json`

`splitbrief doctor --json` writes one JSON object to stdout (not NDJSON):

```json
{ "type": "readiness_report", "report": { "status": "ready|blocked|warning", "nextAction": { ... }, "checks": [ ... ] } }
```

Each `report.checks[]` entry includes `id`, `severity`, `summary`, `stateId` (or `null`), and `remediation` (or `null`). Section titles from human output are omitted — parsers should use `stateId` and `remediation`, not decorative banners. `start --json` emits the same `readiness_report` shape as its first stdout line, and `start --rpc` emits it inside the first `status` envelope. `resume` re-probes CLI readiness for start gates but emits no `readiness_report`.

```bash
splitbrief doctor --json
```

Exit `0` when ready or ready-with-warnings; exit `1` when blocked (the JSON report is still written first). Full field reference: [CLI-REFERENCE.md](./CLI-REFERENCE.md#json-output-doctor---json).

### Readiness `stateId` index

Prefer these stable identifiers in automation and log correlation. Remediation strings match `src/core/readiness/format.ts`.

| Symptom (what you see) | `stateId` | Copyable remediation |
|---|---|---|
| Configured CLI is not installed or not on `PATH` (`spawn-not-found`, executable was not found). | `missing-binary` | Install the configured CLI, then run `splitbrief doctor` again. |
| Executable identity does not match the trusted fingerprint (untrusted project-bin or stale fingerprint). | `untrusted-path` | Trust the exact CLI executable identity, then run `splitbrief doctor` again. |
| Installed CLI version is outside the tested or qualified range. | `incompatible-version` | Install the tested CLI version, then run `splitbrief doctor` again. |
| Required auth channel is not satisfied in the staged runner environment. | `unauthenticated` | Authenticate the CLI in the staged runner environment, then run `splitbrief doctor` again. |
| Auth probe could not determine login state. | `auth-unknown` | CLI authentication cannot be verified without spending a call: stored credentials prove presence, not a working session. The first real call settles it; if it fails to authenticate, sign in to the CLI again. |
| Provider `apiBase` violates the declared endpoint policy (wrong scheme, origin, or redirect target). | `endpoint-invalid` | Fix the provider endpoint to match its declared policy, then run `splitbrief doctor` again. |
| Environment credential prefix or family does not match the declared provider. | `credential-family-mismatch` | Use a credential that matches the declared provider family, then run `splitbrief doctor` again. |
| CLI or API output protocol error, including a missing terminal result line. | `protocol-failure` | Check the CLI or provider version and output protocol, then run `splitbrief doctor` again. |
| Provider returned quota or rate-limit pressure (for example HTTP 429). | `quota-rate-limit` | Wait for quota or rate limits to reset, reduce request volume, or switch providers, then run `splitbrief doctor` again. |
| Runner configuration contains mutually exclusive CLI arguments. | `conflicting-args` | Remove conflicting runner arguments from the config, then run `splitbrief doctor` again. |

### Runner `state` outcomes (workflow commands)

During `start`, `spec`, `resume`, and other planner/implementer invocations, distinguishable subprocess outcomes use `state` (not readiness `stateId`). Remediation strings match `src/engine/runners/errors.ts`.

| Symptom (what you see) | `state` | Copyable remediation |
|---|---|---|
| CLI stdout, stderr, or protocol event stream exceeded the configured byte or line budget. | `output-budget-breach` | Reduce the requested output or increase the configured output budget. |
| Implementer completed without staging the expected working-tree change. | `no-staged-change` | Make the requested change in the staged project, then retry. |

Other runner outcomes (`spawn-not-found`, `protocol-failure`, `incompatible-version`, `unauthenticated`, and others) overlap readiness families above or are documented in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

### Canonical support documentation

| Topic | Canonical doc |
|---|---|
| Admitted CLI tools, tested versions, readiness probes | [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) |
| Endpoint policy, runner args, conflicting-flag validation | [CONFIGURATION.md](./CONFIGURATION.md) |
| Credential resolution and provider families | [API-KEYS.md](./API-KEYS.md) |
| `doctor --json` fields, exit codes, CLI flag reference | [CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-doctor) |

Parity with runtime output is enforced by `testing/docs/troubleshooting.test.ts`.

---

## Setup and install

### Symptom: `splitbrief requires Node.js 22 or newer`, `SyntaxError: Unexpected token`, or `engine "node" is incompatible`

**Likely cause:** Node version below the required 22.x. SPLITBRIEF is ESM-only and uses `node:` built-ins, top-level `await`, and runtime features that older Node releases do not ship. The CLI checks `process.versions.node` before it parses any argument and refuses with `splitbrief requires Node.js 22 or newer; this process is Node.js <version>.` rather than running and reporting a wrong diagnosis later — on Node 20 the CLI arg-vector preflight truncates its `--help` capture and reports flags the installed binary does support as unsupported.

**Fix:**
1. Run `node --version` and confirm output starts with `v22.` or higher.
2. If lower, install Node 22 LTS (`nvm install 22 && nvm use 22`, or use `volta`, `fnm`, or your platform package manager).
3. Re-run `npm install` from a clean tree (`rm -rf node_modules package-lock.json && npm install`) so native bindings (better-sqlite3, etc.) re-resolve against the new ABI.
4. Re-run `npm run typecheck` to confirm the toolchain works end-to-end.

**Prevention:** Pin the engine in your shell profile via `nvm`/`fnm`. The `package.json` `engines.node` field already declares the minimum; add a `.nvmrc` if you frequently switch projects.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [CONTRIBUTING.md](https://github.com/b4r7x/splitbrief/blob/main/CONTRIBUTING.md).

---

### Symptom: `Cannot find module '...'` or `ERR_MODULE_NOT_FOUND` for an internal import

**Likely cause:** Either dependencies were never installed, or you wrote an import without the mandatory `.js` extension. SPLITBRIEF is ESM-only — Node refuses to resolve extensionless internal imports at runtime.

**Fix:**
1. Run `npm install` if `node_modules/` is missing or `package-lock.json` changed.
2. If the missing module is an internal path (e.g. `./config`), edit the import to include the `.js` extension (`./config.js`), even though the source file is `.ts`. This is required by ESM and enforced across `src/`.
3. Run `npm run typecheck` and `npm run lint` — Biome and `tsc` both flag extensionless imports.

**Prevention:** The CLAUDE.md core conventions require `.js` on every internal import. Configure your editor's TypeScript "auto import" feature to add `.js` automatically (VS Code: `"typescript.preferences.importModuleSpecifierEnding": "js"`).

**See also:** [docs/PRINCIPLES.md](./PRINCIPLES.md), [docs/STRUCTURE.md](./STRUCTURE.md).

---

### Symptom: `EACCES: permission denied, open '.splitbrief/...'` or config writes silently fail

**Likely cause:** The `.splitbrief/` directory was created by another user (often `root` after a `sudo` invocation), or sits on a filesystem mounted read-only. SPLITBRIEF writes session state, snapshots, and configuration there continuously.

**Fix:**
1. Inspect ownership: `ls -la .splitbrief`.
2. If owned by `root` or another account, reclaim it: `sudo chown -R "$USER":"$(id -gn)" .splitbrief`.
3. Confirm the directory is writable: `touch .splitbrief/.write-test && rm .splitbrief/.write-test`.
4. If the filesystem itself is read-only (CI sandbox, Docker volume), run SPLITBRIEF from a writable working directory or fix the mounted workspace permissions.

**Prevention:** Never run SPLITBRIEF under `sudo`. If you accidentally do, immediately `chown` the resulting directory back. CI containers should mount the workspace with read-write permissions for the running user.

**See also:** [docs/BOOTSTRAP.md](./BOOTSTRAP.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `splitbrief doctor` or `splitbrief start` says Run Readiness is `blocked`

**Likely cause:** A hard local precondition failed before model calls: invalid or unwritable `.splitbrief/config.yaml`, not a git repository, an in-progress git operation (merge, rebase, etc.), or a live `.splitbrief/active` session in the same checkout. `splitbrief doctor` can also report a missing config because it does not bootstrap setup files.

**Fix:**
1. Read the `Next action` line. It points to `splitbrief init`, config repair, or cleaning/isolating the repo.
2. For doctor-only missing config warnings, run `splitbrief init` or `splitbrief init --reconfigure`.
3. For invalid config, fix `.splitbrief/config.yaml` and re-run `splitbrief doctor --json` to verify (`stateId` / `remediation` per check).
4. For active-session blockers, run `splitbrief status`, then `splitbrief resume` or `splitbrief attach <session-id>` if the run is still live.

**Prevention:** Run `splitbrief doctor` after changing runner config or before CI starts a headless run.

**See also:** [Run readiness and doctor diagnostics](#run-readiness-and-doctor-diagnostics), [CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-doctor), [CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `Project config declares a shell runner command that this machine has not trusted`

**Likely cause:** The project's `.splitbrief/config.yaml` names a `shell` or `agent` runner command that this machine has never granted. A config file travels with `git clone`, so a command written there is the repository author's proposal, not your consent — SPLITBRIEF refuses to run it until you say so, whichever approval level is set.

**Fix:**
1. Read the command first. `splitbrief doctor` prints it under `runners.planner.trust-boundary` / `runners.implementer.trust-boundary` as `Command:` and `Arguments:`.
2. If you want it, run SPLITBRIEF in a terminal. It shows the resolved executable path, the argv, the working directory, and the fact that the child inherits your environment, then asks for the confirmation phrase and a reason. Confirming stores an owner-only receipt in `~/.splitbrief/trust/custom-runners.json`.
3. In CI or any headless run (`--json`, `--rpc`, `--detach`), pass `--allow-repo-runners`. It grants that run only and persists nothing.
4. If the command should not run, replace the runner in `.splitbrief/config.yaml`.

Related refusals name their own cause: `does not exist on this machine`, `is not executable`, and `executable changed since this machine trusted it` (the receipt binds the executable's content digest). `Configured command is outside the current trust policy` is the separate, stricter rule for repo-local commands, which need `--allow-repo-runners` even interactively.

**Prevention:** A receipt is scoped to this checkout's canonical path and to a digest of the command, its argv, its declared environment references, and its watchdog thresholds. Editing any of those, or opening a second checkout, asks again by design.

**See also:** [CONFIGURATION.md](./CONFIGURATION.md#runner-command-trust), [CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-start).

---

### Symptom: Run Readiness warns about validation, but tests were not run

**Likely cause:** Readiness is a pre-run posture check, not CI. It inspects `validation.typecheck`, `validation.lint`, `validation.test`, `validation.testCommand`, and obvious package-script availability without executing validation commands.

**Fix:**
1. If checks are disabled intentionally, continue and run your validation manually.
2. If `testCommand` references a missing npm script, add the script or update `.splitbrief/config.yaml`.
3. To verify the project now, run your real commands directly, such as `npm run typecheck`, `npm run lint`, and `npm test`.

**Prevention:** Keep validation commands cheap and reliable so warnings remain rare.

**See also:** [FEATURES.md](./FEATURES.md#run-readiness--doctor), [WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: Run Readiness warns that the working tree is dirty

**Likely cause:** Files are modified or untracked before Task Briefs exist. Readiness cannot know yet whether those files overlap the future task scope, so ordinary dirty state is a warning rather than a blocker.

**Fix:**
1. Run `git status` and decide whether the local edits should be part of this run.
2. Continue if the edits are intentional and unlikely to overlap.
3. Use `splitbrief start --worktree <name> "..."` from a clean source checkout when you want isolation.

**Prevention:** Start substantial runs from a clean checkout or a dedicated worktree.

**See also:** [FEATURES.md](./FEATURES.md#splitbrief-start---worktree-name), [WORKFLOW.md](./WORKFLOW.md).

---

## Cost and billing

### Symptom: Anthropic / OpenAI bill spiked after a single run

**Likely cause:** The planner is configured with an expensive model (commonly Opus) and the implementer uses the same model. Standard and speckit modes call the planner 4 and 6–7 times respectively per task; multiplying that by Opus pricing escalates fast.

**Fix:**
1. Open `.splitbrief/config.yaml` and inspect `planner.kind` and `planner.model`.
2. Keep Opus for the planner only when you genuinely need its planning quality; for most work Sonnet 4.6 is the better cost/quality point.
3. Switch the implementer to a cheap or local runner: an `api` runner pointed at Ollama / LM Studio, or `cli` with a Haiku-class model.
4. Run `splitbrief status` to confirm the resolved configuration matches your intent.
5. Set `workflow.maxBudget` so the next runaway is bounded.

**Prevention:** Decouple planner and implementer cost tiers — that asymmetry is the entire point of SPLITBRIEF. Always set `workflow.maxBudget` for production usage.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/ARCHITECTURE.md](./ARCHITECTURE.md), [docs/VISION.md](./VISION.md).

---

### Symptom: Workflow keeps pausing with "budget threshold reached"

**Likely cause:** `workflow.budgetPauseThreshold` (a fraction of `maxBudget`) is set too low for the task at hand, or `maxBudget` is too tight. The orchestrator's budget guard fires whenever the rolling spend crosses the threshold.

**Fix:**
1. Inspect `workflow.maxBudget` and `workflow.budgetPauseThreshold` in `.splitbrief/config.yaml`.
2. Either raise `maxBudget` (if the task legitimately needs more headroom) or lower `budgetPauseThreshold` (if you want the warning earlier and resume manually each time).
3. If you simply want to silence the pause for one run, pass `--budget <usd>` on the CLI.
4. Inspect `summary.json` after the run for the actual spend distribution and right-size the limits.

**Prevention:** Calibrate budgets against `summary.json` from a few representative runs before locking them down.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), `src/engine/orchestrator/budget/`.

---

### Symptom: Cache hit percentage stuck at 0% in the cost status line

**Likely cause:** The active runner does not surface `cache_read_input_tokens`. CLI runners (`claude-code`, `codex`, `aider`, etc.) often emit aggregate token counts only, with no cache breakdown; the orchestrator reports what it receives.

**Fix:**
1. Confirm runner kind via `splitbrief status` or `.splitbrief/config.yaml`.
2. If you require cache visibility, switch the planner / implementer to `kind: api` with Anthropic or to `kind: agent-sdk`. Both expose cache token counts in usage payloads.
3. For CLI runners, accept that the cache % will be `0` (or `n/a`) and rely on the absolute token totals instead.

**Prevention:** Choose `api` or `agent-sdk` runners when cache observability matters for cost analysis.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md), [docs/OTEL.md](./OTEL.md).

---

### Symptom: Pricing column shows `n/a` and totals do not include a USD figure

**Likely cause:** The model identifier returned by the runner is not in the bundled pricing catalog (`src/core/providers/known-models.ts`). SPLITBRIEF refuses to invent prices, so any unknown model defaults to `n/a`.

**Fix:**
1. Check the exact model string in `summary.json` under `runs[].model`.
2. Check whether the provider returns pricing metadata during model discovery; runtime metadata can supply rates for models that are not bundled.
3. If the model is widely used and missing upstream, open a PR adding it to `src/core/providers/known-models.ts`.

**Prevention:** Audit `summary.json` for any `n/a` row after introducing a new model. Treat USD totals as incomplete until pricing comes from models.dev, runtime provider metadata, or `known-models.ts`.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), `src/core/providers/known-models.ts`.

---

### Symptom: A run records zero implementer tokens

**Likely cause:** The runner completed its call but its protocol carried no usage payload — `claude-code` and `codex` emit usage through their protocol terminal, and a runner that reports none records zero. That is no longer a silent zero: `recordTaskUsage` publishes exactly one warning with `category: 'cost'` and `code: 'implementer_usage_not_reported'` naming the runner and the task, so a run that did real work is distinguishable from one whose runner never reported. SPLITBRIEF never invents a price or synthesises token counts; a CLI runner staying structurally unpriced is by design, and the warning is the signal, not a defect.

**Fix:**
1. Read the warning in the transcript, `session.jsonl`, or `review-packet.json` (`escalations.warnings`) — it names the runner and the task.
2. If the runner normally reports usage (check its protocol terminal in `src/engine/runners/cli-tools/`), upgrade or reconfigure the binary — the warning is the early sign of a version whose usage channel changed.
3. If the runner genuinely has no usage channel, accept the zero and the warning per task; the run's cost posture is unknowable for that runner.

**Prevention:** Check the review packet's warnings list after a run. One `implementer_usage_not_reported` warning per unpriced task is expected; a warning for a runner that used to report usage means the binary drifted.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) (token accounting), [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) (review-packet warnings list), `src/engine/orchestrator/tokens.ts`.

---

## Planner issues

### Symptom: `runners.cli.claude-code.readiness` is `unauthenticated` on macOS

**Likely cause:** Claude Code keeps its subscription session in the macOS login keychain. A `session` runner on macOS reads that keychain with your real `HOME` and `USER`, so readiness runs `claude auth status` inside the staged environment and reports exactly what the child answered. `unauthenticated` here means the child got `"loggedIn": false` — the host is not signed in, or is signed in as a different account.

**Fix:**
1. `claude /login` (or `claude setup-token`), then `claude auth status` to confirm `"loggedIn": true`.
2. Re-run `splitbrief doctor`.
3. If you would rather not let a planner child see your home directory at all, set `auth_channel: api-key` for that runner in `.splitbrief/config.yaml` and `export ANTHROPIC_API_KEY=...` — that channel is metered and exposes nothing.

**Prevention:** Trust `splitbrief doctor` — including its refusals to overclaim. Readiness never reads a login off directory contents, and it also refuses to promote a tool's own local status read into proof: `codex login status` prints `Logged in using ChatGPT` from a pure file read even after the refresh token has been invalidated server-side, so a positive local status reports as *unverified* ("stored credentials prove presence, not a working session") and the first real call settles it. A definitive negative — no credential, or the tool answering signed-out — still blocks, because that run really would have failed.

**See also:** [docs/API-KEYS.md](./API-KEYS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

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

**Likely cause:** There is no default total-call timeout. What you are hitting is the fixed 60-second **stream-idle** guard: an `api`-kind planner aborts when no token (including the first one) arrives for 60s. A cold-loading local model (Ollama/LM Studio pulling a model into memory) easily exceeds that time-to-first-token window. Non-`api` planners (`cli`, `shell`, `agent`, `agent-sdk`) are covered by the **inactivity watchdog** instead: after 5 minutes of output silence the byline shows a "still working" warning, and at 30 minutes of silence the runner process group is auto-interrupted and a retry prompt appears (type instructions to steer, or press Enter to retry) — except the optional estimate-review extra planner call, which degrades gracefully to an unavailable review instead of parking a retry prompt. Both thresholds are tunable per runner via `idleWarnMs` / `idleKillMs`; `planner.timeout` remains the optional wall-clock cap on the whole call.

**Fix:**
1. Warm the model before the run so the first token arrives within 60s — e.g. issue one throwaway request to your local server, or pre-pull the model so it is resident.
2. Set `planner.timeout` (milliseconds) in `.splitbrief/config.yaml` to put a total wall-clock budget on each planner call (Opus planning passes can take several minutes). This caps the whole call; it does not extend the 60s idle guard.
3. Use `--detach` so the planner runs in the background and the TUI re-attaches when it completes — useful for long invocations.
4. If the planner is genuinely stuck (no token activity), check provider status pages and your network; restart the run.
5. Reduce `codebase.tokenBudget` so the prompt is smaller and the call returns sooner.

**Prevention:** Keep local models warm so time-to-first-token stays under the 60s idle guard, set `planner.timeout` as a total-call ceiling for high-latency planners, and prefer `--detach` for long jobs so terminal disconnects do not interrupt them.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: Planner says "I cannot find the file" or invents file paths

**Likely cause:** The codebase context shipped to the planner is truncated below the relevant file, or `codebase.exclude` patterns are filtering it out.

**Fix:**
1. Inspect the repo-map produced for the run (`.splitbrief/sessions/<session>/planner-input.json` or equivalent under the session directory).
2. Increase `codebase.tokenBudget` so the relevant tree is included.
3. Trim `codebase.exclude` if a glob is hiding the directory you need (common: `dist/`, `**/*.test.ts`).
4. Use `codebase.include` to pin specific paths that must always appear regardless of token budget.

**Prevention:** When onboarding a new repo, run a single `start` and inspect the repo-map size; tune limits so the planner-relevant code fits.

**See also:** [docs/REPOMAP.md](./REPOMAP.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: instant mode failed with zero tasks

**Likely cause:** The single planner call returned no parsable Task Briefs. Before failing, the same call is retried exactly once; if the retry also returns nothing, the run ends with `instant planner returned zero tasks; cannot proceed`. The planner's text output was persisted to the session directory before the failure and a coded warning (`planner_returned_zero_tasks`) was published pointing at it.

**Fix:**
1. Open the session directory — the planner's output is on disk (typically `tasks.md` or the phase files named in the warning), so you can read what the planner actually said.
2. If the output is prose with no briefs, the planner model may be too weak to emit Task Briefs: raise the planner model or switch to `--mode standard`.
3. If the planner produced nothing at all, check the runner diagnostics (`planner.timeout`, stream-idle guard, provider health) and re-run.
4. Re-run with `splitbrief start --mode instant "<feature>"`.

**Prevention:** Keep `instant`/`quick` for trivial edits and reserve the multi-call modes for anything where brief quality matters — a zero-task outcome is usually a mode/model mismatch.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) (mode table), `src/engine/orchestrator/planning/instant.ts`.

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
1. Inspect `.splitbrief/sessions/<id>/drift-report.json` for in-bounds and out-of-bounds touched paths.
2. If the changes are legitimate (the brief was incomplete), add the paths to `scope.approvedOutOfBounds` in the brief and re-run the final review.
3. If the changes are wrong, revert via the snapshot system: `splitbrief snapshot restore <snapshot-id>`.
4. For repeat offenders, raise the implementer model or tighten the brief's scope language.

**Prevention:** Always check the drift report before accepting a task or making any manual commit. Treat unexpected out-of-bounds files as a planning bug, not implementation noise.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: The implementer says it finished but nothing changed

**Likely cause:** The runner completed its call without writing any file. Change detection (`detectChanges()`, `src/engine/change-detection.ts`) reports the distinct `no-files-changed` reason, the task fails with the `no-staged-change` outcome, and SPLITBRIEF publishes one coded warning — `category: implementer`, `code: implementer_wrote_nothing`, `transcriptSafe: true` — naming the runner and the task. The warning lands in `session.jsonl` and in the review packet's warnings list (`review-packet.json` → `escalations.warnings`).

**Fix:**
1. Read the warning in the transcript or `review-packet.json`. A "finished but wrote nothing" response is a model behaviour problem, not a SPLITBRIEF failure — the retry ladder runs exactly as it would for any other failure.
2. Inspect the implementer's output in `session.jsonl` around the task's `implementer_generate_running` / `implementer_generate_failed` events to see what the runner actually said.
3. Re-run with a stronger implementer model, or tighten the Task Brief so the runner has a concrete edit to make.

**Prevention:** Prefer a `direct`-write runner verified against the task file, and check the review packet's warnings list after a run — the `implementer_wrote_nothing` warning is the signal that the model reported success without touching the tree.

**See also:** [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), `src/engine/change-detection.ts`, `src/engine/implementers/pipeline/run.ts`.

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

### Symptom: Implementer fails repeatedly against a local model that is not running

**Likely cause:** An `api`-kind implementer probes its provider's model list instead of assuming a local endpoint is up (`createProviderAvailability`, `src/engine/providers/client/availability.ts`). A dead daemon fails the probe, and the availability gate raises the unavailable-implementer recovery immediately — no local retries and no paid escalation tiers are burned against the dead endpoint. The hint tier is never invoked, so a stopped Ollama/LM Studio cannot cost you a planner call.

**Fix:**
1. Read the recovery issue's detail — it carries the runner's own reason (e.g. "the endpoint is unreachable") when one exists.
2. Start the daemon (`ollama serve`, LM Studio, etc.).
3. Pick `retry-same-worker` — the next availability probe runs once per task iteration and the verdict is never cached, so the running daemon is detected on the next task.

**Prevention:** Readiness probes the endpoint before the run starts, so a stopped daemon is a blocker at `doctor` and at `start` rather than a mid-run surprise after the planning phase has been paid for (`runners.availability.implementer.<profile>`, `src/core/readiness/checks/availability.ts`). To draft a spec while the daemon is down, use `splitbrief spec` — it never calls the implementer, so its readiness does not gate on one.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), `src/engine/implementers/api.ts`.

---

### Symptom: Implementer keeps failing with "refusing to overwrite"

**Likely cause:** For a modify task, the extracted-code branch refuses a marker-less response that would replace the whole file while keeping less than half of its (at least five) non-empty lines — a model that answered with prose plus one fenced function instead of the complete file. The file is left untouched and the task fails, so the damage cannot compound across retries.

**Fix:**
1. Read the failure message: it states the kept-of-had line counts and carries a literal SEARCH/REPLACE template.
2. Retry the task with the exact-patch form: a fenced block containing `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` around only the lines to change. A search/replace patch is applied even when it is small.
3. If the task genuinely rewrites most of the file, return the complete new file contents instead.

**Prevention:** None needed for correct model output — a whole-file rewrite that keeps most of its lines, or any patch carrying SEARCH/REPLACE markers, passes the guard unchanged.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), `src/engine/implementers/pipeline/extracted-code.ts`.

---

### Symptom: The runner rejected a flag SPLITBRIEF sent

**Likely cause:** The installed binary's version does not accept the arg vector the adapter emits for the configured role — historically `error: unexpected argument '--reasoning…'`, `unexpected argument '--quiet…'`, `warning: --full-auto is deprecated`, an unexpected stdin read, or a claude session-id error. These used to surface as a task failure at attempt one, after planning was already paid for.

**Fix:**
1. Run `splitbrief doctor` to inspect the verdict without starting a run. Doctor runs the same preflight and reports the same check (`runners.cli.<tool>.arg-vector.<role>`) in its report, with `doctor --json` publishing it for automation.
2. Run readiness again: execution preparation preflights the emitted arg vector against the installed binary's own `--help` and reports the blocker before any planning starts.
3. If a flag is reported unsupported, upgrade the installed binary to a version the adapter is verified against, or remove the offending flag from the runner's configured `args`.
4. A flag the binary merely marks deprecated shows as a warning — plan to remove it from the config, but the run can proceed.

**Prevention:** Keep the installed CLI tools on versions matching the support matrix in [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md). The preflight cannot detect adapter/binary drift for a help text it cannot read; that case reports ok rather than blocking.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), `src/engine/runners/arg-vector-preflight.ts`.

---

### Symptom: The run retried three times in seven seconds after I pressed Ctrl-C

**Likely cause:** A cancelled implementer call was treated as an ordinary failure and fed into the retry ladder. Aborted calls are now recognised at the retry decision site: when the workflow signal is aborted or the implementer reports the runner's abort text (`Aborted`), the retry loop stops immediately instead of consuming `workflow.maxRetries` and escalating against a call the user already cancelled.

**Fix:**
1. Confirm the run stopped: `splitbrief status` shows the session ending at the task boundary, not continuing through retries.
2. Check `session.jsonl` for `task_retry` rows — a cancelled run should no longer append them.
3. If you cancelled by accident, resume with `splitbrief continue <session-id>`.

**Prevention:** None needed — this is fixed behaviour; a cancelled call no longer spends retries or escalation budget.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) (retry arithmetic), `src/engine/orchestrator/escalation/local-retries.ts`.

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
3. If validation is misconfigured (wrong command, missing dependency), fix the `validation` block in `.splitbrief/config.yaml` (`validation.typecheck`, `validation.lint`, `validation.test`, `validation.testCommand`) and re-run.
4. As a last resort, set `validation.typecheck: false` / `validation.lint: false` / `validation.test: false` in config to disable the failing check while you debug — you are then responsible for running the check manually.

**Prevention:** Keep `validation.testCommand` minimal but reliable: at least `npm run typecheck`. Slow test suites should not block per-task validation; move them to CI.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: Every task fails validation because the tree was already red

**Likely cause:** A validation stage (typecheck, lint, or test) was already failing in the repository before the run started — a pre-existing error in a file no task touches. Acceptance is baseline-relative: a stage that was already red at baseline is exempt when its failure evidence names none of the task's changed files, and the task commits anyway. A stage that was green at baseline always blocks.

**Fix:**
1. Check the baseline probe row at the start of the run — it names the stages that were already failing before the first task.
2. If the failing stage was red at baseline and its evidence names none of the task's changed files, the task is accepted; retry and escalation do not fire for pre-existing failures.
3. A task that introduces a **new** failure in a stage already red at baseline is still rejected — the evidence names one of the task's changed files.
4. Fix the pre-existing failure itself to turn the whole tree green; until then, tasks that do not touch the failing files keep completing with the exemption noted.

To see which stages are already red **before** starting a run, run `splitbrief doctor --probe-validation`: it runs the configured validation commands and reports each failing stage, naming the exact commands in the check details (it can take minutes — it is a real run, not a posture check).

**Prevention:** Keep the tree green before starting a run (`npm run test-ci`); baseline-relative acceptance spares tasks from pre-existing failures, not from the failures they cause.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) (§4 `validation`), [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

---

### Symptom: The run seems stuck at `Implementing…` before the first task

**Likely cause:** The run-start baseline probe is running. Before the first task, SPLITBRIEF probes every enabled validation stage once (typecheck → lint → test, with the test probe narrowed to the first task's affected file). Each stage can block for `validation.timeoutMs` (default 10 minutes) and the probe deliberately does not stop at the first red stage, so three slow stages can hold the phase for up to half an hour.

**Fix:**
1. Look at the conversation rows — the probe publishes a `baseline` row naming the stage currently being probed (`baseline typecheck (npx tsc --noEmit) running …`). The run is not hung; it is waiting on that command.
2. If a stage is genuinely slow, lower `validation.timeoutMs` in `.splitbrief/config.yaml` (minimum 1000 ms) so each probe step gives up sooner.
3. If a stage can never pass in this repository (a pre-existing type error, a broken linter), leave it red: the probe records it as a pre-existing failure and the run continues past it rather than failing every task on it.

**Prevention:** Keep the validation commands fast enough for a pre-task probe (a full test suite is usually too slow); the probe runs them once before any task. The same stages can be probed on demand, without starting a run, via `splitbrief doctor --probe-validation`.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) (§4 `validation`), [docs/WORKFLOW.md](./WORKFLOW.md).

---

## Workflow issues

### Symptom: `Still working — silent 5:12` sits in the byline for minutes with OpenCode

**Likely cause:** OpenCode's `run --format json` mode reports a tool only once that tool completes, and it never forwards child-session (subagent) events at all. A `task explore` subagent that runs for two minutes therefore produces no output until it lands, so the idle watchdog warns at `RUNNER_IDLE_WARN_MS` (5 minutes) even though the call is healthy. The run is not hung.

**Fix:**
1. Wait. The byline appends `· tools report when done` when the silent runner is one that only reports finished tools, which is the signal that this silence is expected rather than a hang.
2. If you want to confirm liveness, the watchdog is still armed underneath: a genuinely dead process is killed at `RUNNER_IDLE_KILL_MS` (30 minutes), and the stall clears on the next activity, completion, or error event.
3. To see what the tool actually did, read the run tree after the call completes — the tool uses land there in one batch.

**Prevention:** Use a runner that streams tool use live (Claude Code's `stream-json`) for the role where you want per-tool progress, and keep OpenCode for the role where a batched report is acceptable.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: a session is reported active but nothing is running

**Likely cause:** Each session writes a per-session lockfile at `.splitbrief/sessions/<id>/lockfile.json` that records the PID, heartbeat, and exit marker. If `.splitbrief/active` still points at a non-terminal `state.json`, older versions could treat that pointer as live even when the lockfile already had `exitedAt`.

**Fix:**
1. Run `splitbrief ps` to list known sessions; it reads each lockfile, checks whether the PID is alive, and marks stale entries as `crashed` or exited.
2. Run `splitbrief start ...` again. Current versions clear `.splitbrief/active` automatically when the active lockfile has exited or the PID is gone.
3. If you want to resume that interrupted session instead of starting fresh, run `splitbrief continue <session-id>`.
4. If the lock is fresh and a real process is alive, you have a genuine concurrent session. Attach to that one rather than starting another.

**Prevention:** Prefer clean TUI cancellation or `splitbrief continue` for interrupted work. For long-running jobs, use `--detach` so the server survives terminal closure and exits cleanly.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: `.splitbrief/sessions/` accumulates directories that never became sessions

**Likely cause:** An abort or crash after `readiness.json` was written — before the run acquired its lockfile — leaves a session directory holding nothing but `readiness.json` (or nothing at all). Historically nothing could act on those directories, so long-lived projects accumulated hundreds of them; `splitbrief ps` printed a row for each, and the stale slug suffixes kept `splitbrief ps` alias numbers and session-id slugs occupied.

**Fix:**
1. A directory holding only `readiness.json` (or empty) and older than 24 hours is collectable. `splitbrief ps --prune` removes the collectable directories and lists what it collected; the sweep also runs automatically at workflow start.
2. `splitbrief ps` no longer lists non-session directories, so the table matches what `splitbrief continue <n>` can address.

**Prevention:** None needed beyond the automatic sweep. A directory holding any other artifact — a lockfile, `state.json`, an ownership marker, or anything else — is never collected.

**See also:** [docs/HOW-IT-WORKS.md](./HOW-IT-WORKS.md), [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-ps).

---

### Symptom: Workflow stalls indefinitely at an approval gate

**Likely cause:** The TUI is waiting for input but the input mode is wrong, or a non-interactive run reached an approval gate that needs a response.

**Fix:**
1. In the TUI, focus the composer (Tab if focus is elsewhere) and press `y` / `c` / `q`, or submit `approve` / `comment ...` / `reject`.
2. If you ran with `--json`, the NDJSON stream cannot accept replies. Workflow review gates are auto-approved in headless JSON mode; file-write tiered approvals fail closed with `APPROVAL_REQUIRED` unless their tiers allow the write. Use `--rpc` from the start when a client needs to answer approvals programmatically, or resume with `splitbrief continue --rpc <session-id>` when the session is resumable. For unattended runs, use `--mode quick` or configure approval tiers so file writes do not prompt.
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

### Symptom: every implementer profile is rejected with `context-overflow`

**Likely cause:** Every candidate profile overflowed the task's estimated prompt tokens — the brief is larger than any available context window. A profile that declares no `contextLength` and whose provider exposes no detected window routes at the single documented default, `DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32768` (`src/core/tokens/context-length.ts`); with the 15% safety margin, a task over roughly 28 000 estimated tokens overflows it. A CLI tool under `model: auto` escapes this floor — its window resolves from the smallest bundled window its catalog guarantees (`resolveRunnerContextWindow`, `src/engine/providers/model/context-window.ts`) — so check that the profile's tool actually carries a bundled catalog row before configuring a window by hand.

**Fix:**
1. Set `implementer.contextLength` (or the `SPLITBRIEF_CONTEXT_LENGTH` environment variable) to the runner's real window — see [docs/CONFIGURATION.md](./CONFIGURATION.md).
2. Use a profile whose declared or detected window fits the brief, or split the brief into smaller tasks.
3. When the recovery prompt offers `route-bigger-worker`, take it so the task is retried on a larger-window profile.

**Prevention:** Configure `contextLength` on implementer profiles that run outside a known catalog, and keep briefs under roughly 28 000 estimated tokens when the window is unknown.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) (`context-overflow` recovery), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

## Approval gates

### Symptom: the briefs prompt keeps coming back

**Likely cause:** The brief readiness gate (`runBriefReadinessGateAndReport()`, `src/engine/orchestrator/planning/brief-readiness-gate.ts`) ran over the Task Briefs and reported blocks — tasks that overflow the worker context window, have no capable worker, or carry stale routing context. The block is advisory, not a permanent stop: the review header shows `readiness N blocked` and the override instruction `approve again overrides`.

**Fix:**
1. Read the block kinds in the warning (`overflow`, `no-capable-worker`, `stale-conflict`) and the task ids — the review header counts them, and the transcript warning names each block with its next best action.
2. Either revise `tasks.md` to resolve the blocks (split oversized tasks, widen the worker, refresh routing), or approve again without editing `tasks.md` — the second identical approval records the override in `brief-readiness.json` and proceeds.
3. Editing or revising `tasks.md` between the two approvals cancels the pending override, so a confirmation is never granted against stale briefs.

**Prevention:** None needed — a blocked report never permanently blocks approval; the loop also terminates after `MAX_UNPRODUCTIVE_BRIEF_REVIEW_ATTEMPTS` (20) unchanged failures instead of re-prompting forever.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `APPROVAL_REQUIRED` (headless run paused, or stuck on a sticky/confirm tier)

**Likely cause:** A `--json` run hit a file-write tiered approval that has no reply channel; an RPC client did not answer the prompt; or an interactive run has `approval.headless: true` set, which forces fail-closed on any tier that would ordinarily prompt.

**Fix:**
1. If the session is resumable, continue it with an interactive TUI (`splitbrief continue <session-id>`) or RPC (`splitbrief continue --rpc <session-id>`).
2. Or set the offending file-write tier to `auto` in `.splitbrief/config.yaml` under `approval.tiers.<class>: auto`.
3. For CI runs that should never prompt, make sure every tier is set to `auto` (or remove the `approval` block entirely for fully non-interactive runs). Set `approval.headless: true` only when you want fail-closed behaviour on unexpected prompts.

**Prevention:** Audit `approval.tiers` before running `--json` or unattended RPC. Any tier left at `sticky` or `confirm` can require an approval response.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval, [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `invalid_confirm_phrase` — confirm tier rejected my input

**Likely cause:** The engine requires every confirm-tier response to carry the literal phrase `I confirm` (capital I, space, lowercase confirm) and a non-empty reason. The TUI supplies both for you once you make the keyed gesture, so this error means the response came from somewhere else: an RPC client (`splitbrief spec --rpc`), the configured-runner trust prompt, or a custom `onTieredApproval` callback that sent a different phrase or an empty reason.

**Fix:**
1. In the TUI, press Enter (destructive class) or `y` (every other confirm-tier class). Press `r` first if you want to record a reason. Escape denies.
2. Over RPC, send `confirmationPhrase: "I confirm"` plus a non-empty `reason` — see `src/cli/rpc/gates.ts`.
3. In a custom callback, return `{ decision: 'confirm', phrase: CONFIRM_PHRASE, reason }` with `reason` non-empty.

**Prevention:** Import `CONFIRM_PHRASE` from `src/core/approval/types.ts` rather than retyping the literal.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval.tiers.

---

## Snapshots

### Symptom: `snapshot create` fails with "lock held"

**Likely cause:** Another SPLITBRIEF process — or a previous run that crashed — is holding the snapshot lock. The lock is considered stale after 60 seconds.

**Fix:**
1. Wait 60 seconds and retry; stale locks expire automatically.
2. If a real concurrent operation is running, finish it first (or attach with `splitbrief attach` to see what it is doing).
3. If no other process exists and the lock is older than 60s, remove it manually: `rm .splitbrief/sessions/<session-id>/snapshots/.lock`.
4. Re-run the snapshot operation.

**Prevention:** Avoid running multiple `splitbrief start` invocations against the same workspace simultaneously — use worktrees instead.

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

### Symptom: `.splitbrief/snapshots/` directory grows to many gigabytes

**Likely cause:** The baseline + delta snapshot scheme keeps a full baseline plus per-task deltas; long sessions touching large files (build outputs, lockfiles, generated assets) accumulate quickly.

**Fix:**
1. The snapshot system always excludes `.git`, `.splitbrief`, `node_modules`, and `.trees`; for additional paths, add them to `.gitignore` so the snapshot walker skips them automatically.
2. For terminal cleanup, archive the session and delete its snapshot directory: `rm -rf .splitbrief/sessions/<session-id>/snapshots`.

**Prevention:** Keep build outputs and lockfiles in `.gitignore` — the snapshot walker respects it. Delete old session snapshot directories after you no longer need restore points.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/INVARIANTS.md](./INVARIANTS.md).

---

## Drift

### Symptom: Drift report flags files I never touched

**Likely cause:** Drift matching uses substring comparison against the brief's declared paths; loose globs and short tokens produce false positives.

**Fix:**
1. Inspect `.splitbrief/sessions/<id>/drift-report.json` and confirm whether the file was actually modified (run `git diff` against the pre-task snapshot).
2. If the match is spurious, tighten the brief's scope strings (use full paths, not bare filenames).
3. If the file is intentionally out of scope, add it to `scope.approvedOutOfBounds` in the brief.
4. For repeat offenders, tighten future brief scope strings or add intentional shared files to `approvedOutOfBounds`.

**Prevention:** Write brief scope sections with full project-relative paths (`src/engine/orchestrator/run/workflow.ts`), never bare names (`workflow.ts`).

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Chain-drift detection flags every task

**Likely cause:** `workflow.driftChainThreshold` is set too low for your codebase — small overlaps in touched files trip the chain heuristic. If unset, the chain threshold defaults to `0.6`; there is no config-level off switch.

**Fix:**
1. Inspect `.splitbrief/sessions/<id>/drift-chains.json`; `summary.json.chainDriftSummary` is only the aggregate/top emitted chain summary.
2. Raise `workflow.driftChainThreshold` in config (try 0.75 or 0.85) until only meaningful chains trip it.
3. Set it to `1.0` to make emissions least likely, or add a real disable flag before documenting off semantics.

**Prevention:** Tune the threshold against a representative session before relying on it as a gate.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Edits to `drift.ts` do not change behavior

**Likely cause:** Drift logic exists at two layers. Per-task chain analysis runs from `src/engine/orchestrator/task/analyze-drift.ts` (via `step.ts`) through `src/engine/orchestrator/drift/chain.ts` and persists to `drift-chains.json`. The final deterministic drift report runs from `src/engine/orchestrator/final-review.ts` through `src/engine/orchestrator/drift/analyze.ts`, persists to `drift-report.json`, and is summarized in `summary.json`.

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
4. Re-run handoff: `splitbrief handoff <target>`.

**Prevention:** Treat handoff renderers as downstream consumers — never run handoff before all prerequisite briefs have completed.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md).

---

### Symptom: Custom handoff renderer is not picked up

**Likely cause:** The renderer file does not export a default function, has the wrong file extension, or cannot be loaded by the current runtime. Handoff loads only runtime-loadable `.ts` and `.js` files exporting a default function.

**Fix:**
1. For `.js`, ensure the file exports `export default function render(input) { ... }` (or async).
2. For `.ts`, type the function with `RendererFunction` or annotate `input` and return; `.ts` also needs runtime loader support.
3. Place the file at `.splitbrief/handoff-renderers/<target>.ts` (or `.js`). The loader scans that directory automatically — there is no `handoff.renderersDir` config field.
4. Re-run `splitbrief handoff <target> --allow-custom-renderer`, or set `trust.customRenderers: true` in `.splitbrief/config.yaml`. Loader errors report the import or default-export failure reason. Unknown-target errors include the target name.

**Prevention:** Copy from a known-good renderer template when starting a new one rather than writing from scratch.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `Handoff target not recognized: <name>`

**Likely cause:** The target is neither in the built-in `HANDOFF_TARGETS` list nor mapped to a custom renderer.

**Fix:**
1. Run `splitbrief handoff --list` to enumerate known targets.
2. If the name is a typo, correct it.
3. If you want a new target, add a runtime-loadable custom renderer at `.splitbrief/handoff-renderers/<target>.ts` or `.js` — `splitbrief handoff --list` can discover it without trusting it.
4. Execute it with `splitbrief handoff <target> --allow-custom-renderer`, or set `trust.customRenderers: true` in config.

**Prevention:** Define custom renderers as soon as you adopt a new downstream consumer, and document the available targets in your team handbook.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/handoff/`.

---

## MCP server

SPLITBRIEF MCP exposes read-only session resources and five constrained evidence tools. The tools only update `.splitbrief/sessions/<id>/evidence.json` for existing sessions/tasks; they do not write project files, run shells, or dispatch implementers. General tool calls remain inside the configured planner or implementer runner.

### Symptom: `splitbrief mcp serve` exits immediately or refuses to bind

**Likely cause:** The default port is in use, or there is no active session for the server to attach to.

**Fix:**
1. Pass `--port <n>` with a free port (default may be occupied by another SPLITBRIEF or unrelated service).
2. Pass `--session <id>` explicitly — `splitbrief mcp serve` attaches to a specific session, not "the current workspace".
3. Confirm the session exists with `splitbrief ps`.
4. Check that no other `splitbrief mcp serve` is running for the same session: `pgrep -fa 'splitbrief mcp serve'`.

**Prevention:** Always pass `--port` and `--session` explicitly in scripts; never rely on defaults for production usage.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: MCP client reports "auth token rejected"

**Likely cause:** The token is mistyped or stale. `splitbrief mcp serve` prints a fresh token on startup; clients must use that exact value.

**Fix:**
1. Re-read the startup banner — the token is printed once at server start.
2. Copy it verbatim (no surrounding whitespace, no quotes) into your client config.
3. If you lost the banner, restart the server: `splitbrief mcp serve --port <p> --session <s>` and capture the new token.
4. Update the client config with the new bearer token.

**Prevention:** Start MCP from a wrapper script that captures the startup banner and writes the generated token into your client config. The token is generated in memory for each server run and is not pinned by environment variable.

**See also:** [docs/API-KEYS.md](./API-KEYS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: Expected MCP resources are missing or empty

**Likely cause:** Resources are synthesized from the served session artifacts. `resources/list` omits missing concrete artifacts; reading a missing concrete resource returns resource-not-found. The virtual `tasks` resource returns an empty JSON array when `tasks.md` is absent. MCP evidence tools can update the evidence ledger, but no MCP tool can create missing planning artifacts.

**Fix:**
1. Confirm session status with `splitbrief ps`.
2. If the session is still planning, wait for the artifacts to materialize.
3. Use `splitbrief explain --session <id>` or inspect `.splitbrief/sessions/<id>/` directly to confirm what exists.
4. If artifacts exist but the MCP server does not expose them, restart `splitbrief mcp serve` to re-scan.

**Prevention:** Start MCP after the session has produced at least its first brief.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: MCP `Resource not found` (error `-32002`)

**Likely cause:** The resource URI references a session ID or artifact that the running MCP server is not serving. This happens when the session was started after the server, or you referenced the wrong session ID.

**Fix:**
1. Confirm the session ID exists: `splitbrief ps`.
2. If the session was created after the server started, restart `splitbrief mcp serve` — the server does not hot-reload new sessions.
3. To serve all sessions known at server startup, use `splitbrief mcp serve --all-sessions --port 4321`; restart the server to include sessions created later.

**Prevention:** Start or restart the MCP server after all relevant sessions exist.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: MCP HTTP 401 (Bearer token rejected)

**Likely cause:** The token printed in the server startup banner is generated once per server invocation and kept in memory only. It rotates on every restart. A stale token from a previous run will always be rejected.

**Fix:**
1. Re-read the token from the server startup banner: `splitbrief mcp serve --port 4321` prints `Token: <value>` on start.
2. Copy the token exactly — no surrounding quotes or whitespace.
3. Update your MCP client config with the new token value.

**Prevention:** Keep the terminal that started `splitbrief mcp serve` visible, or have a wrapper script tee the startup banner to a file before handing the token to your client config.

**See also:** [docs/API-KEYS.md](./API-KEYS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `Port 4321 already in use` (starting `splitbrief mcp serve`)

**Likely cause:** Another process (a previous `splitbrief mcp serve`, or an unrelated service) is already bound to port 4321, which is the MCP server's default port.

**Fix:**
1. Pass a different port: `splitbrief mcp serve --port 4444`.
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
2. If the changes matter, commit (manually — SPLITBRIEF does not commit for you) or `git stash` them.
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

**Prevention:** Treat each worktree you create yourself as a fully independent checkout. Never symlink `node_modules/` across those worktrees. (Run isolation is the deliberate exception: it links the project's `node_modules` into its worktree — see the entry below.)

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: The implementer cannot run the project's own checks inside a worktree-isolated run

**Likely cause:** Only Node dependencies are made reachable in a run-isolation worktree (a `node_modules` link, with its `.bin` prepended to the workspace PATH). A project whose toolchain lives elsewhere — a Python virtualenv, a Go module cache, a Rust target directory — has nothing to resolve inside the worktree, and a `staged-copy` isolation has no dependencies at all. Separately, a repository that does not ignore `node_modules` at all cannot take the link — SPLITBRIEF will not change your ignore rules to make it fit — so the run falls back to `staged-copy` on its own. The common `node_modules/` pattern is fine: the link is excluded through the repository's `.git/info/exclude` and the worktree is kept.

**Fix:**
1. Nothing is broken: validation runs in the real project directory after promotion, so the run's verdict never depends on the implementer's own checks.
2. To give the implementer its own toolchain anyway, add a `node_modules` entry to `.gitignore` so the link can be excluded from change detection, or set `workflow.isolation: staged-copy` and accept the first-pass-rate loss.

**Prevention:** Treat dependency reachability inside isolation as a first-pass-rate improvement, never the authority on correctness.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `Branch splitbrief/<slug> already exists.`

**Likely cause:** A previous SPLITBRIEF run created that branch and it was never deleted. SPLITBRIEF refuses to overwrite an existing branch when creating a worktree.

**Fix:**
1. If the branch contains work you still want: `git branch -D splitbrief/<slug>` (or rename it first).
2. Alternatively, pass a different slug: `splitbrief start --worktree <other-name> "..."`.

**Prevention:** Run `splitbrief worktree list` and clean up idle branches with `splitbrief worktree remove <slug> --delete-branch` after merging or abandoning work.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: `Worktree ".trees/<slug>" has a live session <id>.`

**Likely cause:** You tried to remove a worktree that still has an active SPLITBRIEF session.

**Fix:**
1. Attach to the running session and stop it: `splitbrief attach <id>` then Ctrl-C.
2. Or force-remove once you're certain the session can be discarded: `splitbrief worktree remove <slug> --force`.

**Prevention:** Always run `splitbrief ps` before removing a worktree to confirm no session is active inside it.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: `Worktree ".trees/<slug>" has uncommitted changes.`

**Likely cause:** The worktree has local modifications; `splitbrief worktree remove` refuses by default to avoid accidental data loss.

**Fix:**
1. `cd .trees/<slug>` and either commit or `git stash` your changes.
2. If the changes are disposable: `splitbrief worktree remove <slug> --force`.

**Prevention:** Treat worktrees as ephemeral; merge or discard changes before removal.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

### Symptom: A run-isolation worktree is left behind after an interrupted run

**Likely cause:** Run isolation retained the worktree on purpose. When a run ends with work that was never promoted — an interrupted task, an escalation that never landed — SPLITBRIEF keeps the worktree and its `splitbrief/<session-id>` branch so that work can be recovered. It also keeps the worktree when the worktree strategy could not prove the worktree clean, so a retained directory does not always mean a failed run. The checkout lives under `$XDG_STATE_HOME/splitbrief/trees/<hash>/<session-id>/` (default `~/.local/state/splitbrief/trees/...`), outside both `.git/` and the project root.

**Fix:**
1. Find the path: `git worktree list` (look for `splitbrief/<session-id>`) or read the trailing line from `splitbrief ps` when the session directory is gone.
2. Inspect what it holds: `cd` to that path and run `git status` (and compare against the project directory).
3. If the work is wanted, promote it manually or resume the session; if it is disposable, remove both the worktree and its branch with the commands `splitbrief ps` prints — `git worktree remove <path> --force` then `git branch -D splitbrief/<session-id>`. Do not use `splitbrief worktree remove` for these paths; it manages `.trees/` lanes only.

**Prevention:** A fully accepted run removes its worktree and branch itself; retained directories are the signal that something did not reach the project. `git worktree list` shows them. `splitbrief ps` names isolation worktrees whose session directory is gone and prints the `git worktree remove` cleanup — it does not treat a live session running inside a `--worktree` lane as orphaned just because you invoked `ps` from the repository root.

**See also:** [docs/WORKTREES.md](./WORKTREES.md).

---

## Server-client and detach

### Symptom: `splitbrief attach` exits with "connection refused" or "no such session"

**Likely cause:** The server process died (OOM, terminal closed without `--detach`, host reboot) and the session metadata is now stale.

**Fix:**
1. Run `splitbrief ps` and confirm the session's PID is alive.
2. If the PID is dead, the run is over; archive the session and start fresh.
3. If the PID is alive but the socket is gone, the IPC layer crashed — continue from saved state with `splitbrief continue <session>`.
4. Check OS logs for OOM kills if this happens repeatedly.

**Prevention:** Use `--detach` for any long-running session so the server lives independently of the terminal.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: TUI input is dropped or duplicated when multiple clients are attached

**Likely cause:** Single-writer constraint. Only one attached client should send input to a session at a time.

**Fix:**
1. Detach all but one client.
2. For multi-viewer setups, use `splitbrief status`, `splitbrief ps`, and the session artifacts instead of extra interactive attach clients.
3. If you need to hand off control between people, the current writer must `detach` before the next one attaches as writer.

**Prevention:** Establish a convention: only one teammate is the active writer per session at any time.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `attach` is slow because the entire event log replays

**Likely cause:** The session's `session.jsonl` has grown large; the client replays from the start to reconstruct UI state.

**Fix:**
1. Use `splitbrief status` or `splitbrief ps` to confirm you are attaching to the intended session.
2. For very long sessions, detach and resume from a checkpoint when the workflow reaches a stable boundary.
3. Keep the existing session directory intact; `attach` only accepts `--project` plus the optional session id.

**Prevention:** Keep sessions short — split long-running multi-feature work across multiple sessions rather than one mega-session.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `timeout waiting for server to start` (when using `--detach`)

**Likely cause:** The background server process failed to write its lockfile within the expected window (3 seconds). This can happen if the process itself crashed immediately, if the disk is full, or if there is a port conflict on the IPC socket.

**Fix:**
1. Check `.splitbrief/sessions/<id>/server.log` for the crash reason.
2. Confirm no port or socket conflict: another `splitbrief` process may already be using the same IPC socket.
3. Retry `splitbrief start --detach "..."` — transient startup failures are rare.

**Prevention:** Use `--detach` for long jobs on reliable infrastructure; avoid running multiple SPLITBRIEF instances against the same session directory simultaneously.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: TUI shows `ipc_reconnect_attempt` / `ipc_reconnect_failed` events

**Likely cause:** The IPC client lost its connection to the server and is retrying with exponential backoff (up to 5 attempts). If all attempts fail, an `ipc_reconnect_failed` event fires and the TUI shows the session as disconnected.

**Fix:**
1. If `ipc_reconnect_failed` fires, the server process has most likely crashed — run `splitbrief attach <id>` to see the post-mortem from `server.log`.
2. If you see reconnect attempts but eventual success, the server hiccuped (GC pause, brief overload) — no action needed.
3. Check OS-level OOM logs if crashes repeat: `dmesg | grep -i kill` (Linux) or Console.app (macOS).

**Prevention:** Run on a machine with enough RAM for your planner model's context window. Prefer `--detach` for long sessions so the server survives terminal disconnects.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

## TUI

### Symptom: TUI layout is broken — overlapping panes, truncated text

**Likely cause:** Terminal width below 60 columns. Ink can render but SPLITBRIEF's layout assumes a minimum width.

**Fix:**
1. Resize the terminal to at least 80 columns (120 recommended).
2. If you are on a tiny window, run without the TUI instead: `splitbrief start --json "..."` for NDJSON output, or `splitbrief start --rpc "..."` for an interactive NDJSON protocol.
3. For tmux/screen users, increase the pane width or detach from the multiplexer.

**Prevention:** Default to a wide terminal for SPLITBRIEF sessions, or use `--json`/`--rpc` when working in narrow contexts.

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

**Likely cause:** Spec, plan, and brief review edits use the external editor resolver and then spawn the resolved command. Resolution uses explicit `VISUAL` first, then non-terminal `EDITOR`, then detected GUI editors (`cursor`, `code`, `zed`, `subl`, `mate`, `bbedit`) with wait flags from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. The failure is in launching or running that resolved command, not a missing variable:
- The resolved binary is not on `PATH` (e.g. `VISUAL=code` or `EDITOR=code` on a machine without VS Code) — the spawn errors and you get `Failed to open editor: …`.
- The editor exits non-zero or is killed by a signal — if it saved the file first, the saved content is kept and applied (`Editor exited with status … but saved spec.md — content reloaded`); if the file is unchanged you get `Editor exited with status … — edit not applied` or `Editor failed: … terminated by …`.
- You press Ctrl+C in the editor — that is a cancel, not a failure: `Edit cancelled — vim closed by ctrl+c`. A save that landed before the interrupt is still detected and applied.
- A GUI editor returns immediately without blocking (e.g. `code` without `--wait`), so the edit is treated as cancelled.

**Fix:**
1. Confirm the resolved editor command is installed and on `PATH`. Check `VISUAL` first, then `EDITOR`, then common GUI CLIs such as `cursor` or `code`; implicit GUI discovery skips empty, `.`, and relative `PATH` entries.
2. For an explicit GUI editor, use the blocking flag so SPLITBRIEF waits for you to save and close: `export VISUAL='code --wait'`.
3. For a one-off run with a known terminal editor: `VISUAL=vi splitbrief start "..."`.

**Prevention:** Point `VISUAL` at the editor you want, for example `cursor --wait` or `code --wait`. If `VISUAL` is empty and `EDITOR` is a terminal editor (`vi`, `vim`, `nano`), SPLITBRIEF will try safely detected GUI editors first so Task Brief editing does not stay inside the TUI terminal when a GUI editor is available.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §Review gates.

---

### Symptom: Cost status line shows blank or `--` instead of token / dollar values

**Likely cause:** The active runner does not emit `cost_update` events; the TUI displays nothing rather than fabricating values.

**Fix:**
1. Confirm the runner kind via `splitbrief status`. CLI runners often skip cost events.
2. Switch to `kind: api` for USD pricing when the provider/model is priced. `agent-sdk` can report token usage, but it remains unpriced because it is a meta/subscription runner.
3. If you must use a CLI runner and want approximate costs, post-process `summary.json` after the run rather than relying on the live status.

**Prevention:** Use `api` runners when live USD cost feedback matters.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/OTEL.md](./OTEL.md).

---

## Hooks

### Symptom: A user-declared hook fails the workflow

**Likely cause:** The hook command exited non-zero. SPLITBRIEF treats non-zero hook exits as failures and halts the workflow at the hook's gate.

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

### Symptom: `git commit` is blocked when running under SPLITBRIEF

**Likely cause:** This repository's agent workflow blocks staging and commits so the human owner reviews the final diff manually. Product-level `commitStrategy` settings may create checkpoints in user projects, but agents working in this repo must not stage or commit. A pre-tool-use hook (`.claude/hooks/block-git-commits.sh`) enforces the repo rule.

**Fix:**
1. Exit the SPLITBRIEF session.
2. Review the changes (`git status`, `git diff`).
3. If you are the human owner, stage and commit yourself (`git add ...`, `git commit -m "..."`). Agents working in this repository must not stage or commit.
4. If you need SPLITBRIEF to coexist with auto-commit tooling, run the auto-commit step outside this repository's agent session.

**Prevention:** Treat the post-session commit step as a manual review checkpoint, not a chore to automate away.

**See also:** [CLAUDE.md](https://github.com/b4r7x/splitbrief/blob/main/CLAUDE.md) ("CRITICAL — NEVER COMMIT, NEVER STAGE").

---

### Symptom: Per-task commit messages have unfamiliar format

**Likely cause:** When commits are eventually made (manually, by you), the recommended convention is to prefix with the task ID so commits map back to briefs. This is a convention, not enforcement.

**Fix:**
1. Use the task ID from the brief as a commit prefix: `git commit -m "T03: rename foo to bar"`.
2. Adjust to your project's convention if you prefer (Conventional Commits, ticket IDs, etc.) — SPLITBRIEF does not enforce a format.
3. Document the convention in your CONTRIBUTING.md so future contributors follow it.

**Prevention:** Agree on a commit convention up front and apply it consistently.

**See also:** [CONTRIBUTING.md](https://github.com/b4r7x/splitbrief/blob/main/CONTRIBUTING.md).

---

### Symptom: Want to skip per-task validation

**Likely cause:** Per-task validation is mandatory by design — it is the contract that makes briefs trustworthy. Skipping it weakens the entire workflow.

**Fix:**
1. The closest escape hatch is to set specific validation toggles to `false` in `.splitbrief/config.yaml` — e.g. `validation.test: false` to drop slow tests, or `validation.lint: false` to skip the linter. There is no `--no-validate` CLI flag.
2. Better: fix the underlying validation failure rather than bypassing it.
3. Better still: relax `validation.testCommand` (e.g. drop slow tests from the per-task check, leave them for CI).

**Prevention:** Treat validation toggles as a temporary debugging tool, not a permanent workflow option. If you find yourself disabling checks routinely, your validation config is wrong.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

## CI and headless

### Symptom: Headless run exits 0 having done nothing

**Likely cause (fixed):** A resume over a state with a **paused** or **applying** `pendingRecovery` used to exit 0 silently — the headless driver only failed on `awaiting-user`. The task loop now publishes a transcript-safe `warning` with `code: 'recovery_pending_unresolved'` naming the reason, status, and available actions, and headless fails with exit code 1 for every recovery status.

**Fix:**
1. Inspect the `recovery_required` record in the NDJSON stream — it now carries `status` (`awaiting-user` | `paused` | `applying`).
2. Resolve the recovery with `splitbrief continue --rpc <session-id>` and the matching `recovery` command, or `splitbrief resume` in the TUI and pick an action.
3. If the run truly did nothing, check `state.json` for `pendingRecovery` before assuming CI passed.

**Prevention:** Treat any `recovery_required` record as a hard failure in CI.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md).

---

### Symptom: `splitbrief start --json` output is interleaved with logs

**Likely cause:** Logs go to stderr, JSON goes to stdout. If you captured both streams together, they interleave. Console OTel (`OTEL_TRACES_EXPORTER=console`, `SPLITBRIEF_OTEL_EXPORTER=console`, or `--otel-exporter console`) also writes spans to stdout and can interleave with `--json`.

**Fix:**
1. Redirect stderr separately: `splitbrief start --json "feature" 2>splitbrief.log >splitbrief.json`.
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

**Prevention:** Wire drift checks into your CI script explicitly; do not assume SPLITBRIEF will fail the build for you.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Want CI to fail when drift exceeds a threshold

**Likely cause:** No built-in flag enforces a drift threshold; you wire it yourself.

**Fix:**
1. In your CI script, after `splitbrief start --json ...`, resolve the session id from readiness/session output, `.splitbrief/active`, or wrapper state, then parse `.splitbrief/sessions/<id>/summary.json`.
2. Read `driftSummary.score`, `driftSummary.errorCount`, or `driftSummary.warningCount`; use `chainDriftSummary.score` only for chain-drift gating.
3. Exit non-zero from the wrapper if the score exceeds your threshold:
   `node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1])); process.exit((s.driftSummary?.score ?? 0) > 0.7 ? 1 : 0)" .splitbrief/sessions/<id>/summary.json`.
4. Tune the threshold against representative runs.

**Prevention:** Bake the drift gate into your CI workflow definition so it is uniform across branches.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

## Config

### Symptom: Config rejected with a Zod schema error mentioning `version`

**Likely cause:** Your `.splitbrief/config.yaml` declares a version other than `3`, or uses a field shape the schema no longer accepts. There is no upgrade path — the load fails closed.

**Fix:**
1. Read the error — it states the expected `version` and the field that broke.
2. Regenerate from scratch (`splitbrief init --reconfigure`) and merge your customizations back manually.
3. Keep a copy of the old config under version control in case you need to diff.

**Prevention:** After a version bump, run `splitbrief doctor` and follow any config warning it reports.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: A config override (CLI flag, env var) does not take effect

**Likely cause:** Only specific startup options are overrideable. SPLITBRIEF loads project `.splitbrief/config.yaml`, applies explicit CLI runner/workflow flags for that invocation, and reads documented environment variables for provider keys, context length, OTel, terminal behavior, and editor selection. It does not load a global config file.

**Fix:**
1. Inspect `.splitbrief/config.yaml` for persistent values.
2. Check the command line for one-shot overrides such as `--planner`, `--implementer`, `--model`, or `--mode`.
3. Check the documented environment variables in `docs/CONFIGURATION.md`, especially provider API keys and `SPLITBRIEF_CONTEXT_LENGTH`.

**Prevention:** Put durable settings in `.splitbrief/config.yaml`. Keep CLI flags for one-off runs and environment variables for secrets or process-level behavior.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/BOOTSTRAP.md](./BOOTSTRAP.md).
