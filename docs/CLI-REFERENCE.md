# CLI Reference

Complete reference for every `diptych` command. Maintained against `src/cli.ts` and `src/cli/commands/*.ts`.

```
diptych — Cost-optimized AI coding orchestrator (v0.1.0)
```

## Global behavior

- **Binary name:** `diptych`. The `npm run dev -- <cmd>` form is equivalent during local development.
- **Working directory:** Most commands accept `--project <dir>`. When omitted, the project resolves to the current working directory.
- **Exit codes:**
  - `0` — success.
  - `1` — generic CLI failure. Almost every command throws via `cliError(message)` which defaults to `exitCode: 1`. The top-level handler in `src/cli.ts` prints `Error: <message>` to stderr and exits with the carried code.
  - `2` — reserved for guardrail hooks (e.g. `.claude/hooks/block-git-commits.sh`). The CLI itself does not raise `2`; observe it in subprocess output only.
- **Error format:** Failures print `Error: <message>` in red on stderr. Programmatic callers should grep stderr, not stdout.
- **OpenTelemetry:** `src/cli.ts` calls `bootstrapOtel()` before parsing. When `otel.enabled: true` in config and `--otel-exporter console` is passed (where supported), spans flow to stdout. See [OTEL.md](./OTEL.md).
- **Platform notes:** `attach`, `detach`, `ps`, and `start --detach` (server lifecycle) call `assertNotWindows()` and exit with `1` and the message `diptych attach/detach/ps are not supported on Windows.` on `win32`.

## Command index

| # | Command | Purpose |
|---|---|---|
| 1 | `diptych start` | Launch a workflow (TUI, headless, or detached). Also the default command: `diptych "feature"` works without `start`. |
| 2 | `diptych spec` | Run the planner only — produce spec/plan/tasks, no implementation. |
| 3 | `diptych init` | Create `.diptych/config.yaml` with detected models. |
| 4 | `diptych status` | Show the active session and optional cost history. |
| 5 | `diptych explain` | Explain routing, cost, review, and warnings from session artifacts. |
| 6 | `diptych resume` | Resume the active interrupted workflow. |
| 7 | `diptych continue` | Smart session continuity: attach if running, resume if interrupted. |
| 8 | `diptych last` | Attach or resume the most recent session. |
| 9 | `diptych stats` | Show cumulative cost savings across all sessions. |
| 10 | `diptych export` | Export a session as an HTML report. |
| 11 | `diptych migrate` | Migrate pre-v3 `.diptych/current/` state to per-session folders. |
| 12 | `diptych handoff` | Export a Handoff Pack for an external coding agent. |
| 13 | `diptych snapshot` | Create / list / restore / diff working-tree snapshots. |
| 14 | `diptych approval` | List or clear sticky approval grants. |
| 15 | `diptych mcp` | Run the MCP resource and evidence-tool server. |
| 16 | `diptych worktree` | List / switch / remove `.trees/<slug>` git worktrees. |
| 17 | `diptych attach` | Attach a TUI client to a detached background session. |
| 18 | `diptych detach` | Detach a TUI client without stopping the background server. |
| 19 | `diptych ps` | List sessions in the current project with status. |
| 20 | `diptych doctor` | Check run readiness without creating a workflow session. |

---

## diptych start

**Synopsis**

```
diptych start [feature] [options]
```

Launch a complete plan-and-implement workflow. Without a feature argument the TUI opens to the home screen so you can pick one interactively. With a feature, diptych runs the planner, gathers approvals (per `--mode`), then dispatches the implementer loop. This is the canonical entry point for ordinary work.

**Shorthand.** `diptych "feature"` is equivalent to `diptych start "feature"` — `start` is the default command (`isDefault`). No subcommand required for the happy path.

**`@file` syntax.** Positional arguments prefixed with `@` are resolved as file paths. Text files are injected into planner context; image files are queued as planner attachments. Example: `diptych "refactor auth" @context.md @screenshot.png`.

### Usage

```
diptych start [feature] [--mode <mode>] [--auto] [--approve <level>] \
  [--planner <tool>] [--planner-model <model>] [--planner-command <cmd>] \
  [--planner-api-base <url>] [--planner-api-key-env <var>] [--planner-args <arg>] \
  [--planner-output-format <format>] [--planner-context-length <tokens>] \
  [--implementer <provider>] [--implementer-model <model>] [--implementer-command <cmd>] \
  [--implementer-api-base <url>] [--implementer-api-key-env <var>] [--implementer-args <arg>] \
  [--implementer-output-format <format>] [--implementer-context-length <tokens>] \
  [--model <model>] [--provider <provider>] \
  [--budget <amount>] [--planner-effort <level>] [--yolo] \
  [--project <dir>] [--worktree [name]] [--detach] \
  [--no-fullscreen] [--no-mouse] \
  [--allow-hooks] [--json] [--rpc] [--otel-exporter <name>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--mode <mode>` | enum | `standard` (or `workflow.mode` from config) | One of `instant`, `quick`, `standard`, `speckit`. `full` is a legacy alias for `speckit`. See [WORKFLOW.md](./WORKFLOW.md). |
| `--auto` | boolean | `false` | Auto-approve spec and plan. Equivalent to `--approve none`. |
| `--approve <level>` | enum | `default` | Approval gates: `none`, `spec`, `plan`, `all`, `default`. `default` follows the mode's built-in policy. |
| `--planner <tool>` | string | from config | Planner tool: `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code`, `anthropic`, `openai`, `groq`, `together`, `deepseek`, `openrouter`, `shell`, `agent`, `agent-sdk`. |
| `--planner-model <model>` | string | from config | Planner model identifier (for API planners). |
| `--planner-command <cmd>` | string | from config | Custom planner command (when `--planner=shell`). |
| `--planner-api-base <url>` | string | from config | Planner API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--planner-api-key-env <var>` | string | from config | Environment variable holding the planner API key; stored as an `env:<var>` reference. A bare name is normalized to `env:<var>`. Applies only to `api` and `agent-sdk` runners; ignored (with a stderr warning) otherwise. |
| `--planner-args <arg>` | string | from config | Append one planner CLI/shell argument. Repeatable; each use adds another argument. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-output-format <format>` | enum | from config | Planner output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-context-length <tokens>` | number | from config | Planner context length in tokens. Consumed only by the `api` planner kind, where it sizes the request's `max_tokens` output budget; other kinds delegate the budget to their backend and ignore it. |
| `--planner-effort <level>` | enum | — | Effort hint: `low`, `medium`, `high`, `xhigh`. Silently dropped on backends that don't support it. |
| `--implementer <provider>` | string | from config | Implementer provider: `ollama`, `lm-studio`, `anthropic`, `openai`, `groq`, `together`, `deepseek`, `openrouter`, `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code`, `shell`, `agent`, `agent-sdk`. |
| `--implementer-model <model>` | string | from config | Implementer model identifier. |
| `--implementer-command <cmd>` | string | from config | Custom implementer command (when `--implementer=shell`). |
| `--implementer-api-base <url>` | string | from config | Implementer API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--implementer-api-key-env <var>` | string | from config | Environment variable holding the implementer API key; stored as an `env:<var>` reference. A bare name is normalized to `env:<var>`. Applies only to `api` and `agent-sdk` runners; ignored (with a stderr warning) otherwise. |
| `--implementer-args <arg>` | string | from config | Append one implementer CLI/shell argument. Repeatable; each use adds another argument. Applies to `cli`, `shell`, and `agent` runners. |
| `--implementer-output-format <format>` | enum | from config | Implementer output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--implementer-context-length <tokens>` | number | from config | Implementer context length in tokens. |
| `--model <model>` | string | — | Alias for `--implementer-model`. |
| `--provider <provider>` | string | — | Alias for `--implementer`. |
| `--budget <amount>` | float | — | Maximum budget in USD (e.g. `2.00`). Workflow warns/pauses before the cap, stops when exceeded, and pauses when paid usage has unknown pricing. |
| `--yolo` | boolean | `false` | Disable action-level tiered approval prompts for the session. Workflow review gates still follow `--approve` / mode policy. |
| `--project <dir>` | path | cwd | Project directory. |
| `--worktree [name]` | string \| boolean | — | Run inside a new linked git worktree at `.trees/<name>` on branch `diptych/<name>`. If `name` is omitted, the feature slug is used. |
| `--detach` | boolean | `false` | Spawn the workflow as a background server and exit. Requires a `feature` argument and is mutually exclusive with `--json` and `--rpc`. |
| `--no-fullscreen` | boolean | fullscreen on | Disable the alternate screen buffer. Useful when piping or debugging. |
| `--no-mouse` | boolean | mouse on | Disable Ink mouse tracking. |
| `--allow-hooks` | boolean | `false` | Trust the hook config without prompting (CI). |
| `--json` | boolean | `false` | Headless: emit public NDJSON records to stdout, skip TUI. Workflow events are wrapped as `{ "type": "event", "data": <EngineEvent> }`. Requires a `feature`. |
| `--rpc` | boolean | `false` | RPC: bidirectional NDJSON. Reads commands from stdin and writes `ack` / `error` / `status` / wrapped `event` responses to stdout. Requires a `feature`; mutually exclusive with `--json`. |
| `--otel-exporter <name>` | string | — | Bootstrap an OTel exporter (currently only `console`). Requires `otel.enabled: true` in config. |

### Examples

```bash
# Shorthand — no subcommand needed (start is default)
diptych "fix the typo in README"

