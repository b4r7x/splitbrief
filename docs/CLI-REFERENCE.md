# CLI Reference

Complete reference for every `splitbrief` command. Maintained against `src/cli.ts` and `src/cli/commands/*.ts`.

```
SPLITBRIEF — an orchestrator of two coding tools: one plans and reviews, the other executes, and it holds the contract, validation, retry, escalation and evidence
```

## Global behavior

- **Binary name:** `splitbrief`. The `npm run dev -- <cmd>` form is equivalent during local development.
- **Working directory:** Most commands accept `--project <dir>`. When omitted, the project starts from the current working directory. Every command then canonicalizes it to the git toplevel (`canonicalizeProjectDir` in `src/cli/setup.ts`), so a session started from `packages/web` is the same session `status`, `doctor` and `resume` see from the repository root, and `spec` never auto-creates a second config next to a nested `package.json`. An explicit `--project` pointing inside a repository prints a one-line relocation warning; a bare subdirectory invocation relocates silently.
- **Runtime requirement:** the CLI reads `process.versions.node` before it parses anything and refuses a Node older than `package.json`'s `engines.node` (`>=22`) with `splitbrief requires Node.js 22 or newer; this process is Node.js <version>.` — see `src/cli/node-guard.ts`.
- **Mistyped subcommands:** `start` is the default command, so a bare token becomes a feature description. To stop `splitbrief doctro` from buying a planner call, a single bare operand that is not a registered command but is within one edit of a short command name (≤ 4 characters) or two edits of a longer one is rejected: `unknown command 'doctro' — did you mean 'doctor'?`, exit `1`. Transpositions count as one edit. The guard only looks at an invocation whose leading operand run is exactly one whitespace-free token, so `splitbrief "fix the typo"`, `splitbrief fix the typo` and the explicit `splitbrief start doctro` all still run. See `src/cli/unknown-command.ts`.
- **Exit codes:**
  - `0` — success.
  - `1` — generic CLI failure. Almost every command throws via `cliError(message)` which defaults to `exitCode: 1`. The top-level handler in `src/cli.ts` prints `Error: <message>` to stderr and exits with the carried code.
  - `2` — reserved for guardrail hooks (e.g. `.claude/hooks/block-git-commits.sh`). The CLI itself does not raise `2`; observe it in subprocess output only.
- **Error format:** Failures print `Error: <message>` in red on stderr. Programmatic callers should grep stderr, not stdout.

## Command index

| # | Command | Purpose |
|---|---|---|
| 1 | `splitbrief start` | Launch a workflow (TUI or headless). Also the default command: `splitbrief "feature"` works without `start`. |
| 2 | `splitbrief spec` | Run the planner only — produce the planning artifacts for a mode, no implementation. |
| 3 | `splitbrief init` | Create `.splitbrief/config.yaml` with detected models. |
| 4 | `splitbrief status` | Show the active session. |
| 5 | `splitbrief resume` | Resume the active interrupted workflow. |
| 6 | `splitbrief continue` | Session continuity: resume a saved session. |
| 7 | `splitbrief approval` | List or clear sticky approval grants. |
| 8 | `splitbrief doctor` | Check run readiness without creating a workflow session. |
| 9 | `splitbrief review` | Review the working-tree diff in one reviewer call — no session, no planning. |

---

## splitbrief start

**Synopsis**

```
splitbrief start [feature] [options]
```

Launch a complete plan-and-implement workflow. Without a feature argument the TUI opens to the home screen so you can pick one interactively. With a feature, SPLITBRIEF runs the planner, gathers approvals (per `--mode`), then dispatches the implementer loop. This is the canonical entry point for ordinary work.

**Shorthand.** `splitbrief "feature"` is equivalent to `splitbrief start "feature"` — `start` is the default command (`isDefault`). No subcommand required for the happy path.

**`@file` syntax.** Positional arguments prefixed with `@` are resolved as file paths. Text files are injected into planner context; image files are queued as planner attachments. Example: `splitbrief "refactor auth" @context.md @screenshot.png`.

### Usage

```
splitbrief start [feature] [--mode <mode>] [--approve <level>] \
  [--planner <tool>] [--planner-model <model>] [--planner-command <cmd>] \
  [--planner-api-base <url>] [--planner-api-key-env <var>] [--planner-args <arg>] \
  [--planner-output-format <format>] [--planner-context-length <tokens>] \
  [--implementer <provider>] [--implementer-model <model>] [--implementer-command <cmd>] \
  [--implementer-api-base <url>] [--implementer-api-key-env <var>] [--implementer-args <arg>] \
  [--implementer-output-format <format>] [--implementer-context-length <tokens>] \
  [--reviewer <tool>] [--reviewer-model <model>] [--reviewer-command <cmd>] \
  [--reviewer-api-base <url>] [--reviewer-api-key-env <var>] [--reviewer-args <arg>] \
  [--reviewer-output-format <format>] [--reviewer-context-length <tokens>] \
  [--model <model>] [--provider <provider>] \
  [--budget <amount>] [--planner-effort <level>] [--reviewer-effort <level>] [--yolo] \
  [--project <dir>] \
  [--no-fullscreen] [--no-mouse] [--hover] \
  [--allow-hooks] [--allow-repo-runners] [--allow-unverified-auth] \
  [--json]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--mode <mode>` | enum | `standard` (or `workflow.mode` from config) | One of `quick`, `standard`, `speckit`. The retired `instant` still parses and resolves to `quick` with a deprecation notice. See [WORKFLOW.md](./WORKFLOW.md). |
