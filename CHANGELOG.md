# Changelog

## [Unreleased]

### Fixed

- A cloned repository can no longer grant itself hook execution. The hook trust receipt moved out of the project (`.splitbrief/hook-trust.json`) into the owner's machine-scoped store (`~/.splitbrief/trust/hooks.json`, mode `0600` in a `0700` directory), keyed by the canonical path of the checkout — the same store, identity, and owner-only read that custom runner trust already used, now shared through `src/core/trust/receipt-store.ts`. A receipt committed into a repository is a file SPLITBRIEF never reads; a second clone, a `cp -a`, or another account prompts again. Receipts written by earlier versions inside `.splitbrief/` are ignored: trust those hooks once more and delete the file.
- The hook trust prompt now discloses what it authorizes, and cannot be answered without it. The question itself carries each hook's executable, the absolute path that executable resolves to on this machine, its argv, and the trust boundary the hook runs inside, so every surface that answers the prompt must display it. A config-supplied `name:` no longer displaces the command in the disclosure, and repository-supplied strings are rendered as escaped literals so bidi or zero-width characters cannot redress one command as another. `--allow-hooks` writes the same disclosure to stderr before granting, so CI logs record what was authorized.
- Multi-line trust disclosures no longer collapse into one run-on line in the TUI approval prompt; the line breaks survive sanitization and the prompt's row math counts them.
- Readiness no longer certifies a CLI runner as authenticated because the sandbox roots are non-empty. The probe's credential-presence fact now asserts that the bridge's own destination file exists for that tool and channel, so the files a probe writes into the staged HOME — Claude Code drops `.claude.json` and a backup during a readiness run — are no longer read back as proof of a credential. A credential the staged child cannot read is a credential it does not have.
- The Claude Code subscription `session` channel works on macOS, where the credential is a login-keychain item the file bridge cannot carry. An auth channel now declares `hostKeychainPlatforms`, and a channel that resolves to `host-account` there keeps the host `HOME` and `USER` — the two values the keychain's search list and item account are keyed on — while `TMPDIR`, `XDG_*`, `npm_config_cache`, `PIP_CACHE_DIR` and `CARGO_HOME` stay redirected into `.splitbrief/sandbox/` and nothing is copied to disk. `session` is the default on every platform again, so a fresh macOS config no longer bills per token for a subscription the user already pays for. The security cost of that one channel — `~`-relative reads and Claude Code's own state writes land in the real home, and the login keychain resolves by default — is stated in `docs/WORKTREES.md`, `docs/API-KEYS.md` and `docs/HOW-IT-WORKS.md`. No other tool, channel or platform changed.
- Readiness never infers a keychain-backed login from directory contents. Where the staged environment cannot observe a credential it says so and runs the tool's own status command; `claude auth status` reporting `"loggedIn": false` is still `unauthenticated`, with `Sign in to claude-code on this host` as the fix.
- Readiness and the start gate name the credential that is missing and the command that supplies it (`Export ANTHROPIC_API_KEY …`) instead of `Authenticate claude-code in the staged runner environment` / `Review the configured runner, then retry.`
- The detection cache no longer rejects its own context key when a runner uses the `api-key` channel: the key names the channel, and the literal `api-key` tripped the credential-material heuristic, silently disabling caching for that runner.
- Every command now canonicalizes the project directory to the git toplevel, not only `start`. Run from `packages/web`, `doctor` no longer reports `config.missing`, `ps`/`status`/`last`/`resume`/`stats` no longer report an empty project, and `spec` no longer auto-creates a second `.splitbrief/config.yaml` plus a `.gitignore` inside the package directory. An explicit `--project` pointing inside a repository still prints the relocation warning; a bare subdirectory invocation relocates silently.
- A mistyped subcommand no longer starts a workflow named after the typo. A single bare operand that is not a registered command but is one edit from a short command name or two from a longer one (transposition counted as one edit) is rejected with `unknown command 'doctro' — did you mean 'doctor'?` and exit `1`. The bare-feature shorthand is untouched: `splitbrief "fix the typo"`, `splitbrief fix the typo`, and `splitbrief start doctro` all still run.
- `engines.node` is enforced at runtime. The CLI reads `process.versions.node` before parsing and refuses a Node older than 22 with `splitbrief requires Node.js 22 or newer; this process is Node.js <version>.`, instead of running and reporting a wrong diagnosis — on Node 20 the arg-vector preflight truncates its `--help` capture and blocks on flags the installed binary does support.
- Documented `kind: api` examples now load. `service` and `offering` were missing from the examples in CONFIGURATION.md, CONCEPTS.md, FEATURES.md and COST-AWARE-IMPLEMENTER-DIRECTION.md while the field table promised a catalog back-fill that has never existed, and the generic remote example taught `apiKey: env:VAR` — the one credential form a custom provider is refused. Every YAML fence in `README.md` and `docs/*.md` that names a top-level config key is now loaded through the real `loadConfig` by `testing/docs/configuration.test.ts`, whole configs as written and section fragments under a `version: 3` header, and every documented `kind: api` block is checked for the identity triple it cannot be inferred from.
- `docs/GETTING-STARTED.md` §8 no longer documents an always-visible `spent … proj … budget … cache …` status line that nothing renders. It describes the four surfaces that exist — the `/sidebar` footer, the Ctrl+G breakdown, the summary screen, and the budget gate — and `testing/docs/getting-started.test.ts` checks each name against the registry or threshold constant that produces it.
- A first run on a machine with no Ollama no longer prints `detectContextLength(ollama): fetch failed` to stderr before the UI appears. An unreachable provider endpoint is handled by falling back to the catalog, exactly as `fetchModelList` already treated it; readiness is where an unreachable implementer is reported. Diagnostics that are not connection failures still print, now credential-redacted.