# With @file context injection
diptych "refactor auth" @design-notes.md @screenshot.png

# Interactive TUI (no feature → home screen)
diptych start

# Standard workflow on a feature description
diptych start "extract auth into module"

# Speckit mode with budget cap
diptych start --mode speckit --budget 2.00 "rewrite billing"

# Headless / CI: stream NDJSON events
diptych start --json --auto "fix flaky test in user.test.ts"

# RPC: external tool drives approvals and messages
diptych start --rpc "add audit logging"

# Detached background session, attach later
diptych start --detach "long migration"
diptych ps
diptych attach <session-id>

# Isolated worktree
diptych start --worktree migration "Postgres 17 upgrade"
```

### Exit codes

- `0` — workflow completed (or TUI exited cleanly).
- `1` — invalid flag combination, invalid or unwritable config, planner/implementer failure, budget exceeded, or any uncaught error.

### Files affected

- **Reads:** `.diptych/config.yaml`, `.diptych/sessions/<id>/state.json` (if resuming), repo files supplied to the planner.
- **Writes:** `.diptych/sessions/<id>/{readiness.json,spec.md,plan.md,tasks.md,state.json,session.jsonl}`, working-tree changes by the implementer, `.diptych/sessions/<id>/lockfile.json` and `ipc.sock` when detached, `.trees/<slug>/` when `--worktree` is used.

### See also

- `diptych spec` — planning only, no implementation.
- `diptych resume` — continue an interrupted run.
- `diptych ps` / `diptych attach` / `diptych detach` — manage detached sessions.
- [WORKFLOW.md](./WORKFLOW.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [CONFIGURATION.md](./CONFIGURATION.md).

### Behavior notes

- `--detach` cannot be combined with `--json` or `--rpc`; `--json` and `--rpc` cannot be combined. `--detach`, `--json`, and `--rpc` each require a feature where they start a new workflow.
- The startup pipeline calls `maybeMigrate(projectDir)` first, so a stale pre-v3 state is migrated on the fly.
- Before planner or implementer calls, `start` computes Run Readiness. Blockers stop the run; warnings are shown in the TUI or emitted as JSON. The compact session artifact is `.diptych/sessions/<id>/readiness.json`.
- Readiness inspects validation configuration and package-script posture only. It does not run `typecheck`, lint, tests, model calls, or network probes.
- With `--json`, the first readiness line is `{ "type": "readiness_report", "report": ... }` before model-backed workflow events. With `--rpc`, readiness is wrapped as `{ "type": "status", "data": { "type": "readiness_report", "report": ... } }`.
- `clearStaleSession()` runs before a new session begins. It blocks only a genuinely live active session; if the active session's lockfile has exited or the PID is gone, the stale `.diptych/active` pointer is cleared and start continues.
- When `--worktree` is passed, the source working tree must be clean. The project directory is reassigned to the newly created worktree path before any state is written. With `--detach --worktree`, worktree selection happens before the detached server is spawned. If worktree creation fails, the command exits `1` with the underlying message.
- The `setupWorkflow()` step may show an interactive setup screen if config is incomplete; pass `--allow-hooks` in CI to skip the hook-trust prompt.
- Runner override flags are validated against the resolved runner kind. `--planner-api-base` / `--implementer-api-base` apply only to `api` runners, and `--planner-api-key-env` / `--implementer-api-key-env` apply only to `api` and `agent-sdk` runners. Passing one for an incompatible kind prints a warning to stderr (e.g. `--planner-api-base is ignored: the planner 'cli' runner does not use it.`) and the value is dropped rather than erroring.

---

## diptych spec

**Synopsis**

```
diptych spec <feature> [options]
```

Run only the planner. Produces `spec.md`, `plan.md`, and `tasks.md` for the feature in a fresh session folder, then exits without invoking the implementer. Useful for review-only flows, scripting, or bootstrapping a Handoff Pack.

Planner stream output is stripped of terminal control sequences before writing to stdout.

### Usage

```
diptych spec <feature> [--project <dir>] [--allow-hooks]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--allow-hooks` | boolean | `false` | Trust the hook config without prompting (CI). |

### Examples

```bash
# Generate a spec for review
diptych spec "add SSO via Okta"

# Run in another repo
diptych spec --project ../service-a "add health endpoint"

