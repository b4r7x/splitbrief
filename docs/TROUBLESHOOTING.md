# Troubleshooting

Symptom-driven guide. Find the line that matches what you see, follow the diagnosis, apply the fix.

Each entry is structured as **Symptom → Likely cause → Fix → Prevention → See also**. Entries are grouped by area; jump to the section that matches the failing surface.

Stable `stateId` and runner `state` values with copyable remediations are indexed under [Run readiness and doctor diagnostics](#run-readiness-and-doctor-diagnostics). Use `splitbrief doctor --json` for automation.

Use the reported preparation error; a zero-blocker readiness count does not explain a session-ownership failure. Start and continue must acquire current ownership independently of discovery. A live or unknown competing owner is not permission to take over.

---

## Run readiness and doctor diagnostics

`splitbrief doctor` and the readiness gate on `start` emit the same remediation strings in human output and JSON. During workflow commands, runner subprocess failures normalize to `RunnerOutcome` `state` values in `session.jsonl` with the same copyable remediation pattern.

The two commands share the strings but not the verdict: `doctor` diagnoses and exits `0` on warnings, while `start` fails closed on a configured `kind: cli` runner that is denied admission — no trusted executable identity, a version not proven compatible, or a definitively negative authentication fact (no credential, or the tool answering signed-out). Those refusals land in both transports: start exits `1` with the remediation quoted, before creating a session, instead of aborting mid-run.

Unverified authentication is the one state where the verdict also splits by transport. A credential that exists but no call has proven reports readiness status `unverified` (stateId `auth-unknown`, severity warning), and a headless start (`--json` or `--plain`) refuses it unless `--allow-unverified-auth` is passed, while an interactive start discloses the unverified state and proceeds. `doctor` on a TTY reports it as a warning and exits `0`; its human output says so in one line — `No trusted readiness identity for <tool>: headless start would be refused; use --allow-unverified-auth or complete verification — interactive start proceeds.` — and `doctor --json` or a non-TTY stdin replays the headless blocker instead. See [CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-doctor).

### `splitbrief doctor --json`

`splitbrief doctor --json` writes one JSON object to stdout (not NDJSON):

```json
{ "type": "readiness_report", "report": { "status": "ready|blocked|warning", "nextAction": { ... }, "checks": [ ... ] } }
```

Each `report.checks[]` entry includes `id`, `severity`, `summary`, `stateId` (or `null`), and `remediation` (or `null`). Section titles from human output are omitted — parsers should use `stateId` and `remediation`, not decorative banners. `start --json` emits the same `readiness_report` shape as its first stdout line. `resume` re-probes CLI readiness for start gates but emits no `readiness_report`.

```bash
splitbrief doctor --json
```

Exit `0` when ready or ready-with-warnings; exit `1` when blocked (the JSON report is still written first). Full field reference: [CLI-REFERENCE.md](./CLI-REFERENCE.md#json-output-doctor---json).

### Readiness `stateId` index

Prefer these stable identifiers in automation and log correlation. Remediation strings match `src/core/readiness/format.ts`.

| Symptom (what you see) | `stateId` | Copyable remediation |
|---|---|---|
| Configured CLI is not installed or not on `PATH` (`spawn-not-found`, executable was not found). | `missing-binary` | Install the configured CLI, then run `splitbrief doctor` again. |
| Executable identity does not match the trusted fingerprint (untrusted project-bin or stale fingerprint). | `untrusted-path` | Install the configured CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again. |
| Installed CLI version is outside the tested or qualified range. | `incompatible-version` | Install the tested CLI version, then run `splitbrief doctor` again. |
| Required credentials are missing or invalid. | `unauthenticated` | Sign in to the configured CLI, then run `splitbrief doctor` again. |
| Auth probe could not determine login state. | `auth-unknown` | CLI authentication cannot be verified without spending a call: stored credentials prove presence, not a working session. The first real call settles it; if it fails to authenticate, sign in to the CLI again. |
| The CLI sign-in check timed out. | `auth-timeout` | Check the network connection, then run `splitbrief doctor` again. |
| The CLI sign-in check could not connect. | `auth-offline` | Check the network connection, then run `splitbrief doctor` again. |
| SPLITBRIEF could not read the CLI sign-in check result. | `auth-malformed` | Run `splitbrief doctor` again. If the result is still unreadable, update the CLI. |
| An access policy denied the CLI sign-in check. | `auth-policy-denied` | Check the account and access policy, then run `splitbrief doctor` again. |
| Provider `apiBase` violates the declared endpoint policy (wrong scheme, origin, or redirect target). | `endpoint-invalid` | Fix the provider endpoint to match its declared policy, then run `splitbrief doctor` again. |
| Environment credential prefix or family does not match the declared provider. | `credential-family-mismatch` | Use a credential that matches the declared provider family, then run `splitbrief doctor` again. |
| CLI or API output protocol error, including a missing terminal result line. | `protocol-failure` | Check the CLI or provider version and output protocol, then run `splitbrief doctor` again. |
| Provider returned quota or rate-limit pressure (for example HTTP 429). | `quota-rate-limit` | Wait for quota or rate limits to reset, reduce request volume, or switch providers, then run `splitbrief doctor` again. |
| Runner configuration contains mutually exclusive CLI arguments. | `conflicting-args` | Remove conflicting runner arguments from the config, then run `splitbrief doctor` again. |

On Linux, Antigravity session authentication reports `auth-policy-denied`. Choose another tool in Settings > Crew, or use macOS. Other policy refusals use the account and access policy remedy above.

A quota that runs out mid-run is not a readiness failure and is not answered here: the run raises a `runner-usage-limit` recovery, and that panel offers `switch-seat` — its recommended action whenever the last readiness pass saw another ready tool for that seat, or the seat declares a `fallback` — beside `retry-later` (when the message names a reset), `retry-same-worker`, skip and end. When the automatic-switch conditions hold, the seat moves to its configured fallback at once and asks nothing; see [Seat down](./APPROVAL-AND-RECOVERY.md#seat-down). SPLITBRIEF reads the limit message of these tools as a usage limit: codex, Claude Code, antigravity (`Individual quota reached … Resets in 2h6m30s` on stderr, with or without a `result` frame), opencode 2.x (the flat `provider.quota` error envelope) and command-code (`You've reached your weekly usage limit`), plus the Gemini API body behind antigravity (`RESOURCE_EXHAUSTED`). The limits of copilot, cursor and kilo-code classify through the shared phrases (`usage limit`, `quota exceeded`, `too many requests`, HTTP 429). A spent account is the same halt with no reset: a provider that will not bill the account (`Insufficient Balance`, HTTP 402, `payment required`, `insufficient_quota`) raises `runner-usage-limit` on the first failed call, with no retry and no planner consult; top up the account, take `switch-seat`, or let a declared `fallback` move the seat. A provider that refuses the login (HTTP 401 or 403, `unauthenticated`, `sign in`) raises `runner-unauthenticated`, which offers `switch-seat` beside the re-login retry.

Set the seat's fallback in Settings › Fallback, or write it in `.splitbrief/config.yaml` using [Configuration §fallback](./CONFIGURATION.md#fallback).
A fallback saved during a run applies at the next halt, in any phase.
Read the fallback row on the panel if no automatic switch occurs. It names an unavailable tool, the seat's current identity, or an automatic switch already used in this run.
`fallback: not read · config.yaml does not load` means the config of record failed to load. Fix that file before retrying; SPLITBRIEF does not use the prepared fallback in its place.
After an automatic switch, Settings › Fallback shows the old CLI seat as the fallback. An old non-CLI seat leaves no fallback. A manual switch keeps the fallback.

### Runner `state` outcomes (workflow commands)

During `start`, `spec`, `resume`, and other planner/implementer invocations, distinguishable subprocess outcomes use `state` (not readiness `stateId`). Remediation strings match `src/engine/runners/errors.ts`.

| Symptom (what you see) | `state` | Copyable remediation |
|---|---|---|
| CLI stdout, stderr, or protocol event stream exceeded the configured byte or line budget. | `output-budget-breach` | The tool wrote more than 64 MB of output and was stopped. Narrow what it was asked to print, then retry. |
| Implementer completed without staging the expected working-tree change. | `no-staged-change` | Make the requested change in the staged project, then retry. |
| Implementer tool call reached outside the isolation directory. | `implementer-left-isolation` | The implementer reached outside its isolation directory and was stopped. Check your checkout, then retry, switch the seat or skip the brief. |
| Git state changed during an implementer call. [Isolation checks](./APPROVAL-AND-RECOVERY.md#isolation-checks) defines which changes halt. | `checkout-changed` | Your checkout's git state changed while the implementer ran, and SPLITBRIEF reverted nothing. Check the named changes, then retry, switch the seat or skip the brief. |

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

**Likely cause:** The Node major is not 22 or 24. SPLITBRIEF supports Node.js 22 and Node.js 24. It is ESM-only and loads the native `better-sqlite3` module, which needs a supported Node ABI. On a Node older than 22, the CLI checks `process.versions.node` before it parses any argument and refuses with `splitbrief requires Node.js 22 or newer; this process is Node.js <version>.` rather than running and reporting a wrong diagnosis later — on Node 20 the CLI arg-vector preflight truncates its `--help` capture and reports flags the installed binary does support as unsupported.

**Fix:**
1. Run `node --version` and confirm output starts with `v22.` or `v24.`.
2. If not, install Node 24 LTS (`nvm install 24 && nvm use 24`) or Node 22 LTS, with `nvm`, `volta`, `fnm`, or your platform package manager.
3. Re-run `npm install` from a clean tree (`rm -rf node_modules package-lock.json && npm install`) so native bindings (better-sqlite3, etc.) re-resolve against the new ABI.
4. Re-run `npm run typecheck` to confirm the toolchain works end-to-end.

**Prevention:** Pin the engine in your shell profile via `nvm`/`fnm`. The `package.json` `engines.node` field declares the supported majors; add a `.nvmrc` if you frequently switch projects.

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

### Symptom: `Repo-map cache unavailable. Continuing without caching.`

The native `better-sqlite3` binding is missing or was built for a different Node version. SPLITBRIEF still parses the project and supplies the repo-map to the planner; only the cache is unavailable. The session log keeps the full diagnostic without printing its list of attempted paths into the conversation.

Run `npm rebuild better-sqlite3` in the SPLITBRIEF installation directory to restore the cache. Reinstalling dependencies with lifecycle scripts disabled can leave the native binding absent.

**See also:** [REPOMAP.md](./REPOMAP.md#cache).

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
4. For active-session blockers, run `splitbrief status`, then `splitbrief resume` or `splitbrief continue <session-id>`.

**Prevention:** Run `splitbrief doctor` after changing runner config or before CI starts a headless run.

**See also:** [Run readiness and doctor diagnostics](#run-readiness-and-doctor-diagnostics), [CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-doctor), [CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `Project config declares a shell runner command that this machine has not trusted`

**Likely cause:** The project's `.splitbrief/config.yaml` names a `shell` or `agent` runner command that this machine has never granted. A config file travels with `git clone`, so a command written there is the repository author's proposal, not your consent — SPLITBRIEF refuses to run it until you say so, whichever approval level is set.

**Fix:**
1. Read the command first. In `splitbrief doctor`, the seat shows the warning `PLAN runs a command you declared, with your permissions on this machine.` (or `BUILD` or `REVIEW`). The `Command:` line under it shows the command and its arguments. The check ids, such as `runners.planner.trust-boundary`, appear only in `splitbrief doctor --json`.
2. If you want it, run SPLITBRIEF in a terminal. It shows the resolved executable path, the argv, the working directory, and the environment names the runner declares in `env` (the only variables of your shell it gets), then asks for the confirmation phrase and a reason. Confirming stores an owner-only receipt in `~/.splitbrief/trust/custom-runners.json`.
3. In CI or any headless run (`--json`), pass `--allow-repo-runners`. It grants that run only and persists nothing.
4. If the command should not run, replace the runner in `.splitbrief/config.yaml`.

Related refusals name their own cause: `does not exist on this machine`, `is not executable`, and `executable changed since this machine trusted it` (the receipt binds the executable's content digest). `Configured command is outside the current trust policy` is the separate, stricter rule for repo-local commands, which need `--allow-repo-runners` even interactively.

**Prevention:** A receipt is scoped to this checkout's canonical path and to a digest of the command, its argv, its declared environment references, and its watchdog thresholds. Editing any of those, or opening a second checkout, asks again by design.

**See also:** [CONFIGURATION.md](./CONFIGURATION.md#runner-command-trust), [CLI-REFERENCE.md](./CLI-REFERENCE.md#splitbrief-start).

---

### Symptom: Run Readiness warns about validation, but tests were not run

**Likely cause:** Readiness is a pre-run posture check, not CI. It inspects `validation.end_checks`, the command a planner `test` check resolves (`validation.test_command` first), and obvious package-script availability without executing validation commands.

**Fix:**
1. If End-of-run checks are off intentionally (`validation.end_checks: false`), continue and run your validation manually.
2. If `test_command` references a missing npm script, add the script or update `.splitbrief/config.yaml`.
3. To verify the project now, run your real commands directly, such as `npm run typecheck`, `npm run lint`, and `npm test`.

**Prevention:** Keep validation commands cheap and reliable so warnings remain rare.

**See also:** [FEATURES.md](./FEATURES.md#run-readiness--doctor), [WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: Run Readiness warns that the working tree is dirty

**Likely cause:** Files are modified or untracked before Task Briefs exist. Readiness cannot know yet whether those files overlap the future task scope, so ordinary dirty state is a warning rather than a blocker. SPLITBRIEF's own files do not count: the `.splitbrief/` folder, and a `.gitignore` whose only change is the `.splitbrief/` line that `init` or Setup added.

**Fix:**
1. Run `git status` and decide whether the local edits should be part of this run.
2. Continue if the edits are intentional and unlikely to overlap.
3. Commit or stash the edits you do not want this run to touch.

**Prevention:** Start substantial runs from a clean checkout.

**See also:** [WORKFLOW.md](./WORKFLOW.md).

---

## Cost and billing

### Symptom: Anthropic / OpenAI bill spiked after a single run

**Likely cause:** The planner is configured with a frontier model (commonly Opus) and the implementer uses the same model. Every planner turn — each question round, the plan, its one repair, every consult and the review — is billed at the planner's price, and Opus pricing multiplies that fast.

**Fix:**
1. Open `.splitbrief/config.yaml` and inspect `planner.kind` and `planner.model`.
2. Keep Opus for the planner only when you genuinely need its planning quality; for most work Sonnet 4.6 is the better quality point.
3. Switch the implementer to a smaller or local runner: an `api` runner pointed at Ollama / LM Studio, or `cli` with a Haiku-class model.
4. Run `splitbrief status` to confirm the resolved configuration matches your intent.

**Prevention:** Keep the two seats on different models — that asymmetry is the entire point of SPLITBRIEF.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/ARCHITECTURE.md](./ARCHITECTURE.md), [docs/VISION.md](./VISION.md).

---


### Symptom: Cache hit percentage stuck at 0% in the cost status line

**Likely cause:** The active runner does not surface `cache_read_input_tokens`. CLI runners (`claude-code`, `codex`, `opencode`, etc.) often emit aggregate token counts only, with no cache breakdown; the orchestrator reports what it receives.

**Fix:**
1. Confirm runner kind via `splitbrief status` or `.splitbrief/config.yaml`.
2. If you require cache visibility, switch the planner / implementer to `kind: api`: the OpenAI-compatible stream reads `prompt_tokens_details.cached_tokens`, so cache counts appear whenever the endpoint reports them.
3. For CLI runners, accept that the cache % will be `0` (or `n/a`) and rely on the absolute token totals instead.

**Prevention:** Choose `api` runners when cache observability matters for cost analysis.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md).

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

### Symptom: `splitbrief start` stops with `Cannot start:` and names an `@file` input or the feature description

**Likely cause:** An `@file` input is missing, is not a regular file, exceeds 10 MiB, or SPLITBRIEF cannot read it. Non-image content is binary or is not UTF-8 text. The feature description is empty before `@file` inputs, or it starts with `@`.

**Fix:**

1. Check each refused path against its error message. `~/` works. Relative paths resolve against the project root. SPLITBRIEF follows symlinks.
2. Name a regular, readable UTF-8 text file or a supported image up to 10 MiB.
3. Put the feature description first: `splitbrief start "<feature>" @<file>`.

**Prevention:** Check each path before you start. Put the feature description before all `@file` inputs.

**See also:** [CLI Reference: splitbrief start](./CLI-REFERENCE.md#splitbrief-start).

---

### Symptom: The composer shows `Cannot send:` after an `@file` reference

A refused plain send keeps the whole draft, history, and pending images unchanged. Feedback ends with ` File: <base name>.`. The base name uses at most 24 terminal cells. Read the reason before you send again.

`/steer` accepts the same `@` references. A refused `/steer` clears the draft and records the command in history; ↑ recalls it. The refusal sends no correction and leaves pending images unchanged.

| Reason | Fix |
|---|---|
| `not-found` | Check the path and try again. |
| `not-a-file` | Name a file, not a directory. |
| `too-large` | Choose a file at most 10 MiB. |
| `unreadable` | Check the file's read permissions. |
| `not-text` | Choose a UTF-8 text file or a supported image. |

Overlong paths and symlink loops use `not-found`. A bare composer `@word` stays prose for that reason. A token with `/` or matching quotes refuses the send.

Image-only actions also refuse unsupported formats with `not-image`. Choose PNG, JPEG, GIF, WebP, or BMP. If the PLAN seat cannot see images, select a vision model with `/crew plan`.

Files can be inside or outside the project. Relative paths use the project root. `~/` works, and SPLITBRIEF follows symlinks. See [composer syntax](./FEATURES.md#file-context-injection) for quoted paths and bare references.

---

### Symptom: `runners.cli.claude-code.readiness` is `unauthenticated` on macOS

**Likely cause:** Claude Code keeps its subscription session in the macOS login keychain. A `session` runner on macOS reads that keychain with your real `HOME` and `USER`, so readiness runs `claude auth status` inside the staged environment and reports exactly what the child answered. `unauthenticated` here means the child got `"loggedIn": false` — the host is not signed in, or is signed in as a different account.

**Fix:**
1. `claude /login` (or `claude setup-token`), then `claude auth status` to confirm `"loggedIn": true`.
2. Re-run `splitbrief doctor`.
3. Do not set an explicit `auth_channel` to work around it: readiness refuses any explicit method, because no CLI tool has an enforceable method ([AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md)), so the child runs on the login `claude` itself holds.

**Prevention:** Trust `splitbrief doctor` — including its refusals to overclaim. Readiness never reads a login off directory contents alone. For session-channel tools such as Codex, a positive `codex login status` proves a credential is present, not that the token is still live — the first real call settles liveness, and a dead token fails there with its own remediation (a host whose refresh token was rotated away server-side can still print `Logged in using ChatGPT` while every real call returns 401). A definitive negative — no credential, or the tool answering signed-out — still blocks, because that run really would have failed.

**See also:** [docs/API-KEYS.md](./API-KEYS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: codex shows unverified although it is installed and logged in

**Likely cause:** Detection was cached before the auth-policy change that treats a positive local `codex login status` as authenticated. Older cache rows stored `auth: "unknown"` for a positive login probe.

**Fix:** Refresh detection — caches written before the auth-policy change are discarded automatically on upgrade.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) (readiness states).

---

### Symptom: Planner returns vague briefs — generic acceptance criteria, no file references, hand-wavy steps

**Likely cause:** The task text leaves the planner too much to guess, or the planner model is undersized for the codebase.

**Fix:**
1. At the plan card, choose **Request changes** and say what the plan must name: the files, the acceptance criteria, the checks. The planner revises the plan in the same session.
2. Put the constraints in the task text up front, so the planner asks fewer questions and guesses less.
3. Confirm the planner is large enough — Sonnet 4.6 minimum, Opus for unfamiliar codebases.
4. Tune the codebase config (`codebase.tokenBudget`) so the planner sees enough of the codebase to ground its references.

**Prevention:** Keep `workflow.approve: plan` (the default) for real feature work, so you read the plan before any code is written.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), [docs/REPOMAP.md](./REPOMAP.md).

---

### Symptom: Planner times out before producing a brief

**Likely cause:** An `api` planner has three deadlines. The total call has 10 minutes (`TIMEOUTS.reviewerMs`). The first response must arrive within 120 s. A 60 s stream-idle guard applies between chunks. A cold-loading local model (Ollama or LM Studio loads the model into memory) usually hits the first-response deadline. Non-`api` planners (`cli`, `shell`, `agent`) have no default limit. The **inactivity watchdog** warns after 5 minutes of no output. Beside the build block, the byline shows the normal live status. Where no block is painted, the byline reads `⚠ No output for 5:00`. The call continues until it ends or you press Esc. Set `idleKillMs` to cut a silent call, or `planner.timeout` to put a wall-clock cap on the whole call; both are opt-in.

**Fix:**
1. Warm the model before the run so the first token arrives within 120s — e.g. issue one throwaway request to your local server, or pre-pull the model so it is resident.
2. Set `planner.timeout` (milliseconds) in `.splitbrief/config.yaml` to put a total wall-clock budget on each planner call (Opus planning passes can take several minutes). This caps the whole call; it does not extend the 60s idle guard.
3. If the planner is genuinely stuck (no token activity), check provider status pages and your network; restart the run.
4. Reduce `codebase.tokenBudget` so the prompt is smaller and the call returns sooner.

**Prevention:** Keep local models warm so the first response arrives within the 120s first-response deadline, and set `planner.timeout` as a total-call ceiling for high-latency planners.

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

### Symptom: the run halted with "Plan still fails its checks after one repair"

**Likely cause:** SPLITBRIEF checks every plan before the build: each criterion needs a check, each task needs a suggested file inside the project, the dependencies must not form a cycle, and each task must fit the implementer's context. A failing plan goes back to the planner once with the failed checks. When the repaired plan still fails, the run halts on a `plan-checks-failed` recovery rather than building a plan that cannot be verified. A planner that still asks questions after 2 rounds halts the same way, on `plan-questions-exhausted`.

**Fix:**
1. Read the halt's details: they list each failed check in plain words.
2. Answer the recovery panel. `revise` (recommended) sends the planner your correction in the same session. `retry-same-worker` asks again without a correction. `end-run` closes the run and keeps whatever is on disk.
3. Headlessly, the halt prints the `continue --action …` line and exits 1: `splitbrief continue <session-id> --action retry`, or `--action end-run` to close it.
4. If the same check fails again and again, the planner model may be too small for the typed plan: raise the planner model.

**Prevention:** Name the files and the expected behaviour in the task text; a plan whose criteria the planner can tie to concrete checks passes on the first try.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

## Reviewer issues

### Symptom: the run refuses to start with a blocker naming the Reviewer

**Likely cause:** `.splitbrief/config.yaml` carries a `reviewer` block, and that runner failed the same fresh admission the planner and implementer go through. A configured reviewer is a candidate in `prepareExecution()` under its own slot, so a missing binary, an untrusted command, an unverified login, or an unreachable endpoint stops the run before the first planner call — the seat is not quietly skipped just because it is used last.

**Fix:**
1. Run `splitbrief doctor` and read the `REVIEW` lines under `Runners:`. One line says whether REVIEW is ready to start, or why it cannot start. A `cli` reviewer also has the line of its tool, which says whether that tool is installed, compatible and signed in. An `api` reviewer has a line that says whether its endpoint answered. A `shell` or `agent` reviewer shows the warning `REVIEW runs a command you declared, with your permissions on this machine.` and its `Command:` line. `splitbrief doctor --json` gives the same checks with their ids (`runners.preparation.reviewer`, `runners.availability.reviewer`, `runners.reviewer.trust-boundary`).
2. Fix it the way you would fix the same condition on the planner — the `stateId` families and remediations in the [readiness index](#readiness-stateid-index) apply unchanged.
3. A `shell` or `agent` reviewer needs its own trust grant on this machine, exactly like a `shell` planner.
4. If you do not need a separate reviewer right now, delete the `reviewer` block. The planner takes the seat back and the run behaves as it did before the seat was assignable.

**Prevention:** Run `splitbrief doctor` after changing the reviewer through `/crew review` or Settings › Crew. The picker writes config; it does not prove the tool will start.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md).

---

### Symptom: the run finished but the review says it failed, and no review was written

**Likely cause:** The reviewer was admitted at start and then failed during the final-review call — the process died, the endpoint went away, the credential expired mid-run, the call timed out. The phase records `reviewStatus: 'failed'`, publishes an error carrying the reviewer's display name, records the final-review evidence anyway, and still builds the run summary. `finalReviewStatus` in `summary.json` and `finalReview.status` in the review packet both say `failed`.

A REVIEW account refusal or long-reset limit raises a Seat down halt. Its configured fallback can take the seat once per run under the [automatic-switch conditions](./APPROVAL-AND-RECOVERY.md#seat-down). Set it in Settings › Fallback. While REVIEW follows PLAN, it uses PLAN's fallback. Switching that REVIEW writes a `reviewer` block and leaves PLAN unchanged. Other review failures keep their failed evidence; SPLITBRIEF does not silently hand the review to PLAN.

**Fix:**
1. Read the error on the run screen or in `session.jsonl` — it names the reviewer seat, so you can tell a reviewer failure apart from a planner failure at a glance.
2. Fix the underlying runner (see the readiness families above), then re-run the review by continuing the run: it picks up at the review it reached.
3. To get the review from the planner instead, remove the `reviewer` block (or point `/crew review` at the planner's tool) and resume. That is a decision you make, not one SPLITBRIEF makes for you.

**Prevention:** Give a metered reviewer a `timeout` that fits a diff-sized read, and prefer a reviewer whose credentials do not expire mid-run.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/HOW-IT-WORKS.md](./HOW-IT-WORKS.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: the run halted with "Review input too large for OpenAI Codex CLI"

**Likely cause:** The final review prompt is larger than the reviewer tool accepts. Codex takes at most 1,048,576 characters. SPLITBRIEF already trimmed whole new files, the diffs of files no brief declares and the recorded evidence, and the rest of the run diff is still over the cap. The same halt follows when the tool itself answers `input_too_large`.

**Fix:**
1. Read the halt details. They name the prompt size, the cap and the largest file diffs.
2. Choose **Skip review** to make a workspace run ready to apply with no review. Your note is recorded, and Apply asks for one confirmation. Nothing is reported as verified.
3. Or choose **End run**. The changes are saved in `.splitbrief/sessions/<id>/run.patch`, and the workspace is removed.
4. A retry is not offered, because it would send the same input. For the next run, give the review seat a tool with a larger input (`/crew review`), or keep the run smaller.

**Prevention:** Smaller runs. Keep generated or vendored files out of the briefs' declared files.

**See also:** [Review input too large](./APPROVAL-AND-RECOVERY.md#review-input-too-large).

---

### Symptom: the reviewer said `fail` — what now

**Likely cause:** The reviewer read the whole diff and returned the verdict `fail` with Critical findings. This is a verdict, not a runner failure: the review happened, and it says the work is not done.

SPLITBRIEF tries to fix it before it tells you. Each Critical finding is mapped to the brief whose `files` its paths name, those briefs re-enter implementation with the finding text as the error block, gates and drift run again, and the review is re-run. At most **two** such cycles per run (`REVIEW_CYCLE_CAP`). What you are looking at is the state after those cycles.

**Fix:**
1. Read `.splitbrief/sessions/<id>/review.md` — the Critical findings are the blocking list, in the reviewer's own words. The recovery panel's headline reads `Final review failed with <n> blocking findings`, and the run's `Packet` row names the `review-packet.md` to open.
2. Choose **Send a correction** to send the findings back for one more fix cycle, with your note beside them. On a worktree or staged-copy run, **Accept as is** records an Accept as is override and makes the result ready to apply with the open findings; see [Accept as is](./APPROVAL-AND-RECOVERY.md#accept-as-is). Nothing reaches your checkout before Apply.
3. A finding whose paths name no brief cannot be routed back, so it is never auto-fixed — those are the ones to read first.
4. An unparseable verdict is re-asked once; a second unparseable reply is reported as `review: failed (unparseable verdict)`. That is a reviewer-output problem, not a code problem — check the reviewer's output format before re-running.
5. Headless runs exit `1` on a failed review even when every task reached `done`, and `--plain` writes `review: failed (<n> blocking)` followed by the closing `done:` line. In CI, treat that exit as "the diff needs a human", not as an infrastructure failure.

**Prevention:** Smaller slices. A brief that is one verifiable change gives the reviewer something it can accept or reject cleanly, and gives a re-entry cycle a chance of fixing it.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) (the `final-review → implementing` edge), [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md#plain-output-stream---plain).

---

## Implementer issues

### Symptom: Implementer modified files outside the brief's declared scope

**Likely cause:** The model wandered. Drift detection should flag it during the final-review phase, but if you see drift only after merging it means the report was ignored or the brief scope strings were too broad or too short.

**Fix:**
1. Inspect `.splitbrief/sessions/<id>/drift-report.json` for in-bounds and out-of-bounds touched paths.
2. If the changes are legitimate (the brief was incomplete), keep them. A brief's files are suggestions: an ordinary write outside them is recorded as `write_out_of_scope`, not refused ([APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation)).
3. Correct unwanted changes in the run workspace before Apply, or discard the run. After Apply, [`/run reject confirm`](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject) undoes its guarded writes.
4. For repeat offenders, raise the implementer model or tighten the brief's scope language.

**Prevention:** Always check the drift report before accepting a task or making any manual commit. Treat unexpected out-of-bounds files as a planning bug, not implementation noise.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: the run halted with "T00N left the isolation directory"

**Likely cause:** One of the implementer's tool calls wrote outside the isolation directory it was given — into your checkout, into its linked `node_modules` through a package-manager install, or anywhere else on the disk — and the tripwire stopped the call. The halt's sentence carries the evidence: `T004 left the isolation directory · Google Antigravity CLI wrote to ~/Projects/app/src/index.ts (your checkout) with run_command: touch ~/Projects/app/src/index.ts`. When the git state of your checkout also changed during the stopped call, the evidence ends with `; ran while your checkout changed: tag v1.2`.

A read, list or search outside the isolation directory does not halt. The tripwire logs it as an `isolation_outside_read` warning and the call goes on: `Task T004 searched ~ (outside the workspace) with run_command: find ~ -name "process-invoke.ts" 2>/dev/null`. The warning is in the transcript, in `session.jsonl` and in the review packet's warnings list. A tool whose shell does not start in the isolation directory is the usual source: it cannot find the project and searches the disk for it. See [Isolation checks](./APPROVAL-AND-RECOVERY.md#isolation-checks).

**Fix:**
1. Read the evidence on the recovery panel or in the `Seat down (implementer-left-isolation): …` line a headless run printed.
2. If the evidence reads `ran while your checkout changed`, look at each named change in your checkout first. SPLITBRIEF reverts nothing there: a new tag, a stash, a hook or a git config change stays until you undo it. The halted attempt writes nothing into your checkout; its output stays in the run workspace.
3. Choose **Try again** (`splitbrief continue <session> --action retry`) to run the brief again; the implementer prompt names the isolation directory and tells the implementer to stay in it. Choose **Change BUILD tool** when the same tool keeps leaving, or **Skip task** to move on.
4. If the evidence reads `ran a package-manager command`, the brief needs a dependency change: make it in your checkout yourself (`npm install <pkg>`), then retry. A package-manager install, ci, add, remove or update from the isolation directory writes into your checkout's shared `node_modules`, so it always halts. A write to a tool cache there (`node_modules/.vite`, `node_modules/.cache`) does not halt. A write to `node_modules/.bin` or to a package manager's lockfile marker halts.

**Prevention:** Prefer tools whose shell runs in the directory SPLITBRIEF gives them. The halt is a check SPLITBRIEF makes on what the tool reports and on what the checkout shows afterwards — not a sandbox: a write to a path no tool call names, into a directory outside the checkout, or into a gitignored file of the checkout goes unseen.

**See also:** [APPROVAL-AND-RECOVERY.md §Recovery](./APPROVAL-AND-RECOVERY.md#recovery), `src/engine/implementers/isolation/`.

---

### Symptom: the run halted with "Repository changed under T00N"

**Likely cause:** Git state that the run shares with your checkout changed while an implementer call ran: a branch other than the current one, a tag, the stash, a hook, the git config or the installed `node_modules` set. A change to the run worktree's own `HEAD`, branch or index halts too. The halt's sentence names each change: `Repository changed under T004 · tag v1.2 · hook pre-commit`, or `Repository changed under T004 · run worktree branch splitbrief/<session-id>` when something committed inside the run worktree. The audit sees what changed, not who changed it: a hook that is still running, or another agent that creates or moves an audited branch ref in the same repository, halts the brief too. See [Isolation checks](./APPROVAL-AND-RECOVERY.md#isolation-checks).

A commit, a branch switch or a pull in your checkout does not halt the brief: a move of the checkout's `HEAD` or current branch is Apply's work. Apply merges it with the run's result, and an overlap it cannot merge stops Apply with an `apply-conflict` halt instead ([Apply conflicts](./APPROVAL-AND-RECOVERY.md#apply-conflicts)). A changed file does not halt the brief either, because an editor save changes files too. The run publishes the `checkout_changed_during_call` warning and continues: `Task T004: your checkout changed while Google Antigravity CLI ran — src/app.ts; nothing there was reverted`. The warning is in the transcript, in `session.jsonl` and in the review packet's warnings list.

**Fix:**
1. Read the evidence on the recovery panel or in the `Needs you (checkout-changed): …` line a headless run printed.
2. Look at each named change in your checkout or in the run worktree. SPLITBRIEF reverts nothing there: a new tag, a stash, a hook or a git config change stays until you undo it. The halted attempt writes nothing into your checkout.
3. If the change is yours, choose **Try again** (`splitbrief continue <session> --action retry`).
4. If the change is not yours, undo it. Then choose **Try again**, **Change BUILD tool** or **Skip task**.

**Prevention:** Do not stage or commit inside the run worktree. While a brief runs, do not create tags or other branches, stash, or change hooks or the git config, and do not start agents that create or move branches in the same repository. Commits and branch switches in your checkout are safe; Apply merges them.

**See also:** [APPROVAL-AND-RECOVERY.md §Recovery](./APPROVAL-AND-RECOVERY.md#recovery), `src/engine/implementers/isolation/checkout-audit.ts`.

---

### Symptom: The implementer says it finished but nothing changed

**Likely cause:** The runner completed its call without writing any file. Change detection (`detectChanges()`, `src/engine/change-detection.ts`) reports the distinct `no-files-changed` reason, the task fails with the `no-staged-change` outcome, and SPLITBRIEF publishes one coded warning — `category: implementer`, `code: implementer_wrote_nothing` — naming the runner and the task. The warning lands in `session.jsonl` and in the review packet's warnings list (`review-packet.json` → `escalations.warnings`). Two calls are the exception, and each may verify and change nothing: a fix attempt for an appended review fix task, whose code is already on disk, and the first call of a brief continued after a stop or a *Seat down* halt, with or without a correction, when the brief already changed its declared files before it was cut. A fix attempt's done row reads `verified · no change needed`. A continued brief's done row names the files it kept and reads `verified · kept the interrupted attempt's work · no further change`.

**Fix:**
1. Read the warning in the transcript or `review-packet.json`. A "finished but wrote nothing" response is a model behaviour problem, not a SPLITBRIEF failure — the retry ladder runs exactly as it would for any other failure.
2. Inspect the implementer's output in `session.jsonl` around the task's `implementer_generate_running` / `implementer_generate_failed` events to see what the runner actually said.
3. Re-run with a stronger implementer model, or tighten the Task Brief so the runner has a concrete edit to make.

**Prevention:** Prefer a `direct`-write runner verified against the task file, and check the review packet's warnings list after a run — the `implementer_wrote_nothing` warning is the signal that the model reported success without touching the tree.

**See also:** [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), `src/engine/change-detection.ts`, `src/engine/implementers/pipeline/run.ts`.

---

### Symptom: Implementer keeps failing the same task in a loop

**Likely cause:** The task is genuinely too hard for the implementer model, or the brief contains contradictory constraints. The orchestrator retries once and then asks the planner, so you may see the same failure repeat before the consult lands.

**Fix:**
1. Watch the attempt counter in the build block — it reads `attempt <a> of 8` and the consult runs after the first retry.
2. Inspect `evidence.json` and the task log to see whether failures are typecheck, test, or runtime.
3. Read the consult row (`PLAN → T00N: … · <diagnosis>`). Guidance retries the brief; a `rewrite-task` or `split-task` answer changes the brief itself; `ask-user` is the one question that asks you.
4. If a bound was spent, answer the `consult-bound-spent` recovery: **continue** with a note grants +1 consult and +4 attempts, or take `skip-current-task` or `end-run`.
5. As a last resort, take `skip-current-task` and plan the remaining work in a new run.

**Prevention:** Give the implementer a model that matches the brief's difficulty. There is no retry count or intermediate model to configure: `workflow.max_retries` and the `escalation` block are retired.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/task/loop.ts`.

---

### Symptom: Implementer fails repeatedly against a local model that is not running

**Likely cause:** An `api`-kind implementer probes its provider's model list instead of assuming a local endpoint is up (`createProviderAvailability`, `src/engine/providers/client/availability.ts`). A dead daemon fails the probe, and the availability gate raises the unavailable-implementer recovery immediately — no local retry and no consult is burned against the dead endpoint, so a stopped Ollama/LM Studio cannot cost you a planner call.

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

### Symptom: the run halted with "Tool recipe rejected by Claude Code CLI" and `sandbox required but unavailable`

**Likely cause:** The sandbox of the Claude Code implementer cannot start. The Claude Code implementer runs its shell commands in Claude Code's own sandbox, and SPLITBRIEF sets `sandbox.failIfUnavailable` to `true`. A sandbox that cannot start therefore stops the seat at startup; the seat never runs its commands without the sandbox. Claude Code prints this on stderr:

```text
Error: sandbox required but unavailable: <reason>
  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.
```

On Linux and WSL2 without `bubblewrap` or `socat`, `<reason>` reads `sandbox is enabled but dependencies are missing: … · install missing tools (e.g. apt install bubblewrap socat) …`. On WSL1 it reads `sandbox is enabled but WSL1 is not supported (requires WSL2)`. SPLITBRIEF halts the brief on the `sandbox required but unavailable` line and spends no retries.

Readiness finds the usual cause before the run starts. On Linux, when an implementer profile is `cli` `claude-code`, the check `runners.sandbox.claude-code` looks for `bwrap` and `socat` on the absolute `PATH` entries, as the seat does, and names each missing program: `Claude Code sandbox cannot start: socat is not on PATH.` It is a blocker when that profile is the default implementer, and a warning for any other profile. `splitbrief spec` and `splitbrief review` call no implementer, so they skip the check. The check does not start the sandbox, so a `bwrap` that AppArmor refuses passes readiness and still reaches the startup halt.

Without `failIfUnavailable`, Claude Code prints `⚠ Sandbox disabled: <reason>` and runs the commands without the sandbox. SPLITBRIEF no longer lets the implementer run that way. That warning line never halts the brief.

A related case does not halt at startup. When SPLITBRIEF itself runs inside another sandbox on macOS, for example from a sandboxed agent session, Claude Code starts, but every shell command of the implementer fails with exit 71 (`sandbox_apply: Operation not permitted`). The implementer then cannot run its own checks.

**Fix:**
1. On Linux or WSL2, install both packages (`sudo apt-get install bubblewrap socat` on Debian and Ubuntu). Run `splitbrief doctor` to confirm the `runners.sandbox.claude-code` check, then choose **Try again**.
2. If the packages are installed and shell commands still fail, check the AppArmor restriction on Ubuntu 24.04 and later. [Set up Linux and WSL2](https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2) gives the check and the `bwrap` profile.
3. On WSL1, move the project to a WSL2 distribution.
4. On macOS, start SPLITBRIEF from an ordinary terminal, not from inside another sandbox.
5. To finish the run on another implementer, choose **Change BUILD tool**.

**Prevention:** Run `splitbrief doctor` before the first run: on Linux the `runners.sandbox.claude-code` check names a missing `bwrap` or `socat`. Run `claude` once in the project and open `/sandbox`: its panel also names a missing package.

**See also:** [PLANNERS-AND-IMPLEMENTERS.md §Posture, trust, and auth](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth), `src/engine/runners/cli-tools/claude-code.ts`, `src/core/readiness/checks/claude-sandbox.ts`, `src/core/pipeline-spec/halts.ts`.

---

### Symptom: A message waits while BUILD works on a brief

**Likely cause:** The current tool or call has not returned, or checks still run. Enter queues the message and lets work continue. A matching steerable call uses the `read after this tool` timing. Otherwise, BUILD takes the message at its next safe break. See [Message queue](./ENGINE.md#message-queue) for delivery during calls and checks. See [Mid-call steering](./PLANNERS-AND-IMPLEMENTERS.md#mid-call-steering) for tool support.

**Fix:**

1. Read the byline for the receiving seat and brief, for example `1 queued for BUILD on T003`.
2. Use `/queue show` to inspect the queued count.
3. Use `/queue clear` to remove messages awaiting first delivery.
4. To send now, press `ctrl+⏎` with text or use `/steer <text>`.

`ctrl+⏎` stops now and continues with the text. A terminal without extended keys reports this key as Enter, which queues the message. `/steer` works in every terminal. See [Input footer](./FEATURES.md#input-footer) for transcript delivery rows.

**Prevention:** Check the composer placeholder before sending. Enter delivers at the earliest supported break; `/steer` stops now. The queued count drops only at first delivery. `/queue clear` preserves delivered history, including messages that REVIEW read and BUILD still needs. See [Queued count](./ENGINE.md#queued-count).

---

### Symptom: I want to stop a run and I am not sure which key does what

**Likely cause:** Older builds spent `esc esc` on an interrupt ladder with a 2-second armed window, and quitting was a ladder of its own. The interrupt ladder is gone: `esc` opens the **Stop options** sheet, and `ctrl+c` stops a live run in one press. Quitting still asks once: every first `ctrl+c` shows `Press ctrl+c again to quit`, and a second press within two seconds quits after cleanup and saving. On a live run, that first press is also Stop now.

**Fix:**
1. `esc` opens the **Stop options** sheet, with or without a draft (on the plan card, the first `esc` clears a comment draft and returns the keys to the card rows): `Stop now` (stop execution; keep partial changes — they stay in the run workspace), `Pause after this brief` (finish `T<id>` including checks and review; start no next brief), `End run` (stop execution; close this run; keep changes — a worktree or staged-copy run saves them in `run.patch` before its workspace goes). `↑↓ · ⏎ · esc`, no letter keys. `esc` from the sheet is Stop now — it goes back to sessions once the run is parked or at rest — and `Tab` dismisses the sheet without stopping. No option writes the run's changes into your checkout; only Apply does.
2. `ctrl+c` is Stop now, immediately, one press. It aborts the in-flight call along with any retry, consult or per-task review call, and parks the run as `Stopped at T<id>`, followed by `· Partial changes kept` when the brief had already changed files. The same press arms a two-second quit confirmation (`Press ctrl+c again to quit`). A second press within two seconds, or while the stop is still running, quits after cleanup and saving. Once the run is stopping or parked, the next `esc` goes home instead.
3. `ctrl+q` or `/quit` stops safely, saves the session, then exits.
4. With text in the composer, `esc` opens the same sheet and leaves the draft in place — the composer swallows no part of the key.
5. Restart with `/resume` (type instructions first if you want to steer) or from the shell with `splitbrief continue <session-id>`; a continuable run at rest continues on a bare `⏎`, and a blank `⏎` resumes a run parked in this process exactly as `/resume` does; typed text steers it. `/end` closes a parked run; after that nothing picks it up.

**Prevention:** None needed — the legend row states the live keys (`esc stop options · ctrl+c stop now · ctrl+k commands · /help`), and a cancelled call still never spends an attempt or a consult: an aborted implementer call stops the retry loop, and the attempt counter rolls back to the value it had before it.

**See also:** [docs/FEATURES.md](./FEATURES.md#stopping-a-run), [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) (retry arithmetic), `src/engine/orchestrator/escalation/local-retries.ts`.

---

### Symptom: two consecutive timeouts halted my run

**Likely cause:** The implementer hit a limit twice in a row on the same brief. A `cli`, `shell` or `agent` seat has no default limit, so this halt follows an opt-in `timeout` or `idleKillMs` on the seat, or the role total of an `api` seat (`TIMEOUTS.implementerMs`, 20 minutes, for BUILD; 10 for REVIEW). A second consecutive timeout or idle cut on one brief raises the recovery issue `runner-timeout-repeated` — `<tool> timed out twice in a row on T00N` — instead of retrying or consulting the planner, because handing an unfinishable brief to the planner only spends planner money on the same defect.

**Fix:**
1. Read the issue's details: they carry the tool's own last message, the attempt count, and the implementer profile that was selected.
2. The halt is *Seat down*. The offered actions are retry, switch seat (when another ready tool was detected), skip the brief, or end the run. Headless, the stderr block prints the exact line to paste — for example `splitbrief continue <session> --action retry`.
3. If the brief is simply too large for this seat, the durable fix is to split it in a new plan along its independent outcomes, so each brief is one coherent change the seat can finish.
4. If the tool is genuinely slow rather than stuck, raise or remove its seat's `timeout` and `idleKillMs`, or move the seat to a faster model.
5. Know the two limits: `idleKillMs` cuts on *no output*, and `timeout` cuts on total wall clock. Both count toward this halt. A call that produces output steadily still times out at its `timeout`.

**Prevention:** Keep each brief to one coherent outcome, and give a slow local model a bigger `timeout` before the run rather than after the second halt.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) (`timeout`), [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

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

### Symptom: A check fails after a task or before the review; workflow blocked

**Likely cause:** A brief's check or a reviewer check ran against the implementer's output and failed. A failed brief check retries the brief. A reviewer check with new failures stops the list and reaches the reviewer as a pending input, and the reviewer returns the fix work. SPLITBRIEF never stages or commits the result.

**Fix:**
1. Open `evidence.json` for the run; the checks log lists the exact failing command, its exit code and its output.
2. If the failure is a real implementation bug, let the retry or the review fix cycle run — the implementer sees the previous failure as feedback.
3. If a plan check is misconfigured (wrong command, missing dependency), request changes on the plan card or fix `validation.test_command` in `.splitbrief/config.yaml`. A reviewer check comes from the reviewer: correct it with a note on the review.
4. As a last resort, set `validation.end_checks: false` to run no reviewer check while you debug — you are then responsible for running the checks manually.

**Prevention:** Keep `validation.test_command` minimal but reliable. Keep the project's own scripts and CI configuration current: the reviewer reads them to choose its commands.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: A check fails because an environment variable is missing

**Likely cause:** The variable has a credential name, or it selects a credential file, profile or helper. SPLITBRIEF drops these variables from plan checks, reviewer checks, base re-runs, fix checks, `render` checks and the formatter. Examples include provider API keys, cloud tokens, `AWS_PROFILE`, `SSH_AUTH_SOCK`, `GIT_ASKPASS` and npm userconfig selectors. Other defined variables reach checks, including `NODE_OPTIONS`, `DATABASE_URL`, `DISPLAY`, `XDG_RUNTIME_DIR` and project settings. The real `HOME` and `USERPROFILE` stay; `PATH` keeps only absolute entries. See [CONFIGURATION.md §What a check can reach](./CONFIGURATION.md#what-a-check-can-reach) for the environment rule and its limits.

**Fix:**
1. Read the check's output in `evidence.json`. Find the variable the test reads.
2. Rename the variable to an ordinary name, and update the test to read that name.
3. Or let the test read the value from a project file, such as a test `.env` file.
4. Or run that test yourself, and tell the reviewer the result in a note on the review.

**Prevention:** Keep the tests that need a secret or a live service out of the commands the reviewer can choose, or give them a local default.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md#what-a-check-can-reach), `src/lib/process/spawn/child-env.ts`.

---

### Symptom: A plan check is `refused`

**Likely cause:** The plan command policy refused the planner's command when the check ran. The row names the rule, for example `Plan check K2 · npm run lint · refused · runs the npm script lint, which package.json does not define`. A package script (`npm run <script>`) runs only under an approved plan and only when `package.json` defines the script. `checkPlan` already sends a plan back to the planner when the command text breaks the policy, so a refusal during Build is usually a script that `package.json` does not define.

A refused check did not run. SPLITBRIEF records it as refused, not as failed, and the reviewer sees it as refused. An optional refused check does not stop the run. A required refused check halts the run before the review with `Required checks cannot run: <id>`.

**Fix:**
1. Read the reason on the row.
2. For the next run, to run package scripts as plan checks, set `workflow.approve: plan` and approve the plan card. A halted run keeps the approve level it recorded at planning.
3. Or end the run and start it again, so the planner names an allowed command, such as `npm test` or a `test` check.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md#reviewer-checks), `src/engine/orchestrator/planning/sanitize-discovered-validation.ts`.

---

### Symptom: A reviewer check is `refused`

**Likely cause:** The reviewer command policy refused the command. Any installed program of any language can run if it follows the policy. Each `refused` row names the rule.

The policy refuses these forms:

- Shell syntax, control characters, environment prefixes, `cd`, URLs and paths outside the run workspace.
- Programs run by path, such as `bin/test` and a nested `sub/gradlew`.
- The project's own `./gradlew` or `./mvnw` when this run changed its wrapper files, or when the run has no run base to compare them with.
- Shells and wrappers, including `bash`, `env`, `sudo`, `busybox`, `toybox`, `nix-shell`, `nix` and `npm explore`. This also applies through `npx --no-install` and `pnpm exec`.
- Inline interpreter code, including `node -e`, `python -c`, `deno eval`, `elixir -e`, `elixir --erl`, `iex -e`, `groovy -e`, `scala -e` and `kotlin -e`. This includes `erl -eval`, `erl -s`, `erl -run`, `php -r`, `php -B`, `php -R`, `php -F` and `php -E`.
- Inline task code, including `make --eval`, `rake -e`, `rake --require`, `gradle --init-script`, `just --command`, `mvn exec:*`, `mvn antrun:*`, `rails runner` and `rails r`. `mix run -e`, `mix run --eval` and `mix eval` are refused too. `mvn` refuses the exec and antrun plugins also by coordinate (`mvn org.codehaus.mojo:exec-maven-plugin:*`). `mix do` checks each task it chains as its own `mix` command.
- `npx` or `npm exec` without `--no-install`, or with `--yes` or `-y`. Download launchers include `bunx`, `uvx`, `pnpx`, `pipx run`, `pnpm dlx`, `yarn dlx`, `bun x`, `uv tool run` and `go run <package>@<version>`. Every `corepack` command, `pnpm env` and `yarn set` is refused. The policy refuses `--with`, `--with-editable`, `--with-requirements` and `-w` anywhere after `uv run`, including attached values and program arguments. It cannot distinguish these flags from program arguments, and they can download a package. For example, `uv run grep -w expected README.md` is refused as `has -w after uv run, where it can download a package`. Run `grep -w expected README.md` directly instead.
- Setup commands, including `npm ci`, `pip install`, `go generate`, `bundle install`, `pnpm up`, `yarn up`, `poetry lock`, `uv lock` and `bundle lock`. This includes `cargo generate-lockfile`, `gradle wrapper`, `npm dedupe`, `pnpm dedupe`, `yarn dedupe`, `npm prune`, `pnpm prune`, `npm shrinkwrap` and `pnpm shrinkwrap`. These added verbs apply only to their named tools.
- Every `config`, `pkg` or `version` subcommand of `npm`, `pnpm` and `yarn`, including `config get` and `config list`. The policy also refuses their `audit` commands with `fix` or `--fix`.
- Programs that do not verify a change, including `git`, `rm`, `osascript`, `sed`, `tar` and `docker`. Refused network tools include `curl`, `wget`, `ssh`, `scp`, `nc`, `ncat`, `socat`, `telnet`, `ftp` and `sftp`.
- `find` with `-delete`, `-exec`, `-execdir`, `-ok` or `-okdir`.
- Other task files or directories for `make`, `just` and `rake`, such as `make -f`, `make -C`, `make -I`, `just -f`, `rake -f`, `rake -C` and `rake -R`. A `make` operand cannot change its shell or definition variables, or assign with `!=`.
- Package scripts, task files, build wrappers or interpreter scripts that this run changed or the run base does not hold. Test files that this run wrote or changed can run.

Verification targets such as `make lock` and package scripts such as `npm run lock` can run. Reviewer package scripts need no plan approval. Every reviewer `npm run` still gets the changed-definition check. Interpreter option values are not code. For example, `perl -Mstrict t/x.t`, `php -c php.ini artisan test` and `php -dmemory_limit=1G artisan test` can run. In checkout mode, `php vendor/bin/phpunit` is refused because the run base holds no gitignored file. Use `composer test` or `composer exec phpunit`.

The policy does not catch database-drop tasks: `rails db:drop`, `rake db:drop`, `mix ecto.drop`, `python manage.py flush --noinput` and `dotnet ef database drop -f`. Checks run with your permissions and can act on databases outside the workspace. See [What a check can reach](./CONFIGURATION.md#what-a-check-can-reach).

**Fix:**
1. Read the reason on the row, for example `runs a program by path`.
2. Correct the review with a note that names an allowed command, for example `make test` in place of `bin/test`.
3. When a setup step is missing, run it yourself in the run workspace; SPLITBRIEF never runs a setup command as a check.
4. When an admitted `./gradlew` or `./mvnw` check times out on its first run, the wrapper downloads its distribution. Run `./gradlew --version` once yourself, or raise `validation.timeout_ms`.

**See also:** [CONFIGURATION.md §Reviewer checks](./CONFIGURATION.md#reviewer-checks), `src/engine/orchestrator/validation/reviewer-command-policy.ts`.

---

### Symptom: Every task fails validation because the tree was already red

**Likely cause:** A brief check fails on a failure the tree had before the run. This can occur with `workflow.review: task` or a consult `verify`. Its failure retries the brief once with the exact errors, then consults a seat: the planner for a plan task, the reviewer for a fix task. Only a red reviewer check at review re-runs at the run base, with the same command text.

A fix check runs once per brief gate. Each new BUILD attempt runs the checks again. A fix check never re-runs at the run base.

It judges the failure keys its findings carry for that check id. A red passes only when no carried failure remains and the re-run still shows a key the original red showed that is not the task's own. Otherwise, the command must pass. A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once.

Test failures match by name. Keys with no file match exactly. Each judged re-run gets a fix check verdict row. A green re-run shows that all carried failures are gone. A red without proof shows `your N failures not shown · not proven fixed`. Plan and task checks get only a done row, with no duration. Other failures belong to other fix tasks or the next review.

A check with no carried keys, or a re-run with no named failure, must pass. Keys come from the full process capture. An incomplete capture gives one placeholder key. The command must pass. Older saved fix tasks without own keys or original red keys must pass their commands.

**Fix:**

1. Run the failing command in your checkout to confirm the failure.
2. Make the tree green first, or plan a task that repairs it.
3. For a reviewer check, read the `Base re-run` rows. A row that reads `<m> new, <n> pre-existing` counts the failures that also occur at the run base. The dim rows under it name the failing tests of each side. Read the Checks Log's `pre-existing (also red at the run base)` line. Its pre-existing failures start no fix.
4. A base row that reads `<k> not verified at the run base · <reason>`, or a Checks Log line that reads `not verified at the run base (<reason>)`, is red at the run base too, but SPLITBRIEF could not show the same failure: a timeout, or a red with no failing test name and no diagnostic line, for example a red that prints only an `npm` script banner or a `make` error summary. Such a red is never exempt. It reaches the reviewer as a pending input, and the reviewer decides from the output. A fix check with such a red does not pass its gate. To make it comparable, make the command print its failing tests, or raise `validation.timeout_ms`.

To measure the project before a run, run its own commands directly. `doctor` runs no validation command.

**Prevention:** Maintain passing validation commands. The reviewer check's base comparison excludes pre-existing failures from fixes and still blocks failures the run causes. A failure it cannot compare goes to the reviewer, never to the pre-existing list.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) (§4 `validation`), [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

---

### Symptom: a planner `test` check is `not-runnable` with `no test command for an unrecognised stack`

**Likely cause:** The check could not resolve a test command. That happens when the project carries none of the five stack markers (`Cargo.toml`, `go.mod`, `pyproject.toml`/`setup.py`/`setup.cfg`/`requirements.txt`/`Pipfile`, `tsconfig.json` or a `typescript` dependency, `package.json`), and there is no `validation.test_command`, no `package.json` `test` script / `Makefile` or `justfile` `test` target, and nothing the planner discovered. SPLITBRIEF deliberately does not guess `npm test` at that point — a fabricated check that passes is worse than a stated absence. A required `test` check in this state halts the run with `required-checks-unrunnable`. The reviewer checks do not resolve through the stack: the reviewer still chooses them from the project itself, and the reviewer command policy runs any installed program of any language.

**Fix:**
1. If the repo does have a stack SPLITBRIEF knows, pin it: `validation.stack: python` (or `go`, `rust`, `typescript`, `javascript`). Detection order is rust → go → python → typescript → javascript, so a pin is also the fix when the wrong marker wins in a polyglot repo.
2. If the stack is one SPLITBRIEF does not model, set `validation.test_command`. It runs as written and takes the top rung of the ladder.
3. A `test` script in `package.json`, or a `test` target in a `Makefile` or `justfile`, is picked up automatically — adding one is often the smallest fix.
4. Check what actually ran: `evidence.json` records the check as `not-runnable` with its reason, never as passed.

**Prevention:** Run `splitbrief doctor` before the first run in a new repo — the validation check reports the resolved test check command, so an unrecognised stack is visible before a run spends tokens on it.

**See also:** [docs/FEATURES.md](./FEATURES.md#validation-pipeline--checkpoints) (the per-stack table), [docs/CONFIGURATION.md](./CONFIGURATION.md) (§4 `validation`).

---

### Symptom: A reviewer check or base re-run takes a long time

**Likely cause:** A reviewer check is slow. Each reviewer check has its own `validation.timeout_ms`, which defaults to one hour. A red reviewer check then re-runs with the same command text at the run base.

**Fix:**

1. Read the byline and transcript for `Reviewer check V1 · <command>` or `Base re-run V1 · <command>` and the elapsed time.
2. Set `validation.timeout_ms` to the time the command needs, with a minimum of 1000 ms. A timeout is never pre-existing: when the base re-run is red too, the row reads `not verified at the run base`, and the reviewer decides.
3. Correct the review with a note that names a faster command, or set `validation.end_checks: false` and run the commands yourself. No check runs before a run's first task.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) (§4 `validation`), [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: The base re-run is red although the same commit passes in your checkout

**Likely cause:** The run base copy differs from your checkout. A run that started from a commit gets a detached Git worktree at that commit with the run's starting snapshot on top (`withRunBaseTree`, `src/engine/orchestrator/isolation/base-tree.ts`). The checkout supplies Git history and committed file modes and symlinks. Reconciliation keeps an existing regular file's checked-out mode when replacing its contents. The snapshot does not carry uncommitted mode changes or recreate symlinks, and new regular files get default permissions. The copy does not have ignored files that only your checkout holds, such as `.env` or a build output. A run that recorded no base commit (a staged-copy run, or a repository with no commit) gets only the snapshot copy, without Git history or committed modes and symlinks. There a red base re-run reads `not verified at the run base · the run recorded no base commit, …`, and the reviewer decides.

Any base-tree preparation failure, including listing stale trees, Git checkout, submodule initialization, snapshot reconciliation or dependency-link failure, settles the row as `not verified at the run base` with the error. No base command runs. If cleanup also fails, the detail includes both errors. Cleanup failure after a completed base command settles the row as `not verified at the run base`, with the cleanup error visible. The review continues, but its failure keys stay unverified and the check has no `base` field, even though the command completed. If the callback itself failed, its error propagates unchanged and cleanup failure appears as a warning naming the tree.

A killed process's `base-<pid>-*` tree under `$XDG_STATE_HOME/splitbrief/bases/` (`~/.local/state/splitbrief/bases/` by default) is swept at the next base re-run, including one with no base commit, provided its PID belongs to no live process. Registered trees are removed with `git worktree remove --force <dir>` in their owning repository, which removes their directory and registration together, even for another project. If the gitdir named in the tree's `.git` file no longer exists, SPLITBRIEF deletes the tree from disk. Its registration is already gone. Snapshot-only copies are also deleted from disk. A removal failure, such as a locked worktree, is a warning that names the tree. The sweep continues with the other trees, and the current base re-run runs and compares its keys as usual. Remove that tree by hand as in step 4. Unrelated worktree registrations are not pruned. Older `base-*` names without a PID stay untouched.

**Fix:**

1. Open `.splitbrief/sessions/<session>/evidence.json`. Find the reviewer check entry by its id (`V1`, …). Its `output` is the run workspace output. Its `base.output` and `base.exitCode` are the base re-run output, bounded like the workspace output.
2. Find the first failing stage in `base.output`. A failure that names a missing ignored file means the gate needs a file that Git does not track. Track the file, or make the gate create it.
3. Run the command in a clean worktree of the commit to confirm: `git worktree add --detach <dir> <commit>`, link `node_modules` if the project uses it, run the command, then `git worktree remove --force <dir>`.
4. For an older tree without a PID, delete it once by hand from `$XDG_STATE_HOME/splitbrief/bases/base-*`, or `~/.local/state/splitbrief/bases/base-*` by default. For each registered worktree, run `git worktree remove --force <dir>` from the repository that owns it; the tree's `.git` file identifies that repository's gitdir. For a snapshot-only copy that is not a worktree, run `rm -rf <dir>` on that specific directory. These commands also let you retry a reported cleanup failure after resolving its cause, such as a worktree lock.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md#pre-existing-failures), [docs/WORKFLOW.md](./WORKFLOW.md).

---

## Workflow issues

### Symptom: `No output for` counts up for minutes with OpenCode

**Likely cause:** OpenCode's `run --format json` mode reports a tool only once that tool completes, and it never forwards child-session (subagent) events at all. A `task explore` subagent that runs for two minutes therefore produces no output until it lands, so the idle watchdog warns at `RUNNER_IDLE_WARN_MS` (5 minutes) even though the call is healthy. The run is not hung.

**Fix:**
1. Wait. The hint `· tools report when done` shows when the silent runner reports only finished tools. This hint tells you that the silence is expected and that the call is not hung. SPLITBRIEF states the silence in one place only. While the build block is on screen, its freshness line reads `No output for 5:12 · tools report when done`, and the byline shows the normal live status (`Implementing…`). When no block is painted — during planning, or while the stop menu takes its rows — the byline reads `⚠ No output for 5:12 · tools report when done`. The byline adds the hint only when no block is painted.
2. The watchdog does not end the call by default. The stall clears on the next activity, completion, or error event. To stop a call you think is dead, press Esc (resumable), then Resume the seat. For an unattended run, set `idleKillMs` on the seat.
3. To see what the tool actually did, read the run tree after the call completes — the tool uses land there in one batch.

**Prevention:** Use a runner that streams tool use live (Claude Code's `stream-json`) for the role where you want per-tool progress, and keep OpenCode for the role where a batched report is acceptable.

**See also:** [docs/PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: `splitbrief resume` says the run is closed

**Likely cause:** A closed run is the one thing continuing refuses. `state.json` records `closed: { at, as: 'ended' }` — written by **End run** on the stop sheet or a document gate, the `end-run` recovery action, or `/end` — or the run reached `complete` with a passing final review. Closing a run clears `.splitbrief/active`, so `resume` with no argument finds nothing at all.

**Fix:**
1. Open `/sessions` in the TUI to browse runs. Use `splitbrief status` to check the active run.
2. Its files are still on disk and its session directory is intact — read `summary.json`, `review.md` and the evidence ledger, or open it with `/sessions` and read the `Closed ─` block at the tail of its transcript.
3. To carry the work on, start a new run: `splitbrief start "<what is left>"`. A closed run is a record, not a workspace.

**Prevention:** Use **Stop now** or **Pause after this brief** when you mean to come back. Only **End run** closes; the stop sheet's footer says so.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md) §6, [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md).

---

### Symptom: `splitbrief resume` refuses with unreadable or unsupported saved state

**Likely cause:** `state.json` is missing, is not valid JSON, fails the v4 schema, or records a `stateVersion` newer than `WORKFLOW_STATE_VERSION`. A v3 state is migrated on load; anything else is refused rather than guessed at.

**Fix:**
1. `splitbrief status` names the session; check `.splitbrief/sessions/<id>/state.json` exists and parses (`node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <path>`).
2. A state written by a newer SPLITBRIEF cannot be read by an older one. Upgrade, or start a fresh run.
3. The session's artifacts are independent of its state: `plan.json`, `plan.md`, `tasks.md` and `review.md` (and `spec.md` on older runs) are still readable and can seed a new run.

**Prevention:** Do not hand-edit `state.json`. Every legitimate mutation goes through the compare-and-swap in `state-ops.ts`; an edited file loses that guarantee.

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md) §v4 contract boundary.

---

### Symptom: continuing a run re-opens the planner halt instead of building

**Likely cause:** The run stopped on a planner-seat recovery — `planner-call-failed`, `plan-questions-exhausted`, `plan-checks-failed`, a planner `seat-protocol-error`, or a *Seat down* `runner-unauthenticated` / `runner-usage-limit` on the **plan** seat. A halt is answered before any work runs, so continuing shows the panel first. That is the design: the run is waiting on a decision, not stuck.

**Fix:**
1. In the TUI, answer the panel. The issue carries its own `seat`, so a swap offer names the seat that is actually blocked.
2. Headlessly, the halt printed the exact line to run: `splitbrief continue <session-id> --action retry` (or `--action switch-seat:<tool>`, `--action skip`, `--action end-run`).
3. A halt you leave stays in place, so the next continuation shows the same panel. That is deliberate — it is not a loop.

**Prevention:** Nothing to prevent. A halt is a question; leaving it unanswered means it gets asked again.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) §Recovery.

---

### Symptom: a session is reported active but nothing is running

**Likely cause:** Each session writes a per-session lockfile at `.splitbrief/sessions/<id>/lockfile.json` that records the PID, heartbeat, and exit marker. If `.splitbrief/active` still points at a non-terminal `state.json`, older versions could treat that pointer as live even when the lockfile already had `exitedAt`.

**Fix:**
1. Run `splitbrief status` to see what the project believes is running.
2. Run `splitbrief start ...` again. Current versions clear `.splitbrief/active` automatically when the active lockfile has exited or the PID is gone.
3. If you want to continue that run instead of starting fresh, run `splitbrief continue <session-id>`.
4. If the lock is fresh and a real process is alive, you have a genuine concurrent session. Finish that one rather than starting another.

**Prevention:** Prefer clean TUI cancellation or `splitbrief continue` for interrupted work.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/DEBUGGING.md](./DEBUGGING.md).

---

### Symptom: `.splitbrief/sessions/` accumulates directories that never became sessions

**Likely cause:** An abort or crash after `readiness.json` was written — before the run acquired its lockfile — leaves a session directory holding nothing but `readiness.json` (or nothing at all). Historically nothing could act on those directories, so long-lived projects accumulated hundreds of them and the stale slug suffixes kept session-id slugs occupied.

**Fix:**
1. A directory holding only `readiness.json` (or empty) and older than 24 hours is collectable; the sweep runs automatically at workflow start.

**Prevention:** None needed beyond the automatic sweep. A directory holding any other artifact — a lockfile, `state.json`, an ownership marker, or anything else — is never collected.

**See also:** [docs/HOW-IT-WORKS.md](./HOW-IT-WORKS.md).

---

### Symptom: Workflow stalls indefinitely at an approval gate

**Likely cause:** The TUI is waiting for input but the input mode is wrong, or a non-interactive run reached an approval gate that needs a response.

**Fix:**
1. In the TUI, focus the composer (Tab if focus is elsewhere) and press `y` / `c` / `q`, or submit `approve` / `comment ...` / `reject`.
2. If you ran with `--json`, the NDJSON stream cannot accept replies. The plan card is approved unattended in headless JSON mode; a write to a protected path fails closed with `APPROVAL_REQUIRED`. Resume the session interactively with `splitbrief continue <session-id>` to answer it.
3. Check `workflow.approve` in config: `plan` (the default) opens the plan card before the build, and `none` skips it. A write to a protected path asks either way, unless the approved plan lists it.

**Prevention:** Decide up front whether a run is interactive or `--json`; configure approval policy to match.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

---

### Symptom: the plan card shows the same plan after I requested changes

**Likely cause:** The planner returned the same plan, usually because the correction was too vague to act on.

**Fix:**
1. Confirm that you chose **Request changes** and typed the correction, rather than approving.
2. Inspect the session log; it should record a new planner call after your correction.
3. Restate the correction as a concrete, falsifiable change ("add a test check for the empty input", "drop T003").
4. To make the change yourself, choose **Edit plan.json**. SPLITBRIEF re-validates the edited plan and keeps the old one when the edit fails a check.

**Prevention:** Write corrections as imperatives ("rename `foo` to `bar`", "remove the constraint about X"), not impressions ("seems off").

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md).

---

### Symptom: every implementer profile is rejected with `context-overflow`

**Likely cause:** Every candidate profile overflowed the task's estimated prompt tokens — the brief is larger than any available context window. A profile that declares no `contextLength` and whose provider exposes no detected window routes at the single documented default, `DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32768` (`src/core/tokens/context-length.ts`); with the 15% safety margin, a task over roughly 28 000 estimated tokens overflows it. A CLI tool under `model: auto` escapes this floor — its window resolves from the smallest bundled window its catalog guarantees (`resolveRunnerContextWindow`, `src/engine/providers/model/context-window.ts`) — so check that the profile's tool actually carries a bundled catalog row before configuring a window by hand.

**Fix:**
1. Set `implementer.contextLength` (or the `SPLITBRIEF_CONTEXT_LENGTH` environment variable) to the runner's real window — see [docs/CONFIGURATION.md](./CONFIGURATION.md).
2. Use a profile whose declared or detected window fits the brief, or split the brief into smaller tasks.
3. The halt offers `retry-same-worker`, `skip-current-task` and `end-run`. Fix the window or the profile first, then retry.

**Prevention:** Configure `contextLength` on implementer profiles that run outside a known catalog, and keep briefs under roughly 28 000 estimated tokens when the window is unknown.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md) (`context-overflow` recovery), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

## Approval gates

### Symptom: the run halts with `plan-checks-failed` instead of opening the plan card

**Likely cause:** The planner's plan failed `checkPlan` (`src/engine/spec/plan-checks.ts`) or the context fit (`estimatePlanContextFits`) — for example a criterion with no check, a task with no check, a dependency cycle, or a task that does not fit the implementer's context window. A failing plan goes back to the planner once with the failed checks; a second failure halts the run with `plan-checks-failed` and the plan card never opens.

**Fix:**
1. Read the failed checks: the recovery panel lists each one.
2. Type a correction at the halt (`revise`, the recommended action) that tells the planner how to fix them — split an oversized task, add the missing check.
3. Or take `retry-same-worker` to ask the same session again, or `end-run` to close the run.

**Prevention:** Set `contextLength` on implementer profiles outside a known catalog, so the context fit measures against the real window.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md).

---

### Symptom: `APPROVAL_REQUIRED` (headless run paused on a protected write)

**Likely cause:** A write to a protected path (dependency manifests and lockfiles, `.git`, `.splitbrief`, CI configuration, env and key files) reached a run with no reply channel. The gate prompts whenever there is somebody to prompt and denies with `APPROVAL_REQUIRED` when there is not, so this is a `--json` or `--plain` run. No setting turns this confirmation off; the retired `approval.tiers` key loads with one notice and is ignored.

**Fix:**
1. If the session is resumable, continue it with an interactive TUI: `splitbrief continue <session-id>`.
2. For a write you expect, let the plan list it as a protected operation and approve the plan card interactively. The approval confirms the write for the whole run, so you can stop the run and `continue` it headlessly without a prompt. An unattended approval confirms nothing.

**Prevention:** Run work that changes manifests, lockfiles or CI configuration interactively.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md) §approval, [docs/WORKFLOW.md](./WORKFLOW.md).

---

### Symptom: `invalid_confirm_phrase` — the confirmation rejected my input

**Likely cause:** The engine requires every confirmation response to carry the literal phrase `I confirm` (capital I, space, lowercase confirm) and a non-empty reason. The TUI supplies both for you once you make the keyed gesture, so this error means the response came from somewhere else: the configured-runner trust prompt, or a custom `onTieredApproval` callback that sent a different phrase or an empty reason.

**Fix:**
1. In the TUI, press Enter (destructive class) or `y` (every other protected class). Press `r` first if you want to record a reason. Escape denies.
2. In a custom callback, return `{ decision: 'confirm', phrase: CONFIRM_PHRASE, reason }` with `reason` non-empty.

**Prevention:** Import `CONFIRM_PHRASE` from `src/core/approval/types.ts` rather than retyping the literal.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md).

---

## Snapshots

### Symptom: a snapshot fails with "lock held"

**Likely cause:** Another SPLITBRIEF process — or a previous run that crashed — is holding the snapshot lock. The lock is considered stale after 60 seconds.

**Fix:**
1. Wait 60 seconds and retry; stale locks expire automatically.
2. If a real concurrent operation is running, finish it first.
3. If no other process exists and the lock is older than 60s, remove it manually: `rm .splitbrief/sessions/<session-id>/snapshots/.lock`.
4. Re-run the operation that needed the snapshot.

**Prevention:** Avoid running multiple `splitbrief start` invocations against the same workspace simultaneously.

**See also:** `src/engine/snapshots/` (lock implementation).

---

### Symptom: `/run reject confirm` has nothing to reject

**Likely cause:** The checkout run was killed before its first brief settled, or the older run has no recorded run snapshot, or its snapshot ledger is already accepted. A closed run refuses rejection except undo of a completed Apply from its backup in a worktree or staged-copy run.

**Fix:** Read the command's diagnostic and the [run rejection behavior](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject). Checkout rejection changes no files without a recorded run snapshot; use End run to keep the files, or remove them yourself. A worktree or staged-copy run uses Discard before Apply and backup restore after Apply. End run and Discard refuse an unfinished Apply: restore or retry Apply first.


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

**Likely cause:** The report lists every changed file that no brief suggested as an `out_of_scope_file` finding. That finding is `info` and never fails drift. A file that was already changed before the run started gets a pre-existing note instead, unless the evidence ledger shows the run touched it.

**Fix:**
1. Inspect `.splitbrief/sessions/<id>/drift-report.json` and confirm whether the file was actually modified (run `git diff` against the pre-task snapshot).
2. If the file was intentionally in scope, name it in the brief's `suggestedFiles`, `scope.inBounds` or `scope.approvedOutOfBounds`; those are the accepted change patterns.
3. Leave the finding when the change is real: the final reviewer reads the files the run touched that no brief suggested.

**Prevention:** Write brief scope sections with full project-relative paths (`src/engine/orchestrator/run/workflow.ts`), never bare names (`workflow.ts`).

**See also:** [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: `workflow.drift_chain_threshold was retired` notice at start

**Likely cause:** The config still sets `workflow.driftChainThreshold`. SPLITBRIEF no longer scores drift chains across tasks, so the key loads with one notice and changes nothing.

**Fix:**
1. Delete `workflow.driftChainThreshold` from `.splitbrief/config.yaml`.

**Prevention:** Read the retired-key table in [CONFIGURATION.md](./CONFIGURATION.md) after an upgrade.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), `src/core/config/load/validation/config.ts`.

---

### Symptom: Edits to `drift.ts` do not change behavior

**Likely cause:** Drift logic lives in one place. The final deterministic drift report runs from `src/engine/orchestrator/final-review.ts` through `src/engine/orchestrator/drift/analyze.ts`, persists to `drift-report.json`, and is summarized in `summary.json`. There is no per-task chain analysis.

**Fix:**
1. For final review drift findings, inspect `drift-report.json` and `src/engine/orchestrator/drift/analyze.ts`.
2. Use `summary.json` only for the aggregate drift summary.
3. Edit `analyze.ts`, re-run, and re-verify in `drift-report.json` or the drift summary in `summary.json`.

**Prevention:** Before editing drift code, grep for the symptom string and confirm which file emits it.

**See also:** [docs/ARCHITECTURE.md](./ARCHITECTURE.md), `src/engine/orchestrator/`.

---

## Run isolation

### Symptom: the run halted with "Apply found <n> conflicting files"

**Likely cause:** Your checkout and the run workspace both changed a file, and Apply cannot merge the two versions safely. The `apply-conflict` halt names every file and the workspace path.

**Fix:** Follow [Apply conflicts](./APPROVAL-AND-RECOVERY.md#apply-conflicts) to choose each file's result in the workspace. Then choose **Re-run Apply**. Checks and whole-run review assess a changed candidate before the checkout write.

### Symptom: the run halted with "Apply stopped part way"

**Likely cause:** A write failed or the process stopped after `APPLY_START`. The `apply-partial` halt names the backup; the saved `applying` record points to it.

**Fix:** Open the same run. The `apply-partial` recovery offers **Re-run Apply** or **Restore backup**. Follow [Partial Apply recovery](./APPROVAL-AND-RECOVERY.md#partial-apply-recovery). Keep the backup until recovery finishes. A later checkout edit is a conflict, not permission to overwrite it.

### Symptom: I discarded or ended a run and need its work

**Likely cause:** The run closed without Apply. Its notice names the patch: `Run changes not applied are saved in .splitbrief/sessions/<id>/run.patch; apply them with git apply.` The closed run's `Run` block names the file in its `Patch` row, and the byline of a discarded or ended run points at it: `Bring the changes back with git apply on the Patch file`. When the workspace was already gone, the notice reads `The run workspace at <path> is gone; no run patch was written.`

**Fix:** Inspect that patch. Use `git apply .splitbrief/sessions/<id>/run.patch` to bring the saved changes into a suitable checkout. Discarded and ended runs stay closed. If patch creation failed, the run remains open and keeps its workspace; resolve the reported failure, then close again.


### Symptom: The implementer cannot run the project's own checks inside a worktree-isolated run

**Likely cause:** Only Node dependencies are made reachable in a run-isolation worktree (a `node_modules` link, with its `.bin` prepended to the workspace PATH). A project whose toolchain lives elsewhere — a Python virtualenv, a Go module cache, a Rust target directory — has nothing to resolve inside the worktree, and a `staged-copy` isolation has no dependencies at all. Separately, a repository that does not ignore `node_modules` at all cannot take the link — SPLITBRIEF will not change your ignore rules to make it fit — so the run falls back to `staged-copy` on its own. The common `node_modules/` pattern is fine: the link is excluded through the repository's `.git/info/exclude` and the worktree is kept.

**Fix:**
1. Read the readiness warning. Validation runs inside the workspace, so its tooling must assess the workspace candidate.
2. Make the configured validation commands and dependencies available inside the workspace. A staged copy does not supply missing dependencies. See [Implementer isolation](./CONFIGURATION.md#implementer-isolation).

**Prevention:** Resolve readiness warnings before trusting workspace checks. Linked packages or editable installs can read checkout sources instead of the candidate.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: `Branch splitbrief/<slug> already exists.`

**Likely cause:** A previous run's isolation worktree left the branch behind and it was never deleted. SPLITBRIEF refuses to overwrite an existing branch when creating a worktree.

**Fix:**
1. If the branch contains work you still want, inspect it first, then rename it.
2. Otherwise clear the stale registration: `git worktree prune`, then `git branch -D splitbrief/<slug>`.

**Prevention:** Let runs finish so isolation removes its own worktree and branch; `git worktree list` shows the ones that outlived a run.

---

### Symptom: A run-isolation worktree is left behind after an interrupted run

**Likely cause:** An open or ready run retains its workspace across stops and restarts. Discard and End run preserve a patch before removal. A failed patch write keeps the workspace. A failed removal reports its path. See [Apply](./WORKFLOW.md#apply).

**Fix:**
1. Find the path: `git worktree list` (look for `splitbrief/<session-id>`).
2. Inspect what it holds: `cd` to that path and run `git status` (and compare against the project directory).
3. Continue the same run. If it is ready, use [the result menu](./FEATURES.md#run-result-menu). If you closed it, inspect the reported `run.patch` before removing any retained directory.

**Prevention:** Use Discard or End run to preserve unapplied work through the shared close path. Read any patch or removal warning before deleting a directory.

---

## TUI

### Symptom: copying an image and pressing `Cmd+V` does not insert an image

On macOS, Zed 1.20.2 forwards a clipboard image to the terminal application as `Ctrl+V`; SPLITBRIEF reads the image and inserts `[image #1]` at the composer caret. A custom paste keybinding or an older terminal version can prevent that event from reaching the application. Check Zed's default `terminal::Paste` binding and [terminal paste behavior](https://github.com/zed-industries/zed/blob/v1.20.2/crates/terminal_view/src/terminal_view.rs#L848-L895).

If the clipboard offers both text and an image, [Zed pastes the text](https://github.com/zed-industries/zed/blob/v1.20.2/crates/gpui_macos/src/pasteboard.rs#L47-L83). Press `Ctrl+V` directly to read the image representation.

`Pasting image…` means the read is pending. `Clipboard has no image` means the clipboard contains no readable bitmap; `Cannot read clipboard image` means the system reader or image storage failed. Clipboard images must fit the 10 MiB attachment limit. A PLAN seat without vision reports that it cannot see images; choose a vision-capable seat with `/crew plan`.

Copied images remain in `~/.splitbrief/clipboard/` so history and runs retain readable attachments. See [Image attachments](./FEATURES.md#image-attachments) for paste, drop, and removal behavior.

### Symptom: TUI layout is broken — overlapping panes, truncated text

**Likely cause:** Terminal width below 60 columns. Ink can render but SPLITBRIEF's layout assumes a minimum width.

**Fix:**
1. Resize the terminal to at least 80 columns (120 recommended).
2. If you are on a tiny window, run without the TUI instead: `splitbrief start --json "..."` for NDJSON output.
3. For tmux/screen users, increase the pane width or detach from the multiplexer.

**Prevention:** Default to a wide terminal for SPLITBRIEF sessions, or use `--json` when working in narrow contexts.

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

### Symptom: opencode shows no models in the picker

**Likely cause:** OpenCode 2 no longer lists models itself. `opencode models` takes no `--verbose` on 2.x, and the list comes from OpenCode's background server, which answers nothing for a directory it has not indexed yet. SPLITBRIEF asks that server with `opencode api GET /api/model` and keeps `opencode models --verbose` for releases below 2.0.0, chosen by the installed version. The picker shows the list the last detection pass remembered in `.splitbrief/detection-cache.json`. A list taken before the upgrade, or by a SPLITBRIEF build that still ran the 1.x command against OpenCode 2, stays empty until a new pass replaces it, and the picker offers only its bundled rows under `No models listed` or `No models confirmed`.

**Fix:**
1. Run a detection refresh: `/refresh`, `ctrl+r` in the seat picker, or `r` on the Setup screen when its discovery check failed. The pass reads the installed version again, runs the listing that version serves and rewrites the cache.
2. Do not expect a run to refresh it. Run preparation checks readiness only and never probes a catalog. The TUI runs one background pass at launch and none after that, so an upgrade made while it is open needs a refresh.
3. If the refresh still lists nothing, run `opencode api GET /api/model` in the project directory. An empty `data` array means OpenCode itself serves no model there: check `opencode auth list`, sign in with `opencode auth login`, then refresh again.

**Prevention:** Refresh detection after you upgrade OpenCode across 2.0.0.

**See also:** [docs/SUBSYSTEMS.md](./SUBSYSTEMS.md) (detection), [docs/AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md) (why the listing runs with the host account).

---

### Symptom: A slash command is not in the command palette

**Likely cause:** The command's `validScreens` does not include the screen you are currently on. Slash commands are scoped per-screen by the catalog.

**Fix:**
1. Inspect the screen indicator in the TUI status bar.
2. Open the command's `src/core/runtime/commands/defs/<category>.ts` module and check its `validScreens` array.
3. Navigate to a screen where the command is valid.
4. If you authored the command, add the missing screen to its `validScreens`.

**Prevention:** When adding a new slash command, list every screen it should be available on — defaulting to too few is more common than too many.

**See also:** [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), `src/core/runtime/commands/defs/`.

---

### Symptom: `Failed to open editor: …` or `Editor exited with …` (when editing `plan.json` at the plan card)

**Likely cause:** `plan.json` edits at the plan card use the external editor resolver and then spawn the resolved command. Resolution uses explicit `VISUAL` first, then non-terminal `EDITOR`, then detected GUI editors (`cursor`, `code`, `zed`, `subl`, `mate`, `bbedit`) with wait flags from safe absolute `PATH` segments, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`; Windows detection honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. The failure is in launching or running that resolved command, not a missing variable:
- The resolved binary is not on `PATH` (e.g. `VISUAL=code` or `EDITOR=code` on a machine without VS Code) — the spawn errors and you get `Failed to open editor: …`.
- The editor exits non-zero or is killed by a signal — if it saved the file first, the saved content is kept and applied (`Editor exited with status … (<editor>) but saved plan.json`); if the file is unchanged you get `Editor exited with status … — edit not applied` or `Editor failed: … terminated by …`.
- You press Ctrl+C in the editor — that is a cancel, not a failure: `Edit cancelled — vim closed by ctrl+c`. A save that landed before the interrupt is still detected and applied.
- A GUI editor returns immediately without blocking (e.g. `code` without `--wait`), so the edit is treated as cancelled.

**Fix:**
1. Confirm the resolved editor command is installed and on `PATH`. Check `VISUAL` first, then `EDITOR`, then common GUI CLIs such as `cursor` or `code`; implicit GUI discovery skips empty, `.`, and relative `PATH` entries.
2. For an explicit GUI editor, use the blocking flag so SPLITBRIEF waits for you to save and close: `export VISUAL='code --wait'`.
3. For a one-off run with a known terminal editor: `VISUAL=vi splitbrief start "..."`.

**Prevention:** Point `VISUAL` at the editor you want, for example `cursor --wait` or `code --wait`. If `VISUAL` is empty and `EDITOR` is a terminal editor (`vi`, `vim`, `nano`), SPLITBRIEF will try safely detected GUI editors first so plan editing does not stay inside the TUI terminal when a GUI editor is available.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md#approval-the-plan-card) §Approval: the plan card.

---

### Symptom: Cost status line shows blank or `--` instead of token / dollar values

**Likely cause:** The active runner does not emit `cost_update` events; the TUI displays nothing rather than fabricating values.

**Fix:**
1. Confirm the runner kind via `splitbrief status`. CLI runners often skip cost events.
2. Switch to `kind: api` for USD pricing when the provider/model is priced.
3. If you must use a CLI runner and want approximate costs, post-process `summary.json` after the run rather than relying on the live status.

**Prevention:** Use `api` runners when live USD cost feedback matters.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md).

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
1. The nearest option is `validation.end_checks: false` in `.splitbrief/config.yaml` (Settings: End-of-run checks). It turns off the reviewer checks; plan and task checks still run. There is no `--no-validate` CLI flag.
2. Better: fix the underlying validation failure rather than bypassing it.
3. Better still: relax `validation.test_command` (e.g. drop slow tests from the planner's `test` checks, leave them for CI).

**Prevention:** Treat validation toggles as a temporary debugging tool, not a permanent workflow option. If you find yourself disabling checks routinely, your validation config is wrong.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/WORKFLOW.md](./WORKFLOW.md).

---

## CI and headless

### Symptom: Headless run exits 0 having done nothing

**Likely cause (fixed):** A resume over a state with a **paused** or **applying** `pendingRecovery` used to exit 0 silently — the headless driver only failed on `awaiting-user`. The task loop now publishes a transcript-safe `warning` with `code: 'recovery_pending_unresolved'` naming the reason, status, and available actions, and headless fails with exit code 1 for every recovery status.

**Fix:**
1. Inspect the `recovery_required` record in the NDJSON stream — it now carries `status` (`awaiting-user` | `applying`).
2. Resolve it with `splitbrief resume` in the TUI and pick an action.
3. If the run truly did nothing, check `state.json` for `pendingRecovery` before assuming CI passed.

**Prevention:** Treat any `recovery_required` record as a hard failure in CI.

**See also:** [docs/APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md), [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md).

---

### Symptom: `splitbrief start --json` output is interleaved with logs

**Likely cause:** Logs go to stderr, JSON goes to stdout. If you captured both streams together, they interleave.

**Fix:**
1. Redirect stderr separately: `splitbrief start --json "feature" 2>splitbrief.log >splitbrief.json`.
2. Or, parse line-by-line and reject any line that does not begin with `{`.

**Prevention:** In CI, redirect stdout and stderr to distinct files.

**See also:** [docs/DEBUGGING.md](./DEBUGGING.md), [docs/CONFIGURATION.md](./CONFIGURATION.md).

---

### Symptom: Headless run exits 0 even though the drift report flagged issues

**Likely cause:** Drift is not a hard failure by design — it is reported, not enforced. The exit code reflects only fatal failures (validation, runner errors).

**Fix:**
1. Inspect `drift-report.json` for per-finding details and `summary.json.driftSummary` for the final deterministic drift aggregate; `evidence.json` only contains the evidence ledger.
2. To gate CI on drift, post-process `summary.json` and exit non-zero from your wrapper script when drift exceeds your threshold.
3. Use `driftSummary.passed`, `driftSummary.errorCount`, or `driftSummary.warningCount` as the signal. There is no drift score.

**Prevention:** Wire drift checks into your CI script explicitly; do not assume SPLITBRIEF will fail the build for you.

**See also:** [docs/WORKFLOW.md](./WORKFLOW.md), `src/engine/orchestrator/final-review.ts`.

---

### Symptom: Want CI to fail when drift exceeds a threshold

**Likely cause:** No built-in flag enforces a drift threshold; you wire it yourself.

**Fix:**
1. In your CI script, after `splitbrief start --json ...`, resolve the session id from readiness/session output, `.splitbrief/active`, or wrapper state, then parse `.splitbrief/sessions/<id>/summary.json`.
2. Read `driftSummary.passed`, `driftSummary.errorCount`, or `driftSummary.warningCount`. There is no drift score.
3. Exit non-zero from the wrapper if the counts exceed your threshold:
   `node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1])); process.exit((s.driftSummary?.errorCount ?? 0) > 0 ? 1 : 0)" .splitbrief/sessions/<id>/summary.json`.
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

**Likely cause:** Only specific startup options are overrideable. SPLITBRIEF loads project `.splitbrief/config.yaml`, applies explicit CLI runner/workflow flags for that invocation, and reads documented environment variables for provider keys, context length, terminal behavior, and editor selection. It does not load a global config file.

**Fix:**
1. Inspect `.splitbrief/config.yaml` for persistent values.
2. Check the command line for one-shot overrides such as `--planner`, `--implementer` or `--model`.
3. Check the documented environment variables in `docs/CONFIGURATION.md`, especially provider API keys and `SPLITBRIEF_CONTEXT_LENGTH`.

**Prevention:** Put durable settings in `.splitbrief/config.yaml`. Keep CLI flags for one-off runs and environment variables for secrets or process-level behavior.

**See also:** [docs/CONFIGURATION.md](./CONFIGURATION.md), [docs/BOOTSTRAP.md](./BOOTSTRAP.md).
