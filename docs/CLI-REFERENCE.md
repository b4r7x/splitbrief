# CLI Reference

Complete reference for every `splitbrief` command. Maintained against `src/cli.ts` and `src/cli/commands/*.ts`.

```
SPLITBRIEF — an orchestrator of two coding tools: one plans and reviews, the other executes, and it holds the contract, validation, retry, escalation and evidence
```

## Global behavior

- **Binary name:** `splitbrief`. The `npm run dev -- <cmd>` form is equivalent during local development.
- **Working directory:** Most commands accept `--project <dir>`. When omitted, the project starts from the current working directory. Every command then canonicalizes it to the git toplevel (`canonicalizeProjectDir` in `src/cli/setup.ts`), so a session started from `packages/web` is the same session `status`, `doctor` and `resume` see from the repository root, and `spec` never auto-creates a second config next to a nested `package.json`. An explicit `--project` pointing inside a repository prints a one-line relocation warning; a bare subdirectory invocation relocates silently.
- **Runtime requirement:** the CLI reads `process.versions.node` before it parses anything and refuses a Node older than 22, the lowest major in `package.json`'s `engines.node` (`^22.0.0 || ^24.0.0`), with `splitbrief requires Node.js 22 or newer; this process is Node.js <version>.` — see `src/cli/node-guard.ts`.
- **Mistyped subcommands:** `start` is the default command, so a bare token becomes a feature description. To stop `splitbrief doctro` from buying a planner call, a single bare operand that is not a registered command but is within one edit of a short command name (≤ 4 characters) or two edits of a longer one is rejected: `unknown command 'doctro' — did you mean 'doctor'?`, exit `1`. Transpositions count as one edit. The guard only looks at an invocation whose leading operand run is exactly one whitespace-free token, so `splitbrief "fix the typo"`, `splitbrief fix the typo` and the explicit `splitbrief start doctro` all still run. The guard skips tokens that start with `@`; they are file references, and `start` handles their refusal. See `src/cli/unknown-command.ts`.
- **Exit codes:**
  - `0` — success.
  - `1` — generic CLI failure. Almost every command throws via `cliError(message)` which defaults to `exitCode: 1`. The top-level handler in `src/cli.ts` prints `Error: <message>` to stderr and exits with the carried code.
  - `2`: `start` refuses an `@file` input, an empty feature description before `@file` inputs, or a feature description that starts with `@`. Guardrail hooks also use this code.
- **Error format:** Command errors print `Error: <message>` in red on stderr. Blocked `doctor` readiness prints its report on stdout and exits `1` without a repeated error message. Use `doctor --json` to read readiness blockers programmatically.

### Global options