| `--approve <level>` | enum | `default` | Spec/plan document gates: `none`, `spec`, `plan`, `all`, `default`. `default` follows the mode's built-in policy. |
| `--planner <tool>` | string | from config | Planner tool: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `shell`, `agent`. The flag's help text is derived from `PLANNER_TOOL_IDS` (`src/core/schemas/enums.ts`), so `splitbrief start --help` always prints the admitted set. |
| `--planner-model <model>` | string | from config | Planner model identifier (for API planners). |
| `--planner-command <cmd>` | string | from config | Custom planner command (when `--planner=shell`). |
| `--planner-api-base <url>` | string | from config | Planner API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--planner-api-key-env <var>` | string | from config | Environment variable holding the planner API key; stored as an `env:<var>` reference. A bare name is normalized to `env:<var>`. Applies only to `api` runners; ignored (with a stderr warning) otherwise. |
| `--planner-args <arg>` | string | from config | Append one planner CLI/shell argument. Repeatable; each use adds another argument. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-output-format <format>` | enum | from config | Planner output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-context-length <tokens>` | number | from config | Planner context length in tokens. Consumed only by the `api` planner kind, where it sizes the request's `max_tokens` output budget; other kinds delegate the budget to their backend and ignore it. |
| `--planner-effort <level>` | enum | — | Planner effort hint: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it. |
| `--implementer <provider>` | string | from config | Implementer provider: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `ollama`, `lm-studio`, `shell`, `agent`. The flag's help text is derived from the catalog's implementer role admission (`src/cli/options.ts`), so `splitbrief start --help` always prints the admitted set. |
| `--implementer-model <model>` | string | from config | Implementer model identifier. |
| `--implementer-command <cmd>` | string | from config | Custom implementer command (when `--implementer=shell`). |
| `--implementer-api-base <url>` | string | from config | Implementer API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--implementer-api-key-env <var>` | string | from config | Environment variable holding the implementer API key; stored as an `env:<var>` reference. A bare name is normalized to `env:<var>`. Applies only to `api` runners; ignored (with a stderr warning) otherwise. |
| `--implementer-args <arg>` | string | from config | Append one implementer CLI/shell argument. Repeatable; each use adds another argument. Applies to `cli`, `shell`, and `agent` runners. |
| `--implementer-output-format <format>` | enum | from config | Implementer output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--implementer-context-length <tokens>` | number | from config | Implementer context length in tokens. |
| `--reviewer <tool>` | string | from config | Reviewer tool. Same admitted set as `--planner` — the flag's help text is derived from `PLANNER_TOOL_IDS` too. Without any `--reviewer-*` flag and without a `reviewer` block in config, the planner keeps the review seat. |
| `--reviewer-model <model>` | string | from config | Reviewer model identifier (for API reviewers). |
| `--reviewer-command <cmd>` | string | from config | Custom reviewer command (when `--reviewer=shell`). |
| `--reviewer-api-base <url>` | string | from config | Reviewer API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--reviewer-api-key-env <var>` | string | from config | Environment variable holding the reviewer API key; stored as an `env:<var>` reference. Applies only to `api` runners; ignored (with a stderr warning) otherwise. |
| `--reviewer-args <arg>` | string | from config | Append one reviewer CLI/shell argument. Repeatable. Applies to `cli`, `shell`, and `agent` runners. |
| `--reviewer-output-format <format>` | enum | from config | Reviewer output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--reviewer-context-length <tokens>` | number | from config | Reviewer context length in tokens. Consumed only by the `api` kind, where it sizes the request's `max_tokens` budget. |
| `--reviewer-effort <level>` | enum | — | Reviewer effort hint: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The seat's tool accepts a subset and reports what it rejects. Requires the review seat to have its own runner: with no `reviewer` block in config and no `--reviewer`, the run is refused with a message naming `--reviewer`. On a configured reviewer whose backend has no reasoning control, it is dropped with a stderr warning. |
| `--model <model>` | string | — | Alias for `--implementer-model`. |
| `--provider <provider>` | string | — | Alias for `--implementer`. |
| `--budget <amount>` | float | — | Maximum budget in USD (e.g. `2.00`). Workflow warns/pauses before the cap, stops when exceeded, and pauses when paid usage has unknown pricing. |
| `--yolo` | boolean | `false` | Disable file-write tiered approval prompts for the session. Spec/plan gates still follow `--approve` / mode policy, and briefs review remains separate. This is not a shell or network sandbox setting. |
| `--project <dir>` | path | cwd | Project directory. |
| `--no-fullscreen` | boolean | fullscreen on | Disable the alternate screen buffer. Useful when piping or debugging. |
| `--no-mouse` | boolean | mouse on | Disable Ink mouse tracking — click, hover and scroll. Tracking runs only in fullscreen, so `--no-fullscreen` disables it too and leaves this flag a no-op. |
| `--hover` | boolean | `false` | Opt in to hover highlighting under the mouse. Requires both mouse tracking and fullscreen; a no-op with `--no-mouse` or `--no-fullscreen`. |
| `--allow-hooks` | boolean | `false` | Trust the hook config without prompting (CI). |
| `--allow-repo-runners` | boolean | `false` | Grant this run every `shell`/`agent` runner command the project config declares, including profile runners, package-manager script indirection, and project-local PATH resolution. Headless runs have no other way past the trust prompt; the grant is not persisted. Command strings containing `{prompt}` are rejected by config validation; pass prompts through stdin or args. |
| `--allow-unverified-auth` | boolean | `false` | Let a headless run proceed when a compatible CLI runner's authentication could not be verified. Only affects headless runs (`--json` or `--plain`); interactive runs disclose the unverified state and prompt instead. |
| `--json` | boolean | `false` | Headless: emit public NDJSON records to stdout, skip TUI. Workflow events are wrapped as `{ "type": "event", "data": <EngineEvent> }`. Requires a `feature`. |
| `--plain` | boolean | `false` | Headless: emit one plain line per phase, task, review and completion instead of NDJSON. Requires a `feature`. Mutually exclusive with `--json`. |

### Examples

```bash
# Shorthand — no subcommand needed (start is default)
splitbrief "fix the typo in README"

# With @file context injection
splitbrief "refactor auth" @design-notes.md @screenshot.png

# Interactive TUI (no feature → home screen)
splitbrief start

# Standard workflow on a feature description
splitbrief start "extract auth into module"

# Speckit mode with budget cap
splitbrief start --mode speckit --budget 2.00 "rewrite billing"

# Headless / CI: stream NDJSON events
splitbrief start --json --approve none "fix flaky test in user.test.ts"

# Headless / CI: four line shapes a shell script can read
splitbrief start --plain --approve none "fix flaky test in user.test.ts"