### Added

- `splitbrief init --yes` writes the default config without the interactive picker, and `splitbrief init --project <dir>` targets a directory. Without a TTY, `init` previously refused with `use --json or --detach` — two flags it has never accepted — leaving CI, container builds and piped shells with no documented way to create a config.

### Changed

- Headless `--json` runs now exit non-zero for a **paused** or **applying** `pendingRecovery`, not only `awaiting-user` — a resume that does nothing no longer exits 0. The `recovery_required` record carries the `status` field (optional for older consumers), and the task loop publishes a transcript-safe `recovery_pending_unresolved` warning naming the reason, status, and available actions before stopping.

## [0.1.0] - 2026-08-01

First published release. The entries below describe how this version differs from the
unpublished pre-release layout that earlier sections of this file document.

### Breaking

- The tool is named SPLITBRIEF: the binary is `splitbrief` and project state lives in `.splitbrief/`.
- `.splitbrief/current/` removed; each session now lives in `.splitbrief/sessions/<id>/`. State schema bumped to v3.
- `events.jsonl` renamed to `session.jsonl`; entries are tagged with `kind: "event" | "message"`.
- `sessionId` on `WorkflowState` renamed to `plannerSessionId`.
- `kind: api` runners now require `service` and `offering`, declared explicitly. Nothing is back-filled at load: an admitted provider ID must match its catalog `service`/`offering`, and a custom provider declares its own.

### Added

- `PlannerCapabilities` struct declares backend features; `shell` and `agent` kinds support config override.
- Ctrl-C interaction model: single press aborts current turn (enters awaiting-continue); double press exits workflow.
- `workflowStore.messageQueue` for non-destructive mid-phase user messages; parallel native-session injection for Claude Code / agent-sdk backends.
- Slash commands `/revise-spec`, `/revise-plan`, `/redo-task`, `/queue show`, `/queue clear`.
- `workflow.persistTranscript` config option (default `true`).
- Clarification answers now reach the live planner session on capable backends (closes long-standing gap where answers only affected the next call).
- Auto-detect and display planner/implementer models in cost-savings footer.
- Session JSONL log at `.splitbrief/sessions/<id>/session.jsonl` with `kind: "event" | "message"` entries.
- `splitbrief resume` rebuilds planner context from `session.jsonl` on backends without native session resume.

### Changed

- Workflow transcript redesigned: one column model (glyph slot at column 0, content at column 2), full-width conversation with a 2-column sidebar gap, always-on activity batch headers with Capitalized labels (`Run`, `Read`, `Search`, …), and a conservative shell-command prettifier (`cat`/`sed`/`head`/`tail` → Read, `rg`/`grep` → Search, `ls` → List).
- Live stage status moved from the transcript into the composer byline (braille spinner on unicode terminals). Scroll counts now render on the chrome dividers, and question prompts render as a bordered panel above the composer instead of replacing the transcript.
- CLI runners express automatic model selection by omitting `model`; `auto` is no longer a model ID and is rejected at config load with `model "auto" is not a model ID; omit model to use automatic selection`.

### Fixed

- `splitbrief resume` now correctly handles `awaitingContinue` state.

## 2026-04-20 — EventBus architecture

Unified `EventBus` replaces every per-call-site callback. The workflow hook
system, repo-map planner context, OpenTelemetry integration, and a headless
`--json` mode all ride on top of the same bus. Design rationale is folded into
the subsystem docs (`ARCHITECTURE.md`, `HOOKS-CONFIG.md`, `REPOMAP.md`,
`OTEL.md`) rather than kept in separate ADRs.

### Added

- **EventBus** — single typed `EngineEvent` discriminated union (50 variants); engine emits via `bus.publish()` and UI/persistence/hooks subscribe as sinks. Replaces ad-hoc `callbacks.onEvent` + direct `appendEvent` calls. ([ARCHITECTURE.md §Design decisions](docs/ARCHITECTURE.md))
- **Hook system** — 11 workflow lifecycle hooks (`pre_task`, `post_commit`, etc.). Shell-spawned commands (`kind: "command"`) and in-process JS modules (`kind: "module"`). Trust prompt + `--allow-hooks` flag for CI. 2 built-ins: `prettier-on-change`, `block-secrets`. ([HOOKS-CONFIG.md](docs/HOOKS-CONFIG.md))
- **Repo-map context** — Aider-style codebase symbol summary auto-injected into the planner. Tree-sitter parsing, PageRank ranking, SQLite cache. ([REPOMAP.md](docs/REPOMAP.md))
- **Headless `--json` mode** — `splitbrief start --json "..."` and `splitbrief resume --json` emit each EngineEvent as NDJSON to stdout. TUI render skipped. Auto-approves workflow review gates; file-write sticky/confirm approvals fail closed unless configured or granted.
- **OpenTelemetry sink** — opt-in (`otel.enabled: true`) span emission for workflow lifecycle, phases, and tasks. Per-cost attributes. Users register their own exporter. ([OTEL.md](docs/OTEL.md))
- **`/repomap rebuild`** slash command — clears the SQLite cache.
- **`pre_planning` hooks** — fire before planner phases.