# CI-friendly invocation
diptych spec --allow-hooks "tighten zod schemas"
```

### Exit codes

- `0` — all three artifacts written.
- `1` — not a git repo, invalid or unwritable config, hooks distrusted, planner failure, init failure, or any other failure (the underlying error message is preserved through `Error.cause`).

### Files affected

- **Reads:** `.diptych/config.yaml`, repo files passed to the planner, `.diptych/hook-trust.json`.
- **Writes:** `.diptych/sessions/<id>/spec.md`, `.diptych/sessions/<id>/plan.md`, `.diptych/sessions/<id>/tasks.md`, the `.diptych/active` pointer.

### See also

- `diptych start` — full plan-and-implement.
- `diptych handoff` — export the produced artifacts to another tool.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md), [WORKFLOW.md](./WORKFLOW.md).

### Behavior notes

- Planner output streams to stdout in real time via the `onOutput` callback. Phase headings appear as bold `--- <phase> ---` separators.
- `clearStaleSession()` runs before `beginSession()` — a crashed prior run will not block this one.
- Session id is generated from the feature; the final summary prints the absolute paths to the three artifacts.
- The number of generated tasks is reported as `... (N tasks)` after the run.

---

## diptych doctor

**Synopsis**

```
diptych doctor [--project <dir>] [--json]
```

Check whether the current repository and diptych configuration are ready for a safe run. `doctor` is read-only: it does not create `.diptych/active`, session folders, worktrees, snapshots, migrations, config rewrites, validation subprocesses, planner calls, or implementer calls.

### Usage

```
diptych doctor [--project <dir>] [--json]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--json` | boolean | `false` | Emit a stable JSON readiness report for automation. |

### Examples

```bash
diptych doctor
diptych doctor --project ../service-a
diptych doctor --json
```

### Exit codes

- `0` — ready or ready with warnings.
- `1` — blocked by a hard local precondition such as no git repo, invalid config, missing config, or a live same-checkout session.

### Files affected

- **Reads:** git status, `.diptych/config.yaml` when present, `.diptych/active` when present, `package.json` when present.
- **Writes:** none.

### Behavior notes

- Missing config reports `diptych init`; legacy config warnings report `diptych init --reconfigure`, but `doctor` does not run setup commands.
- Validation readiness is posture only. It reports disabled checks or missing npm scripts without running validation commands.
- Runner availability is conservative. Network/API and CLI auth probes are not required for a ready result.

---

## diptych init

**Synopsis**

```
diptych init [--reconfigure]
```

Bootstrap a project. Creates `.diptych/config.yaml` populated with detected planner / implementer providers and models, then opens the TUI setup screen for review. Safe to re-run with `--reconfigure` to start over.

### Usage

```
diptych init [--reconfigure]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--reconfigure` | boolean | `false` | Overwrite an existing `.diptych/config.yaml`. Without this flag, init refuses to overwrite. |

### Examples

```bash
# First-time setup in a repo
diptych init

# Throw away current config and start over
diptych init --reconfigure
```

### Exit codes

- `0` — config exists / was created and the TUI exited cleanly.
- `1` — TUI render failure or unexpected I/O error.

### Files affected

- **Reads:** existing `.diptych/config.yaml` (to detect collision), provider environment.
- **Writes:** `.diptych/config.yaml`, store directories under `.diptych/`.

### See also

- [CONFIGURATION.md](./CONFIGURATION.md) — every config field.
- [API-KEYS.md](./API-KEYS.md) — credential resolution.
- [BOOTSTRAP.md](./BOOTSTRAP.md) — startup sequence.

### Behavior notes

- If `.diptych/config.yaml` already exists and `--reconfigure` is not passed, init prints "Config already exists at .diptych/config.yaml" plus a hint and exits `0`.
- The TUI launches in fullscreen mode. The `setup` screen handoffs to the home screen when the user finishes.
- `init` always uses cwd; it does not honor `--project`.

---

## diptych status

**Synopsis**

```
diptych status [--project <dir>] [--history]
```

Print the current session's phase, task progress, planner / implementer identity, and counts for completed / escalated / failed tasks. With `--history`, also aggregate cost across all completed sessions in the project.

### Usage

```
diptych status [--project <dir>] [--history]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--history` | boolean | `false` | Append a cost history block aggregated across all completed sessions. |

### Examples

```bash
# What is the current run doing?
diptych status

# Same plus past spend
diptych status --history

# Inspect a different repo
diptych status --project ../other-repo --history
```

### Exit codes

- `0` — always (status is read-only).
- `1` — only on unexpected I/O failure when reading session files.

### Files affected

- **Reads:** `.diptych/active`, `.diptych/sessions/<id>/state.json`, and completed session `summary.json` files when `--history` is set.
- **Writes:** none.

### See also

- `diptych ps` — broader session listing including detached / crashed runs.
- `diptych resume` — pick up where the active session left off.

### Behavior notes

- If there is no active session, prints `No active workflow.` and (when `--history` is absent) a hint about `--history`.
- The `(awaiting continue)` suffix on the phase line means the run is in the Ctrl-C abort/continue state and is waiting for user input.
- Cost history loads via `aggregateSessionCosts(listAllSessions(...))` over completed `summary.json` files. Invalid summaries are skipped with a warning; unexpected history errors print `Cannot load session history`.
- `Done`, `Escalated`, `Failed` lines only appear when the corresponding count is non-zero.

---

## diptych explain

**Synopsis**

```
diptych explain [--session <id>] [--project <dir>] [--json]
```

Read existing session artifacts and print a compact explanation of why routing, cost, review, and warning decisions happened. It never calls the planner, implementer, or provider APIs, and it does not rewrite session artifacts.

### Usage

```
diptych explain [--session <id>] [--project <dir>] [--json]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--session <id>` | string | active session | Session to explain. Required when `.diptych/active` is absent, which is typical after completed runs. |
| `--project <dir>` | path | cwd | Project directory. |
| `--json` | boolean | `false` | Emit one JSON object: `{ "type": "run_explain", "explain": ... }`. |

### Examples

```bash
# Explain the active in-progress run
diptych explain

# Explain a completed session
diptych explain --session 2026-04-29-add-auth

# Machine-readable output
diptych explain --session 2026-04-29-add-auth --json
```

### Exit codes

- `0` — explanation was printed.
- `1` — no active session and no `--session`, invalid session id, missing session directory, or unreadable required filesystem state.

### Files affected

- **Reads:** `.diptych/active`, `.diptych/sessions/<id>/{summary.json,state.json,session.jsonl,readiness.json,review.md,review-packet.json,review-packet.md,evidence.json,drift-report.json}` when present.
- **Writes:** none.

### See also

- `diptych status` — live phase/task posture.
- `diptych doctor` — pre-run readiness diagnostics.
- `diptych mcp serve` — artifact access and evidence reporting for MCP clients.

### Behavior notes

- Output is intentionally compact: task routes are summarized and artifact paths are referenced instead of embedding full plans, Task Briefs, logs, diffs, or source code.
- Cost confidence is marked `partial` when pricing is unknown, a profile is unavailable, usage is unpriced, or the all-planner baseline cannot be fully priced.
- Cost prediction data is prompt-input scoped; runtime output, retries, validation reruns, and escalation are explained from recorded usage and warnings.
- Context fallback is shown from deterministic estimate metadata when available, and from routing reasons on completed task artifacts. Task-start rows show concise routing reasons during the run; explain/drilldown surfaces richer context and per-task routing metadata.
- Task review gates are inferred from `task_review_needed` events in `session.jsonl`; final review status comes from `review-packet.json` or `review.md`.
- Missing optional artifacts are reported as missing instead of causing a model call or artifact regeneration.

---

## diptych resume

**Synopsis**

```
diptych resume [options]
```

Resume the current active interrupted session. Validates the saved state version and current phase; refuses to resume from a non-resumable phase or stale schema. If the active pointer was cleared after a clean cancel or stale lockfile cleanup, use `diptych continue <session-id>` instead. Accepts the same workflow flags as `start`.

### Usage

```
diptych resume [--mode <mode>] [--auto] [--approve <level>] \
  [--planner <tool>] [--planner-model <model>] [--planner-command <cmd>] \
  [--planner-api-base <url>] [--planner-api-key-env <var>] [--planner-args <arg>] \
  [--planner-output-format <format>] [--planner-context-length <tokens>] \
  [--implementer <provider>] [--implementer-model <model>] [--implementer-command <cmd>] \
  [--implementer-api-base <url>] [--implementer-api-key-env <var>] [--implementer-args <arg>] \
  [--implementer-output-format <format>] [--implementer-context-length <tokens>] \
  [--model <model>] [--provider <provider>] \
  [--budget <amount>] [--planner-effort <level>] [--yolo] \
  [--project <dir>] \
  [--no-fullscreen] [--no-mouse] \
  [--allow-hooks] [--json] [--rpc] [--otel-exporter <name>]