```

### Exit codes

- `0` — workflow completed (or TUI exited cleanly).
- `1` — invalid or unwritable config, planner/implementer failure, budget exceeded, or any uncaught error.
- `2` — an invalid flag combination, such as `--plain` together with `--json`.

### Files affected

- **Reads:** `.splitbrief/config.yaml`, `.splitbrief/sessions/<id>/state.json` (if resuming), repo files supplied to the planner.
- **Writes:** `.splitbrief/sessions/<id>/{readiness.json,spec.md,plan.md,tasks.md,state.json,session.jsonl}`, working-tree changes by the implementer.

### See also

- `splitbrief spec` — planning only, no implementation.
- `splitbrief resume` — continue an interrupted run.
- [WORKFLOW.md](./WORKFLOW.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [CONFIGURATION.md](./CONFIGURATION.md).

### Behavior notes

- `--json` requires a feature where it starts a new workflow.
- `--plain` and `--json` are two renderings of one headless stream and cannot share stdout; passing both exits `2` with `--plain and --json cannot be combined; choose one output mode.`
- Before planner or implementer calls, `start` computes Run Readiness. Blockers stop the run; warnings are shown in the TUI or emitted as JSON. The compact session artifact is `.splitbrief/sessions/<id>/readiness.json`. Stable `stateId` values and copyable remediations for missing-binary, untrusted-path, version, authentication, endpoint, credential-family, protocol, quota/rate, and conflicting-argument conditions are documented under `splitbrief doctor --json`.
- Readiness inspects validation configuration and package-script posture only. It does not run `typecheck`, lint, tests, model calls, or network probes.
- With `--json`, the first readiness line is `{ "type": "readiness_report", "report": ... }` before model-backed workflow events.
- `clearStaleSession()` runs before a new session begins. It blocks only a genuinely live active session; if the active session's lockfile has exited or the PID is gone, the stale `.splitbrief/active` pointer is cleared and start continues.
- The `setupWorkflow()` step may show an interactive setup screen if config is incomplete; pass `--allow-hooks` in CI to skip the hook-trust prompt.
- The `--reviewer-*` flags start from whatever runner currently holds the review seat — the `reviewer` block when config has one, the planner when it does not — and write the result back as the reviewer. If no `--reviewer-*` flag applies to the resolved runner kind, nothing is written and the planner keeps the review seat; a flag that names the planner's own tool still writes an explicit `reviewer` block, so the seat is admitted, priced and displayed on its own. The nine flags are declared once in `addWorkflowOptions()` (`src/cli/options.ts`), so `start`, `resume` and `continue` all accept them.
- Runner override flags are validated against the resolved runner kind. `--planner-api-base` / `--reviewer-api-base` / `--implementer-api-base` apply only to `api` runners, and `--planner-api-key-env` / `--reviewer-api-key-env` / `--implementer-api-key-env` apply only to `api` runners. Passing one for an incompatible kind prints a warning to stderr (e.g. `--planner-api-base is ignored: the planner 'cli' runner does not use it.`) and the value is dropped rather than erroring.

---

## splitbrief spec

**Synopsis**

```
splitbrief spec <feature> [options]
```

Run only the planner. Produces the planning artifacts for the selected mode in a fresh session folder, then exits without invoking the implementer. In `standard` and `speckit` that is `spec.md`, `plan.md`, and `tasks.md`; in `quick`, a single planner call produces `tasks.md`. Useful for review-only flows or scripting.

Planner stream output is stripped of terminal control sequences before writing to stdout.

### Usage

```
splitbrief spec <feature> [--mode <mode>] [--project <dir>] [--allow-hooks] [--allow-repo-runners]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--mode <mode>` | enum | `standard` (or `workflow.mode` from config) | One of `quick`, `standard`, `speckit`. Same validation and precedence as `splitbrief start`: the flag wins over `workflow.mode`, and an unrecognized value fails the command. See [WORKFLOW.md](./WORKFLOW.md). |
| `--project <dir>` | path | cwd | Project directory. |
| `--allow-hooks` | boolean | `false` | Trust the hook config without prompting (CI). |
| `--allow-repo-runners` | boolean | `false` | Grant this run the planner runner command the project config declares. |

### Examples

```bash
# Generate a spec for review
splitbrief spec "add SSO via Okta"

# Just the Task Brief, one planner call
splitbrief spec --mode quick "rename the config loader"

# Full ceremony for a risky change
# (writes the standard artifact set: spec --mode speckit never produces the
# speckit-only orchestrator artifacts)
splitbrief spec --mode speckit "replace the auth provider"

# Run in another repo
splitbrief spec --project ../service-a "add health endpoint"

# CI-friendly invocation
splitbrief spec --allow-hooks "tighten zod schemas"
```

### Exit codes

- `0` — the mode's planner artifacts were written.
- `1` — not a git repo, invalid or unwritable config, invalid `--mode` value, hooks distrusted, planner failure, init failure, or any other failure (the underlying error message is preserved through `Error.cause`).

### Files affected

- **Reads:** `.splitbrief/config.yaml`, repo files passed to the planner, `~/.splitbrief/trust/hooks.json`.
- **Writes:** the planning artifacts under `.splitbrief/sessions/<id>/` for the resolved mode (`research.md`, `spec.md`, `plan.md`, `tasks.md` in `standard` / `speckit`; `tasks.md` in `quick`), and the `.splitbrief/active` pointer.
- **On a failed planner call:** the session directory it allocated is removed again via the preparation rollback (including the `.splitbrief/active` pointer); no directory is left behind.

### See also

- `splitbrief start` — full plan-and-implement.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md), [WORKFLOW.md](./WORKFLOW.md).

### Behavior notes

- Planner output streams to stdout in real time via the `onOutput` callback. Phase headings appear as bold `--- <phase> ---` separators.
- The line printed before planning starts names the planner and the resolved mode, so the mode in force is visible at the point of decision.
- `spec` runs no approval gate. `--approve` is not accepted here; the mode's approval defaults apply to `splitbrief start`, not to planning-only runs.
- The stale-session sweep runs before the new session is prepared — a crashed prior run will not block this one.
- Session id is generated from the feature; the final summary prints the absolute path of every artifact the mode produced.
- The number of generated tasks is reported as `... (N tasks)` after the run.

---

## splitbrief review

**Synopsis**

```
splitbrief review [options]
```

One reviewer call over the current diff. No session is created, no planning phase runs, and no state machine is entered: the command collects the diff, hands it to the review seat with the same review prompt a full run uses, prints the verdict and findings, and writes the review to `.splitbrief/reviews/<timestamp>/review.md`.

The specification line in that prompt reads `none — review for correctness, scope creep, and test coverage of the diff`, because a one-shot review has no spec and no Task Briefs to check against.

### Usage

```
splitbrief review [--reviewer <tool>[:<model>][@<effort>]] [--base <ref>] [--project <dir>] [--allow-repo-runners] [--allow-unverified-auth]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--reviewer <spec>` | seat | the configured reviewer, else the planner | The review seat in the same grammar the skills use for `impl=` / `review=`: `<tool>[:<model>][@<effort>]`, split on the first `:` and the last `@`. `codex`, `codex@high`, `opencode:opencode-go/kimi-k3@high` are all valid. |
| `--base <ref>` | git ref | working tree | Diff against this ref (`git diff <ref>` plus untracked files) instead of the uncommitted working tree. |
| `--project <dir>` | path | cwd | Project directory. |
| `--allow-repo-runners` | boolean | `false` | Grant this run the shell/agent runner commands the project config declares. |
| `--allow-unverified-auth` | boolean | `false` | Let this review run headless when the review seat's CLI authentication could not be verified. A one-shot review runs no hooks, so there is no `--allow-hooks` to pass. |

### Examples

```bash
# Review everything uncommitted
splitbrief review