### Changed

- `OrchestratorCallbacks.onEvent` removed. Engine no longer accepts inline event callbacks; subscribe to the bus instead.
- `Planner.plan()` and `Planner.quickPlan()` signatures gain optional `codebaseContext?: string` parameter.
- Validator pipeline (`tsc → lint → test`) now fires `pre_validation` / `post_validation` hooks.
- Per-task git commit fires `pre_commit` (can deny) / `post_commit` (informational) hooks.
- Config schema (`.splitbrief/config.yaml`) now supports optional `hooks`, `codebase`, `otel` top-level blocks.

### Removed

- `OrchestratorEvent`, `OrchestratorEventPayloadMap`, `SessionLogEventEntryFor` legacy types (superseded by `EngineEvent`).
- Legacy `appendEvent` (use `appendEngineEvent` instead).
- `TuiEvent` and the `engine→features` bridge sink (renderers now consume `EngineEvent` directly).
- `OrchestratorCallbacks.onEvent` field.

### Architecture

- 0 `engine → features` imports (was the layer violation rationale for the whole 2026-04-20 release).
- 7 grep gates enforced pre-merge: `callbacks.onEvent`, `OrchestratorEvent`, `from features in engine`, `throw new Error in engine`, barrel `index.ts`, `TuiEvent`, `features/workflow/types`. All return 0.
- Full test suite green; typecheck and lint clean.

### Amendments beyond original plan

- **OpenTelemetry sink** — added as the third EventBus sink (opt-in via `config.otel.enabled`). Span hierarchy: `splitbrief.workflow` → `splitbrief.phase.<name>` → `splitbrief.task`. Bring-your-own `TracerProvider`; a console-exporter shortcut is available via `SPLITBRIEF_OTEL_EXPORTER=console` or `--otel-exporter console` for local debugging. (`src/core/schemas/otel.ts`, `src/engine/events/sinks/otel.ts`)
- **Headless mode (`--json`)** — no-TUI execution, NDJSON `EngineEvent` stream on stdout, review-gate auto-approval, empty clarification answers, fail-closed tiered approvals unless configured or granted. Pairs with `--allow-hooks` for non-interactive CI. (`src/cli/headless.ts`, `src/engine/events/sinks/stdout-json.ts`)
- **tuiSink redesign** — because `TuiEvent` and `src/features/workflow/types.ts` were deleted outright, the planned `EngineEvent → TuiEvent` mapper became vestigial. `createTuiSink()` is now a thin pass-through that returns `actions.addEvent`; the workflow store consumes `EngineEvent` directly. (`src/features/workflow/tui-sink.ts`)
- **Test suite cleanup** — a follow-up audit against `docs/TESTING.md` turned up tests that verified implementation details rather than behavior (sibling `vi.mock('./...')` calls, `toHaveBeenCalled` spies on private helpers, sharded store tests, trivial wrapper hook tests). All were rewritten in behavior style or deleted.

### Migration notes

Existing `.splitbrief/config.yaml` files work unchanged — all new top-level blocks (`hooks`, `codebase`, `otel`) are optional. See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the full 2026-04-20 breaking-change reference.

## Earlier migrations

### models.dev as primary catalog

SPLITBRIEF treats [models.dev](https://models.dev) as the primary model catalog and pricing source. README §Models documents the user-facing contract; the notes below capture the behavior details that used to live in a standalone migration doc.

**Precedence** (first hit wins):

1. `models.dev`
2. Runtime provider detection / CLI discovery
3. Bundled offline fallback manifest

**Behavior:**

- CLI tools and subscriptions stay unpriced. We no longer proxy-price `claude-code`, `codex`, `copilot`, `opencode`, `kilo-code`, or `aider` through upstream APIs.
- Claude Code uses tool-native aliases: `auto`, `sonnet`, `opus`, `opusplan`. **Superseded in 0.1.0** — `auto` is no longer a model ID; automatic selection is expressed by omitting `model`.
- Legacy stored `claude-code: default` still works and normalizes to `auto`. **Superseded in 0.1.0** — it normalizes to the omission instead.
- `opencode` and `kilo-code` should usually stay on `auto`; configure the real model in the tool itself. **Superseded in 0.1.0** — leave `model` unset instead.
- `models.dev` prices are already expressed in USD per 1M tokens. Do not multiply them again.