```

### Options

Resume accepts the same workflow override options as `start` except `--detach` and `--worktree` (both start-only; `--worktree` is rejected because a resumed session already lives in its original worktree). See [`diptych start`](#diptych-start) for the shared runner, mode, budget, OTel, and approval flags.

| Flag | Notes |
|---|---|
| `--json` | Resume the run in headless mode, streaming NDJSON to stdout. |
| `--rpc` | Resume the run in RPC mode, reading commands from stdin and writing NDJSON responses to stdout. Mutually exclusive with `--json`. |
| `--mode` / `--approve` / planner+implementer flags | Override the persisted values for this run only. The workflow mode resolved on the original run is saved in `state.json`; resume reuses it unless `--mode` is passed, which overrides it and prints a warning. |

### Examples

```bash
# Pick up where the last session stopped
diptych resume

# Resume in headless mode for CI re-runs
diptych resume --json --auto

# Resume and drive gates programmatically
diptych resume --rpc

# Force a different implementer for the rest of the run
diptych resume --implementer claude-code --implementer-model claude-sonnet-4-5
```

### Exit codes

- `0` — resumed successfully (TUI or headless).
- `1` — no active session, missing `state.json`, schema older than `CURRENT_STATE_VERSION`, non-resumable phase, or any downstream failure.

### Files affected

- **Reads:** `.diptych/active`, `.diptych/sessions/<id>/state.json`, `.diptych/config.yaml`.
- **Writes:** updates to `state.json`, `session.jsonl`, working-tree edits as the run proceeds.

### See also

- `diptych start` — fresh run.
- `diptych status` — see the current phase before resuming.
- [WORKFLOW.md](./WORKFLOW.md), [docs/CHANGELOG.md](./CHANGELOG.md) — schema migrations.

### Behavior notes

- `maybeMigrate(projectDir)` runs before state load, so legacy layouts are upgraded transparently.
- The version guard rejects resume with: `saved state is from an older version and cannot be resumed. Please start a new workflow with 'diptych start'.`
- `isResumable(state)` rejects any non-resumable phase (anything outside `RESUMABLE_PHASES` — `planning`, `implementing`, `final-review` — without `awaitingContinue`) with: `session '<id>' is in phase "<phase>" which cannot be resumed.`
- A short `Resuming: <feature> (phase: <phase>, task N/M)` line prints before the TUI mounts.
- The workflow mode is pinned in `state.json` alongside `plannerModel`; resume reuses the saved mode and approval level unless `--mode` is passed explicitly, in which case the override applies and a warning is printed.

---

## diptych continue

**Synopsis**

```
diptych continue [session-id-or-number] [resume options]
```

Smart session continuity command. Figures out the right thing: attaches if the session is still running, resumes if it was interrupted. Replaces the mental model of choosing between `ps`, `attach`, `detach`, and `resume`.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id-or-number>` | string \| number (positional) | active/single running | Session ID, numeric alias from `ps`, or omitted to use `.diptych/active` or the only running session. |
| `--project <dir>` | path | cwd | Project directory. |
| `--auto` / `--approve <level>` | approval | mode default | Workflow review approval mode. |
| `--allow-hooks` | boolean | `false` | Trust hook config without prompting. |
| `--json` | boolean | `false` | Resume an interrupted session in headless NDJSON mode. Live detached sessions still attach through the TUI. |
| `--rpc` | boolean | `false` | Resume an interrupted session in bidirectional RPC mode. Mutually exclusive with `--json`; rejected for live detached sessions. |
| Other resume flags | — | — | Runner overrides, mode, budget, OTel, fullscreen/mouse, and approval controls. `--worktree` is rejected — it is a `start`-only flag, since a resumed session already lives in its original worktree. |

### Examples

```bash
# Continue the active session, or the only running session
diptych continue

# Continue by numeric alias from ps output
diptych continue 1

# Continue a specific session
diptych continue 2026-05-01-add-auth

# Continue an interrupted session via RPC
diptych continue --rpc 2026-05-01-add-auth
```

### Exit codes

- `0` — attached or resumed successfully.
- `1` — no sessions found, ambiguous target, or underlying attach/resume failure.

### Files affected

- **Reads:** `.diptych/active`, `.diptych/sessions/<id>/lockfile.json`, `.diptych/sessions/<id>/state.json`.
- **Writes:** same as `attach` or `resume` depending on session state.

### See also

- `diptych last` — always targets the most recent session.
- `diptych attach` — explicit attach to a running session.
- `diptych resume` — explicit resume of an interrupted session.
- `diptych ps` — list sessions with numeric aliases.

### Behavior notes

- When the target session is running (lockfile present, process alive), `continue` delegates to `attach`; `--json` is ignored on that path and `--rpc` is rejected.
- When the target session is not running but has resumable state, `continue` delegates to `resume`.
- `--rpc` applies only to interrupted sessions. It does not attach to a live detached server.
- Numeric aliases correspond to the `#` column in `diptych ps` output.

---

## diptych last

**Synopsis**

```
diptych last [workflow options]
```

Attach or resume the newest lockfile-backed session. Use this when you want recency instead of `continue`'s active-or-single-running resolution.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| Workflow flags | — | — | Same options as `continue`, including `--json`, `--rpc`, `--auto`, `--allow-hooks`, runner overrides, mode, budget, and approval controls. `--json` / `--rpc` apply only when the newest session resolves to interrupted resumable state. |

### Examples

```bash
# Pick up where you left off
diptych last
```

### Exit codes

- `0` — attached or resumed successfully.
- `1` — no sessions found, or underlying attach/resume failure.

### Files affected

- **Reads:** `.diptych/sessions/` (to find the most recent), `.diptych/sessions/<id>/lockfile.json`, `.diptych/sessions/<id>/state.json`.
- **Writes:** same as `attach` or `resume` depending on session state.

### See also

- `diptych continue` — active, single-running, or explicitly targeted session continuity.
- `diptych ps` — see all sessions.

### Behavior notes

- Selects the session with the most recent `startTimeMs` regardless of status.
- If the most recent session is running, attaches. If interrupted, resumes.

---

## diptych stats

**Synopsis**

```
diptych stats [--project <dir>] [--rebuild] [--json]
```

Show cumulative cost savings across all sessions in the project. Reads from `.diptych/stats.json`, which is updated when a saved session summary includes cost data.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--rebuild` | boolean | `false` | Rebuild `.diptych/stats.json` from completed session summaries before printing. |
| `--json` | boolean | `false` | Emit machine-readable JSON output. |

### Examples

```bash
# Human-readable savings summary
diptych stats

# Machine-readable for scripting
diptych stats --json