# Review the branch against main, with a second-opinion seat
splitbrief review --base main --reviewer codex@high

# Review another repo's working tree
splitbrief review --project ../service-a
```

### Exit codes

- `0` — the review ran (whatever its verdict), or the tree was clean and the command printed `nothing to review`.
- `1` — not a git repo, invalid config, blocked runner admission, or a failed reviewer call.

### Files affected

- **Reads:** `.splitbrief/config.yaml`, the git diff, repo files the reviewer opens itself.
- **Writes:** `.splitbrief/reviews/<YYYY-MM-DD-HHMMSS>/review.md`. Nothing under `.splitbrief/sessions/`, and the `.splitbrief/active` pointer is never touched.

### See also

- `splitbrief start` — the full loop, whose final review uses the same prompt with the run's spec and briefs.
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — the three seats and how the review seat resolves.

### Behavior notes

- The review seat resolves exactly once, through `resolveReviewerRunner`: a configured `reviewer:` block, or the planner holding the seat. `--reviewer` overrides that seat for this call only; nothing is written back to the config.
- The reviewer runs in its tool's read-only mode (for Claude Code, `--permission-mode plan`).
- A clean tree prints `nothing to review` and exits `0` before any runner is constructed — the command never spawns a tool with nothing to say.
- A diff longer than 100,000 characters is truncated in the prompt with an explicit `[... diff truncated, N characters omitted ...]` marker; the file on disk holds the reviewer's full answer.
- Reviewer output streams to stdout with terminal control sequences stripped, then the verdict, findings and the review path are printed.

---

## splitbrief doctor

**Synopsis**

```
splitbrief doctor [--project <dir>] [--json] [--probe-validation]
```

Check whether the current repository and SPLITBRIEF configuration are ready for a safe run. `doctor` is read-only: it does not create `.splitbrief/active`, session folders, worktrees, snapshots, config rewrites, planner calls, or implementer calls. It probes each configured CLI runner the way `start` does — installation, trust, version, authentication, and the arg vector SPLITBRIEF would emit compared against that binary's own `--help` — and runs no validation subprocesses unless `--probe-validation` is given.

### Usage

```
splitbrief doctor [--project <dir>] [--json] [--probe-validation]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--json` | boolean | `false` | Emit one stable JSON readiness object to stdout for automation (`doctor --json`). |
| `--probe-validation` | boolean | `false` | Run the configured validation commands against the working tree and report a `validation.already-failing` warning naming every stage that is already red before any task. It runs real commands (`validation.timeoutMs` per stage) and can take minutes. The resolved commands are listed in the check details, and the check notes that during a run SPLITBRIEF may resolve different commands from planner discovery. |

### Examples

```bash
splitbrief doctor
splitbrief doctor --project ../service-a

# Automation: stable stateId + remediation per check
splitbrief doctor --json

