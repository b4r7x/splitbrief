# CLI Reference

Complete reference for every `splitbrief` command. Maintained against `src/cli.ts` and `src/cli/commands/*.ts`.

```
SPLITBRIEF — an orchestrator of two coding tools: one plans and reviews, the other executes, and it holds the contract, validation, retry, escalation and evidence
```

## Global behavior

- **Binary name:** `splitbrief`. The `npm run dev -- <cmd>` form is equivalent during local development.
- **Working directory:** Most commands accept `--project <dir>`. When omitted, the project starts from the current working directory. Every command then canonicalizes it to the git toplevel (`canonicalizeProjectDir` in `src/cli/setup.ts`), so a session started from `packages/web` is the same session `ps`, `status`, `doctor` and `resume` see from the repository root, and `spec` never auto-creates a second config next to a nested `package.json`. An explicit `--project` pointing inside a repository prints a one-line relocation warning; a bare subdirectory invocation relocates silently.
- **Runtime requirement:** the CLI reads `process.versions.node` before it parses anything and refuses a Node older than `package.json`'s `engines.node` (`>=22`) with `splitbrief requires Node.js 22 or newer; this process is Node.js <version>.` — see `src/cli/node-guard.ts`.
- **Mistyped subcommands:** `start` is the default command, so a bare token becomes a feature description. To stop `splitbrief doctro` from buying a planner call, a single bare operand that is not a registered command but is within one edit of a short command name (≤ 4 characters) or two edits of a longer one is rejected: `unknown command 'doctro' — did you mean 'doctor'?`, exit `1`. Transpositions count as one edit. The guard only looks at an invocation whose leading operand run is exactly one whitespace-free token, so `splitbrief "fix the typo"`, `splitbrief fix the typo` and the explicit `splitbrief start doctro` all still run. See `src/cli/unknown-command.ts`.
- **Exit codes:**
  - `0` — success.
  - `1` — generic CLI failure. Almost every command throws via `cliError(message)` which defaults to `exitCode: 1`. The top-level handler in `src/cli.ts` prints `Error: <message>` to stderr and exits with the carried code.
  - `2` — reserved for guardrail hooks (e.g. `.claude/hooks/block-git-commits.sh`). The CLI itself does not raise `2`; observe it in subprocess output only.
- **Error format:** Failures print `Error: <message>` in red on stderr. Programmatic callers should grep stderr, not stdout.
- **OpenTelemetry:** `src/cli.ts` calls `bootstrapOtel()` before parsing. When `otel.enabled: true` in config and `--otel-exporter console` is passed (where supported), spans flow to stdout. See [OTEL.md](./OTEL.md).
- **Platform notes:** `attach`, `detach`, `ps`, and `start --detach` (server lifecycle) call `assertNotWindows()` and exit with `1` and the message `splitbrief attach/detach/ps are not supported on Windows.` on `win32`. `continue` and `last` resume interrupted sessions on Windows, but reject a **live** running target with the same attach unsupported message because that path delegates to `attach`.

## Command index