# Rebuild aggregate stats from session history
diptych stats --rebuild
```

### Exit codes

- `0` — stats printed (or empty summary when no sessions have completed).
- `1` — I/O failure reading session history or writing `.diptych/stats.json` during `--rebuild`.

### Output

```
diptych savings: $15.64 saved across 23 sessions

Total spent:          $2.76
All-planner would be: $18.40
Savings rate:         85%
Tasks completed:      47 (39 local, 8 escalated)

By Provider:
  Claude Code:  $2.76 (23 sessions)

Last updated: 2026-05-13T08:00:00.000Z
```

### Files affected

- **Reads:** `.diptych/stats.json`; with `--rebuild`, completed session summaries under `.diptych/sessions/`.
- **Writes:** none normally. With `--rebuild`, rewrites `.diptych/stats.json`.

### See also

- `diptych status --history` — aggregate cost history across completed sessions, with provider totals.
- `diptych explain` — per-session cost confidence and routing decisions.

### Behavior notes

- `.diptych/stats.json` is updated atomically by `saveFinalSession()` for any saved summary with eligible cost data.
- When no stats file exists, prints a message indicating no sessions have completed yet.
- The all-planner baseline uses the same pricing model as the per-run hero savings stat on the summary screen. Deterministic pre-run estimates are prompt-input scoped; runtime stats use recorded usage.

---

## diptych export

**Synopsis**

```
diptych export [session-id] [-o <path>] [-p <dir>]
```

Export a completed session as a standalone HTML report. If `session-id` is omitted, diptych uses the active session when it is complete, otherwise the newest completed session.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `-o, --out <path>` | path | `.diptych/sessions/<id>/report.html` | Output file path. |
| `-p, --project <dir>` | path | cwd | Project directory. |

### Examples

```bash
diptych export
diptych export 2026-04-26-abcd1234
diptych export 2026-04-26-abcd1234 --out ./report.html
```

### Exit codes

- `0` — report written.
- `1` — no session could be resolved, export failed, or the output path could not be written.

### Files affected

- **Reads:** `.diptych/sessions/<id>/summary.json`, `state.json`, `evidence.json`, and related report inputs when present.
- **Writes:** the requested HTML report path.

### See also

- `/export` — export the active session from the TUI.
- `diptych explain` — inspect the same session artifacts without producing HTML.

---

## diptych migrate

**Synopsis**

```
diptych migrate [-p <dir>]
```

One-shot migrator from the pre-v3 single-session layout (`.diptych/current/`) to the per-session layout (`.diptych/sessions/<id>/`). Idempotent — safe to run twice.

### Usage

```
diptych migrate [-p <dir> | --project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `-p, --project <dir>` | path | `.` | Project directory to migrate. Resolved with `path.resolve()`. |

### Examples

```bash
# Migrate the current repo
diptych migrate

# Migrate another checkout
diptych migrate -p ../legacy-repo

# Long-form
diptych migrate --project /Users/me/code/app
```

### Exit codes

- `0` — migration succeeded or nothing to migrate.
- `1` — I/O failure during migration.

### Files affected

- **Reads:** `.diptych/current/` and any siblings.
- **Writes:** new entries under `.diptych/sessions/<id>/`; cleans up legacy paths it no longer needs.

### See also

- [docs/CHANGELOG.md](./CHANGELOG.md) — schema versions.
- `diptych start` and `diptych resume` — both call `maybeMigrate()` automatically; this command is for explicit, predictable migration.

### Behavior notes

- The `start` and `resume` commands invoke the same migration code via `maybeMigrate()`. Running `diptych migrate` directly is mostly useful for CI or for one-off cleanup before a manual sweep of `.diptych/`.
- The default `--project` value is the literal `.`, then resolved via `path.resolve()`. Passing `--project ../foo` yields the absolute path of the parent.

---

## diptych handoff

**Synopsis**

```
diptych handoff [target] [options]
```

Export a Handoff Pack — a directory of artifacts (spec, plan, tasks, optional context) formatted for an external coding agent. Built-in targets cover spec-kit and other common destinations; custom renderers under `.diptych/handoff-renderers/` are auto-discovered.

### Usage

```
diptych handoff [target] [--session <id>] [--out <dir>] [--task <ids>] \
  [--mode <mode>] [--project <dir>] [--allow-custom-renderer] [--list]
```

The optional `target` argument defaults to `spec-kit`.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--session <id>` | string | active session | Session ID to export. |
| `--out <dir>` | path | `.diptych/handoffs/<target>/` | Output directory. |
| `--task <ids>` | csv | all tasks | Comma-separated list of task IDs to include. |
| `--mode <mode>` | enum | `default` | Write mode: `default` (refuse on conflict), `append`, or `overwrite`. |
| `--project <dir>` | path | cwd | Project directory. |
| `--allow-custom-renderer` | boolean | `false` | Trust and load repo-local custom renderers for this invocation. |
| `--list` | boolean | `false` | List built-in and custom render targets, then exit. |

### Examples

```bash
# Default: spec-kit pack into .diptych/handoffs/spec-kit/
diptych handoff

# Pack a specific session for Claude Code
diptych handoff claude-code --session 2026-04-26-abcd1234

# Subset of tasks, custom output directory
diptych handoff agents-md --task T-001,T-003,T-007 --out ./pack

# Overwrite a previous export
diptych handoff --mode overwrite

# See what targets are available (built-in + custom renderers under .diptych/)
diptych handoff --list

# Execute a repo-local custom renderer
diptych handoff linear-ticket --allow-custom-renderer
```

### Exit codes

- `0` — pack written or `--list` printed.
- `1` — no active session and `--session` omitted, invalid `--mode`, missing renderer, untrusted custom renderer, or write failure.

### Files affected

- **Reads:** `.diptych/sessions/<id>/{spec.md,plan.md,tasks.md,state.json}`. Custom renderer modules under `.diptych/handoff-renderers/` are read only when `--allow-custom-renderer` is set or config has `trust.customRenderers: true`.
- **Writes:** every file in `--out` (default `.diptych/handoffs/<target>/`).

### See also

- [WORKFLOW.md](./WORKFLOW.md) — when to hand off vs. continue in diptych.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — contract every renderer must respect.

### Behavior notes

- `--list` prints built-in `HANDOFF_TARGETS` first, then a `Custom renderers:` block when renderers exist.
- The default target string is `spec-kit`. If you pass an unknown target without `--list`, the renderer factory throws and the command exits `1`.
- `--mode default` refuses to clobber existing files. Use `append` for additive updates, `overwrite` to start clean.
- `copilot-issue` writes `manifest.json` plus a single `issue.md` body. It does not emit per-task files.
- Listing custom renderers does not trust them. Executing one requires `--allow-custom-renderer` or `trust.customRenderers: true`.
- Output prints `Handoff written to: <dir>` followed by every emitted relative file path, one per line.

---

## diptych snapshot

**Synopsis**

```
diptych snapshot <subcommand> [options]
```

Manage working-tree snapshots scoped to a session. Snapshots live under `.diptych/sessions/<id>/snapshots/<snapshot-id>/` and let you compare or revert the implementer's changes without touching git.

Subcommands: `create`, `list`, `restore`, `diff`.

---

### diptych snapshot create

**Synopsis**

```
diptych snapshot create [--name <name>] [--session <id>] [--project <dir>]
```

Capture the current working tree state for the active session. The snapshot is tagged `phase: manual`.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--name <name>` | string | — | Optional human label. |
| `--session <id>` | string | active session | Session ID. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
diptych snapshot create
diptych snapshot create --name "before refactor"
diptych snapshot create --session 2026-04-26-abcd1234 --name pre-merge
```

#### Exit codes

- `0` — snapshot written.
- `1` — no active session (and no `--session`), or storage failure.

#### Output

```
Snapshot created: <id>
  Name: <name>            # only when --name passed
  Files: <N>
  Location: <absolute path>
```

---

### diptych snapshot list

**Synopsis**

```
diptych snapshot list [--session <id>] [--project <dir>]
```

List snapshots for a session in chronological order.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--session <id>` | string | active session | Session ID. |
| `--project <dir>` | path | cwd | Project directory. |

#### Output format

```
<id>  <createdAt>  files=<N>  phase=<phase>  <name>
```

#### Exit codes

- `0` — listed (zero snapshots prints `No snapshots found for session <id>.`).
- `1` — no active session and `--session` not passed.

---

### diptych snapshot restore

**Synopsis**

```
diptych snapshot restore <id-or-name> [--session <id>] [--project <dir>] [--force]
```

Restore the working tree to a previously captured snapshot. Files modified after the snapshot are reported as conflicts and skipped — pass `--force` to overwrite them. Tracked files created after the snapshot (absent from its manifest) are reported as extraneous and skipped; `--force` deletes them so the tree matches the snapshot exactly.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<id-or-name>` | string (positional) | — | Snapshot id or `--name` label. Required. |
| `--session <id>` | string | active session | Session ID. |
| `--project <dir>` | path | cwd | Project directory. |
| `--force` | boolean | `false` | Overwrite files modified since the snapshot. |

#### Examples

```bash
diptych snapshot restore snap-7f2c
diptych snapshot restore "before refactor"
diptych snapshot restore snap-7f2c --force
```

#### Exit codes

- `0` — restore completed without conflicts.
- `1` — no active session, snapshot not found, or restore left conflicts (`process.exit(1)` after the report).

#### Output

```
Restored <N> file(s) from snapshot <id>.
Conflicts (not restored — modified since snapshot):
  <path>
Run with --force to overwrite.

Forced (<N> file(s) overwritten):    # when --force is used
  <path>

Warning: <N> file(s) missing from snapshot storage (skipped).   # when applicable
```

---

### diptych snapshot diff

**Synopsis**

```
diptych snapshot diff <id-or-name> [--session <id>] [--project <dir>] [--no-color]
```

Print a unified diff between the current working tree and a snapshot.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<id-or-name>` | string (positional) | — | Snapshot id or `--name` label. Required. |
| `--session <id>` | string | active session | Session ID. |
| `--project <dir>` | path | cwd | Project directory. |
| `--no-color` | boolean | color on | Disable ANSI color in the diff. |

#### Examples

```bash
diptych snapshot diff snap-7f2c
diptych snapshot diff "before refactor" --no-color > /tmp/changes.diff
```

#### Exit codes

- `0` — no changes between working tree and snapshot.
- `1` — at least one file changed (the diff is still printed). Useful as a gate in scripts: `diptych snapshot diff <id> > /dev/null && echo clean`.

### Files affected (snapshot subcommands)

- **Reads:** `.diptych/sessions/<id>/snapshots/<snapshot-id>/manifest.json` and stored blobs.
- **Writes:** new snapshot directories on `create`; working-tree files on `restore`. `list` and `diff` are read-only.

### See also (snapshot)

- `diptych worktree` — physical isolation as an alternative to snapshots.
- [DEBUGGING.md](./DEBUGGING.md) — reverting bad runs.

---

## diptych approval

**Synopsis**

```
diptych approval <subcommand> [options]
```

Manage sticky approval grants. When a workflow asks for approval and the user picks "always allow", the choice is recorded as a grant. This command lists or clears those grants.

Subcommands: `list`, `clear`.

---

### diptych approval list

**Synopsis**

```
diptych approval list [--project <dir>]
```

Print every grant in `.diptych/approvals.json` as an aligned table.

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

### diptych approval clear

**Synopsis**

```
diptych approval clear [--scope <scope>] [--project <dir>]
```

Remove grants whose scope matches the filter.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--scope <scope>` | enum | `all` | One of `session`, `always`, `all`. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
diptych approval list
diptych approval clear                      # clears everything
diptych approval clear --scope session      # only per-session grants
diptych approval clear --scope always       # only persistent grants
```

#### Exit codes

- `0` — cleared (prints `Cleared <N> approval grant(s).`, where `N` may be `0`).
- `1` — invalid scope or store write failure.

### Files affected (approval)

- **Reads / writes:** `.diptych/approvals.json`.

### See also (approval)

- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — `/approval` semantics during a run.
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook policies that interact with approvals.

---

## diptych mcp

**Synopsis**

```
diptych mcp serve [options]
```

Start an MCP (Model Context Protocol) HTTP server that exposes supported diptych session resources to MCP-aware clients (Claude Code, Cursor, etc.). It serves read-only session resources and a narrow evidence-recording tool surface for external agents to report task progress, evidence, validation results, completion, or errors. It does not expose shell access, arbitrary file writes, prompts, or implementer execution. Currently exposes a single subcommand: `serve`.

### Usage

```
diptych mcp serve [--port <number>] [--session <id> | --all-sessions] [--project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--port <number>` | integer | `4321` | TCP port to listen on. Validated as an integer in `[1, 65535]`. |
| `--session <id>` | string | active session | Serve only this session. Mutually exclusive with `--all-sessions`. |
| `--all-sessions` | boolean | `false` | Serve every session in the project. Mutually exclusive with `--session`. |
| `--project <dir>` | path | cwd | Project directory. |

### Examples

```bash
# Default port, active session
diptych mcp serve

# All sessions on a custom port
diptych mcp serve --port 4400 --all-sessions

# Specific session
diptych mcp serve --session 2026-04-26-abcd1234
```

### Exit codes

- `0` — server shut down cleanly via SIGINT or SIGTERM.
- `1` — invalid port, both `--session` and `--all-sessions`, server bind failure, or session resolution failure.

### Files affected

- **Reads:** session artifacts under `.diptych/sessions/`.
- **Writes:** evidence ledger updates under `.diptych/sessions/<id>/evidence.json` when MCP tools are called. The server also binds to `127.0.0.1:<port>` and emits a fresh bearer token on stdout each invocation.

### Output

After binding, prints the URL, generated bearer token, listed sessions, and a ready-to-paste `mcpServers.diptych` block for `.claude/settings.json`. The server runs until `Ctrl+C` (SIGINT) or SIGTERM.

### See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — MCP integration in the engine.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/draft) — protocol overview and safety guidance.
- [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools) — tool surfaces are model-controlled and require explicit safety treatment; diptych's tool surface is limited to evidence ledger updates.

### Behavior notes

- The bearer token is regenerated every run via `generateToken()`. Keep it private; treat the output as a credential.
- The server binds to `127.0.0.1` only — it is not accessible over the network without your own proxy.
- `tools/list` advertises five evidence tools: `report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, and `report_error`. `tools/call` for these tools only mutates diptych's evidence ledger for existing sessions/tasks.
- General tool execution stays inside the configured planner or implementer runner, where the user can review the runner's own tool UI and approval prompts.
- `--port 0` is rejected (the validator requires `>= 1`); a free random port cannot be requested via this CLI.
- MCP Streamable HTTP uses protocol version `2025-11-25`. Missing `MCP-Protocol-Version` request headers default to that version; unsupported versions return `400`.
- `resources/list` always includes the sessions index and conditionally lists session resources that exist: `manifest.json` only when canonical `summary.json` and `state.json` are valid, plus `summary.json`, `state.json`, `spec.md`, `plan.md`, `tasks`, individual `tasks/<id>` blocks, `evidence.json`, and `drift-report.json`.
- Missing concrete session resources return MCP resource-not-found rather than empty success. The virtual `tasks` resource returns an empty JSON array when `tasks.md` is absent.

---

## diptych worktree

**Synopsis**

```
diptych worktree <subcommand> [options]
```

List, switch into, print paths for, or remove diptych-managed git worktrees under `.trees/<slug>` (branch `diptych/<slug>`). Created with `diptych start --worktree`. Subcommands: `list`, `switch`, `path`, `remove`.

---

### diptych worktree list

**Synopsis**

```
diptych worktree list [--project <dir>]
```

Print a table of every diptych-managed worktree with path, branch, live status, session id, phase, and last updated time. Columns adapt to terminal width.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |

#### Output

Columns: `NAME`, `PATH`, `BRANCH`, `STATUS`, `SESSION`, `PHASE`, `UPDATED`. `STATUS` is `none` when no session is bound, otherwise `active` or `idle`; missing session, phase, or updated values render as `unknown`.

#### Exit codes

- `0` — always (read-only). Empty result prints `No diptych-managed worktrees found.`

---

### diptych worktree switch

**Synopsis**

```
diptych worktree switch <name> [--project <dir>]
```

Print shell instructions to enter the worktree (the CLI cannot `cd` for you). Verifies the worktree exists.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<name>` | string (positional) | — | Worktree slug. Required. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
diptych worktree switch migration
# prints:
#   To switch to worktree "migration", run:
#     cd .trees/migration
#   ...
```

#### Exit codes

- `0` — instructions printed.
- `1` — worktree not found.

---

### diptych worktree path

**Synopsis**

```
diptych worktree path <name> [--project <dir>]
```

Print the resolved filesystem path for a diptych-managed worktree. Useful for shell wrappers such as `cd "$(diptych worktree path migration)"`.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<name>` | string (positional) | — | Worktree slug. Required. |
| `--project <dir>` | path | cwd | Project directory. |

#### Exit codes

- `0` — path printed on stdout.
- `1` — worktree not found.

---

### diptych worktree remove

**Synopsis**

```
diptych worktree remove <name> [--force] [--delete-branch] [--project <dir>]
```

Remove a worktree directory. By default, refuses to remove a worktree with a live session or uncommitted changes — pass `--force` to bypass both guards.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<name>` | string (positional) | — | Worktree slug. Required. |
| `--force` | boolean | `false` | Bypass live-session and uncommitted-changes guards. |
| `--delete-branch` | boolean | `false` | Also delete the `diptych/<name>` branch after removal. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
# Safe removal (fails if dirty or session is live)
diptych worktree remove migration

# Force removal and delete the branch
diptych worktree remove migration --force --delete-branch
```

#### Exit codes

- `0` — removed.
- `1` — worktree not found, guard refused removal, or git error.

### Files affected (worktree)

- **Reads:** `.trees/`, git metadata, `.diptych/active`, and `.diptych/sessions/<id>/state.json` inside each worktree to determine status, session, phase, and update time.
- **Writes:** `git worktree add/remove`, optional `git branch -d/-D`.

### See also (worktree)

- `diptych start --worktree` — create one.
- [WORKTREES.md](./WORKTREES.md) — design rationale.

### Behavior notes

- The list view truncates wide path/branch/name columns when the terminal is narrow. Status, session, phase, and updated columns are preserved.
- Forced removal prints explicit warnings for each bypassed guard, including the live session id when known and the number of uncommitted files when known.
- Removing a worktree removes the worktree-local `.diptych/sessions/` state with that directory. Export or copy needed session artifacts before removal.

---

## diptych attach

**Synopsis**

```
diptych attach [session-id] [--project <dir>]
```

Connect a TUI client to a background session that was launched with `diptych start --detach`. The session keeps running across attaches and detaches. If `session-id` is omitted, attaches to the unique running session in the project (errors when there are zero or two-plus).

### Usage

```
diptych attach [session-id] [--project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id>` | string (positional) | auto-resolved | Specific session to attach to. Optional when exactly one session is running. |
| `--project <dir>` | path | cwd | Project directory. |

### Examples

```bash
# One running session — no id needed
diptych attach

# Pick a specific session
diptych attach 2026-04-26-abcd1234

# Different project
diptych attach 2026-04-26-abcd1234 --project ../service-a
```

### Exit codes

- `0` — attach succeeded (or detached cleanly).
- `1` — Windows platform, no running session, multiple running sessions and no id specified, or the named session is not running (a crash diagnostic is shown first).

### Files affected

- **Reads:** `.diptych/sessions/<id>/lockfile.json`, `.diptych/sessions/<id>/ipc.sock`, crash logs on failure.
- **Writes:** none directly; the IPC connection forwards user input to the running server.

### See also

- `diptych start --detach` — start a background session.
- `diptych ps` — find running sessions.

### Behavior notes

- Not supported on Windows: prints `diptych attach/detach/ps are not supported on Windows.` and exits `1`.
- When the resolver finds zero running sessions: `no running sessions found; pass <session-id> explicitly`.
- When more than one is running: `multiple running sessions (<a>, <b>); pass <session-id> explicitly`.
- If the named session is dead, `showCrashDiagnostic()` prints the post-mortem before the exit.
- Attach renders the workflow TUI as an IPC client, replays session events from disk, streams live events, forwards submitted input to the server, and detaches with Ctrl-D.

---

## diptych detach

**Synopsis**

```
diptych detach [session-id] [--project <dir>]
```

Detach a TUI client from a running background session without stopping the server. If `session-id` is omitted, targets the unique running session in the project and errors when there are zero or multiple running sessions.

### Usage

```
diptych detach [session-id] [--project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id>` | string (positional) | auto-resolved | Specific session to detach from. Optional when exactly one session is running. |
| `--project <dir>` | path | cwd | Project directory. |

### Examples

```bash
diptych detach
diptych detach 2026-04-26-abcd1234
```

### Exit codes

- `0` — detach request sent (`Session <id> detached.`).
- `1` — Windows platform, no running session, multiple running sessions and no id specified, named session is not running, or IPC failure.

### Files affected

- **Reads:** `.diptych/sessions/<id>/lockfile.json`, `.diptych/sessions/<id>/ipc.sock`.
- **Writes:** none persistent; sends `{ "kind": "detach" }` over the session socket.

### See also

- `diptych attach` — connect to a running session.
- `diptych ps` — find running sessions.

---

## diptych ps

**Synopsis**

```
diptych ps [--project <dir>]
```

List every session in the current project (running, exited, crashed, unknown), newest first. Mirrors `ps`/`docker ps` ergonomics.

### Usage

```
diptych ps [--project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |

### Examples

```bash
# All sessions in this repo
diptych ps

# Sessions in a sibling project
diptych ps --project ../service-b
```

### Exit codes

- `0` — listed (empty result prints `No sessions found in this project.`).
- `1` — Windows platform.

### Files affected

- **Reads:** `.diptych/sessions/<id>/lockfile.json` for every session directory.
- **Writes:** none.

### Output

Columns (whitespace-aligned): `#`, `SESSION ID`, `STATUS`, `PID`, `MODE`, `ELAPSED`, `FEATURE`.

- `#` is a numeric alias (1, 2, 3...) usable with `diptych attach 1`, `diptych continue 1`, etc.
- `STATUS` is one of `running`, `exited`, `crashed`, `unknown`.
- `ELAPSED` shows `Hh Mm Ss` / `Mm Ss` / `Ss`. For running sessions it's measured against the current clock; for finished sessions, against `exitedAt`.

### See also

- `diptych attach` — connect to a running session.
- `diptych status` — focused view of the active session.

### Behavior notes

- Not supported on Windows: prints `diptych attach/detach/ps are not supported on Windows.` and exits `1`.
- A session whose lockfile is missing reports `STATUS=unknown`, `PID=-`, `MODE=-`, `FEATURE=-`. This usually means the session crashed before writing the lock or was deleted manually.
- Sorting is by `startTimeMs DESC` — newest first, with sessions missing a start time anchored at `0`.
- Column widths grow to fit content; very long feature descriptions push the table wider than the terminal (no truncation).

---

## Cross-cutting reference

### Common flags across multiple commands

| Flag | Commands | Default | Notes |
|---|---|---|---|
| `--project <dir>` | most | cwd | Project directory. |
| `-p, --project <dir>` | `migrate`, `export` | `.` / cwd | Short project-dir alias. |
| `--session <id>` | `explain`, `handoff`, `snapshot *`, `mcp serve` | active session | When omitted, the active session is read from `.diptych/active`. |
| `--auto` | `start`, `resume`, `continue`, `last` | `false` | Aliases `--approve none`. |
| `--allow-hooks` | `start`, `resume`, `continue`, `last`, `spec` | `false` | Skip the hook-trust prompt. CI flag. |
| `--json` | `start`, `resume`, `continue`, `last`, `doctor`, `explain`, `stats` | `false` | Public NDJSON record stream for workflow commands; single JSON object for `doctor` / `explain` / `stats`. Workflow events are wrapped as `{ "type": "event", "data": ... }`. For `continue` / `last`, applies only when the target is an interrupted resumable session; live sessions attach through the TUI. |
| `--rpc` | `start`, `resume`, `continue`, `last` | `false` | Bidirectional NDJSON. Mutually exclusive with `--json`; command responses are wrapped as `ack`, `error`, `status`, or `event`. For `continue` / `last`, applies only to interrupted resumable sessions and is rejected for live detached sessions. |

### Where state lives

| Path | Owner | Purpose |
|---|---|---|
| `.diptych/config.yaml` | `init` | Provider, model, workflow, hooks, OTel config. |
| `.diptych/active` | `start`, `spec` | Pointer to the current session while a workflow is active; cleared on final save unless preserved for recovery. |
| `.diptych/sessions/<id>/spec.md` | planner | Spec phase output. |
| `.diptych/sessions/<id>/plan.md` | planner | Plan phase output. |
| `.diptych/sessions/<id>/tasks.md` | planner | Task list. |
| `.diptych/sessions/<id>/state.json` | orchestrator | Persisted machine state for `resume` / `status`. |
| `.diptych/sessions/<id>/session.jsonl` | orchestrator | Append-only transcript and event log. |
| `.diptych/sessions/<id>/snapshots/<snap-id>/` | `snapshot create` | Working-tree snapshots. |
| `.diptych/sessions/<id>/lockfile.json` | `start --detach` | Background server lockfile. |
| `.diptych/sessions/<id>/ipc.sock` | `start --detach` | Unix domain socket for IPC. |
| `.diptych/approvals.json` | `approval`, runtime `/approval` | Sticky grants. |
| `.diptych/hook-trust.json` | `start`/`resume`/`spec` trust prompt | Hook trust ledger. |
| `.diptych/handoff-renderers/` | user | Custom Handoff Pack renderers. |
| `.trees/<slug>/` | `worktree`, `start --worktree` | Linked git worktrees on branch `diptych/<slug>`. |
| `.diptych/handoffs/<target>/` | `handoff` | Default Handoff Pack output (overridden by `--out`). |

### Headless event stream (`--json`)

When `start`, `resume`, or an interrupted resumable `continue` / `last` runs with `--json`, stdout emits one public JSON record per line (NDJSON). Live workflow events use `{ "type": "event", "data": <EngineEvent> }`. Other records use named top-level types such as `readiness_report`, `recovery_required`, `final_review_failed`, `warning`, and `error`. Public records are bounded and secret-redacted before writing. The TUI is not started, the alternate screen buffer is never entered, and `--no-fullscreen`/`--no-mouse` are no-ops in this mode. Workflow review gates approve by default, questions and continuations resolve non-interactively, recovery pauses such as unknown paid pricing exit non-zero, and tiered sticky/confirm approvals fail closed instead of waiting for input. Live `continue` / `last` targets attach through the TUI instead.

### RPC stream (`--rpc`)

When `start`, `resume`, or an interrupted resumable `continue` / `last` runs with `--rpc`, stdin accepts one JSON command per line and stdout emits one JSON response per line. Commands are `approve`, `reject`, `regenerate`, `message`, `recovery`, `status`, `abort`, and `slash`. Workflow events are wrapped as `{ "type": "event", "data": <EngineEvent> }`; command results use `{ "type": "ack" | "error" | "status", ... }`. Unlike `--json`, RPC keeps approval, question, continuation, cost, and task-review gates open until the client sends the matching command. Live `continue` / `last` targets reject `--rpc` rather than attaching.

### Workflow modes (`--mode`)

| Mode | Planner calls | Approval gates | Best for |
|---|:---:|:---:|---|
| `instant` | 1 | none | Trivial edits that need almost no ceremony. |
| `quick` | 1 | none | Small tasks that still need a brief. |
| `standard` (default) | 4 | supporting spec + briefs | Ordinary feature work. |
| `speckit` | 6–7 | supporting spec + plan + briefs | Large, risky, or externally visible work. |

`full` is a legacy alias for `speckit`. Detailed semantics in [WORKFLOW.md](./WORKFLOW.md).

### Runner kinds (`--planner` / `--implementer`)

| `kind` | What it is | Examples |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` |
| `api` | OpenAI-compatible HTTP endpoint | `ollama`, `lm-studio`, `openrouter`, `deepseek`, `groq`, `together`, `anthropic` |
| `shell` | Arbitrary command (stdin → stdout) | Custom scripts via `--planner-command` / `--implementer-command` |
| `agent` | Subprocess that writes files directly (no stdout extraction) | Custom file-writing tools |
| `agent-sdk` | Anthropic Agent SDK library call | Via `@anthropic-ai/claude-agent-sdk` |

Schemas and YAML shape live in [ARCHITECTURE.md](./ARCHITECTURE.md) and [CONFIGURATION.md](./CONFIGURATION.md).

### Getting help

```bash
diptych --help                     # top-level help
diptych <command> --help           # command help (Commander-generated)
diptych snapshot --help            # subcommand parents print their child list
diptych snapshot create --help     # leaf subcommand help
```

Commander emits a usage banner, the description string, and the option table verbatim — this reference document expands the same surface with examples, exit codes, files, and behavior notes.