# Pre-run diagnostic: which validation stages are already red?
splitbrief doctor --probe-validation
```

### Exit codes

- `0` — ready or ready with warnings.
- `1` — blocked by a hard local precondition such as no git repo, invalid config, missing config, or a live same-checkout session. With `--json`, the report is still written to stdout before exit.

### Files affected

- **Reads:** git status, `.splitbrief/config.yaml` when present, `.splitbrief/active` when present, `package.json` when present, and each configured CLI runner's own version, auth, and `--help` output (read-only probes of the trusted executable identity).
- **Writes:** none.

### JSON output (`doctor --json`)

`splitbrief doctor --json` writes a single JSON object to stdout (not NDJSON):

```json
{ "type": "readiness_report", "report": { "generatedAt": "...", "projectDir": "...", "status": "ready|blocked|warning", "counts": { ... }, "nextAction": { ... }, "checks": [ ... ], "metadata": { ... } } }
```

`report.checks` is a flat list; section titles from human output are omitted. Each check carries:

| Field | Meaning |
|---|---|
| `id` | Stable check identifier (for example `runners.cli.claude-code.readiness`, `config.invalid`). |
| `severity` | `ok`, `info`, `warning`, or `blocker`. |
| `summary` | One-line human summary. |
| `stateId` | Stable diagnostic state ID when the check maps to a known failure family; `null` otherwise. |
| `remediation` | Copyable next action when `stateId` is set or the check supplies a fix; `null` otherwise. |
| `details` | Optional detail lines (secret-redacted). |
| `nextAction` | Optional structured pointer (`kind`, `label`, `command`). |
| `modelSelection` | On `runners.<role>.configured`: `auto` (automatic selection), `explicit` (a model ID), or `unset` (no `model` key). Absent on other checks. |

Human and JSON output share the same remediation strings. CLI executable identity paths and secrets are redacted from check text; `projectDir` is emitted verbatim as the absolute project directory.

`start --json` emits the same `readiness_report` shape as its first stdout line before workflow events. `resume` re-probes CLI readiness for start gates but emits no `readiness_report`. See [FEATURES.md](./FEATURES.md).

### Readiness diagnostic state IDs

CLI readiness, config validation, and provider posture checks map to stable `stateId` values. Prefer `stateId` and `remediation` in automation instead of parsing free-form text.

| `stateId` | Condition | Copyable remediation |
|---|---|---|
| `missing-binary` | Configured CLI is not installed or not on PATH. | Install the configured CLI, then run `splitbrief doctor` again. |
| `untrusted-path` | Executable identity does not match the trusted fingerprint (untrusted project-bin or stale fingerprint). | Trust the exact CLI executable identity, then run `splitbrief doctor` again. |
| `incompatible-version` | Installed CLI version is outside the tested or qualified range. | Install the tested CLI version, then run `splitbrief doctor` again. |
| `unauthenticated` | Required auth channel is not satisfied in the staged runner environment. | Authenticate the CLI in the staged runner environment, then run `splitbrief doctor` again. |
| `auth-unknown` | Auth probe could not determine login state. | CLI authentication cannot be verified without spending a call: stored credentials prove presence, not a working session. The first real call settles it; if it fails to authenticate, sign in to the CLI again. |
| `endpoint-invalid` | Provider `apiBase` violates the declared endpoint policy (wrong scheme, origin, or redirect target). | Fix the provider endpoint to match its declared policy, then run `splitbrief doctor` again. |
| `credential-family-mismatch` | Environment credential prefix or family does not match the declared provider. | Use a credential that matches the declared provider family, then run `splitbrief doctor` again. |
| `protocol-failure` | CLI or API output protocol error, including a missing terminal result line. | Check the CLI or provider version and output protocol, then run `splitbrief doctor` again. |
| `quota-rate-limit` | Provider returned quota or rate-limit pressure (for example HTTP 429). | Wait for quota or rate limits to reset, reduce request volume, or switch providers, then run `splitbrief doctor` again. |
| `conflicting-args` | Runner configuration contains mutually exclusive CLI arguments. | Remove conflicting runner arguments from the config, then run `splitbrief doctor` again. |

CLI installation, trust, version, and auth mapping for admitted tools: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md). Endpoint and credential rules: [CONFIGURATION.md](./CONFIGURATION.md), [API-KEYS.md](./API-KEYS.md).

### Runner outcome states (workflow commands)

During `start`, `spec`, `resume`, and other commands that invoke planners or implementers, subprocess failures normalize to `RunnerOutcome` states in session events and `session.jsonl`. These differ from readiness `stateId` values but use the same copyable remediation pattern:

| `state` | Condition | Copyable remediation |
|---|---|---|
| `output-budget-breach` | CLI stdout, stderr, or protocol event stream exceeded the configured byte or line budget. | Reduce the requested output or increase the configured output budget. |
| `no-staged-change` | Implementer completed without staging the expected working-tree change. | Make the requested change in the staged project, then retry. |

Other distinguishable runner outcomes (`spawn-not-found`, `protocol-failure`, `incompatible-version`, `unauthenticated`, and others) are documented in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [ENGINE.md](./ENGINE.md). Symptom-oriented guidance: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### See also

- [FEATURES.md](./FEATURES.md) — when to run doctor and how readiness gates `start`.
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — admitted CLI readiness states and runner contracts.
- [CONFIGURATION.md](./CONFIGURATION.md) — endpoint policy, runner args, and conflicting-flag validation.
- [API-KEYS.md](./API-KEYS.md) — credential resolution and provider families.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptom to state ID to remediation.

### Behavior notes

- Missing config reports `splitbrief init`; legacy config warnings report `splitbrief init --reconfigure`, but `doctor` does not run setup commands.
- Validation readiness is posture only. It reports disabled checks or missing npm scripts without running validation commands; the exception is `--probe-validation`, which runs the configured commands.
- Runner availability is probed for the `api` runners a run would call (`runners.availability.planner`, `runners.availability.implementer.<profile>`, and `runners.availability.reviewer` when a `reviewer` block is configured). Each probe is one model-list round trip against the endpoint the runner already targets, bounded by a 2s budget and run in parallel. An unreachable planner or default implementer is a blocker — the planning phase is paid for before the implementer is first used — while a non-default profile is a warning. A probe that could not run or overran its budget reports `not-probed` (info); it never reports available. When no probe runs at all, readiness says so and makes no claim (`runners.availability`).
- The arg-vector preflight runs here too, so a blocker `start` would raise can be inspected without starting a run: a flag the installed binary's help does not advertise is a blocker (`runners.cli.<tool>.arg-vector.<role>`), a flag it marks deprecated is a warning, and a help text that cannot be read reports ok. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
- A `shell` or `agent` runner reaches execution only through an owner-only trust receipt, so `doctor` replays that admission read-only (`runners.consent.planner`, `runners.consent.implementer.<profile>`, and `runners.consent.reviewer` when a `reviewer` block is configured) instead of only warning that the runner can execute commands. The verdict is reported for a run started the way `doctor` was started: on a TTY it is a warning naming the one-time confirmation `start` would prompt for, and with `--json` or a non-TTY stdin it is the blocker a non-interactive run receives. Nothing is written and no receipt is granted — `doctor` takes no `--allow-repo-runners`, so a run that passes that flag can be admitted where `doctor` reports a blocker, and the check's remediation names the flag.
- Headless runner admission is replayed the same way: with `--json` or a non-TTY stdin, `doctor` runs the same `runners.preparation.*` checks `start --json` would fail on when a configured CLI runner lacks a trusted readiness identity or would otherwise be refused headless admission. Each check's remediation names `--allow-unverified-auth` when that flag would admit the run; `doctor` accepts no override flags, so a headless run that passes `--allow-unverified-auth` can proceed where `doctor` reports a blocker. Interactive `doctor` on a TTY does not emit these preparation blockers — interactive `start` discloses and prompts instead.
- `doctor --json` never prints decorative section banners; checks are serialized semantically for parsers.

---

## splitbrief init

**Synopsis**

```
splitbrief init [--project <dir>] [--reconfigure] [--yes]
```

Bootstrap a project. Creates `.splitbrief/config.yaml` populated with detected planner / implementer providers and models, then opens the TUI setup screen for review. Safe to re-run with `--reconfigure` to start over.

`--yes` skips the setup screen and writes the default config directly — the same defaults `start` and `spec` fall back to when no config exists, written on purpose instead of as a side effect. That is the mode for CI, container builds and piped shells: the setup screen needs a TTY, and without `--yes` a non-TTY invocation refuses and points at `--yes`.

### Usage

```
splitbrief init [--project <dir>] [--reconfigure] [--yes]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | string | cwd | Project directory. Canonicalized to the git toplevel, like every other command. |
| `--reconfigure` | boolean | `false` | Overwrite an existing `.splitbrief/config.yaml`. Without this flag, init refuses to overwrite. |
| `--yes` | boolean | `false` | Write the default config without the interactive picker. Requires no TTY. |