`splitbrief --help` lists these entries next to the eight commands in the [Command index](#command-index).

| Option or command | Description |
|---|---|
| `-V, --version` | Print the version number and exit. |
| `-h, --help` | Print help and exit. After a command name, it prints the help for that command. |
| `help [command]` | Print the top-level help, or the help for `command`. |

## Command index

| # | Command | Purpose |
|---|---|---|
| 1 | `splitbrief start` | Launch a workflow (TUI or headless). Also the default command: `splitbrief "feature"` works without `start`. |
| 2 | `splitbrief spec` | Run the planning session only — write `plan.json`, `plan.md` and `tasks.md`, no implementation. |
| 3 | `splitbrief init` | Create `.splitbrief/config.yaml` with detected models. |
| 4 | `splitbrief status` | Show the active session. |
| 5 | `splitbrief resume` | Resume the most recent run. |
| 6 | `splitbrief continue` | Continue a run by id, with recovery and Apply actions. |
| 7 | `splitbrief doctor` | Check run readiness without creating a workflow session. |
| 8 | `splitbrief review` | Review the working-tree diff in one reviewer call — no session, no planning. |

---

## splitbrief start

**Synopsis**

```
splitbrief start [feature] [files...] [options]
```

Launch a complete plan-and-implement workflow. Without a feature argument the TUI opens to the home screen so you can pick one interactively. With a feature, SPLITBRIEF runs one planning session, shows the plan card (unless `workflow.approve: none`), then dispatches the implementer loop. This is the canonical entry point for ordinary work.

Without a config, the TUI opens Setup and proposes detected ready tools. Setup saves your choices to `.splitbrief/config.yaml`. A headless start (`--plain` or `--json`) saves a detected ready crew before starting; runner flags apply to that invocation. If detection finds no default crew, supplying every seat through runner flags saves that crew instead. REVIEW inherits PLAN unless explicitly set. If any seat is unavailable, start exits with a `splitbrief init` instruction and writes no config.

**Shorthand.** `splitbrief "feature"` is equivalent to `splitbrief start "feature"` — `start` is the default command (`isDefault`). No subcommand required for the happy path.

**`@file` syntax.** Put the feature description first, then the `@file` inputs. Example: `splitbrief "refactor auth" @context.md @screenshot.png`. A feature description cannot start with `@`. Example: `splitbrief "Implement @mentions in comments"`.

An `@file` input is the user's explicit choice. SPLITBRIEF reads the file wherever it is. Use an absolute path, a path relative to the project root, or `~/…`. SPLITBRIEF expands only a leading `~/` to the home folder. It follows symlinks. The file must exist, be a regular file, be at most 10 MiB, and be readable.

Text must use UTF-8 and contain no control bytes except whitespace. SPLITBRIEF refuses binary content with `not-text`. Images must use PNG, JPEG, GIF, WebP, or BMP.

Text enters planner context on every planner call and stays in the run's `state.json`. Images become planner attachments. The transcript lists each file as `text · <path>` or `image · <path>` under the request. Paths inside the project are relative; outside paths are resolved and absolute. `--plain` prints one `attached files:` line. `--json` carries `attachedInputs` on the `user_message` event.

Any refused input stops `start` before the run begins, with exit code `2`. One error names every refused input, its reason, and the fix. An empty feature description before `@file` inputs also stops `start` with exit code `2`. SPLITBRIEF attaches nothing from that command line.

CLI `@file` arguments are strict: a missing file always refuses the command. The [composer syntax](./FEATURES.md#file-context-injection) also accepts references within a message. A bare composer `@word` stays text when no file exists.

**A bare path.** A path without `@` in the feature text stays text. The plan seat uses its own tools and policy to read it. An `api` plan seat shows one warning before planning for existing absolute paths. The TUI shows the warning in the transcript. `--plain` and `splitbrief spec` write it to stderr. `--json` writes it as a `warning` record on stdout.

The warning reads `The plan seat reads no files, so it cannot open <p1>, <p2>. Put @ before a file path to attach its text.`

### Usage

```
splitbrief start [feature] [files...] \
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
  [--planner-effort <level>] [--reviewer-effort <level>] \
  [--skills <ids>] [--project <dir>] \
  [--no-fullscreen] [--no-mouse] [--hover] \
  [--allow-hooks] [--allow-repo-runners] [--allow-unverified-auth] [--on-seat-down <halt|switch>] \
  [--json]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--planner <tool>` | string | from config | Planner tool: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity`, `ollama`, `lm-studio`, `llama-cpp`, `shell`, `agent`. The flag's help text is derived from `PLANNER_TOOL_IDS` (`src/core/schemas/enums.ts`), so `splitbrief start --help` always prints the admitted set. A CLI tool id here always selects the CLI; an API provider that reuses a CLI tool's id is configured in `.splitbrief/config.yaml` (`kind: api`) and cannot be selected by this flag. |
| `--planner-model <model>` | string | from config | Planner model (CLI and API planners). |
| `--planner-command <cmd>` | string | from config | Custom planner command (when `--planner=shell`). |
| `--planner-api-base <url>` | string | from config | Planner API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--planner-api-key-env <var>` | string | from config | Environment variable holding the planner API key; stored as an `env:<var>` reference. A bare name is normalized to `env:<var>`. Applies only to `api` runners; ignored (with a stderr warning) otherwise. |
| `--planner-args <arg>` | string | from config | Append one planner CLI/shell argument. Repeatable; each use adds another argument. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-output-format <format>` | enum | from config | Planner output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-context-length <tokens>` | number | from config | Planner context length in tokens. Consumed only by the `api` planner kind, where it sizes the request's `max_tokens` output budget; other kinds delegate the budget to their backend and ignore it. |
| `--planner-effort <level>` | enum | — | Planner effort hint: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it. |
| `--implementer <provider>` | string | from config | Implementer provider: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity`, `ollama`, `lm-studio`, `llama-cpp`, `shell`, `agent`. The flag's help text is derived from the catalog's implementer role admission (`src/cli/options.ts`), so `splitbrief start --help` always prints the admitted set. A CLI tool id here always selects the CLI; an API provider that reuses a CLI tool's id is configured in `.splitbrief/config.yaml` (`kind: api`) and cannot be selected by this flag. |
| `--implementer-model <model>` | string | from config | Implementer model identifier. |
| `--implementer-command <cmd>` | string | from config | Custom implementer command (when `--implementer=shell`). |
| `--implementer-api-base <url>` | string | from config | Implementer API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--implementer-api-key-env <var>` | string | from config | Environment variable holding the implementer API key; stored as an `env:<var>` reference. A bare name is normalized to `env:<var>`. Applies only to `api` runners; ignored (with a stderr warning) otherwise. |
| `--implementer-args <arg>` | string | from config | Append one implementer CLI/shell argument. Repeatable; each use adds another argument. Applies to `cli`, `shell`, and `agent` runners. |
| `--implementer-output-format <format>` | enum | from config | Implementer output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--implementer-context-length <tokens>` | number | from config | Implementer context length in tokens. |
| `--reviewer <tool>` | string | from config | Reviewer tool. Same admitted set as `--planner` — the flag's help text is derived from `PLANNER_TOOL_IDS` too. Without any `--reviewer-*` flag and without a `reviewer` block in config, the planner keeps the review seat. A CLI tool id here always selects the CLI; an API provider that reuses a CLI tool's id is configured in `.splitbrief/config.yaml` (`kind: api`) and cannot be selected by this flag. |
| `--reviewer-model <model>` | string | from config | Reviewer model (CLI and API reviewers). |
| `--reviewer-command <cmd>` | string | from config | Custom reviewer command (when `--reviewer=shell`). |
| `--reviewer-api-base <url>` | string | from config | Reviewer API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--reviewer-api-key-env <var>` | string | from config | Environment variable holding the reviewer API key; stored as an `env:<var>` reference. Applies only to `api` runners; ignored (with a stderr warning) otherwise. |
| `--reviewer-args <arg>` | string | from config | Append one reviewer CLI/shell argument. Repeatable. Applies to `cli`, `shell`, and `agent` runners. |
| `--reviewer-output-format <format>` | enum | from config | Reviewer output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--reviewer-context-length <tokens>` | number | from config | Reviewer context length in tokens. Consumed only by the `api` kind, where it sizes the request's `max_tokens` budget. |
| `--reviewer-effort <level>` | enum | — | Reviewer effort hint: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The seat's tool accepts a subset and reports what it rejects. Requires the review seat to have its own runner: with no `reviewer` block in config and no `--reviewer`, the run is refused with a message naming `--reviewer`. On a configured reviewer whose backend has no reasoning control, it is dropped with a stderr warning. |
| `--model <model>` | string | — | Alias for `--implementer-model`. |
| `--provider <provider>` | string | — | Alias for `--implementer`. |
| `--skills <ids>` | string | — | Comma-separated skill ids to attach to every seat for this run, the headless equivalent of the `/skills` picker. Resolved against the same scan roots before planning starts; an id no root carries fails with `Unknown skill: <id> (scanned: <roots>)` and exit `2`. On `start` it applies to headless runs (`--json` / `--plain`); on `resume` and `continue` it applies in both modes, to that continue only — it is not saved, so a later continue without it uses the selection the run saved when it started. |
| `--yolo` | removed | — | Rejected with a removed-flag error. Only a protected-path write asks; the plan card follows `workflow.approve`. |
| `--project <dir>` | path | cwd | Project directory. |
| `--no-fullscreen` | boolean | fullscreen on | Disable the alternate screen buffer. Useful when piping or debugging. |
| `--no-mouse` | boolean | mouse on | Disable Ink mouse tracking — click, hover and scroll. Tracking runs only in fullscreen, so `--no-fullscreen` disables it too and leaves this flag a no-op. |
| `--hover` | boolean | `false` | Opt in to hover highlighting under the mouse. Requires both mouse tracking and fullscreen; a no-op with `--no-mouse` or `--no-fullscreen`. |
| `--allow-hooks` | boolean | `false` | Trust the hook config without prompting (CI). |
| `--allow-repo-runners` | boolean | `false` | Grant this run every `shell`/`agent` runner command the project config declares, including profile runners, package-manager script indirection, and project-local PATH resolution. Headless runs have no other way past the trust prompt; the grant is not persisted. The run keeps the grant while SPLITBRIEF stays open: after a stop, Resume, `⏎`, `/resume` or `/sessions` continue it under the same grant. A new SPLITBRIEF process needs the flag again (`splitbrief continue --allow-repo-runners`). Command strings containing `{prompt}` are rejected by config validation; pass prompts through stdin or args. |
| `--allow-unverified-auth` | boolean | `false` | Let a headless run proceed when a compatible CLI runner's authentication could not be verified. Only affects headless runs (`--json` or `--plain`); interactive runs disclose the unverified state and prompt instead. |
| `--json` | boolean | `false` | Headless: emit public NDJSON records to stdout, skip TUI. Workflow events are wrapped as `{ "type": "event", "data": <EngineEvent> }`. Requires a `feature`. |
| `--plain` | boolean | `false` | Headless: emit one plain line per phase, task, reviewer check, review and completion instead of NDJSON (see [Plain output stream](#plain-output-stream---plain)). Requires a `feature`. Mutually exclusive with `--json`. |
| `--on-seat-down <policy>` | enum | unset | Headless: `halt` stops on a seat-down halt; `switch` applies the seat's declared `fallback` at once. Unset applies a declared fallback too. `switch` with no declared fallback exits `2`. The swap goes through the TUI's own path, and a swap that leaves the halt pending exits `1` with `recovery_required`. See [Seat down](./APPROVAL-AND-RECOVERY.md#seat-down). |

### Examples

```bash
# Shorthand — no subcommand needed (start is default)
splitbrief "fix the typo in README"

# With @file context injection
splitbrief "refactor auth" @design-notes.md @screenshot.png

# Interactive TUI (no feature → home screen)
splitbrief start

# A workflow on a feature description
splitbrief start "extract auth into module"

# Headless / CI: stream NDJSON events
splitbrief start --json "fix flaky test in user.test.ts"

# Headless / CI: line shapes a shell script can read
splitbrief start --plain "fix flaky test in user.test.ts"

```

### Exit codes

- `0` — workflow completed (or TUI exited cleanly).
- `1` — invalid or unwritable config, planner/implementer failure, a pending recovery nobody answered, a final review that ended `failed`, or a run that did not reach `complete` (it is saved `open` or `ended` and can be continued with `splitbrief continue <id>`), or any uncaught error.
- `2` — an invalid flag combination, such as `--plain` together with `--json`, or an unusable flag value such as an unknown `--skills` id or a `--action` that names no continue action. `start` refuses an `@file` input, an empty feature description before `@file` inputs, or a feature description that starts with `@`.

### Files affected

- **Reads:** `.splitbrief/config.yaml`, `.splitbrief/sessions/<id>/state.json` (if resuming), repo files supplied to the planner.
- **Writes:** `.splitbrief/sessions/<id>/{readiness.json,plan.json,plan.md,tasks.md,state.json,session.jsonl}`, working-tree changes by the implementer.

### See also

- `splitbrief spec` — planning only, no implementation.
- `splitbrief resume` — continue an interrupted run.
- [WORKFLOW.md](./WORKFLOW.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [CONFIGURATION.md](./CONFIGURATION.md).

### Behavior notes

- `start` does not accept `--action`; use `continue --action` to answer recovery or settle a ready run.
- `--json` requires a feature where it starts a new workflow.
- `--plain` and `--json` are two renderings of one headless stream and cannot share stdout; passing both exits `2` with `--plain and --json cannot be combined; choose one output mode.`
- Before planner or implementer calls, `start` computes Run Readiness. Blockers stop the run. Each warning appears as a Warning row under your request when the run starts, with its details and fix as `splitbrief doctor` prints them, and `--json` also emits it in the readiness report. The compact session artifact is `.splitbrief/sessions/<id>/readiness.json`; it keeps each warning and blocker with its details and fix. Stable `stateId` values and copyable remediations for missing-binary, untrusted-path, version, authentication, endpoint, credential-family, protocol, quota/rate, and conflicting-argument conditions are documented under `splitbrief doctor --json`.
- Readiness inspects validation configuration and package-script posture only. It runs no validation command, model call or network probe.
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

Run only the planning session. It writes `plan.json`, `plan.md` and `tasks.md` to a fresh session folder, then exits without invoking the implementer. Useful for review-only flows or scripting.

Without a config, spec saves a detected ready crew to `.splitbrief/config.yaml`. If no crew is ready, it asks you to run `splitbrief init` and leaves the config absent.

The planning session is the same one `splitbrief start` runs ([WORKFLOW.md](./WORKFLOW.md#3-the-planning-session)): the planner answers with one typed plan, SPLITBRIEF checks it (`checkPlan` plus the context fit), and a plan that fails its checks goes back to the planner once.

### Usage

```
splitbrief spec <feature> [--project <dir>] [--allow-hooks] [--allow-repo-runners]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--allow-hooks` | boolean | `false` | Trust the hook config without prompting (CI). |
| `--allow-repo-runners` | boolean | `false` | Grant this run the planner runner command the project config declares. |

### Examples

```bash
# Plan a feature for review
splitbrief spec "add SSO via Okta"

# Run in another repo
splitbrief spec --project ../service-a "add health endpoint"

# CI-friendly invocation (no terminal: every question takes its default)
splitbrief spec --allow-hooks "tighten zod schemas"
```

### Exit codes

- `0` — the plan passed its checks and `plan.json`, `plan.md` and `tasks.md` were written.
- `1` — not a git repo, invalid or unwritable config, hooks distrusted, a removed flag (`--mode`, `--approve`), planner failure, a plan that failed its checks again after one repair, a third round of questions, init failure, or any other failure (the underlying error message is preserved through `Error.cause`).

### Files affected

- **Reads:** `.splitbrief/config.yaml`, repo files passed to the planner, `~/.splitbrief/trust/hooks.json`.
- **Writes:** `plan.json`, `plan.md` and `tasks.md` under `.splitbrief/sessions/<id>/`, and the `.splitbrief/active` pointer.
- **On a failed planner call:** the session directory it allocated is removed again via the preparation rollback (including the `.splitbrief/active` pointer); no directory is left behind.

### See also

- `splitbrief start` — full plan-and-implement.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md#the-plan-contract), [WORKFLOW.md](./WORKFLOW.md).

### Behavior notes

- The line printed before planning starts names the feature and the planner: `Planning feature: <feature> (planner: <name>)`.
- The planner's stream is not echoed: its answer is typed JSON.
- Questions: the planner may ask up to three questions per round, for at most two rounds, and every question carries a default. `spec` prints them under `The planner asks:`. In a terminal it reads one line (`Your answer (⏎ takes the defaults): `), and an empty line takes the defaults. Without a terminal every question takes its default.
- The planner is told the BUILD context a headless `start` measures: the profile's declared `contextLength`, else the model catalog. `spec` takes no `--skills`, so its prompt carries no skills block, as a `start` with no skills selected.
- `spec` shows no plan card. `--mode` and `--approve` were removed and fail the command with exit code 1.
- The stale-session sweep runs before the new session is prepared — a crashed prior run will not block this one.
- Session id is generated from the feature. The final summary prints `Planning complete.`, the session id and the path of `plan.json`, `plan.md` and `tasks.md`, with the task count as `(N tasks)`.

---

## splitbrief review

**Synopsis**

```
splitbrief review [options]
```

One reviewer call over the current diff. The command needs no session: it creates none, runs no planning phase and enters no state machine. It collects the diff, hands it to the review seat with the same review prompt a full run uses, and writes the review to `.splitbrief/reviews/<timestamp>/review.json` and `review.md`. Then it prints the rendered review, the verdict and the findings.

Without a config, review saves a detected ready crew to `.splitbrief/config.yaml`. If no crew is ready, it asks you to run `splitbrief init` and leaves the config absent.

Without `--base`, the diff is the staged changes, the unstaged changes and the untracked files. With `--base <ref>`, it is `git diff <ref>` plus the untracked files. Untracked files under `.splitbrief/` and `.trees/` are left out.

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
- **Writes:** `.splitbrief/reviews/<YYYY-MM-DD-HHMMSS>/review.json` (the verdict record) and `review.md` (the rendered review) next to it. Nothing under `.splitbrief/sessions/`, and the `.splitbrief/active` pointer is never touched.

### See also

- `splitbrief start` — the full loop, whose final review uses the same prompt with the run's spec and briefs.
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — the three seats and how the review seat resolves.

### Behavior notes

- The review seat resolves exactly once, through `resolveReviewerRunner`: a configured `reviewer:` block, or the planner holding the seat. `--reviewer` overrides that seat for this call only; nothing is written back to the config.
- The reviewer runs in its tool's read-only mode (for Claude Code, `--permission-mode plan`).
- A clean tree prints `nothing to review` and exits `0` before any runner is constructed — the command never spawns a tool with nothing to say.
- Before the call the command prints one line that names the subject and the seat: `Reviewing the working tree (reviewer: <seat>)`, or `Reviewing changes since <ref> (reviewer: <seat>)` with `--base`.
- The reviewer's live output is not printed. After the call, the rendered review prints with terminal control sequences stripped, then the verdict, each finding by severity (`critical`, `warning`, `note`) and the path of `review.md`.

---

## splitbrief doctor

**Synopsis**

```
splitbrief doctor [--project <dir>] [--json] [--probe-seat <plan|build|review>]
```

Check whether the current repository and SPLITBRIEF configuration are ready for a safe run. The readiness report is read-only. It makes no model call and writes nothing: no `.splitbrief/active`, session folders, worktrees, snapshots or config rewrites. With `--probe-seat`, `doctor` makes one paid call instead of the report; see [Seat probe](#seat-probe---probe-seat). The readiness report probes each configured CLI runner the way `start` does — installation, trust, version, authentication, and the arg vector SPLITBRIEF would emit compared against that binary's own `--help` — and runs no validation subprocess.

With plan approval enabled, the TUI waits for you to approve the plan. Headless runs approve it automatically. Context windows are sized automatically unless you set an override. Tool permission warnings explain what your coding tools can do; open Settings > Crew to change a seat.

An OpenCode or Kilo Code seat on a `provider/model` route gets a warning when the tool has no credential for that provider and its model listing serves no model of that provider. Doctor reads the model listing that SPLITBRIEF saved; when none is saved, it reads the listing from the tool, as `start` does. An OpenCode listing saved before OpenCode was on a seat holds none of the providers set up in the project's own `opencode.json`, so doctor and `start` read that listing from the tool again. A route on the tool's own gateway (`opencode/…`, `kilo/…`) gets the warning whenever the tool has no credential for it. When the model listing cannot be read, the seat gets no warning. A seat on `auto`, or with no model, is checked on the model that the tool's own config selects, as at `start`. A tool that holds no credential at all gets no route warning. It still calls a provider set up in its own config, so its sign-in blocker names only the seats whose route the model listing does not serve. When the listing serves the route of every seat, doctor shows no blocker for the tool: ``OpenCode CLI is installed, trusted, compatible, and stores no credential; it calls the providers set up in its config.`` The route warning names the seat and the tool's sign-in command:

```
  warning  BUILD: OpenCode CLI has no credential for ollama-cloud.
           Fix: Run `opencode auth login ollama-cloud`, or choose another model in Settings > Crew > BUILD.
```

`start` shows the same warning before the run spends a call. When OpenCode then refuses the route, the seat halts as **Seat down** with the same sentence; see [Approval and recovery](./APPROVAL-AND-RECOVERY.md).

### Usage

```
splitbrief doctor [--project <dir>] [--json] [--probe-seat <plan|build|review>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--json` | boolean | `false` | Emit one stable JSON readiness object to stdout for automation (`doctor --json`). |
| `--probe-seat <seat>` | string | — | Make one paid call through the `plan`, `build` or `review` seat's CLI adapter instead of the readiness report. See [Seat probe](#seat-probe---probe-seat). |

### Examples

```bash
splitbrief doctor
splitbrief doctor --project ../service-a

# Automation: stable stateId + remediation per check
splitbrief doctor --json

# One paid call through the build seat: is its sign-in and quota working?
splitbrief doctor --probe-seat build
```

### Exit codes

- `0` — ready or ready with warnings. With `--probe-seat`: the call ran, whatever its result, so a failed call also exits `0`.
- `1` — blocked by a hard local precondition such as no git repo, invalid config, missing config, or a live same-checkout session. With `--json`, the report is still written to stdout before exit. With `--probe-seat`: a seat value other than `plan`, `build` or `review`, a seat that is not a `cli` runner, or an error before the call starts, such as a missing config or executable.

### Files affected

- **Reads:** git status, `.splitbrief/config.yaml` when present, `.splitbrief/active` when present, `package.json` when present, and each configured CLI runner's own version, auth, and `--help` output (read-only probes of the trusted executable identity).
- **Writes:** none for the readiness report. `--probe-seat` appends one record to `.splitbrief/probes/<tool>-<date>.jsonl`.

### Seat probe (`--probe-seat`)

`splitbrief doctor --probe-seat <plan|build|review>` makes one paid call through that seat's CLI adapter. Use it to learn whether the seat's sign-in and quota work before a run spends a planning phase.

- **What it runs:** the prompt `Reply with the word ok.`, with the seat's own tool, model, effort, variant and args. The call runs in a temporary empty git repository, in the same sandbox environment a run uses, and the repository is deleted after the call.
- **Limits:** the call has a 60-second time limit and a 64 KiB output limit.
- **Only the probe runs:** the readiness report and the preparation preflights do not run, so a readiness blocker does not stop the probe. `--json` has no effect on it.
- **Output:** one line, `Seat probe <seat>: <class>`. The class is `passed` when the call completed with exit status `0`; otherwise it is the failure class, and a second line prints `First error: <line>`.
- **Record:** the probe appends one JSON line to `.splitbrief/probes/<tool>-<date>.jsonl` (file mode `0600`). It holds the time, seat, tool, class, exit status, the time-limit and output-limit flags, and the stdout and stderr with the seat's credential values removed.
- **Exit codes:** `0` whenever the call ran, also when it failed. `1` for a bad seat value, a seat that is not a `cli` runner (`api`, `shell` or `agent`), or an error before the call starts, such as a missing config or executable.

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
| `modelSelection` | On `runners.<role>.configured`, and on `runners.reviewer.inherited` for a REVIEW that follows PLAN: `auto` (automatic selection), `explicit` (a model ID), or `unset` (no `model` key). Absent on other checks. |
| `seats` | On a check for a CLI problem: every seat it stops (`PLAN`, `BUILD`, `BUILD (<profile>)`, `REVIEW`). One check covers every seat that shares the problem, so a seat `id` such as `runners.preparation.planner` names only the first of them. Absent on other checks. |

Human and JSON output share the same remediation strings. CLI executable identity paths and secrets are redacted from check text; `projectDir` is emitted verbatim as the absolute project directory.

`start --json` emits the same `readiness_report` shape as its first stdout line before workflow events. `resume` re-probes CLI readiness for start gates but emits no `readiness_report`. See [FEATURES.md](./FEATURES.md).

### Readiness diagnostic state IDs

CLI readiness, config validation, and provider posture checks map to stable `stateId` values. Prefer `stateId` and `remediation` in automation instead of parsing free-form text.

| `stateId` | Condition | Copyable remediation |
|---|---|---|
| `missing-binary` | Configured CLI is not installed or not on PATH. | Install the configured CLI, then run `splitbrief doctor` again. |
| `untrusted-path` | Executable identity does not match the trusted fingerprint (untrusted project-bin or stale fingerprint). | Install the configured CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again. |
| `incompatible-version` | Installed CLI version is outside the tested or qualified range. | Install the tested CLI version, then run `splitbrief doctor` again. |
| `unauthenticated` | Required credentials are missing or invalid. | Sign in to the configured CLI, then run `splitbrief doctor` again. |
| `auth-unknown` | Auth probe could not determine login state. | CLI authentication cannot be verified without spending a call: stored credentials prove presence, not a working session. The first real call settles it; if it fails to authenticate, sign in to the CLI again. |
| `auth-timeout` | The CLI sign-in check timed out. | Check the network connection, then run `splitbrief doctor` again. |
| `auth-offline` | The CLI sign-in check could not connect. | Check the network connection, then run `splitbrief doctor` again. |
| `auth-malformed` | SPLITBRIEF could not read the CLI sign-in check result. | Run `splitbrief doctor` again. If the result is still unreadable, update the CLI. |
| `auth-policy-denied` | An access policy denied the CLI sign-in check. | Check the account and access policy, then run `splitbrief doctor` again. |
| `endpoint-invalid` | Provider `apiBase` violates the declared endpoint policy (wrong scheme, origin, or redirect target). | Fix the provider endpoint to match its declared policy, then run `splitbrief doctor` again. |
| `credential-family-mismatch` | Environment credential prefix or family does not match the declared provider. | Use a credential that matches the declared provider family, then run `splitbrief doctor` again. |
| `protocol-failure` | CLI or API output protocol error, including a missing terminal result line. | Check the CLI or provider version and output protocol, then run `splitbrief doctor` again. |
| `quota-rate-limit` | Provider returned quota or rate-limit pressure (for example HTTP 429). | Wait for quota or rate limits to reset, reduce request volume, or switch providers, then run `splitbrief doctor` again. |
| `conflicting-args` | Runner configuration contains mutually exclusive CLI arguments. | Remove conflicting runner arguments from the config, then run `splitbrief doctor` again. |

On Linux, Antigravity session authentication reports `auth-policy-denied`. Choose another tool in Settings > Crew, or use macOS. Other policy refusals use the account and access policy remedy above.

CLI installation, trust, version, and auth mapping for admitted tools: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md). Endpoint and credential rules: [CONFIGURATION.md](./CONFIGURATION.md), [API-KEYS.md](./API-KEYS.md).

### Runner outcome states (workflow commands)

During `start`, `spec`, `resume`, and other commands that invoke planners or implementers, subprocess failures normalize to `RunnerOutcome` states in session events and `session.jsonl`. These differ from readiness `stateId` values but use the same copyable remediation pattern:

| `state` | Condition | Copyable remediation |
|---|---|---|
| `output-budget-breach` | CLI stdout, stderr, or protocol event stream exceeded the configured byte or line budget. | The tool wrote more than 64 MB of output and was stopped. Narrow what it was asked to print, then retry. |
| `no-staged-change` | Implementer completed without staging the expected working-tree change. | Make the requested change in the staged project, then retry. |

Other distinguishable runner outcomes (`spawn-not-found`, `protocol-failure`, `incompatible-version`, `unauthenticated`, and others) are documented in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [ENGINE.md](./ENGINE.md). Symptom-oriented guidance: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### See also

- [FEATURES.md](./FEATURES.md) — when to run doctor and how readiness gates `start`.
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — admitted CLI readiness states and runner contracts.
- [CONFIGURATION.md](./CONFIGURATION.md) — endpoint policy, runner args, and conflicting-flag validation.
- [API-KEYS.md](./API-KEYS.md) — credential resolution and provider families.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptom to state ID to remediation.

### Behavior notes

- A blocked readiness report exits `1`. It prints each blocker once in the report, with no repeated `Error:` message on stderr.
- Missing config reports `splitbrief init`; legacy config warnings report `splitbrief init --reconfigure`, but `doctor` does not run setup commands.
- Every load-time config notice is listed, one per retired key (`workflow.mode`, `workflow.approve: all|spec|default`, `workflow.task_review`, `workflow.brief_review`, `workflow.speckit`, `approval.tiers`, `validation.typecheck|lint|test|typecheck_command|lint_command`; see [CONFIGURATION.md §16](./CONFIGURATION.md#retired-keys-that-still-load)). The **Workflow** section explains whether you approve the plan in the TUI or approval is automatic. Context windows are sized automatically; an explicit limit below 32,000 tokens gets a warning.
- On Linux, when an implementer profile is `cli` `claude-code`, the check `runners.sandbox.claude-code` looks for `bwrap` and `socat` on `PATH` and names each missing program. It is a blocker when that profile is the default implementer, and a warning for any other profile. `splitbrief spec` and `splitbrief review` call no implementer, so they skip it. It does not start the sandbox. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#symptom-the-run-halted-with-tool-recipe-rejected-by-claude-code-cli-and-sandbox-required-but-unavailable).
- Validation readiness is posture only. It reports whether End-of-run checks are on (`validation.configured`; `validation.end-checks-off` is a warning when they are off), the command a planner `test` check resolves, and a missing npm script. It runs no command. The `--probe-validation` flag was removed: the reviewer chooses the end-of-run commands during the run, so no fixed command set exists to probe before it.
- Runner availability is probed for the `api` runners a run would call (`runners.availability.planner`, `runners.availability.implementer.<profile>`, and `runners.availability.reviewer` when a `reviewer` block is configured). Each probe is one model-list round trip against the endpoint the runner already targets, bounded by a 2s budget and run in parallel. An unreachable planner or default implementer is a blocker — the planning phase runs before the implementer is first used — while a non-default profile is a warning. A probe that could not run or overran its budget reports `not-probed` (info); it never reports available. When no probe runs at all, readiness says so and makes no claim (`runners.availability`).
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

Bootstrap a project. Opens the TUI setup screen with the detected planner / implementer providers and models. Until the first save, init writes nothing in your checkout. That save creates `.splitbrief/config.yaml` and adds `.splitbrief/` to `.gitignore` when git does not ignore it yet. Safe to re-run with `--reconfigure` to start over.

`--yes` skips the setup screen, detects ready tools and saves a crew. On a Codex-only machine, Codex fills every seat. If no crew is ready, init asks you to choose and sign in to your tools with `splitbrief init` and writes no config. This mode serves CI, container builds and piped shells: the setup screen needs a TTY, and without `--yes` a non-TTY invocation refuses and points at `--yes`.

### Usage

```
splitbrief init [--project <dir>] [--reconfigure] [--yes]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | string | cwd | Project directory. Canonicalized to the git toplevel, like every other command. |
| `--reconfigure` | boolean | `false` | Overwrite an existing `.splitbrief/config.yaml`. Without this flag, init refuses to overwrite. |
| `--yes` | boolean | `false` | Detect and save a ready crew without the interactive picker. Requires no TTY. |

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
- `1` — no ready crew, no TTY and no `--yes`, TUI render failure, or unexpected I/O error.

### Files affected

- **Reads:** existing `.splitbrief/config.yaml` (to detect collision), provider environment.
- **Writes:** on the first save, `.splitbrief/config.yaml` and the `.splitbrief/` rule in `.gitignore` when git does not ignore `.splitbrief/` yet. After that save, `.splitbrief/detection-cache.json`.

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

Print the current session's phase, task progress, one `PLAN`, `BUILD` and `REVIEW` line with the tool and model of each seat, and counts for completed / escalated / failed tasks. Task progress names the brief the run is on as `N/M`; once every brief has settled it reads `M/M`, never a brief past the last.

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
- The `(awaiting continue)` suffix on the phase line means the run parked at a call boundary and is waiting for user input — `/resume` in the TUI, `splitbrief resume` from the shell.
- Without a `reviewer:` block in the config, the planner holds the review seat, so the `REVIEW` line names the same tool and model as `PLAN`, also after the plan seat switches. A switch of the review seat gives `REVIEW` its own tool and model.
- `Done`, `Escalated`, `Failed` lines only appear when the corresponding count is non-zero.

---

## splitbrief resume

**Synopsis**

```
splitbrief resume [options]
```

Continue the most recent run. A run is a durable record: an open run stays continuable, so this refuses exactly six things — no active pointer, a run whose process is still running, a run whose process exists but is unresponsive, a saved state that is missing or unreadable, a **ready** run (`Run <id> is ready to apply.`, followed by the `continue <id> --action apply` and `--action discard` lines), and a **closed** run. Every other stop — parked, waiting at a gate, halted on a recovery, stopped by an error, killed outright — is picked up at the step it left off.

Closing a run clears `.splitbrief/active`, so after an `/end` there is nothing for `resume` to find. Use `splitbrief continue <session-id>` for an older open run. Accepts the same workflow flags as `start`.

Without `--json` or `--plain`, `resume` opens the run screen, which needs a terminal. In a shell with no TTY it exits `1` with `interactive mode needs a TTY — use --json or --plain`, as `start` does.

### Usage

```
splitbrief resume \
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
  [--planner-effort <level>] [--reviewer-effort <level>] \
  [--skills <ids>] [--project <dir>] \
  [--no-fullscreen] [--no-mouse] [--hover] \
  [--allow-hooks] [--allow-repo-runners] [--json] [--plain]
```

### Options

Resume accepts the same workflow override options as `start`. See [`splitbrief start`](#splitbrief-start) for the shared runner flags.

| Flag | Notes |
|---|---|
| `--json` | Resume the run in headless mode, streaming NDJSON to stdout. |
| `--plain` | Resume the run in headless mode, writing plain lines to stdout. Mutually exclusive with `--json`. |
| `--on-seat-down <halt\|switch>` | Headless seat-down policy, as on `start`: `halt` stops on a seat-down halt, `switch` applies the declared `fallback`. Unset applies a declared fallback too. |
| `--skills <ids>` | Comma-separated skill ids for every seat. The list applies to that continue only: it is not saved, so a later continue without it uses the selection the run saved when it started. Applies in headless and interactive mode alike. |
| Planner, implementer and reviewer flags | Override the persisted values for this run only. |

### Examples

```bash
# Pick up where the last session stopped
splitbrief resume

# Resume in headless mode for CI re-runs
splitbrief resume --json

# Force a different implementer for the rest of the run
splitbrief resume --implementer claude-code --implementer-model claude-sonnet-4-5
```

### Exit codes

- `0` — resumed successfully (TUI or headless).
- `1` — no active session, missing or unreadable `state.json`, a schema version `WORKFLOW_STATE_VERSION` cannot load, a closed run, or any downstream failure.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/state.json`, `.splitbrief/config.yaml`.
- **Writes:** updates to `state.json`, `session.jsonl`, working-tree edits as the run proceeds.

### See also

- `splitbrief start` — fresh run.
- `splitbrief continue` — continue a run by id or alias.
- `splitbrief status` — see the current phase before continuing.
- [WORKFLOW.md](./WORKFLOW.md), [CHANGELOG.md](../CHANGELOG.md) — schema migrations.

### Behavior notes

- The version guard rejects resume with: `saved state is from an older version and cannot be resumed. Please start a new workflow with 'splitbrief start'.`
- A session with a pending recovery is not refused headlessly. `resume --plain` and `resume --json` print the issue, the recommended action and the `splitbrief continue … --action …` line to stderr and exit `1`; pass that action to `continue` to carry on.
- Any open run resumes. `deriveRunStatus` (`src/core/sessions/run-status.ts`) decides; [WORKFLOW.md §Run status](./WORKFLOW.md#run-status) owns the rules. A ready run is refused with `Run <id> is ready to apply.` and the two lines that apply or discard it (`splitbrief continue <id> --action apply|discard`). A closed run is refused with `Run <id> is closed (<complete|ended|applied|undone|discarded>); nothing to resume.` A run killed during validation or escalation re-enters at the start of the brief it was on, with that brief's files restored from its task-start snapshot.
- A short `Resuming: <feature> (phase: <phase>, task N/M)` line prints before the TUI mounts. `N` never exceeds `M`: a run whose briefs have all settled reads `M/M`.
- The plan approval level comes from `workflow.approve`, else `plan`. Resume overwrites the level the run saved with that value. A run saved by an older release continues as one planning session if it stopped before its plan: its saved mode is ignored, and only the plan card (or nothing, under `approve: none`) opens before the build.

---

## splitbrief continue

**Synopsis**

```
splitbrief continue [session-id-or-number] [--action <skip|retry|restore|switch-seat:<tool>[:<model>][@<word>]|end-run|apply|discard>] [resume options]
```

Continue a run by name, active session, or numeric alias. The run continues from its saved state. `skip`, `retry`, `restore`, and `switch-seat` first answer a pending recovery. `end-run` closes an open run, with or without a pending recovery, as End run does on the run screen. If Apply did not finish, restore or retry Apply first. Use `--action apply` or `--action discard` to settle a run whose review passed in its workspace. Any open run can continue. The command refuses a closed run with exit `1`. With `--json`, the refusal writes an error record on stdout: `{"type":"error","message":"Run <id> is closed (<as>); nothing to resume."}`.

Without `--json` or `--plain`, a continue that carries the run on opens the run screen, which needs a terminal. In a shell with no TTY it exits `1` with `interactive mode needs a TTY — use --json or --plain`, as `start` does, before it answers a recovery: the run stays as it was. `end-run` and `discard` never open the run screen. `apply` opens it only when the merged result goes through its checks and review again; without a terminal that review then needs `splitbrief continue <id> --plain`.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id-or-number>` | string \| number (positional) | active | Session ID or numeric alias; omitted to use `.splitbrief/active`. |
| `--project <dir>` | path | cwd | Project directory. |
| `--allow-hooks` | boolean | `false` | Trust hook config without prompting. |
| `--allow-repo-runners` | boolean | `false` | Trust repo-local shell/agent runner commands from project config for resumed workflow execution. |
| `--action <skip\|retry\|restore\|switch-seat:<tool>[:<model>][@<word>]\|end-run\|apply\|discard>` | enum | — | `skip`, `retry`, `restore`, and `switch-seat` need a pending recovery and answer it. `switch-seat:<tool>[:<model>][@<word>]`: the `@<word>` is the variant on a variant-channel tool (opencode, kilo-code) and the effort on every other tool. `skip` means `skip-current-task`. `retry` means `retry-same-worker`. `restore` means `restore-backup`: after a partial Apply (`apply-partial`) it puts back the checkout files Apply replaced, from the Apply backup. No other halt offers it. `switch-seat:<tool>[:<model>]` moves the blocked seat. Without a model, the seat keeps no model and the tool runs its own default model. After a model refusal, `switch-seat:<tool>` on the seat's own tool drops the refused model, and `switch-seat:<tool>:<model>` names a listed model instead. These four actions continue the run. `end-run` closes an open run, with or without a pending recovery, as End run does on the run screen. If Apply did not finish, restore or retry Apply first. It prints `Run <id> closed.` on stdout and stops. For a checkout run or an older run without a workspace, it adds ` The files it wrote are still on disk.` after a brief of the run started. A run that ended before its first brief started wrote no files, so the line does not show. On a run ready to apply, it closes the run `discarded` and keeps `run.patch`. An already closed run exits `1` with `Run <id> is closed (<as>); nothing to end.`. `apply` runs Apply on a run that is ready to apply. Apply merges the run workspace into the checkout. It prints `Applied <n> files to your checkout.` on stderr and closes the run `applied`. If Apply changes the reviewed candidate, SPLITBRIEF runs its checks and whole-run review again. A run accepted as is needs confirmation on the run screen with `/run accept confirm`. An Apply conflict halts with `Needs you (apply-conflict)`. `discard` closes the run `discarded`. It keeps the run changes in `run.patch` in the session folder and prints `Run <id> discarded.` and the patch path on stderr. Discard does not apply the run result to the checkout. Apply and Discard keep stdout for the `--plain` and `--json` records. |
| `--skills <ids>` | string | — | Comma-separated skill ids for every seat, in headless and interactive mode alike. The list applies to that continue only: it is not saved, so a later continue without it uses the selection the run saved when it started. |
| `--json` | boolean | `false` | Continue the run in headless NDJSON mode. |
| `--plain` | boolean | `false` | Continue the run in headless plain-line mode. Mutually exclusive with `--json`. |
| `--on-seat-down <halt\|switch>` | enum | unset | Headless seat-down policy, as on `start`. See [Seat down](./APPROVAL-AND-RECOVERY.md#seat-down). |
| Other resume flags | — | — | Runner overrides, `--no-fullscreen`, `--no-mouse`, `--hover`. `--yolo` was removed. |

### Examples

```bash
# Continue the active session
splitbrief continue

# Continue by numeric alias
splitbrief continue 1

# Continue a specific session
splitbrief continue 2026-05-01-add-auth

# Apply a run that is ready to apply
splitbrief continue 2026-05-01-add-auth --action apply

# Answer a pending recovery without a TUI: skip the blocked brief and carry on
splitbrief continue 2026-05-01-add-auth --action skip --plain

# Move a quota-blocked seat to another tool and carry on
splitbrief continue --action switch-seat:claude-code:sonnet --json

# Give up on a halted run: close it, keep everything it wrote
splitbrief continue 2026-05-01-add-auth --action end-run
```

### Exit codes

- `0`: The run continued, `--action end-run` closed an open run, or `--action apply|discard` settled it. `end-run` needs no pending recovery. A ready run closes `discarded` and keeps `run.patch`.
- `1`: No run to continue, a running run, unusable saved state, a closed run, or an underlying failure. `end-run` on an already closed run reports `Run <id> is closed (<as>); nothing to end.`. End run during a partial or interrupted Apply reports `Apply did not finish. Restore or retry Apply first, then end the run.`. Both refusals use the same `{"type":"error","message":"..."}` record with `--json`. `skip`, `retry`, `restore`, and `switch-seat` need a pending recovery. This code also covers an action the pending recovery does not allow. The refusal names the available actions. It also covers `--action apply|discard` on a run that is not ready to apply.
- `2`: `--action` did not name a continue action. The message is `'<value>' is not a continue action. Use skip, retry, restore, switch-seat:<tool>[:<model>][@<effort>], end-run, apply, or discard.` The message says `@<effort>`, which fits every tool except opencode and kilo-code; their `@` word is the variant.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/lockfile.json`, `.splitbrief/sessions/<id>/state.json`.
- **Writes:** same as `resume`.

### See also

- `splitbrief resume` — continue the most recent run.

### Behavior notes

- `continue` uses the existing resume path when an action continues the run. This path supports `--json` and `--plain`.
- `--action end-run` records the close in `state.json`. It closes an open run, with or without a pending recovery, as End run does on the run screen. It refuses an unfinished Apply: restore or retry Apply first. The run lists as `ended`. A run ready to apply closes `discarded` and keeps `run.patch`. The command returns `0` without starting more work. An already closed run exits `1` with `Run <id> is closed (<as>); nothing to end.`. Apply and Discard also return `0` when they settle the run.
- Recovery actions use the same `applyRecoveryAction` transition as the recovery panel. The run continues from the resulting state. Without `--action`, headless mode prints the pending recovery, recommended action, and exact `continue --action` command to stderr. It exits `1`. `resume --plain` behaves the same way.
- Both commands compare the crew they are about to run against the crew the session last ran with (`.splitbrief/sessions/<id>/seats.json`). A seat that changed prints one stderr line per seat — `PLAN seat changed <old> → <new>; context will be rebuilt` for the plan seat, `…; the rest of the run uses the new seat` for the others. A moved plan seat also drops the saved planner session, because it cannot be replayed on a different tool, so the run rebuilds planner context from the transcript. The run itself re-records the crew once it starts, so a resume that never gets past preparation keeps the notice for the next attempt, and an in-app resume from the sessions overlay maintains the record the same way (it records the change as a seat row ending in `crew changed`). The record compares the configured ids (`Claude Code CLI · opus · max`), so a model the catalog renames never reads as a seat that moved; it also keeps each seat's tool and model ids and the runner kind the seat ran on, and the notice spells both sides the way the crew rows and the workflow header do (`Claude Code CLI · Opus 5.5 · max`) — a custom API provider that reuses a CLI tool's name is spelled as the provider, not as that CLI. A record written before the ids or the runner kind were kept gains them on the next run without a notice; should that run report a seat change, its notice keeps the recorded labels on both sides.

---

## Removed commands and flags

- `splitbrief approval list|clear` was removed with the sticky grants it managed. `splitbrief approval` now fails with exit code 1: `unknown command 'approval' — a protected write asks once per run; there are no grants to list or clear`.
- `--mode` and `--approve` were removed. Passing either to any command fails with exit code 1 before any work starts: `--mode was removed: every run plans in one session`, `--approve was removed: set workflow.approve (plan or none) in the config` (`RETIRED_FLAGS`, `src/cli/unknown-command.ts`). A flag value is skipped, so `--planner-args --mode` still reaches the planner tool's own `--mode`.

---

## Cross-cutting reference

### Diagnostic state IDs and support

Commands in this section share stable `stateId` / `state` identifiers and copyable `remediation` strings with `splitbrief doctor --json` (see [`splitbrief doctor`](#splitbrief-doctor)). Canonical references: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [CONFIGURATION.md](./CONFIGURATION.md), [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### Common flags across multiple commands

| Flag | Commands | Default | Notes |
|---|---|---|---|
| `--project <dir>` | most | cwd | Project directory. |
| `--allow-hooks` | `start`, `resume`, `continue`, `spec` | `false` | Skip the hook-trust prompt. CI flag. |
| `--allow-repo-runners` | `start`, `resume`, `continue`, `spec`, `review` | `false` | Trust repo-local shell/agent runner execution from project config. Separate from hook trust. |
| `--allow-unverified-auth` | `start`, `resume`, `continue`, `review` | `false` | Let a headless run proceed with unverified CLI authentication. No effect on interactive runs, which disclose and prompt. |
| `--plain` | `start`, `resume`, `continue` | `false` | Plain-line headless stream — `phase:`, `task:`, `reviewer checks:`, `reviewer check …:`, `review:` and `done:` lines. Refuses to run alongside `--json` (exit `2`). |
| `--json` | `start`, `resume`, `continue`, `doctor` | `false` | Public NDJSON record stream for workflow commands; a single JSON object for `doctor`. Workflow events are wrapped as `{ "type": "event", "data": ... }`. For `continue`, applies only when the target run is open; a closed run is refused before anything streams. |

### Where state lives

| Path | Owner | Purpose |
|---|---|---|
| `.splitbrief/config.yaml` | `init` | Provider, model, workflow, and hooks config. |
| `.splitbrief/active` | `start`, `spec` | Pointer to the current session while a workflow is active; cleared on final save unless preserved for recovery. |
| `.splitbrief/sessions/<id>/plan.json` | planning session | The checked plan: the one source the briefs compile from. |
| `.splitbrief/sessions/<id>/plan.md` | planning session | Rendering of `plan.json`; the body of the plan card. |
| `.splitbrief/sessions/<id>/tasks.md` | planning session | Rendering of the compiled Task Briefs. |
| `.splitbrief/sessions/<id>/state.json` | orchestrator | Persisted machine state for `resume` / `status`. |
| `.splitbrief/sessions/<id>/seats.json` | `start`, `resume`, `continue` | The crew the session last ran with, spelled as the crew rows spell it, so a resume can report a seat change. Rewritten by every run that starts, resumes included; a resume that never starts leaves it alone. |
| `.splitbrief/sessions/<id>/session.jsonl` | orchestrator | Append-only transcript and event log. |
| `.splitbrief/sessions/<id>/snapshots/<snap-id>/` | runtime `/run accept` | The run's snapshots: the run-start `baseline`, the `workspace-base` a workspace run starts from, the `pre-final-review` snapshot, the `post-task-<n>` snapshots of a checkout run and, for a run without a workspace, the accepted-run snapshot `/run accept` records, plus the run ledger. A workspace run restores from its Apply backup instead ([WORKFLOW.md §Apply](./WORKFLOW.md#apply)). |
| `~/.splitbrief/trust/hooks.json` | `start`/`resume`/`spec` trust prompt | Hook trust receipts, owner-only, keyed by checkout. Never inside the project. |
| `$XDG_STATE_HOME/splitbrief/trees/<hash>/<session-id>/` | run isolation | The implementer's per-run worktree, on branch `splitbrief/<session-id>`. Defaults to `~/.local/state/splitbrief/trees/...` when `XDG_STATE_HOME` is unset; `<hash>` is the first 12 hex chars of `sha256(realpath(git-common-dir))` so every linked checkout shares one trees root. Outside `.git/` (direct-writing CLIs refuse paths there) and outside the project root (so project-rooted test globs never walk the second copy). `git worktree list` is how you find one that outlived its run. |

### Headless event stream (`--json`)

When `start`, `resume`, or an interrupted resumable `continue` runs with `--json`, stdout emits one public JSON record per line (NDJSON). Live workflow events use `{ "type": "event", "data": <EngineEvent> }`. Other records use named top-level types such as `readiness_report`, `recovery_required`, `final_review_failed` (with the `blocking` finding count), `final_review_incomplete` (the review never finished), `warning`, and `error`. Public records are bounded and secret-redacted before writing. The TUI is not started, the alternate screen buffer is never entered, and `--no-fullscreen`/`--no-mouse`/`--hover` are no-ops in this mode. The plan card is approved unattended, which pre-confirms nothing (set `workflow.approve: none` to skip the card). A planner question writes an `input_required` record and exits non-zero with the `splitbrief continue <id>` line to answer it. A seat call has no default end: after 5 minutes of no output the stream emits `runner_call_stalled`, and `runner_call_stall_cleared` when output returns, while the call continues. A CI job has its own timeout; an unattended caller sets `idleKillMs` or `timeout` on the seat. SIGINT and SIGTERM stop the run resumably and exit 0. Continuation retry prompts never park, recovery pauses such as unknown paid pricing exit non-zero, failed sessions exit non-zero, and a write to a protected path fails closed with `APPROVAL_REQUIRED` instead of waiting for input.

The `recovery_required` record carries `reason`, `status` (`awaiting-user` | `applying`; a `paused` status that an older run saved reads as `awaiting-user`), message, task/files when known, `availableActions`, and `recommendedAction`; `status` was added after the initial release and older consumers must treat it as optional. The command fails with exit code 1 for **every** pending recovery status — `applying` exits non-zero exactly like `awaiting-user` — and the error message names the available resolution actions.

### Plain output stream (`--plain`)

`--plain` renders the same headless run as a small set of line shapes and nothing else, so a shell script can read a run without a JSON parser:

```
phase: planning
phase: reviewing-plan
phase: implementing
task T001: done (2 of 2 checks passed)
task T002: done (no checks)
task T003: done (1 of 1 checks passed)
phase: final-review
reviewer check declined: src/legacy/old.test.ts (the run did not touch the legacy module)
reviewer check V1: passed (npm test)
reviewer check V2: failed (npm run lint)
base re-run V2: pre-existing · all 2 failures also fail before this run's changes
base re-run V2 pre-existing: src/report.ts:4:3 Unexpected any · src/report.ts:9:1 Missing return type
phase: complete
review: passed
done: 3 tasks
```

- `phase: <name>` — written once each time the run enters a new phase.
- `task <id>: done|failed (<checks>)` — `<passed> of <total> checks passed` for the checks that task ran, `no checks` when it ran none, and `skipped` for a task a recovery skipped. A task that wrote outside its declared files reads `task <id>: failed (effect-invalid: <paths>)`.
- `reviewer checks: off` — End-of-run checks are off (`validation.end_checks: false`), so no reviewer check ran before the review. Plan and task checks still ran.
- `reviewer checks: none (<reason>)` — the reviewer chose no reviewer check, with the reason it gave.
- `reviewer checks: not run <ids> (<reason>)` — none of the chosen reviewer checks ran. A headless run with `validation.approve_checks: ask` has no card to ask on, so it writes `reviewer checks: not run V1, V2 (validation.approve_checks is ask and this run has no screen to ask on)`. The review is told that none of these commands is a pass.
- `reviewer check declined: <target> (<reason>)` — one line for each related test the reviewer chose not to run, with its reason.
- `reviewer check <id>: passed (<command>)` or `reviewer check <id>: failed (<command>)` — the result of one reviewer check (`V1`, `V2`, …) in the run workspace.
- `reviewer check <id>: refused (<detail>)` — the reviewer command policy refused the reviewer check, and `<detail>` names the rule, for example `runs a program by path` or `runs a setup command (pip install)`, or a package script, task file, build wrapper or interpreter script this run changed or the run base does not hold (`runs vendor/bin/phpunit, which the run base does not hold`).
- `reviewer check <id>: not run (<detail>)` — the reviewer check did not run. An earlier reviewer check with new failures stops the later ones: `not run (V1 failed)`.
- `base re-run <id>: passes` — the re-run of a red reviewer check at the run base, with the same command text, passed: every failure is new.
- `base re-run <id>: <m> new, <n> pre-existing` — the re-run is red too, and `<m>` failures do not occur at the run base. New failures stop the later reviewer checks.
- `base re-run <id>: <k> not verified at the run base · <reason>` — the re-run is red too, but `<k>` failures cannot be compared, and the line puts `<m> new, <n> pre-existing, ` before them when there are others: a timeout, or a red with no failing test name and no diagnostic line. Such a failure is never pre-existing. It stops the later reviewer checks, it reaches the reviewer as a pending input, and the reviewer decides.
- `base re-run <id>: pre-existing · all <n> failures also fail before this run's changes` — every failure also occurs at the run base, so the run goes on (`the failure also fails …` for one). A session from before these counts reads `fails`. A re-run that is refused or does not run reads `base re-run <id>: refused (<detail>)` or `base re-run <id>: not run (<detail>)`.
- `base re-run <id> new: <test> · <test> · +<n> more` and `base re-run <id> pre-existing: <test> · …` — under a `<m> new, <n> pre-existing`, `pre-existing` or `passes` line, one line for each side names its failing tests: the first three, then the rest as `+<n> more`. A failure that is not verified at the run base gets no names line.
- `fix check <id>: your 2 failures gone · 3 others left (<command>)` or `fix check <id>: 1 of your 2 failures remains (<command>)` reports the carried failures of a fix check. A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. Every unmatched re-run key counts as another failure. A red passes only when no carried failure remains and the re-run still shows a key the original red showed that is not the task's own. Otherwise, the command must pass. Keys come from the full process capture. An incomplete capture gives one placeholder key. The command must pass.

  A green re-run reads `your N failures gone`. A red without proof reads `your N failures not shown · not proven fixed`. The line also reports judged plan and task checks. Their fix check row has no running state or duration. The line uses singular forms for one failure. It omits other failures when a carried failure remains. Each fix check runs once, with no base re-run.

  A check without carried keys keeps `passed (<command>)` or `failed (<command>)`. A refusal reads `refused (<detail>)`; a check that did not run reads `not run (<detail>)`.
- `stalled: <role> (<tool>) · no output for 5:00` — one line when the watchdog warns that a seat call sent no output for 5 minutes (`idleWarnMs`). The call continues.
- `review: passed|failed [(<n> blocking)]` — the final review verdict. `failed` means the reviewer still reported blocking findings after its fix cycles and carries their count. Without an Accept as is override, the command exits `1` even though every task reached `done`. A checkout run accepted as is exits `0` and keeps the failed verdict.
- `done: <n> tasks` — the closing line, written on completion whatever the review said. `<n>` is the run's completed tasks, read from its state when it completes (`completedTasks` on `workflow_complete`): a task a review-fix cycle completes again counts once, a `continue` counts the tasks an earlier process completed, and a task that did not complete does not count, so `<n>` can be less than the length of the task list. The line carries no token count: token and money figures belong to the run's own record and `/usage`, not to the plain stream.

Everything else the run emits is dropped — including `recovery_required`, which is a `--json` record. A halt no one is there to answer ends the plain stream: the failing task's `failed` line is the last line written, there is no `review:` or `done:` line, and the command exits 1. The halt itself is not silent — stderr carries the block below in both headless renderings.

`--plain` cannot be combined with `--json`.

### Pending recovery in a headless run

Every headless run that stops on a recovery issue — `--json` and `--plain` alike — writes three lines to stderr and exits `1`:

```
Error: Seat down (runner-usage-limit): OpenAI Codex CLI hit its usage limit. Wait for the limit to reset or change the BUILD tool, then continue. (resets 17:00)
Recommended: switch-seat
Continue with: splitbrief continue 2026-09-13-add-auth --action switch-seat:claude-code [--plain|--json]
```

A quota halt ends the first line with the clock its limit resets on, spelled when the line is printed; with `--json`, the halt's `error` event record carries it as `resetAt`. The last line is the command to paste. When the recommended action is one `continue` cannot take on its own, the line opens the recovery panel and names the row to choose there, in the panel's own words: `Continue with: splitbrief continue 2026-09-13-add-auth, then choose Continue in the recovery panel`. That line carries no `[--plain|--json]`: the panel needs the TUI. With `--json` the same facts also arrive on stdout as a `recovery_required` record carrying `reason`, `status`, `message`, `taskId`, `files`, `availableActions`, `recommendedAction` and `resumeCommand`.

### Planning session

There are no workflow modes. Every run plans in one session: one typed planner call, plus one per question round (at most two rounds of at most three questions), plus at most one repair when the plan fails its checks. The plan card then waits for approval unless `workflow.approve: none`. `--mode` was removed; see [Removed commands and flags](#removed-commands-and-flags). Detailed semantics in [WORKFLOW.md](./WORKFLOW.md#3-the-planning-session).

### Runner kinds (`--planner` / `--implementer`)

| `kind` | What it is | Examples |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity` (binary `agy`) |
| `api` | OpenAI-compatible HTTP endpoint | `ollama`, `lm-studio`, `llama-cpp` |
| `shell` | Arbitrary command (stdin → stdout), no shell/network sandbox | Custom scripts via `--planner-command` / `--implementer-command` |
| `agent` | Subprocess that writes files directly, no stdout extraction or shell/network sandbox | Custom file-writing tools |

Schemas and YAML shape live in [ARCHITECTURE.md](./ARCHITECTURE.md) and [CONFIGURATION.md](./CONFIGURATION.md). Built-in CLI tools may run their own auto/permission modes according to their upstream behavior; SPLITBRIEF surfaces warnings but does not sandbox shell or network access.

### Getting help

```bash
splitbrief --help                     # top-level help
splitbrief <command> --help           # command help (Commander-generated)
splitbrief help <command>             # the same command help
splitbrief --version                  # the installed version
```

The [Global options](#global-options) table lists `-V, --version`, `-h, --help` and `help [command]`.

Commander emits a usage banner, the description string, and the option table verbatim — this reference document expands the same surface with examples, exit codes, files, and behavior notes.