| # | Command | Purpose |
|---|---|---|
| 1 | `splitbrief start` | Launch a workflow (TUI, headless, or detached). Also the default command: `splitbrief "feature"` works without `start`. |
| 2 | `splitbrief spec` | Run the planner only — produce the planning artifacts for a mode, no implementation. |
| 3 | `splitbrief init` | Create `.splitbrief/config.yaml` with detected models. |
| 4 | `splitbrief status` | Show the active session and optional cost history. |
| 5 | `splitbrief explain` | Explain routing, cost, review, and warnings from session artifacts. |
| 6 | `splitbrief resume` | Resume the active interrupted workflow. |
| 7 | `splitbrief continue` | Smart session continuity: attach if running, resume if interrupted. |
| 8 | `splitbrief last` | Attach or resume the most recent session. |
| 9 | `splitbrief stats` | Show cumulative cost savings across all sessions. |
| 10 | `splitbrief export` | Export a session as an HTML report. |
| 11 | `splitbrief handoff` | Export a Handoff Pack for an external coding agent. |
| 12 | `splitbrief snapshot` | Create / list / restore / diff working-tree snapshots. |
| 13 | `splitbrief approval` | List or clear sticky approval grants. |
| 14 | `splitbrief mcp` | Run the MCP resource and evidence-tool server. |
| 15 | `splitbrief worktree` | List / switch / path / remove `.trees/<slug>` git worktrees. |
| 16 | `splitbrief attach` | Attach a TUI client to a detached background session. |
| 17 | `splitbrief detach` | Detach a TUI client without stopping the background server. |
| 18 | `splitbrief ps` | List sessions in the current project; collect non-session directories with `--prune`. |
| 19 | `splitbrief doctor` | Check run readiness without creating a workflow session. |

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
  [--model <model>] [--provider <provider>] \
  [--budget <amount>] [--planner-effort <level>] [--yolo] \
  [--project <dir>] [--worktree [name]] [--detach] \
  [--no-fullscreen] [--no-mouse] [--hover] \
  [--allow-hooks] [--allow-repo-runners] [--allow-unverified-auth] \
  [--json] [--rpc] [--otel-exporter <name>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--mode <mode>` | enum | `standard` (or `workflow.mode` from config) | One of `instant`, `quick`, `standard`, `speckit`. See [WORKFLOW.md](./WORKFLOW.md). |
| `--approve <level>` | enum | `default` | Spec/plan document gates: `none`, `spec`, `plan`, `all`, `default`. `default` follows the mode's built-in policy. |
| `--planner <tool>` | string | from config | Planner tool: `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code`, `ollama-cloud`, `anthropic`, `openrouter`, `deepseek`, `openai`, `groq`, `together`, `shell`, `agent`, `agent-sdk`. The flag's help text is derived from `PLANNER_TOOL_IDS` (`src/core/schemas/enums.js`), so `splitbrief start --help` always prints the admitted set. |
| `--planner-model <model>` | string | from config | Planner model identifier (for API planners). |
| `--planner-command <cmd>` | string | from config | Custom planner command (when `--planner=shell`). |
| `--planner-api-base <url>` | string | from config | Planner API base URL. Applies only to `api` runners; ignored (with a stderr warning) for other kinds. |
| `--planner-api-key-env <var>` | string | from config | Environment variable holding the planner API key; stored as an `env:<var>` reference. A bare name is normalized to `env:<var>`. Applies only to `api` and `agent-sdk` runners; ignored (with a stderr warning) otherwise. |
| `--planner-args <arg>` | string | from config | Append one planner CLI/shell argument. Repeatable; each use adds another argument. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-output-format <format>` | enum | from config | Planner output format: `stream-json`, `jsonl`, `text`, or `opencode`. Applies to `cli`, `shell`, and `agent` runners. |
| `--planner-context-length <tokens>` | number | from config | Planner context length in tokens. Consumed only by the `api` planner kind, where it sizes the request's `max_tokens` output budget; other kinds delegate the budget to their backend and ignore it. |
| `--planner-effort <level>` | enum | — | Effort hint: `low`, `medium`, `high`, `xhigh`. Silently dropped on backends that don't support it. |
| `--implementer <provider>` | string | from config | Implementer provider: `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code`, `ollama`, `ollama-cloud`, `lm-studio`, `anthropic`, `openrouter`, `deepseek`, `openai`, `groq`, `together`, `shell`, `agent`, `agent-sdk`. The flag's help text is derived from the catalog's implementer role admission (`src/cli/options.ts`), so `splitbrief start --help` always prints the admitted set. |
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
| `--yolo` | boolean | `false` | Disable file-write tiered approval prompts for the session. Spec/plan gates still follow `--approve` / mode policy, and briefs review remains separate. This is not a shell or network sandbox setting. |
| `--project <dir>` | path | cwd | Project directory. |
| `--worktree [name]` | string \| boolean | — | Run inside a new linked git worktree at `.trees/<name>` on branch `splitbrief/<name>`. If `name` is omitted, the feature slug is used only when `workflow.persistTranscript` is true; otherwise an opaque `session-<hex>` slug is used. |
| `--detach` | boolean | `false` | Spawn the workflow as a background server and exit. Requires a `feature` argument and is mutually exclusive with `--json` and `--rpc`. |
| `--no-fullscreen` | boolean | fullscreen on | Disable the alternate screen buffer. Useful when piping or debugging. |
| `--no-mouse` | boolean | mouse on | Disable Ink mouse tracking. |
| `--hover` | boolean | `false` | Opt in to hover highlighting under the mouse. Requires both mouse tracking and fullscreen; a no-op with `--no-mouse` or `--no-fullscreen`. |
| `--allow-hooks` | boolean | `false` | Trust the hook config without prompting (CI). |
| `--allow-repo-runners` | boolean | `false` | Grant this run every `shell`/`agent` runner command the project config declares, including profile runners, package-manager script indirection, and project-local PATH resolution. Headless runs have no other way past the trust prompt; the grant is not persisted. Command strings containing `{prompt}` are rejected by config validation; pass prompts through stdin or args. |
| `--allow-unverified-auth` | boolean | `false` | Let a headless run proceed when a compatible CLI runner's authentication could not be verified. Only affects headless transports (`--json`, `--rpc`, `--detach`); interactive runs disclose the unverified state and prompt instead. |
| `--json` | boolean | `false` | Headless: emit public NDJSON records to stdout, skip TUI. Workflow events are wrapped as `{ "type": "event", "data": <EngineEvent> }`. Requires a `feature`. |
| `--rpc` | boolean | `false` | RPC: bidirectional NDJSON. Reads commands from stdin and writes `ack` / `error` / `status` / wrapped `event` responses to stdout. Requires a `feature`; mutually exclusive with `--json`. |
| `--otel-exporter <name>` | string | — | Bootstrap an OTel exporter (currently only `console`). Requires `otel.enabled: true` in config. |

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

# RPC: external tool drives approvals and messages
splitbrief start --rpc "add audit logging"

# Detached background session, attach later
splitbrief start --detach "long migration"
splitbrief ps
splitbrief attach <session-id> --project .

# Isolated worktree
splitbrief start --worktree migration "Postgres 17 upgrade"

# Privacy-preserving bare worktree name when workflow.persistTranscript=false
splitbrief start "sensitive customer migration" --worktree
# prints .trees/session-<hex> instead of a feature-derived directory
```

### Exit codes

- `0` — workflow completed (or TUI exited cleanly).
- `1` — invalid flag combination, invalid or unwritable config, planner/implementer failure, budget exceeded, or any uncaught error.

### Files affected

- **Reads:** `.splitbrief/config.yaml`, `.splitbrief/sessions/<id>/state.json` (if resuming), repo files supplied to the planner.
- **Writes:** `.splitbrief/sessions/<id>/{readiness.json,spec.md,plan.md,tasks.md,state.json,session.jsonl}`, working-tree changes by the implementer, `.splitbrief/sessions/<id>/lockfile.json` and `ipc.sock` when detached, `.trees/<slug>/` when `--worktree` is used.

### See also

- `splitbrief spec` — planning only, no implementation.
- `splitbrief resume` — continue an interrupted run.
- `splitbrief ps` / `splitbrief attach` / `splitbrief detach` — manage detached sessions.
- [WORKFLOW.md](./WORKFLOW.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [CONFIGURATION.md](./CONFIGURATION.md).

### Behavior notes

- `--detach` cannot be combined with `--json` or `--rpc`; `--json` and `--rpc` cannot be combined. `--detach`, `--json`, and `--rpc` each require a feature where they start a new workflow.
- When `--detach` omits `--mode`, the workflow mode comes from `workflow.mode` in config (default `standard`), not a hard-coded CLI default.
- After `start --detach`, the printed attach hint is a shell-safe argv line using `--project` (not a brittle `cd … && …` chain). Paths with spaces are quoted.
- Before planner or implementer calls, `start` computes Run Readiness. Blockers stop the run; warnings are shown in the TUI or emitted as JSON. The compact session artifact is `.splitbrief/sessions/<id>/readiness.json`. Stable `stateId` values and copyable remediations for missing-binary, untrusted-path, version, authentication, endpoint, credential-family, protocol, quota/rate, and conflicting-argument conditions are documented under `splitbrief doctor --json`.
- Readiness inspects validation configuration and package-script posture only. It does not run `typecheck`, lint, tests, model calls, or network probes.
- With `--json`, the first readiness line is `{ "type": "readiness_report", "report": ... }` before model-backed workflow events. With `--rpc`, readiness is wrapped as `{ "type": "status", "data": { "type": "readiness_report", "report": ... } }`.
- `clearStaleSession()` runs before a new session begins. It blocks only a genuinely live active session; if the active session's lockfile has exited or the PID is gone, the stale `.splitbrief/active` pointer is cleared and start continues.
- When `--worktree` is passed, the source working tree must be clean. The project directory is reassigned to the newly created worktree path before any state is written. With `--detach --worktree`, worktree selection happens before the detached server is spawned. A bare `--worktree` derives its slug from the feature only when transcript persistence is enabled; with `workflow.persistTranscript: false`, it uses an opaque `session-<hex>` slug so `.trees/<slug>` and `splitbrief/<slug>` do not reveal feature text. If worktree creation fails, the command exits `1` with the underlying message.
- The `setupWorkflow()` step may show an interactive setup screen if config is incomplete; pass `--allow-hooks` in CI to skip the hook-trust prompt.
- Runner override flags are validated against the resolved runner kind. `--planner-api-base` / `--implementer-api-base` apply only to `api` runners, and `--planner-api-key-env` / `--implementer-api-key-env` apply only to `api` and `agent-sdk` runners. Passing one for an incompatible kind prints a warning to stderr (e.g. `--planner-api-base is ignored: the planner 'cli' runner does not use it.`) and the value is dropped rather than erroring.

---

## splitbrief spec

**Synopsis**

```
splitbrief spec <feature> [options]
```

Run only the planner. Produces the planning artifacts for the selected mode in a fresh session folder, then exits without invoking the implementer. In `standard` and `speckit` that is `spec.md`, `plan.md`, and `tasks.md`; in `instant` and `quick`, a single planner call produces `tasks.md`. Useful for review-only flows, scripting, or bootstrapping a Handoff Pack.

Planner stream output is stripped of terminal control sequences before writing to stdout.

### Usage

```
splitbrief spec <feature> [--mode <mode>] [--project <dir>] [--allow-hooks] [--allow-repo-runners]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--mode <mode>` | enum | `standard` (or `workflow.mode` from config) | One of `instant`, `quick`, `standard`, `speckit`. Same validation and precedence as `splitbrief start`: the flag wins over `workflow.mode`, and an unrecognized value fails the command. See [WORKFLOW.md](./WORKFLOW.md). |
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
- **Writes:** the planning artifacts under `.splitbrief/sessions/<id>/` for the resolved mode (`research.md`, `spec.md`, `plan.md`, `tasks.md` in `standard` / `speckit`; `tasks.md` in `instant` / `quick`), and the `.splitbrief/active` pointer.
- **On a failed planner call:** the session directory it allocated is removed again via the preparation rollback (including the `.splitbrief/active` pointer); no directory is left behind.

### See also

- `splitbrief start` — full plan-and-implement.
- `splitbrief handoff` — export the produced artifacts to another tool.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md), [WORKFLOW.md](./WORKFLOW.md).

### Behavior notes

- Planner output streams to stdout in real time via the `onOutput` callback. Phase headings appear as bold `--- <phase> ---` separators.
- The line printed before planning starts names the planner and the resolved mode, so the mode in force is visible at the point of decision.
- `spec` runs no approval gate. `--approve` is not accepted here; the mode's approval defaults apply to `splitbrief start`, not to planning-only runs.
- `clearStaleSession()` runs before `beginSession()` — a crashed prior run will not block this one.
- Session id is generated from the feature; the final summary prints the absolute path of every artifact the mode produced.
- The number of generated tasks is reported as `... (N tasks)` after the run.

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

`start --json` emits the same `readiness_report` shape as its first stdout line before workflow events; `start --rpc` emits it inside the first `status` envelope. `resume` re-probes CLI readiness for start gates but emits no `readiness_report`. See [FEATURES.md](./FEATURES.md).

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
- Runner availability is probed for the `api` and `agent-sdk` runners a run would call (`runners.availability.planner`, `runners.availability.implementer.<profile>`). Each probe is one model-list round trip against the endpoint the runner already targets, bounded by a 2s budget and run in parallel. An unreachable planner or default implementer is a blocker — the planning phase is paid for before the implementer is first used — while a non-default profile is a warning. A probe that could not run or overran its budget reports `not-probed` (info); it never reports available. When no probe runs at all, readiness says so and makes no claim (`runners.availability`).
- The arg-vector preflight runs here too, so a blocker `start` would raise can be inspected without starting a run: a flag the installed binary's help does not advertise is a blocker (`runners.cli.<tool>.arg-vector.<role>`), a flag it marks deprecated is a warning, and a help text that cannot be read reports ok. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
- A `shell` or `agent` runner reaches execution only through an owner-only trust receipt, so `doctor` replays that admission read-only (`runners.consent.planner`, `runners.consent.implementer.<profile>`) instead of only warning that the runner can execute commands. The verdict is reported for a run started the way `doctor` was started: on a TTY it is a warning naming the one-time confirmation `start` would prompt for, and with `--json` or a non-TTY stdin it is the blocker a non-interactive run receives. Nothing is written and no receipt is granted — `doctor` takes no `--allow-repo-runners`, so a run that passes that flag can be admitted where `doctor` reports a blocker, and the check's remediation names the flag.
- Headless runner admission is replayed the same way: with `--json` or a non-TTY stdin, `doctor` runs the same `runners.preparation.*` checks `start --json` / `start --rpc` / `start --detach` would fail on when a configured CLI runner lacks a trusted readiness identity or would otherwise be refused headless admission. Each check's remediation names `--allow-unverified-auth` when that flag would admit the run; `doctor` accepts no override flags, so a headless run that passes `--allow-unverified-auth` can proceed where `doctor` reports a blocker. Interactive `doctor` on a TTY does not emit these preparation blockers — interactive `start` discloses and prompts instead.
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
splitbrief status [--project <dir>] [--history]
```

Print the current session's phase, task progress, planner / implementer identity, and counts for completed / escalated / failed tasks. With `--history`, also aggregate cost across all completed sessions in the project.

### Usage

```
splitbrief status [--project <dir>] [--history]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--history` | boolean | `false` | Append a cost history block aggregated across all completed sessions. |

### Examples

```bash
# What is the current run doing?
splitbrief status

# Same plus past spend
splitbrief status --history

# Inspect a different repo
splitbrief status --project ../other-repo --history
```

### Exit codes

- `0` — always (status is read-only).
- `1` — only on unexpected I/O failure when reading session files.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/state.json`, and completed session `summary.json` files when `--history` is set.
- **Writes:** none.

### See also

- `splitbrief ps` — broader session listing including detached / crashed runs.
- `splitbrief resume` — pick up where the active session left off.

### Behavior notes

- If there is no active session, prints `No active workflow.` and (when `--history` is absent) a hint about `--history`.
- The `(awaiting continue)` suffix on the phase line means the run is in the Ctrl-C abort/continue state and is waiting for user input.
- Cost history loads via `aggregateSessionCosts(listAllSessions(...))` over completed `summary.json` files. Invalid summaries are skipped with a warning; unexpected history errors print `Cannot load session history`.
- `Done`, `Escalated`, `Failed` lines only appear when the corresponding count is non-zero.

---

## splitbrief explain

**Synopsis**

```
splitbrief explain [--session <id>] [--project <dir>] [--json]
```

Read existing session artifacts and print a compact explanation of why routing, cost, review, and warning decisions happened. It never calls the planner, implementer, or provider APIs, and it does not rewrite session artifacts.

### Usage

```
splitbrief explain [--session <id>] [--project <dir>] [--json]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--session <id>` | string \| number | active session | Session ID or numeric alias from `splitbrief ps`. Required when `.splitbrief/active` is absent, which is typical after completed runs. |
| `--project <dir>` | path | cwd | Project directory. |
| `--json` | boolean | `false` | Emit one JSON object: `{ "type": "run_explain", "explain": ... }`. |

### Examples

```bash
# Explain the active in-progress run
splitbrief explain

# Explain a completed session
splitbrief explain --session 2026-04-29-add-auth
splitbrief explain --session 1

# Machine-readable output
splitbrief explain --session 2026-04-29-add-auth --json
```

### Exit codes

- `0` — explanation was printed.
- `1` — no active session and no `--session`, invalid session id, missing session directory, or unreadable required filesystem state.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/{summary.json,state.json,session.jsonl,readiness.json,review.md,review-packet.json,review-packet.md,evidence.json,drift-report.json}` when present.
- **Writes:** none.

### See also

- `splitbrief status` — live phase/task posture.
- `splitbrief doctor` — pre-run readiness diagnostics.
- `splitbrief mcp serve` — artifact access and evidence reporting for MCP clients.

### Behavior notes

- Output is intentionally compact: task routes are summarized and artifact paths are referenced instead of embedding full plans, Task Briefs, logs, diffs, or source code.
- Cost confidence is marked `partial` when pricing is unknown, a profile is unavailable, usage is unpriced, or the all-planner baseline cannot be fully priced.
- Cost prediction data is prompt-input scoped; runtime output, retries, validation reruns, and escalation are explained from recorded usage and warnings.
- Context fallback is shown from deterministic estimate metadata when available, and from routing reasons on completed task artifacts. Task-start rows show concise routing reasons during the run; explain/drilldown surfaces richer context and per-task routing metadata.
- Task review gates are inferred from `task_review_needed` events in `session.jsonl`; final review status comes from `review-packet.json` or `review.md`.
- Missing optional artifacts are reported as missing instead of causing a model call or artifact regeneration.

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
  [--model <model>] [--provider <provider>] \
  [--budget <amount>] [--planner-effort <level>] [--yolo] \
  [--project <dir>] \
  [--no-fullscreen] [--no-mouse] [--hover] \
  [--allow-hooks] [--allow-repo-runners] [--json] [--rpc] [--otel-exporter <name>]
```

### Options

Resume accepts the same workflow override options as `start` except `--detach` and `--worktree` (both start-only; `--worktree` is rejected because a resumed session already lives in its original worktree). See [`splitbrief start`](#splitbrief-start) for the shared runner, mode, budget, OTel, and approval flags.

| Flag | Notes |
|---|---|
| `--json` | Resume the run in headless mode, streaming NDJSON to stdout. |
| `--rpc` | Resume the run in RPC mode, reading commands from stdin and writing NDJSON responses to stdout. Mutually exclusive with `--json`. |
| `--mode` / `--approve` / planner+implementer flags | Override the persisted values for this run only. The workflow mode resolved on the original run is saved in `state.json`; resume reuses it unless `--mode` is passed, which overrides it and prints a warning. |

### Examples

```bash
# Pick up where the last session stopped
splitbrief resume

# Resume in headless mode for CI re-runs
splitbrief resume --json --approve none

# Resume and drive gates programmatically
splitbrief resume --rpc

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
- [WORKFLOW.md](./WORKFLOW.md), [docs/CHANGELOG.md](./CHANGELOG.md) — schema migrations.

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

Smart session continuity command. Figures out the right thing: attaches if the session is still running, resumes if it was interrupted. Replaces the mental model of choosing between `ps`, `attach`, `detach`, and `resume`.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id-or-number>` | string \| number (positional) | active/single running | Session ID, numeric alias from `ps`, or omitted to use `.splitbrief/active` or the only running session. |
| `--project <dir>` | path | cwd | Project directory. |
| `--approve <level>` | approval | mode default | Spec/plan document approval mode. |
| `--allow-hooks` | boolean | `false` | Trust hook config without prompting. |
| `--allow-repo-runners` | boolean | `false` | Trust repo-local shell/agent runner commands from project config for resumed workflow execution. |
| `--json` | boolean | `false` | Resume an interrupted session in headless NDJSON mode. Live detached sessions still attach through the TUI. |
| `--rpc` | boolean | `false` | Resume an interrupted session in bidirectional RPC mode. Mutually exclusive with `--json`; rejected for live detached sessions. |
| Other resume flags | — | — | Runner overrides, mode, budget, OTel, `--no-fullscreen`, `--no-mouse`, and `--hover` (live attach path only), and approval controls. `--worktree` is rejected — it is a `start`-only flag, since a resumed session already lives in its original worktree. |

### Examples

```bash
# Continue the active session, or the only running session
splitbrief continue

# Continue by numeric alias from ps output
splitbrief continue 1

# Continue a specific session
splitbrief continue 2026-05-01-add-auth

# Continue an interrupted session via RPC
splitbrief continue --rpc 2026-05-01-add-auth
```

### Exit codes

- `0` — attached or resumed successfully.
- `1` — no sessions found, ambiguous target, or underlying attach/resume failure.

### Files affected

- **Reads:** `.splitbrief/active`, `.splitbrief/sessions/<id>/lockfile.json`, `.splitbrief/sessions/<id>/state.json`.
- **Writes:** same as `attach` or `resume` depending on session state.

### See also

- `splitbrief last` — always targets the most recent session.
- `splitbrief attach` — explicit attach to a running session.
- `splitbrief resume` — explicit resume of an interrupted session.
- `splitbrief ps` — list sessions with numeric aliases.

### Behavior notes

- When the target session is running (lockfile present, process alive), `continue` delegates to `attach`; `--json` is ignored on that path and `--rpc` is rejected. The live attach path honors `--no-fullscreen`, `--no-mouse`, and `--hover` the same way `splitbrief attach` does.
- When the target session is not running but has resumable state, `continue` delegates to `resume` (including `--json` / `--rpc` when passed).
- On Windows, interrupted sessions still resume; live running targets fail with `splitbrief attach/detach/ps are not supported on Windows.` because attach is unavailable.
- `--rpc` applies only to interrupted sessions. It does not attach to a live detached server.
- Numeric aliases correspond to the `#` column in `splitbrief ps` output.

---

## splitbrief last

**Synopsis**

```
splitbrief last [workflow options]
```

Attach or resume the newest lockfile-backed session. Use this when you want recency instead of `continue`'s active-or-single-running resolution.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| Workflow flags | — | — | Same options as `continue`, including `--json`, `--rpc`, `--approve`, `--allow-hooks`, `--allow-repo-runners`, runner overrides, mode, budget, and approval controls. `--json` / `--rpc` apply only when the newest session resolves to interrupted resumable state. |

### Examples

```bash
# Pick up where you left off
splitbrief last
```

### Exit codes

- `0` — attached or resumed successfully.
- `1` — no sessions found, or underlying attach/resume failure.

### Files affected

- **Reads:** `.splitbrief/sessions/` (to find the most recent), `.splitbrief/sessions/<id>/lockfile.json`, `.splitbrief/sessions/<id>/state.json`.
- **Writes:** same as `attach` or `resume` depending on session state.

### See also

- `splitbrief continue` — active, single-running, or explicitly targeted session continuity.
- `splitbrief ps` — see all sessions.

### Behavior notes

- Selects the session with the most recent `startTimeMs` regardless of status.
- If the most recent session is running, attaches (honoring `--no-fullscreen`, `--no-mouse`, and `--hover` on the live path). If interrupted, resumes (including `--json` / `--rpc` when passed).
- On Windows, interrupted sessions still resume; live running targets fail with the attach unsupported message.

---

## splitbrief stats

**Synopsis**

```
splitbrief stats [--project <dir>] [--rebuild] [--json]
```

Show cumulative cost savings across all sessions in the project. Reads from `.splitbrief/stats.json`, which is updated when a saved session summary includes cost data.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--rebuild` | boolean | `false` | Rebuild `.splitbrief/stats.json` from completed session summaries before printing. |
| `--json` | boolean | `false` | Emit machine-readable JSON output. |

### Examples

```bash
# Human-readable savings summary
splitbrief stats

# Machine-readable for scripting
splitbrief stats --json

# Rebuild aggregate stats from session history
splitbrief stats --rebuild
```

### Exit codes

- `0` — stats printed (or empty summary when no sessions have completed).
- `1` — I/O failure reading session history or writing `.splitbrief/stats.json` during `--rebuild`.

### Output

```
splitbrief savings: $15.64 saved across 23 sessions

Total spent:          $2.76
All-planner would be: $18.40
Savings rate:         85%
Tasks completed:      47 (39 local, 8 escalated)

By Provider:
  Claude Code:  $2.76 (23 sessions)

Last updated: 2026-05-13T08:00:00.000Z
```

### Files affected

- **Reads:** `.splitbrief/stats.json`; with `--rebuild`, completed session summaries under `.splitbrief/sessions/`.
- **Writes:** none normally. With `--rebuild`, rewrites `.splitbrief/stats.json`.

### See also

- `splitbrief status --history` — aggregate cost history across completed sessions, with provider totals.
- `splitbrief explain` — per-session cost confidence and routing decisions.

### Behavior notes

- `.splitbrief/stats.json` is updated atomically by `saveFinalSession()` (`src/engine/orchestrator/session-lifecycle/finalize.ts`) for any saved summary with eligible cost data.
- When no stats file exists, prints a message indicating no sessions have completed yet.
- The all-planner baseline uses the same pricing model as the per-run hero savings stat on the summary screen. Deterministic pre-run estimates are prompt-input scoped; runtime stats use recorded usage.

---

## splitbrief export

**Synopsis**

```
splitbrief export [session-id] [-o <path>] [-p <dir>]
```

Export a completed session as a standalone HTML report. If `session-id` is omitted, SPLITBRIEF uses the active session when it is complete, otherwise the newest completed session.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `-o, --out <path>` | path | `.splitbrief/sessions/<id>/report.html` | Output file path. |
| `-p, --project <dir>` | path | cwd | Project directory. |

### Examples

```bash
splitbrief export
splitbrief export 2026-04-26-abcd1234
splitbrief export 2026-04-26-abcd1234 --out ./report.html
```

### Exit codes

- `0` — report written.
- `1` — no session could be resolved, export failed, or the output path could not be written.

### Files affected

- **Reads:** `.splitbrief/sessions/<id>/summary.json`, `state.json`, `evidence.json`, and related report inputs when present.
- **Writes:** the requested HTML report path.

### See also

- `/export` — export the active session from the TUI.
- `splitbrief explain` — inspect the same session artifacts without producing HTML.

---

## splitbrief handoff

**Synopsis**

```
splitbrief handoff [target] [options]
```

Export a Handoff Pack — a directory of artifacts (spec, plan, tasks, optional context) formatted for an external coding agent. Built-in targets cover spec-kit and other common destinations; custom renderers under `.splitbrief/handoff-renderers/` are auto-discovered.

### Usage

```
splitbrief handoff [target] [--session <id>] [--out <dir>] [--task <ids>] \
  [--mode <mode>] [--project <dir>] [--allow-custom-renderer] [--list]
```

The optional `target` argument defaults to `spec-kit`.

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--session <id>` | string \| number | active session | Session ID or numeric alias from `splitbrief ps` to export. |
| `--out <dir>` | path | `.splitbrief/handoffs/<target>/` | Output directory. |
| `--task <ids>` | csv | all tasks | Comma-separated list of task IDs to include. |
| `--mode <mode>` | enum | `default` | Write mode: `default` (refuse on conflict), `append`, or `overwrite`. |
| `--project <dir>` | path | cwd | Project directory. |
| `--allow-custom-renderer` | boolean | `false` | Trust and load repo-local custom renderers for this invocation. |
| `--list` | boolean | `false` | List built-in and custom render targets, then exit. |

### Examples

```bash
# Default: spec-kit pack into .splitbrief/handoffs/spec-kit/
splitbrief handoff

# Pack a specific session for Claude Code
splitbrief handoff claude-code --session 2026-04-26-abcd1234

# Pack by numeric alias from splitbrief ps
splitbrief handoff claude-code --session 1

# Subset of tasks, custom output directory
splitbrief handoff agents-md --task T-001,T-003,T-007 --out ./pack

# Overwrite a previous export
splitbrief handoff --mode overwrite

# See what targets are available (built-in + custom renderers under .splitbrief/)
splitbrief handoff --list

# Execute a repo-local custom renderer
splitbrief handoff linear-ticket --allow-custom-renderer
```

### Exit codes

- `0` — pack written or `--list` printed.
- `1` — no active session and `--session` omitted, invalid `--mode`, missing renderer, untrusted custom renderer, or write failure.

### Files affected

- **Reads:** `.splitbrief/sessions/<id>/{spec.md,plan.md,tasks.md,state.json}` and `.specify/memory/constitution.md` when present. Custom renderer modules under `.splitbrief/handoff-renderers/` are read only when `--allow-custom-renderer` is set or config has `trust.customRenderers: true`.
- **Writes:** every file in `--out` (default `.splitbrief/handoffs/<target>/`).

### See also

- [WORKFLOW.md](./WORKFLOW.md) — when to hand off vs. continue in SPLITBRIEF.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — contract every renderer must respect.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptom to state ID to remediation; pre-export readiness via `splitbrief doctor --json` (`stateId` / `remediation`).

### Behavior notes

- `--list` prints built-in `HANDOFF_TARGETS` first, then a `Custom renderers:` block when renderers exist.
- The default target string is `spec-kit`. If you pass an unknown target without `--list`, the renderer factory throws and the command exits `1`.
- `--mode default` refuses to clobber existing files. Use `append` for additive updates, `overwrite` to start clean.
- `copilot-issue` writes `manifest.json` plus a single `issue.md` body. It does not emit per-task files.
- Listing custom renderers does not trust them. Executing one requires `--allow-custom-renderer` or `trust.customRenderers: true`. An untrusted renderer module fails with `handoff-custom-renderer-blocked` and exits `1`; it produces no readiness check. Remediation: pass `--allow-custom-renderer` after reviewing the module, or set `trust.customRenderers: true`.
- Output prints `Handoff written to: <dir>` followed by every emitted relative file path, one per line.

---

## splitbrief snapshot

**Synopsis**

```
splitbrief snapshot <subcommand> [options]
```

Manage working-tree snapshots scoped to a session. Snapshots live under `.splitbrief/sessions/<id>/snapshots/<snapshot-id>/` and let you compare or revert the implementer's changes without touching git.

Subcommands: `create`, `list`, `restore`, `diff`.

---

### splitbrief snapshot create

**Synopsis**

```
splitbrief snapshot create [--name <name>] [--session <id>] [--project <dir>]
```

Capture the current working tree state for the active session. The snapshot is tagged `phase: manual`.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--name <name>` | string | — | Optional human label. |
| `--session <id>` | string \| number | active session | Session ID or numeric alias from `splitbrief ps`. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
splitbrief snapshot create
splitbrief snapshot create --name "before refactor"
splitbrief snapshot create --session 2026-04-26-abcd1234 --name pre-merge
splitbrief snapshot create --session 1 --name pre-merge
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

### splitbrief snapshot list

**Synopsis**

```
splitbrief snapshot list [--session <id>] [--project <dir>]
```

List snapshots for a session in chronological order.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--session <id>` | string \| number | active session | Session ID or numeric alias from `splitbrief ps`. |
| `--project <dir>` | path | cwd | Project directory. |

#### Output format

```
<id>  <createdAt>  files=<N>  phase=<phase>  <name>
```

#### Exit codes

- `0` — listed (zero snapshots prints `No snapshots found for session <id>.`).
- `1` — no active session and `--session` not passed.

---

### splitbrief snapshot restore

**Synopsis**

```
splitbrief snapshot restore <id-or-name> [--session <id>] [--project <dir>] [--force]
```

Restore the working tree to a previously captured snapshot. Files modified after the snapshot are reported as conflicts and skipped — pass `--force` to overwrite them. Tracked files created after the snapshot (absent from its manifest) are reported as extraneous and skipped; `--force` deletes them so the tree matches the snapshot exactly.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<id-or-name>` | string (positional) | — | Snapshot id or `--name` label. Required. |
| `--session <id>` | string \| number | active session | Session ID or numeric alias from `splitbrief ps`. |
| `--project <dir>` | path | cwd | Project directory. |
| `--force` | boolean | `false` | Overwrite files modified since the snapshot. |

#### Examples

```bash
splitbrief snapshot restore snap-7f2c
splitbrief snapshot restore "before refactor"
splitbrief snapshot restore snap-7f2c --force
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

### splitbrief snapshot diff

**Synopsis**

```
splitbrief snapshot diff <id-or-name> [--session <id>] [--project <dir>] [--no-color]
```

Print a unified diff between the current working tree and a snapshot.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<id-or-name>` | string (positional) | — | Snapshot id or `--name` label. Required. |
| `--session <id>` | string \| number | active session | Session ID or numeric alias from `splitbrief ps`. |
| `--project <dir>` | path | cwd | Project directory. |
| `--no-color` | boolean | color on | Disable ANSI color in the diff. |

#### Examples

```bash
splitbrief snapshot diff snap-7f2c
splitbrief snapshot diff "before refactor" --no-color > /tmp/changes.diff
```

#### Exit codes

- `0` — no changes between working tree and snapshot.
- `1` — at least one file changed (the diff is still printed). Useful as a gate in scripts: `splitbrief snapshot diff <id> > /dev/null && echo clean`.

### Files affected (snapshot subcommands)

- **Reads:** `.splitbrief/sessions/<id>/snapshots/<snapshot-id>/manifest.json` and stored blobs.
- **Writes:** new snapshot directories on `create`; working-tree files on `restore`. `list` and `diff` are read-only.

### See also (snapshot)

- `splitbrief worktree` — physical isolation as an alternative to snapshots.
- [DEBUGGING.md](./DEBUGGING.md) — reverting bad runs.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — session recovery; readiness `stateId` / `remediation` via `splitbrief doctor --json`.

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

## splitbrief mcp

**Synopsis**

```
splitbrief mcp serve [options]
```

Start an MCP (Model Context Protocol) HTTP server that exposes supported SPLITBRIEF session resources to MCP-aware clients (Claude Code, Cursor, etc.). It serves read-only session resources and a narrow evidence-recording tool surface for external agents to report task progress, evidence, validation results, completion, or errors. It does not expose shell access, arbitrary file writes, prompts, or implementer execution. Currently exposes a single subcommand: `serve`.

### Usage

```
splitbrief mcp serve [--port <number>] [--session <id> | --all-sessions] [--project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--port <number>` | integer | `4321` | TCP port to listen on. Validated as an integer in `[1, 65535]`. |
| `--session <id>` | string \| number | active session | Serve only this session or numeric alias from `splitbrief ps`. Mutually exclusive with `--all-sessions`. |
| `--all-sessions` | boolean | `false` | Serve every session in the project. Mutually exclusive with `--session`. |
| `--project <dir>` | path | cwd | Project directory. |

### Examples

```bash
# Default port, active session
splitbrief mcp serve

# All sessions on a custom port
splitbrief mcp serve --port 4400 --all-sessions

# Specific session
splitbrief mcp serve --session 2026-04-26-abcd1234
splitbrief mcp serve --session 1
```

### Exit codes

- `0` — server shut down cleanly via SIGINT or SIGTERM.
- `1` — invalid port, both `--session` and `--all-sessions`, server bind failure, or session resolution failure.

### Files affected

- **Reads:** session artifacts under `.splitbrief/sessions/`.
- **Writes:** evidence ledger updates under `.splitbrief/sessions/<id>/evidence.json` when MCP tools are called. The server also binds to `127.0.0.1:<port>` and emits a fresh bearer token on stdout each invocation.

### Output

After binding, prints the URL, generated bearer token, listed sessions, and a ready-to-paste `mcpServers.splitbrief` block for `.claude/settings.json`. The server runs until `Ctrl+C` (SIGINT) or SIGTERM.

### See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — MCP integration in the engine.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/draft) — protocol overview and safety guidance.
- [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools) — tool surfaces are model-controlled and require explicit safety treatment; SPLITBRIEF's tool surface is limited to evidence ledger updates.
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — runner `state` outcomes; endpoint/credential policy in [CONFIGURATION.md](./CONFIGURATION.md).

### Behavior notes

- The bearer token is regenerated every run via `generateToken()`. Keep it private; treat the output as a credential.
- The server binds to `127.0.0.1` only — it is not accessible over the network without your own proxy.
- `tools/list` advertises five evidence tools: `report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, and `report_error`. `tools/call` for these tools only mutates SPLITBRIEF's evidence ledger for existing sessions/tasks.
- General tool execution stays inside the configured planner or implementer runner, where the user can review the runner's own tool UI and approval prompts.
- `--port 0` is rejected (the validator requires `>= 1`); a free random port cannot be requested via this CLI.
- MCP Streamable HTTP uses protocol version `2025-11-25`. Missing `MCP-Protocol-Version` request headers default to that version; unsupported versions return a `400` JSON error response. Remediation: align the client protocol version with `2025-11-25` or upgrade SPLITBRIEF.
- `resources/list` always includes the sessions index and conditionally lists session resources that exist: `manifest.json` only when canonical `summary.json` and `state.json` are valid, plus `summary.json`, `state.json`, `spec.md`, `plan.md`, `tasks`, individual `tasks/<id>` blocks, `evidence.json`, and `drift-report.json`. When `workflow.persistTranscript: false`, the sessions index and `state.json` resource replace transcript-sensitive fields such as feature text, task prose, queued message text, and queued clarification questions.
- Missing concrete session resources return MCP resource-not-found rather than empty success. The virtual `tasks` resource returns an empty JSON array when `tasks.md` is absent.

---

## splitbrief worktree

**Synopsis**

```
splitbrief worktree <subcommand> [options]
```

List, switch into, print paths for, or remove SPLITBRIEF-managed git worktrees under `.trees/<slug>` (branch `splitbrief/<slug>`). Created with `splitbrief start --worktree`. Subcommands: `list`, `switch`, `path`, `remove`.

---

### splitbrief worktree list

**Synopsis**

```
splitbrief worktree list [--project <dir>]
```

Print a table of every SPLITBRIEF-managed worktree with path, branch, live status, session id, phase, and last updated time. Columns adapt to terminal width.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |

#### Output

Columns: `NAME`, `PATH`, `BRANCH`, `STATUS`, `SESSION`, `PHASE`, `UPDATED`. `STATUS` is `none` when no session is bound, otherwise `active` or `idle`; missing session, phase, or updated values render as `unknown`.

#### Exit codes

- `0` — always (read-only). Empty result prints `No splitbrief-managed worktrees found.`

---

### splitbrief worktree switch

**Synopsis**

```
splitbrief worktree switch <name> [--project <dir>]
```

Print shell instructions to enter the worktree (the CLI cannot `cd` for you). Verifies the worktree exists.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<name>` | string (positional) | — | Worktree slug. Required. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
splitbrief worktree switch migration
# prints:
#   To switch to worktree "migration", run:
#     cd .trees/migration
#   ...
```

#### Exit codes

- `0` — instructions printed.
- `1` — worktree not found.

---

### splitbrief worktree path

**Synopsis**

```
splitbrief worktree path <name> [--project <dir>]
```

Print the resolved filesystem path for a SPLITBRIEF-managed worktree. Useful for shell wrappers such as `cd "$(splitbrief worktree path migration)"`.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<name>` | string (positional) | — | Worktree slug. Required. |
| `--project <dir>` | path | cwd | Project directory. |

#### Exit codes

- `0` — path printed on stdout.
- `1` — worktree not found.

---

### splitbrief worktree remove

**Synopsis**

```
splitbrief worktree remove <name> [--force] [--delete-branch] [--project <dir>]
```

Remove a worktree directory. By default, refuses to remove a worktree with a live session or uncommitted changes — pass `--force` to bypass both guards.

#### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<name>` | string (positional) | — | Worktree slug. Required. |
| `--force` | boolean | `false` | Bypass live-session and uncommitted-changes guards. |
| `--delete-branch` | boolean | `false` | Also delete the `splitbrief/<name>` branch after removal. |
| `--project <dir>` | path | cwd | Project directory. |

#### Examples

```bash
# Safe removal (fails if dirty or session is live)
splitbrief worktree remove migration

# Force removal and delete the branch
splitbrief worktree remove migration --force --delete-branch
```

#### Exit codes

- `0` — removed.
- `1` — worktree not found, guard refused removal, or git error.

### Files affected (worktree)

- **Reads:** `.trees/`, git metadata, `.splitbrief/active`, and `.splitbrief/sessions/<id>/state.json` inside each worktree to determine status, session, phase, and update time.
- **Writes:** `git worktree add/remove`, optional `git branch -d/-D`.

### See also (worktree)

- `splitbrief start --worktree` — create one.
- [WORKTREES.md](./WORKTREES.md) — design rationale.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptom to state ID to remediation; pre-flight `splitbrief doctor --json` for `missing-binary`, `untrusted-path`, and `conflicting-args`.

### Behavior notes

- The list view truncates wide path/branch/name columns when the terminal is narrow. Status, session, phase, and updated columns are preserved.
- Forced removal prints explicit warnings for each bypassed guard, including the live session id when known and the number of uncommitted files when known.
- Removing a worktree removes the worktree-local `.splitbrief/sessions/` state with that directory. Export or copy needed session artifacts before removal.

---

## splitbrief attach

**Synopsis**

```
splitbrief attach [session-id] [--project <dir>] [--no-fullscreen] [--no-mouse] [--hover]
```

Connect a TUI client to a background session that was launched with `splitbrief start --detach`. The session keeps running across attaches and detaches. If `session-id` is omitted, attaches to the unique running session in the project (errors when there are zero or two-plus).

### Usage

```
splitbrief attach [session-id] [--project <dir>] [--no-fullscreen] [--no-mouse] [--hover]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id>` | string (positional) | auto-resolved | Specific session to attach to. Optional when exactly one session is running. |
| `--project <dir>` | path | cwd | Project directory. |
| `--no-fullscreen` | boolean | fullscreen on | Disable the alternate screen buffer. |
| `--no-mouse` | boolean | mouse on | Disable Ink mouse tracking. |
| `--hover` | boolean | `false` | Opt in to hover highlighting; requires mouse + fullscreen. |

### Examples

```bash
# One running session — no id needed
splitbrief attach

# Pick a specific session
splitbrief attach 2026-04-26-abcd1234

# Different project
splitbrief attach 2026-04-26-abcd1234 --project ../service-a
```

### Exit codes

- `0` — attach succeeded (or detached cleanly).
- `1` — Windows platform, no running session, multiple running sessions and no id specified, or the named session is not running (a crash diagnostic is shown first).

### Files affected

- **Reads:** `.splitbrief/sessions/<id>/lockfile.json`, `.splitbrief/sessions/<id>/ipc.sock`, crash logs on failure.
- **Writes:** none directly; the IPC connection forwards user input to the running server.

### See also

- `splitbrief start --detach` — start a background session.
- `splitbrief ps` — find running sessions.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptom to state ID to remediation; runner `state` outcomes in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

### Behavior notes

- Not supported on Windows: prints `splitbrief attach/detach/ps are not supported on Windows.` and exits `1`.
- When the resolver finds zero running sessions: `no running sessions found; pass <session-id> explicitly`.
- When more than one is running: `multiple running sessions (<a>, <b>); pass <session-id> explicitly`.
- If the named session is dead, `showCrashDiagnostic()` prints the post-mortem before the exit; cross-check with `splitbrief doctor --json` when readiness or runner `state` is in question.
- Attach renders the workflow TUI as an IPC client, replays session events from disk, streams live events, forwards submitted input to the server, and detaches with Ctrl-D.

---

## splitbrief detach

**Synopsis**

```
splitbrief detach [session-id] [--project <dir>]
```

Detach a TUI client from a running background session without stopping the server. If `session-id` is omitted, targets the unique running session in the project and errors when there are zero or multiple running sessions.

### Usage

```
splitbrief detach [session-id] [--project <dir>]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `<session-id>` | string (positional) | auto-resolved | Specific session to detach from. Optional when exactly one session is running. |
| `--project <dir>` | path | cwd | Project directory. |

### Examples

```bash
splitbrief detach
splitbrief detach 2026-04-26-abcd1234
```

### Exit codes

- `0` — detach request sent (`Session <id> detached.`).
- `1` — Windows platform, no running session, multiple running sessions and no id specified, named session is not running, or IPC failure.

### Files affected

- **Reads:** `.splitbrief/sessions/<id>/lockfile.json`, `.splitbrief/sessions/<id>/ipc.sock`.
- **Writes:** none persistent; sends `{ "kind": "detach" }` over the session socket.

### See also

- `splitbrief attach` — connect to a running session.
- `splitbrief ps` — find running sessions.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptom to state ID to remediation.

---

## splitbrief ps

**Synopsis**

```
splitbrief ps [--project <dir>] [--prune]
```

List every session in the current project (running, exited, crashed, unknown), newest first. Mirrors `ps`/`docker ps` ergonomics. Directories that hold no lockfile, no `state.json` and no `summary.json` are not sessions and are omitted. `--prune` collects the collectable **subset** of them, not all of them: only a directory that is empty or holds exactly `readiness.json`, and is older than 24 hours, is collected (`isCollectableOrphan`, `src/core/sessions/orphans.ts`). One holding, say, only `tasks.md` stays hidden from `ps` and is never collected — see [SUBSYSTEMS.md](./SUBSYSTEMS.md).

### Usage

```
splitbrief ps [--project <dir>] [--prune]
```

### Options

| Flag | Type | Default | Description |
|---|---|---|---|
| `--project <dir>` | path | cwd | Project directory. |
| `--prune` | boolean | `false` | Remove collectable session directories before listing, print one line per removed directory plus a total, then render the remaining table. A directory is collectable when it holds nothing but `readiness.json` (or is empty) and is older than 24 hours; see [SUBSYSTEMS.md](./SUBSYSTEMS.md). |

### Examples

```bash
# All sessions in this repo
splitbrief ps

# Sessions in a sibling project
splitbrief ps --project ../service-b

# Collect orphaned session directories, then list what remains
splitbrief ps --prune
```

### Exit codes

- `0` — listed (empty result prints `No sessions found in this project.`).
- `1` — Windows platform.

### Files affected

- **Reads:** `.splitbrief/sessions/<id>/lockfile.json` for every session directory.
- **Writes:** with `--prune`, the collectable session directories under `.splitbrief/sessions/` are removed.

### Output

Columns (whitespace-aligned): `#`, `SESSION ID`, `STATUS`, `PID`, `MODE`, `ELAPSED`, `FEATURE`.

- `#` is a numeric alias (1, 2, 3...) usable with `splitbrief attach 1`, `splitbrief continue 1`, etc.
- `STATUS` is one of `running`, `exited`, `crashed`, `unknown`.
- `ELAPSED` shows `Hh Mm Ss` / `Mm Ss` / `Ss`. For running sessions it's measured against the current clock; for finished sessions, against `exitedAt`.
- When collectable directories exist, a trailing line names the count and the `--prune` flag. An isolation worktree whose session directory no longer exists is also named, with copy-pasteable `git worktree remove <path> --force` and `git branch -D splitbrief/<session-id>` cleanup. That orphan classification applies only when the marker's session directory is gone — a run started inside a `--worktree` lane is not reported orphaned from the repository root (`splitbrief worktree remove` manages `.trees/` lanes only and refuses unmanaged isolation paths).

### See also

- `splitbrief attach` — connect to a running session.
- `splitbrief status` — focused view of the active session.

### Behavior notes

- Not supported on Windows: prints `splitbrief attach/detach/ps are not supported on Windows.` and exits `1`.
- A session whose lockfile is missing reports `STATUS=unknown`, `PID=-`, `MODE=-`, `FEATURE=-`. This usually means the session crashed before writing the lock or was deleted manually. For `STATUS=crashed` or `unknown`, use `splitbrief doctor --json` (`stateId` / `remediation`) and [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
- Sorting is by `startTimeMs DESC` — newest first, with sessions missing a start time anchored at `0`.
- Column widths grow to fit content; very long feature descriptions push the table wider than the terminal (no truncation).

---

## Cross-cutting reference

### Diagnostic state IDs and support

Commands in this section share stable `stateId` / `state` identifiers and copyable `remediation` strings with `splitbrief doctor --json` (see [`splitbrief doctor`](#splitbrief-doctor)). Canonical references: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [CONFIGURATION.md](./CONFIGURATION.md), [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### Common flags across multiple commands

| Flag | Commands | Default | Notes |
|---|---|---|---|
| `--project <dir>` | most | cwd | Project directory. |
| `-p, --project <dir>` | `export` | `.` / cwd | Short project-dir alias. |
| `--session <id>` | `explain`, `handoff`, `snapshot *`, `mcp serve` | active session | Accepts a session ID or numeric alias from `splitbrief ps`. When omitted, the active session is read from `.splitbrief/active`. |
| `--mode <mode>` | `start`, `spec`, `resume`, `continue`, `last` | `workflow.mode`, else `standard` | One of `instant`, `quick`, `standard`, `speckit`. Validated against the same enum everywhere; on the resume family it overrides the mode saved in `state.json` and prints a warning. |
| `--allow-hooks` | `start`, `resume`, `continue`, `last`, `spec` | `false` | Skip the hook-trust prompt. CI flag. |
| `--allow-repo-runners` | `start`, `resume`, `continue`, `last`, `spec` | `false` | Trust repo-local shell/agent runner execution from project config. Separate from hook trust. |
| `--allow-unverified-auth` | `start`, `resume`, `continue`, `last` | `false` | Let a headless run proceed with unverified CLI authentication. No effect on interactive runs, which disclose and prompt. |
| `--json` | `start`, `resume`, `continue`, `last`, `doctor`, `explain`, `stats` | `false` | Public NDJSON record stream for workflow commands; single JSON object for `doctor` / `explain` / `stats`. Workflow events are wrapped as `{ "type": "event", "data": ... }`. For `continue` / `last`, applies only when the target is an interrupted resumable session; live sessions attach through the TUI. |
| `--rpc` | `start`, `resume`, `continue`, `last` | `false` | Bidirectional NDJSON. Mutually exclusive with `--json`; command responses are wrapped as `ack`, `error`, `status`, or `event`. For `continue` / `last`, applies only to interrupted resumable sessions and is rejected for live detached sessions. |

### Where state lives

| Path | Owner | Purpose |
|---|---|---|
| `.splitbrief/config.yaml` | `init` | Provider, model, workflow, hooks, OTel config. |
| `.splitbrief/active` | `start`, `spec` | Pointer to the current session while a workflow is active; cleared on final save unless preserved for recovery. |
| `.splitbrief/sessions/<id>/spec.md` | planner | Spec phase output. |
| `.splitbrief/sessions/<id>/plan.md` | planner | Plan phase output. |
| `.splitbrief/sessions/<id>/tasks.md` | planner | Task list. |
| `.splitbrief/sessions/<id>/state.json` | orchestrator | Persisted machine state for `resume` / `status`. |
| `.splitbrief/sessions/<id>/session.jsonl` | orchestrator | Append-only transcript and event log. |
| `.splitbrief/sessions/<id>/snapshots/<snap-id>/` | `snapshot create` | Working-tree snapshots. |
| `.splitbrief/sessions/<id>/lockfile.json` | `start --detach` | Background server lockfile. |
| `.splitbrief/sessions/<id>/ipc.sock` | `start --detach` | Unix domain socket for IPC. |
| `.splitbrief/approvals.json` | `approval`, runtime `/approval` | Sticky grants. |
| `~/.splitbrief/trust/hooks.json` | `start`/`resume`/`spec` trust prompt | Hook trust receipts, owner-only, keyed by checkout. Never inside the project. |
| `.splitbrief/handoff-renderers/` | user | Custom Handoff Pack renderers. |
| `.trees/<slug>/` | `worktree`, `start --worktree` | Linked git worktrees on branch `splitbrief/<slug>`. |
| `$XDG_STATE_HOME/splitbrief/trees/<hash>/<session-id>/` | run isolation | The implementer's per-run worktree, on branch `splitbrief/<session-id>`. Defaults to `~/.local/state/splitbrief/trees/...` when `XDG_STATE_HOME` is unset; `<hash>` is the first 12 hex chars of `sha256(realpath(git-common-dir))` so every linked checkout shares one trees root. Outside `.git/` (direct-writing CLIs refuse paths there) and outside the project root (so project-rooted test globs never walk the second copy). `git worktree list` and `splitbrief ps` are how you find one that outlived its run. |
| `.splitbrief/handoffs/<target>/` | `handoff` | Default Handoff Pack output (overridden by `--out`). |

### Headless event stream (`--json`)

When `start`, `resume`, or an interrupted resumable `continue` / `last` runs with `--json`, stdout emits one public JSON record per line (NDJSON). Live workflow events use `{ "type": "event", "data": <EngineEvent> }`. Other records use named top-level types such as `readiness_report`, `recovery_required`, `final_review_failed`, `warning`, and `error`. Public records are bounded and secret-redacted before writing. The TUI is not started, the alternate screen buffer is never entered, and `--no-fullscreen`/`--no-mouse`/`--hover` are no-ops in this mode. Workflow review gates approve by default (a blocked brief-readiness report therefore proceeds after the second internal approval), questions resolve non-interactively, continuation retry prompts never park (a watchdog idle-kill fails the run instead), recovery pauses such as unknown paid pricing exit non-zero, failed sessions exit non-zero, and file-write tiered sticky/confirm approvals fail closed instead of waiting for input. Live `continue` / `last` targets attach through the TUI instead.

The `recovery_required` record carries `reason`, `status` (`awaiting-user` | `paused` | `applying`), message, task/files when known, `availableActions`, and `recommendedAction`; `status` was added after the initial release and older consumers must treat it as optional. The command fails with exit code 1 for **every** pending recovery status — `paused` and `applying` exit non-zero exactly like `awaiting-user` — and the error message names the available resolution actions.

### RPC stream (`--rpc`)

When `start`, `resume`, or an interrupted resumable `continue` / `last` runs with `--rpc`, stdin accepts one JSON command per line and stdout emits one JSON response per line. Commands are `approve`, `reject`, `regenerate`, `brief_review`, `message`, `recovery`, `status`, `abort`, and `slash`. Workflow events are wrapped as `{ "type": "event", "data": <EngineEvent> }`; command results use `{ "type": "ack" | "error" | "status", ... }`. `brief_review` is prompt-scoped for Task Brief gates; optional `id` / `operationId` values are echoed in ack, error, and status data. Unlike `--json`, RPC keeps approval, question, continuation, cost, and task-review gates open until the client sends the matching command. Live `continue` / `last` targets reject `--rpc` rather than attaching.

### Workflow modes (`--mode`)

| Mode | Planner calls | Approval gates | Best for |
|---|:---:|:---:|---|
| `instant` | 1 | none | Trivial edits that need almost no ceremony. |
| `quick` | 1 | none | Small tasks that still need a brief. |
| `standard` (default) | 4 | supporting spec + briefs | Ordinary feature work. |
| `speckit` | 6–7 | supporting spec + plan + briefs | Large, risky, or externally visible work. |

`--mode` is accepted by `start`, `spec`, `resume`, `continue`, and `last`. On `spec` it selects planning depth only — that command never implements and runs no approval gate. Detailed semantics in [WORKFLOW.md](./WORKFLOW.md).

### Runner kinds (`--planner` / `--implementer`)

| `kind` | What it is | Examples |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` |
| `api` | OpenAI-compatible HTTP endpoint | `ollama`, `ollama-cloud`, `lm-studio`, `anthropic`, `openrouter`, `deepseek`, `openai`, `groq`, `together` |
| `shell` | Arbitrary command (stdin → stdout), no shell/network sandbox | Custom scripts via `--planner-command` / `--implementer-command` |
| `agent` | Subprocess that writes files directly, no stdout extraction or shell/network sandbox | Custom file-writing tools |
| `agent-sdk` | Anthropic Agent SDK library call | Via `@anthropic-ai/claude-agent-sdk` |

Schemas and YAML shape live in [ARCHITECTURE.md](./ARCHITECTURE.md) and [CONFIGURATION.md](./CONFIGURATION.md). Built-in CLI tools may run their own auto/permission modes according to their upstream behavior; SPLITBRIEF surfaces warnings but does not sandbox shell or network access.

### Getting help

```bash
splitbrief --help                     # top-level help
splitbrief <command> --help           # command help (Commander-generated)
splitbrief snapshot --help            # subcommand parents print their child list
splitbrief snapshot create --help     # leaf subcommand help
```

Commander emits a usage banner, the description string, and the option table verbatim — this reference document expands the same surface with examples, exit codes, files, and behavior notes.