### Examples

```bash
# First-time setup in a repo
splitbrief init

# Non-interactive: CI, Dockerfile, or a piped shell
splitbrief init --yes

# Bootstrap another checkout without cd-ing into it
splitbrief init --yes --project ~/code/other-repo

# Throw away current config and start over
splitbrief init --reconfigure
```

### Exit codes

- `0` — config exists / was created and the TUI exited cleanly, or `--yes` wrote the config.
- `1` — no TTY and no `--yes`, TUI render failure, or unexpected I/O error.

### Files affected

- **Reads:** existing `.splitbrief/config.yaml` (to detect collision), provider environment.
- **Writes:** `.splitbrief/config.yaml`, store directories under `.splitbrief/`.

### See also

- [CONFIGURATION.md](./CONFIGURATION.md) — every config field.
- [API-KEYS.md](./API-KEYS.md) — credential resolution.
- [BOOTSTRAP.md](./BOOTSTRAP.md) — startup sequence.

### Behavior notes

- If `.splitbrief/config.yaml` already exists and `--reconfigure` is not passed, init prints "Config already exists at .splitbrief/config.yaml" plus a hint and exits `0`.
- The TUI launches in fullscreen mode. The `setup` screen handoffs to the home screen when the user finishes.
- `--project` pointing inside a repository writes to the repository root, not the directory you named: init prints `Warning: --project <dir> is inside git repository <root>; using repository root.` and configures `<root>`.

---

## splitbrief status

**Synopsis**

```
splitbrief status [--project <dir>]
```

Print the current session's phase, task progress, planner / implementer identity, and counts for completed / escalated / failed tasks.

### Usage

```
splitbrief status [--project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |

### Examples

```bash
# What is the current run doing?
splitbrief status

# Inspect a different repo
splitbrief status --project ../other-repo
```

### Exit codes

- `0` — always (status is read-only).
- `1` — only on unexpected I/O failure when reading session files.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/state.json`.
- **Writes:** none.

### See also

- `splitbrief resume` — pick up where the active session left off.

### Behavior notes

- If there is no active session, prints `No active workflow.`
- The `(awaiting continue)` suffix on the phase line means the run is in the Ctrl-C abort/continue state and is waiting for user input.
- `Done`, `Escalated`, `Failed` lines only appear when the corresponding count is non-zero.

---

## splitbrief resume

**Synopsis**

```
splitbrief resume [options]
```

Resume the current active interrupted session. Validates the saved state version and current phase; refuses to resume from a non-resumable phase or stale schema. If the active pointer was cleared after a clean cancel or stale lockfile cleanup, use `splitbrief continue <session-id>` instead. Accepts the same workflow flags as `start`.

### Usage

```
splitbrief resume [--mode <mode>] [--approve <level>] \
  [--planner <tool>] [--planner-model <model>] [--planner-command <cmd>] \
  [--planner-api-base <url>] [--planner-api-key-env <var>] [--planner-args <arg>] \
  [--planner-output-format <format>] [--planner-context-length <tokens>] \
  [--implementer <provider>] [--implementer-model <model>] [--implementer-command <cmd>] \
  [--implementer-api-base <url>] [--implementer-api-key-env <var>] [--implementer-args <arg>] \
  [--implementer-output-format <format>] [--implementer-context-length <tokens>] \
  [--reviewer <tool>] [--reviewer-model <model>] [--reviewer-command <cmd>] \
  [--reviewer-api-base <url>] [--reviewer-api-key-env <var>] [--reviewer-args <arg>] \
  [--reviewer-output-format <format>] [--reviewer-context-length <tokens>] \
  [--model <model>] [--provider <provider>] \
  [--budget <amount>] [--planner-effort <level>] [--reviewer-effort <level>] [--yolo] \
  [--project <dir>] \
  [--no-fullscreen] [--no-mouse] [--hover] \
  [--allow-hooks] [--allow-repo-runners] [--json] [--plain]
```

### Options

