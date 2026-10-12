# Changelog

> Entries below `[Unreleased]` describe earlier versions. They name commands, config keys
> and documents that have since been removed; the current surface is what the user guides
> under `docs/` describe.

## [Unreleased]

### Added

- **npm package.** SPLITBRIEF ships as the `splitbrief` npm package with provenance, and the package includes the user guides.
- **One planning session with a typed plan.** Every run plans in one session. Before the plan, the planner may ask up to three questions per round, for at most two rounds, each with a default; an empty `⏎` takes the defaults. The planner then answers with one typed plan. SPLITBRIEF checks it and writes it as `plan.json`, rendered as `plan.md` and `tasks.md`. A plan that fails its checks goes back to the planner once, and a second failure halts the run. `splitbrief spec` runs the same session without a build. See [The planning session](./docs/WORKFLOW.md#3-the-planning-session).
- **The plan card.** One approval before the build: **Approve plan**, **Request changes**, **Edit plan.json** (checked before it saves) or **End run**. Approving the plan also confirms the protected writes that it lists, and the card names them. A headless run approves the card unattended.
- **One workspace per run, applied once.** Every brief, retry, check and review of a run uses one worktree or staged copy. A passing review makes the result ready to apply, and the result menu offers **Apply**, **Show diff** and **Discard**. Apply merges your own checkout edits first, checks and reviews a changed result again, then writes with a hash guard and a backup. A conflict halts for per-file resolution, and a partial write offers restore or retry. Discard and End run keep `run.patch`. See [Apply](./docs/WORKFLOW.md#apply).
- **Checkout mode.** `workflow.isolation: none` ("your checkout") lets the implementer edit your checkout directly. Checks and review run there, and a passing review closes the run with no Apply. An edit between calls is a warning, a git write during a call halts the run, and every revert first saves the bytes it replaces. Settings cycles *Isolation* through worktree, staged copy and your checkout. For a stack that the worktree cannot serve, readiness recommends `none`.
- **Consults instead of fixed escalation tiers.** A brief that fails after its one local retry, reports `blocked`, or has stale inputs gets one read-only consult: guidance and a retry, a rewrite, a split into 2–4 subtasks, a check-only verification, or one question to you. A plan task consults the planner; a fix task consults the reviewer. Consults and attempts are bounded per brief and per run. A spent bound halts the run, and **Continue** grants more, with your note.
- **The decisions ledger.** An implementer can report where it departed from its brief. The planner confirms the change, and the confirmed decisions reach every later brief, consult and review.
- **The reviewer chooses the reviewer checks.** Before each review, the reviewer reads the project and chooses up to six commands (`V1`, `V2`, …), each with a reason. SPLITBRIEF runs them in the run workspace, in any language: for example `mvn test`, `gradle test`, `composer test`, `bundle exec rspec`, `make check`, `dotnet test` and `mix test`. The reviewer command policy refuses shell syntax, programs run by path, inline code, download launchers, setup commands and a script that this run changed; each refusal has a named row. `validation.end_checks` (Settings: *End-of-run checks*, default on) turns the reviewer checks on or off. See [Reviewer checks](./docs/CONFIGURATION.md#reviewer-checks).
- **`validation.approve_checks: ask | auto`** (Settings: *Approve checks*, default `auto`). With `ask`, one card shows the chosen commands and their reasons before any runs: **Run all** or **Skip all**. A skipped check is never a pass.
- **Pre-existing failures are told apart.** A red reviewer check runs again on a copy of the run base. A failure that is red there too is reported as pre-existing and starts no fix. A failure that the base cannot compare, such as a timeout or a red that names no failing test, reads *not verified at the run base*, and the reviewer decides.
- **A fix check answers only its own failures.** A fix task runs the red check it answers again. It passes when its own failures are gone, also when unrelated failures remain: `Fix check V1 · npm test · your 2 failures gone · 3 others left`.
- **`render` checks.** `validation.render` runs a render command for a plan's `render` check. The screenshots are saved with the session and go to the reviewer as images when its seat can take them. A required check that cannot run halts the run instead of reaching the review. Every check run is recorded in `evidence.json` and in the review's Checks Log.
- **Seat fallbacks.** A seat can declare `fallback: { tool, model?, effort?, variant? }`, chosen in Settings › Fallback. When a seat goes down on an account refusal or a long usage-limit reset, the run moves the seat to its fallback, once per run and seat. A headless run decides with `--on-seat-down halt|switch`. `splitbrief doctor --probe-seat <plan|build|review>` checks one seat with one real call.
- **Seat trouble is retried before a halt.** A transient failure is retried up to three times with backoff, and a usage-limit reset up to 10 minutes away is waited for, also across a resume.
- **Messages to the active seat.** Type a message and press Enter to queue it for PLAN, BUILD or REVIEW; the seat reads it at its next break. `ctrl+⏎` or `/steer <text>` stops the current call and continues with your text. Claude Code and OpenCode can take a message during a call. See [Input footer](./docs/FEATURES.md#input-footer).
- **Two halts.** Every recovery is one of two halts, **Needs you** or **Seat down**, and offers only the actions that fit its cause.
- **Runs are durable records.** A run is running, waiting for you, stopped, ready to apply or closed. Any open run continues with `splitbrief continue`, `/resume` or a bare `⏎`; only Apply, Discard or End run close it. Opening a run from `/sessions`, home or the palette shows its history on the run screen.
- **`splitbrief continue <id> --action <action>`** answers a recovery with no terminal attached: `skip`, `retry`, `switch-seat:<tool>[:<model>][@<word>]`, `end-run`, `apply`, `discard` or `restore`. It exits 1 while the run stays blocked, and 2 when the value names no recovery action.
- **Accept as is** for a failed final review, on every run. A checkout run closes; a worktree or staged-copy run becomes ready to apply with the open findings, and Apply asks once.
- **The stop sheet.** On the workflow screen, `esc` opens Stop options: **Stop now**, **Pause after this brief** and **End run**. No option reverts files, and your draft is kept.
- **Build progress block.** While briefs run, a block under the header shows the passed briefs of the total, what the seat is doing, the attempt number from the second attempt, and how long ago the seat last reported.
- **`--plain` output.** A headless run with `--plain` prints one plain-text line per phase. `--json` emits the NDJSON event stream.
- **Cursor Agent CLI (`cursor`), Command Code (`command-code`) and Antigravity (`agy`)** are supported CLI tools.
- **Skills for every seat.** `--skills <ids>` on `start`, `resume` and `continue`, or `/skills`, attaches project or global skills. Every seat call carries them.
- **An `on_halt` hook event**, fired when a run stops for recovery; `${event.resumeCommand}` substitutes into a hook's arguments.
- **Runtime commands** `/tasks`, `/resume`, `/end`, `/diff`, `/run accept|reject` and `/image`.
- **`@file` inputs may name a file anywhere:** an absolute path, a path relative to the project, or `~/…`. A missing, oversized or unreadable input stops `start` with one error that names every refused input and its fix.
- **Stack detection** for TypeScript, JavaScript, Python, Go and Rust. `validation.stack` pins a stack.
- **Typed seat answers.** Plans, reviews, consults and implementer reports are JSON answers that SPLITBRIEF validates, through each tool's native schema flag where it has one.

### Changed

- **Scope is guidance.** A brief's files are suggestions. The implementer may edit another ordinary project file that the change needs, and SPLITBRIEF records it. Only a protected path asks: dependency manifests and lockfiles, `.git` and `.splitbrief`, CI configuration, and env or key files. It asks once per path per run.
- **The retry ladder is attempt → one retry → consult.** `workflow.max_retries` is retired.
- **`workflow.approve` is `plan | none`** (default `plan`). Retired keys load with one notice each and are ignored: `workflow.mode`, `workflow.task_review`, `workflow.brief_review`, `workflow.speckit`, `workflow.max_retries`, `approval.enabled`, `approval.tiers`, the `escalation` block, `validation.typecheck`, `validation.lint`, `validation.test`, `validation.typecheck_command` and `validation.lint_command`.
- **A seat call has no default time limit.** No subprocess seat has a default total timeout or idle cut. The watchdog warns after 5 minutes without output, and the build block reads `No output for m:ss`. `timeout` and `idleKillMs` stay as opt-in limits; two cuts in a row halt the run as *Seat down*. `api` seats keep their deadlines.
- **The validation timeout defaults to one hour** (`validation.timeoutMs`), so a long reviewer check of a large repository can finish.
- **Checks inherit your environment without credentials.** Provider API keys, cloud credentials, tokens, SSH sockets and Git credential helpers stay out; project settings such as `NODE_OPTIONS` and `DATABASE_URL` stay. See [What a check can reach](./docs/CONFIGURATION.md#what-a-check-can-reach).
- **SPLITBRIEF's own git calls keep only the git variables that reach a remote or a checkout filter:** protocol, SSH, askpass, proxy, SSL and HTTP settings, and the Git LFS skip settings. Other `GIT_*` variables, such as `GIT_CONFIG_GLOBAL`, `GIT_TRACE` and `GIT_EDITOR`, and `EDITOR`, `VISUAL`, `PAGER` and `PREFIX` no longer reach them; put such a setting in your git config. See [What SPLITBRIEF's git calls receive](./docs/CONFIGURATION.md#what-splitbriefs-git-calls-receive).
- **The Claude Code implementer never runs unsandboxed.** A sandbox that cannot start stops the seat. On Linux, readiness names a missing `bwrap` or `socat` before the run starts.
- **An inline `shell` or `agent` runner asks for trust once more after this upgrade.** It no longer inherits the SPLITBRIEF environment; it gets its staged environment and the names in its `env` list. A headless run stays blocked until you confirm in a terminal or pass `--allow-repo-runners`.
- **Briefs are grouped by outcome, not by count.** One brief delivers one reviewable outcome with its tests, wiring and documentation, and a run may hold any number of briefs.
- **Staged-copy runs need no git.** A project without git no longer halts at its first brief. `splitbrief init` no longer writes `workflow.isolation`; unset reads `worktree`.
- **Old runs continue as one planning session.** A run that stopped at its spec, plan or briefs gate continues as one planning session that reads its earlier documents. A run saved before the typed plan and the run workspace still opens, but it loses the transcript rows of retired events (user edits, brief quality and readiness, pause selections) and its drift score.
- **One transcript, in time order.** Done, running and pending work reads in one scroller. A review row names its failed commands, failed checks and fix briefs. Event labels use sentence case; seat tags stay upper case.
- **One screen for a run, live or at rest.** The summary screen is gone. A stopped run stays on its run screen, and typing a correction continues it in place. A closed run shows a `Closed ─` block at the end of its transcript.
- **One name per seat on every surface.** `PLAN`, `BUILD` and `REVIEW` are the only seat words, and every surface names a seat as `<tool> · <model>` with the model's catalog label, for example `Claude Code CLI · Opus 5.5`.
- **Settings.** Crew is the first section of Settings, with one row per seat, and the same rows build the first-run Setup screen. Settings explains the row under the cursor. Ready-made crews are offered in Setup.
- **The tool and model picker.** Effort, speed and thinking variants of a model are one row that expands into one child per option; effort is chosen there and shown read-only everywhere else. Providers route inline and show their sign-in state. A tool that cannot list its models says so, and a model with no display name shows its catalog name.
- **Readable terminal colours.** Secondary text stays readable on dark and light terminals. The TUI follows the terminal background and uses no faint text.
- **Layout.** Panels take their width from the terminal size. The workflow screen aligns every left edge on one column, and the workflow composer and transcript stay full-width.
- **23 runtime commands in five categories.** `/crew` opens Settings on PLAN, and `/crew <seat>` opens that seat's picker. On a recovery panel, **Change PLAN tool** (or BUILD or REVIEW) opens that seat's picker.
- **Codex takes its prompt on stdin**, so a prompt over 120,000 bytes works. An expired Codex or Claude Code planner session continues once on a fresh session with the conversation so far.
- **CLI model lists keep a model through one missing read.** A model is added at once and removed only after two agreeing reads.
- **Flag precedence is stated.** `--planner`, `--implementer`, `--provider` and `--reviewer` help states that a CLI tool id always selects the CLI. A `--*-api-base` flag on a non-API seat warns and is ignored.
- Home shows no recent-sessions section when there are none.

### Removed

- Workflow modes (`quick`, `standard`, `speckit`, `instant`), the step chain (research, spec, clarify, constitution check, analyze), the spec and briefs gates, and the flags `--mode` and `--approve`.
- The hint rung and the intermediate escalation tier, with the `escalation` crew row and picker.
- Sticky approvals, `.splitbrief/approvals.json`, `splitbrief approval` and `--yolo`.
- Budget gates, cost prediction, savings figures and price-based implementer routing; `Ctrl+G` and `/cost`. Spend is reported as one plain figure when prices are known.
- The summary screen, the standalone Crew overlay and the mode selector.
- The runtime commands `/redo-task`, `/effort`, `/repomap`, `/attach`, `/detach`, `/mode`, `/revise-spec`, `/revise-plan`, `/approval`, `/compact-transcript`, `/export`, `/handoff` and `/yolo`, and the aliases `/config`, `/planner`, `/implementer`, `/reviewer`, `/accept-run` and `/reject-run`. Each name prints a pointer to its replacement for one release.
- The rollback of an interrupted brief on shutdown: partial changes are kept, and the session says where the run stopped.
- The `esc esc` interrupt ladder. `esc` opens the stop sheet, and `ctrl+c` stops a live run.
- **Breaking.** The `agent-sdk` runner kind; use `kind: api` against your own endpoint.
- **Breaking.** The `aider` CLI tool; choose another `cli` tool, or run Aider as a `shell` runner.
- **Breaking — subsystems.** Each is removed with its command, flags and config keys: the Task Brief compiler, brief recovery, detached runs (`splitbrief attach`, `detach`, `ps` and `--detach`), the RPC server (`--rpc`), the MCP server (`splitbrief mcp`), `splitbrief worktree` and `--worktree`, `splitbrief explain`, `splitbrief handoff`, `splitbrief export`, `splitbrief stats` and `status --history`, `splitbrief snapshot` and automatic snapshots, the planner estimate review, automatic splitting of an overflowing task, the session tree, the OpenTelemetry sink and `--otel-exporter`, and module hooks. A retired CLI name prints what replaced it.
- **Breaking — config keys.** These are load errors, and one load names every offending path: `workflow.persistTranscript`, `workflow.briefReview: rich`, `hooks.builtin`, `hooks.pre_compact`, a hook's `kind: module`, `approval.headless`, `approval.tiers.network`, `approval.tiers.validation`, `codebase.cacheDir`, `sessions.scope: global`, and the top-level `otel`, `snapshots`, `trust`, `plannerEstimateReview` and `autoSplitOverflow`. See [Removed config keys](./docs/CONFIGURATION.md#removed-config-keys). Without `approval.headless`, a run that has a reply channel is always asked.
- **Breaking — `--json` stream.** The `planner_heartbeat` event no longer carries `accumulatedTokens`.

### Fixed

- `splitbrief continue <run> --action end-run` closes any open run; a ready run closes as discarded and keeps `run.patch`.
- `splitbrief continue` on a closed run exits 1, with a JSON error under `--json`.
- Reject on a checkout run restores only the files that still hold what the run wrote, and names the files you changed since. It also works on a run that stopped or halted after a brief passed, and it refuses a closed run.
- A file that Reject recreates gets its recorded mode, and a folder that Reject, Apply or a restore recreates gets the normal mode, not owner-only.
- End run refuses an unfinished Apply until you restore or retry it.
- A closed run's byline offers only the commands that the run can still take.
- The `resume` and `continue` help lines tell the most recent run apart from a run named by id.
- A repository with a large ignored directory, such as a nested `node_modules`, no longer fails every run with `Maximum call stack size exceeded`.
- A failed final review takes a correction from the recovery panel or the composer.
- Stop keys and the first typed input work after you resume a stopped run on the same screen, and `/resume` and `/end` work at the plan card.
- A stop settles unfinished check rows as `stopped`, live and in a reopened run.
- No stop surface claims changes that a run never made, and a run ended at the plan card reads `nothing built`.
- A run whose final review passes as a stop arrives closes as complete, and End run during shutdown keeps a passed review.
- A pause between briefs names the next brief, for example `Paused before T003.`
- Ctrl+C presses that arrive together each count, and control bytes never go into the draft or a restored input history.
- Ctrl+C on a mouse selection copies once and shows its result.
- The header, sidebar and byline clocks agree, leave out waiting time, and spell a run past an hour as `1:15:03`.
- A seat that is thinking no longer reads as silent, and a silent seat is reported once, with one count.
- Claude Code retries, model fallbacks, refusals, denied tool calls and rate-limit warnings show as warning or error rows; its bookkeeping frames no longer reach the transcript.
- A direct implementer's narration shows once.
- A brief stopped inside any implementer continues with the partial output and your note.
- Stops, plan approvals and End run are recorded in `session.jsonl`.
- Your edits survive when a parked run reuses its worktree, and committed partial output in a kept worktree is still applied.
- The external-edit check tells safe edits outside the current brief from real conflicts, names the affected brief, and keeps its actions visible on small terminals. **End run** at that question closes the run at once.
- A correction typed at a parked plan card requests changes, and a corrected plan stays in effect after another stop.
- A closed run lists each brief once, with every attempt's retries.
- Hook trust covers what a hook actually runs: npm aliases and short forms, `pre` and `post` scripts, project files given to an interpreter, any letter case or version suffix of an interpreter, and a repository binary named by path. An affected hook asks for trust once more.
- A validation command that the planner suggests can no longer choose which repository code runs, and each refusal states its true reason.
- An explicit `auth_channel` that SPLITBRIEF cannot guarantee blocks at readiness instead of failing during the run.
- The Cursor Agent CLI `session` channel works on macOS, where the credential is a keychain item.
- OpenCode 2 lists its models in the picker again.
- A custom API provider whose name is also a CLI tool id keeps its own name, model, credential rules and context budget.
- A usage limit or sign-out on the final review or a consult halts on the seat that hit it and offers a seat switch. The error row names the reset time once.
- A headless halt names the `--action` that `splitbrief continue` can take.
- A checkout symlink that stays inside the project no longer stops briefs in the worktree.
- A FIFO in the project can no longer stall the final review, a hook check or the evidence ledger.
- An unreadable or newer saved state no longer stops a run before it can report itself, a run cancelled before its first save closes, and a saved rewind survives a stop.
- A run that fails on a repair or revision call records `failed` instead of `interrupted`.
- A runner picker save is one write and keeps a concurrent change on disk.
- The inline (non-fullscreen) TUI no longer repaints one row low.
- The slash-completion menu reads as one table, and a recovery menu row keeps its words whole on a narrow panel.
- File snapshots are flushed to disk before they replace the old file, and worktree removal checks that the path is the run's own.
- `--plain` no longer prints a `phase:` line for each streamed chunk of the final review, and review usage is counted on the reviewer.

## [0.1.0] - 2026-08-07

Initial release, installed from source. Everything in this section and the dated sections below it is what 0.1.0 contains.

### Fixed

- The repo map extracts symbols from Python, Go and Rust again. Each language now uses its own grammar package, which is also smaller, and Go type declarations are found.
- Readiness no longer headlines a missing, untrusted, incompatible, unauthenticated or unreachable runner with `Required action: Exit`; it names `Set up the configured runner`.
- The start gate names the tool and its install URL when a CLI is missing.
- `npm install -g splitbrief` no longer downloads and builds `node-pty`, which no shipped file uses.
- A cloned repository can no longer grant itself hook execution. Hook trust receipts live in `~/.splitbrief/trust/hooks.json` (mode `0600`), keyed by the checkout path. A receipt inside `.splitbrief/` is ignored: trust those hooks once more and delete the file.
- The hook trust prompt shows each hook's executable, its resolved path, its arguments and its trust boundary, with repository strings escaped. `--allow-hooks` writes the same disclosure to stderr.
- Multi-line trust disclosures keep their line breaks in the TUI approval prompt.
- Readiness no longer reports a CLI runner as authenticated because of files that the probe itself wrote.
- The Claude Code subscription `session` channel works on macOS, where the credential is a login-keychain item. It is the default on every platform again. On macOS it keeps your real `HOME` and `USER`, so the tool's reads and state writes reach your real home ([API-KEYS.md](./docs/API-KEYS.md)).
- Readiness never infers a keychain login from directory contents; it runs the tool's own status command.
- Readiness and the start gate name the missing credential and the command that supplies it, for example `Export ANTHROPIC_API_KEY …`.
- The detection cache works for a runner on the `api-key` channel.
- Every command resolves the project to the git top level, so running from a subdirectory such as `packages/web` no longer reports a missing config or creates a second `.splitbrief/`.
- A mistyped subcommand no longer starts a workflow named after the typo: `unknown command 'doctro' — did you mean 'doctor'?`. `splitbrief "fix the typo"` still runs.
- SPLITBRIEF refuses a Node.js older than 22 with a clear message.
- The documented `kind: api` examples load, with `service` and `offering`.
- `docs/GETTING-STARTED.md` describes only the spend surfaces that exist.
- A Task Brief quality failure in a headless run no longer loops: the planner regenerates the briefs once, and a second failure stops with every issue named.
- A first run on a machine without Ollama no longer prints `detectContextLength(ollama): fetch failed`.

### Added

- **The final review is its own seat.** An optional `reviewer:` block names the runner that reads the run diff, so a model from another lab can review the build. Without it, the planner reviews, as before. Nine `--reviewer-*` flags and `/reviewer` select it. *Superseded:* `/reviewer` is now `/crew review`.
- **`/crew`** shows every seat of the run at once and opens a seat's picker; ready-made crews set all three seats in one save. *Superseded:* crew is now the first section of Settings, and the escalation row is gone.
- `splitbrief init --yes` writes the default config without the picker, and `--project <dir>` targets a directory.

### Changed

- Headless `--json` runs exit non-zero for a paused or applying recovery, and the `recovery_required` record carries its `status`.

## 2026-08-01 — naming and session layout

The entries below describe how the tree changed from the earlier pre-release layout that the sections after this one document.

### Breaking

- The tool is named SPLITBRIEF: the binary is `splitbrief`, and project state lives in `.splitbrief/`.
- `.splitbrief/current/` is removed; each session lives in `.splitbrief/sessions/<id>/`. The state schema is v3.
- `events.jsonl` is renamed to `session.jsonl`; entries are tagged `kind: "event" | "message"`.
- `kind: api` runners require `service` and `offering`.

### Added

- `shell` and `agent` runners can override the planner capabilities in config.
- Ctrl-C: one press stops the current turn; a second press leaves the workflow.
- Messages typed during a phase are queued, and Claude Code receives them in its live session.
- Slash commands `/revise-spec`, `/revise-plan`, `/redo-task`, `/queue show` and `/queue clear`.
- `workflow.persistTranscript` (default `true`).
- Clarification answers reach the live planner session on tools that support it.
- The planner and implementer models show in the footer.
- The session log `.splitbrief/sessions/<id>/session.jsonl`.
- `splitbrief resume` rebuilds the planner context from `session.jsonl` for tools without native session resume.

### Changed

- The workflow transcript is redesigned: one column model, a full-width conversation beside the sidebar, activity headers (`Run`, `Read`, `Search`, …) and readable shell commands.
- Live status moved into the composer byline, and questions show as a panel above the composer.
- Automatic model selection on a CLI runner means omitting `model`; `model: auto` is rejected at load.

### Fixed

- `splitbrief resume` handles a run that waits for Continue.

## 2026-04-20 — event stream, hooks and repo map

### Added

- **Workflow hooks** — 11 lifecycle hooks (`pre_task`, `post_commit` and others), as shell commands or JavaScript modules, with a trust prompt and `--allow-hooks` for CI. Two built-in hooks: `prettier-on-change` and `block-secrets`. ([HOOKS-CONFIG.md](./docs/HOOKS-CONFIG.md))
- **Repo map** — a symbol summary of the codebase goes to the planner, built with tree-sitter and PageRank and cached in SQLite. ([REPOMAP.md](./docs/REPOMAP.md))
- **Headless `--json` mode** — `splitbrief start --json "..."` and `splitbrief resume --json` print every engine event as NDJSON on stdout, without the TUI. Review gates are approved unattended; file-write approvals fail closed unless configured or granted.
- **OpenTelemetry sink** — opt-in spans for the workflow, its phases and tasks (`otel.enabled: true`). *Since removed.*
- The `/repomap rebuild` slash command clears the repo-map cache.
- `pre_planning` hooks fire before planner phases.

### Changed

- The validation pipeline fires `pre_validation` and `post_validation` hooks.
- The per-task git commit fires `pre_commit` (which can deny) and `post_commit` hooks.
- The config accepts optional `hooks`, `codebase` and `otel` blocks; existing configs work unchanged. See [MIGRATION.md](./docs/MIGRATION.md).

## Earlier changes

### models.dev as primary catalog

SPLITBRIEF treats [models.dev](https://models.dev) as the primary model catalog and pricing source. The order is models.dev first, then runtime provider detection and CLI discovery, then the bundled offline list.

- CLI tools and subscriptions stay unpriced.
- Claude Code uses its own aliases, such as `sonnet` and `opus`. *Superseded in 0.1.0:* automatic selection means omitting `model`.
- `opencode` and `kilo-code` should leave `model` unset and configure the model in the tool itself.
- models.dev prices are in USD per 1M tokens.