Resume accepts the same workflow override options as `start`. See [`splitbrief start`](#splitbrief-start) for the shared runner, mode, budget, and approval flags.

| Flag | Notes |
|---|---|
| `--json` | Resume the run in headless mode, streaming NDJSON to stdout. |
| `--plain` | Resume the run in headless mode, writing plain lines to stdout. Mutually exclusive with `--json`. |
| `--mode` / `--approve` / planner+implementer flags | Override the persisted values for this run only. The workflow mode resolved on the original run is saved in `state.json`; resume reuses it unless `--mode` is passed, which overrides it and prints a warning. |

### Examples

```bash
# Pick up where the last session stopped
splitbrief resume

# Resume in headless mode for CI re-runs
splitbrief resume --json --approve none

# Force a different implementer for the rest of the run
splitbrief resume --implementer claude-code --implementer-model claude-sonnet-4-5
```

### Exit codes

- `0` — resumed successfully (TUI or headless).
- `1` — no active session, missing `state.json`, schema older than `CURRENT_STATE_VERSION`, non-resumable phase, or any downstream failure.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/state.json`, `.splitbrief/config.yaml`.
- **Writes:** updates to `state.json`, `session.jsonl`, working-tree edits as the run proceeds.

### See also

- `splitbrief start` — fresh run.
- `splitbrief status` — see the current phase before resuming.
- [WORKFLOW.md](./WORKFLOW.md), [CHANGELOG.md](../CHANGELOG.md) — schema migrations.

### Behavior notes

- The version guard rejects resume with: `saved state is from an older version and cannot be resumed. Please start a new workflow with 'splitbrief start'.`
- `isResumable(state)` rejects any non-resumable phase (anything outside `RESUMABLE_PHASES` — `reviewing-spec`, `planning`, `reviewing-plan`, `reviewing-briefs`, `implementing`, `final-review` — without `awaitingContinue`) with: `session '<id>' is in phase "<phase>" which cannot be resumed.`
- A short `Resuming: <feature> (phase: <phase>, task N/M)` line prints before the TUI mounts.
- The workflow mode is pinned in `state.json` alongside `plannerModel`; resume reuses the saved mode and approval level unless `--mode` is passed explicitly, in which case the override applies and a warning is printed.

---

## splitbrief continue

**Synopsis**

```
splitbrief continue [session-id-or-number] [resume options]
```

Session continuity command: resolves the active session, a session id, or a numeric alias, then resumes it.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id-or-number>` | string \| number (positional) | active | Session ID or numeric alias; omitted to use `.splitbrief/active`. |
| `--project <dir>` | path | cwd | Project directory. |
| `--approve <level>` | approval | mode default | Spec/plan document approval mode. |
| `--allow-hooks` | boolean | `false` | Trust hook config without prompting. |
| `--allow-repo-runners` | boolean | `false` | Trust repo-local shell/agent runner commands from project config for resumed workflow execution. |
| `--json` | boolean | `false` | Resume an interrupted session in headless NDJSON mode. |
| `--plain` | boolean | `false` | Resume an interrupted session in headless plain-line mode. Mutually exclusive with `--json`. |
| Other resume flags | — | — | Runner overrides, mode, budget, `--no-fullscreen`, `--no-mouse`, `--hover`, and approval controls. |

### Examples

```bash
# Continue the active session
splitbrief continue

# Continue by numeric alias
splitbrief continue 1

# Continue a specific session
splitbrief continue 2026-05-01-add-auth
```

### Exit codes

- `0` — resumed successfully.
- `1` — no session to continue, unusable saved state, or an underlying resume failure.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/lockfile.json`, `.splitbrief/sessions/<id>/state.json`.
- **Writes:** same as `resume`.

### See also

- `splitbrief resume` — explicit resume of an interrupted session.

### Behavior notes

- `continue` delegates to `resume`, including `--json` or `--plain` when passed.
- Both commands compare the crew they are about to run against the crew the session last ran with (`.splitbrief/sessions/<id>/seats.json`). A seat that changed prints one stderr line per seat — `PLAN seat changed <old> → <new>; context will be rebuilt` for the plan seat, `…; the rest of the run uses the new seat` for the others. A moved plan seat also drops the saved planner session, because it cannot be replayed on a different tool, so the run rebuilds planner context from the transcript. The run itself re-records the crew once it starts, so a resume that never gets past preparation keeps the notice for the next attempt, and an in-app resume from the sessions overlay maintains the record the same way (it reports the change as a workflow warning). The identity is the same `<tool> · <model>` string the crew rows and the workflow header show.

---

## splitbrief approval

**Synopsis**

```
splitbrief approval <subcommand> [options]
```

Manage sticky approval grants. When a workflow asks for approval and the user picks "always allow", the choice is recorded as a grant. This command lists or clears those grants.

Subcommands: `list`, `clear`.

---

### splitbrief approval list

**Synopsis**

```
splitbrief approval list [--project <dir>]
```

Print every grant in `.splitbrief/approvals.json` as an aligned table.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |

#### Output

Columns: `pattern`, `class`, `scope`, `sessionId`, `grantedAt`. If empty, prints `No sticky approvals on record.`

#### Exit codes

- `0` — listed.
- `1` — store could not be read.

---

### splitbrief approval clear

**Synopsis**

```
splitbrief approval clear [--scope <scope>] [--project <dir>]
```

Remove grants whose scope matches the filter.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--scope <scope>` | enum | `all` | One of `session`, `always`, `all`. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
splitbrief approval list
splitbrief approval clear                      # clears everything
splitbrief approval clear --scope session      # only per-session grants
splitbrief approval clear --scope always       # only persistent grants
```

#### Exit codes

- `0` — cleared (prints `Cleared <N> approval grant(s).`, where `N` may be `0`).
- `1` — invalid scope or store write failure.

### Files affected (approval)

- **Reads / writes:** `.splitbrief/approvals.json`.

### See also (approval)

- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — `/approval` semantics during a run.
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook policies that interact with approvals.

---

## Cross-cutting reference

### Diagnostic state IDs and support

Commands in this section share stable `stateId` / `state` identifiers and copyable `remediation` strings with `splitbrief doctor --json` (see [`splitbrief doctor`](#splitbrief-doctor)). Canonical references: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [CONFIGURATION.md](./CONFIGURATION.md), [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### Common flags across multiple commands

| Flag | Commands | Default | Notes |
|---|---|---|---|
| `--project <dir>` | most | cwd | Project directory. |
| `--mode <mode>` | `start`, `spec`, `resume`, `continue` | `workflow.mode`, else `standard` | One of `quick`, `standard`, `speckit`; the retired `instant` parses as `quick` with a deprecation notice. Validated against the same enum everywhere; on the resume family it overrides the mode saved in `state.json` and prints a warning. |
| `--allow-hooks` | `start`, `resume`, `continue`, `spec` | `false` | Skip the hook-trust prompt. CI flag. |
| `--allow-repo-runners` | `start`, `resume`, `continue`, `spec`, `review` | `false` | Trust repo-local shell/agent runner execution from project config. Separate from hook trust. |
| `--allow-unverified-auth` | `start`, `resume`, `continue`, `review` | `false` | Let a headless run proceed with unverified CLI authentication. No effect on interactive runs, which disclose and prompt. |
| `--plain` | `start`, `resume`, `continue` | `false` | Plain-line headless stream — `phase:`, `task:`, `review:` and `done:` lines. Refuses to run alongside `--json` (exit `2`). |
| `--json` | `start`, `resume`, `continue`, `doctor` | `false` | Public NDJSON record stream for workflow commands; a single JSON object for `doctor`. Workflow events are wrapped as `{ "type": "event", "data": ... }`. For `continue`, applies only when the target is an interrupted resumable session. |

### Where state lives

| Path | Owner | Purpose |
|---|---|---|
| `.splitbrief/config.yaml` | `init` | Provider, model, workflow, and hooks config. |
| `.splitbrief/active` | `start`, `spec` | Pointer to the current session while a workflow is active; cleared on final save unless preserved for recovery. |
| `.splitbrief/sessions/<id>/spec.md` | planner | Spec phase output. |
| `.splitbrief/sessions/<id>/plan.md` | planner | Plan phase output. |
| `.splitbrief/sessions/<id>/tasks.md` | planner | Task list. |
| `.splitbrief/sessions/<id>/state.json` | orchestrator | Persisted machine state for `resume` / `status`. |
| `.splitbrief/sessions/<id>/seats.json` | `start`, `resume`, `continue` | The crew the session last ran with, so a resume can report a seat change. Rewritten by every run that starts, resumes included; a resume that never starts leaves it alone. |
| `.splitbrief/sessions/<id>/session.jsonl` | orchestrator | Append-only transcript and event log. |
| `.splitbrief/sessions/<id>/snapshots/<snap-id>/` | runtime `/run accept` | The working-tree snapshot an accepted run records, plus the run ledger that marks it accepted. Nothing records a pre-run baseline, so `/run reject confirm` has nothing to restore. |
| `.splitbrief/approvals.json` | `approval`, runtime `/approval` | Sticky grants. |
| `~/.splitbrief/trust/hooks.json` | `start`/`resume`/`spec` trust prompt | Hook trust receipts, owner-only, keyed by checkout. Never inside the project. |
| `$XDG_STATE_HOME/splitbrief/trees/<hash>/<session-id>/` | run isolation | The implementer's per-run worktree, on branch `splitbrief/<session-id>`. Defaults to `~/.local/state/splitbrief/trees/...` when `XDG_STATE_HOME` is unset; `<hash>` is the first 12 hex chars of `sha256(realpath(git-common-dir))` so every linked checkout shares one trees root. Outside `.git/` (direct-writing CLIs refuse paths there) and outside the project root (so project-rooted test globs never walk the second copy). `git worktree list` is how you find one that outlived its run. |

### Headless event stream (`--json`)

When `start`, `resume`, or an interrupted resumable `continue` runs with `--json`, stdout emits one public JSON record per line (NDJSON). Live workflow events use `{ "type": "event", "data": <EngineEvent> }`. Other records use named top-level types such as `readiness_report`, `recovery_required`, `final_review_failed`, `warning`, and `error`. Public records are bounded and secret-redacted before writing. The TUI is not started, the alternate screen buffer is never entered, and `--no-fullscreen`/`--no-mouse`/`--hover` are no-ops in this mode. Workflow review gates approve by default (a blocked brief-readiness report therefore proceeds after the second internal approval), questions resolve non-interactively, continuation retry prompts never park (a watchdog idle-kill fails the run instead), recovery pauses such as unknown paid pricing exit non-zero, failed sessions exit non-zero, and file-write tiered sticky/confirm approvals fail closed instead of waiting for input.

The `recovery_required` record carries `reason`, `status` (`awaiting-user` | `paused` | `applying`), message, task/files when known, `availableActions`, and `recommendedAction`; `status` was added after the initial release and older consumers must treat it as optional. The command fails with exit code 1 for **every** pending recovery status — `paused` and `applying` exit non-zero exactly like `awaiting-user` — and the error message names the available resolution actions.

### Plain output stream (`--plain`)

`--plain` renders the same headless run as four line shapes and nothing else, so a shell script can read a run without a JSON parser:

```
phase: researching
phase: implementing
task T001: done (typecheck lint test)
task T002: done (typecheck lint test)
task T003: done (typecheck lint test)
phase: final-review
phase: complete
review: passed
done: 3 tasks, 128.4k tokens
```

- `phase: <name>` — written once each time the run enters a new phase.
- `task <id>: done|failed (<gates>)` — the gates are the validation stages that passed for that task, or `no gates` when validation was skipped and `skipped` for a task a recovery skipped.
- `review: passed|failed` — the final review verdict.
- `done: <n> tasks, <tokens>` — the closing line. `<n>` counts the tasks that completed, not the length of the task list. Cost is reported in tokens: the event stream carries token counts, not prices.

Everything else the run emits is dropped — including `recovery_required`, which is a `--json` record. A halt no one is there to answer ends the plain stream: the failing task's `failed` line is the last line written, there is no `review:` or `done:` line, and the command exits 1.

`--plain` cannot be combined with `--json`.

### Workflow modes (`--mode`)

| Mode | Planner calls | Approval gates | Best for |
|---|:---:|:---:|---|
| `quick` | 1 | none | Trivial edits and small tasks that still need a brief. |
| `standard` (default) | 4 | supporting spec + briefs | Ordinary feature work. |
| `speckit` | 6–7 | supporting spec + plan + briefs | Large, risky, or externally visible work. |

`--mode` is accepted by `start`, `spec`, `resume`, and `continue`. On `spec` it selects planning depth only — that command never implements and runs no approval gate. `--mode instant` is retired: it still parses, resolves to `quick`, and prints a deprecation notice on stderr. Detailed semantics in [WORKFLOW.md](./WORKFLOW.md).

### Runner kinds (`--planner` / `--implementer`)

| `kind` | What it is | Examples |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code` |
| `api` | OpenAI-compatible HTTP endpoint | `ollama`, `lm-studio` |
| `shell` | Arbitrary command (stdin → stdout), no shell/network sandbox | Custom scripts via `--planner-command` / `--implementer-command` |
| `agent` | Subprocess that writes files directly, no stdout extraction or shell/network sandbox | Custom file-writing tools |

Schemas and YAML shape live in [ARCHITECTURE.md](./ARCHITECTURE.md) and [CONFIGURATION.md](./CONFIGURATION.md). Built-in CLI tools may run their own auto/permission modes according to their upstream behavior; SPLITBRIEF surfaces warnings but does not sandbox shell or network access.

### Getting help

```bash
splitbrief --help                     # top-level help
splitbrief <command> --help           # command help (Commander-generated)
splitbrief approval --help            # subcommand parents print their child list
splitbrief approval list --help       # leaf subcommand help
```

Commander emits a usage banner, the description string, and the option table verbatim — this reference document expands the same surface with examples, exit codes, files, and behavior notes.
