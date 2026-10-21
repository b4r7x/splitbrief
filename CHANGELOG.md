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
- **Private vulnerability reports.** The security policy describes how to report a vulnerability privately through GitHub.

### Changed

- **Supported Node.js versions.** SPLITBRIEF supports Node.js 22 and Node.js 24, and the package declares that range.
- **Scope is guidance.** A brief's files are suggestions. The implementer may edit another ordinary project file that the change needs, and SPLITBRIEF records it. Only a protected path asks: dependency manifests and lockfiles, `.git` and `.splitbrief`, CI configuration, and env or key files. It asks once per path per run.
- **The retry ladder is attempt → one retry → consult.** `workflow.max_retries` is retired.
- **`workflow.approve` is `plan | none`** (default `plan`). Retired keys load with one notice each and are ignored: `workflow.mode`, `workflow.task_review`, `workflow.brief_review`, `workflow.speckit`, `workflow.max_retries`, `approval.enabled`, `approval.tiers`, the `escalation` block, `validation.typecheck`, `validation.lint`, `validation.test`, `validation.typecheck_command` and `validation.lint_command`.
- **A seat call has no default time limit.** No subprocess seat has a default total timeout or idle cut. The watchdog warns after 5 minutes without output, and the build block reads `No output for m:ss`. `timeout` and `idleKillMs` stay as opt-in limits; two cuts in a row on one brief halt the build as *Seat down*. `api` seats keep their deadlines.
- **The validation timeout defaults to one hour** (`validation.timeoutMs`), so a long reviewer check of a large repository can finish.
- **Checks inherit your environment without credentials.** Provider API keys, cloud credentials, tokens, SSH sockets and Git credential helpers stay out; project settings such as `NODE_OPTIONS` and `DATABASE_URL` stay. See [What a check can reach](./docs/CONFIGURATION.md#what-a-check-can-reach).
- **SPLITBRIEF's own git calls keep only the git variables that reach a remote or a checkout filter:** protocol, SSH, askpass, proxy, SSL and HTTP settings, and the Git LFS skip settings. Other `GIT_*` variables, such as `GIT_CONFIG_GLOBAL`, `GIT_TRACE` and `GIT_EDITOR`, and `EDITOR`, `VISUAL`, `PAGER` and `PREFIX` no longer reach them; put such a setting in your git config. See [What SPLITBRIEF's git calls receive](./docs/CONFIGURATION.md#what-splitbriefs-git-calls-receive).
- **The Claude Code implementer never runs unsandboxed.** A sandbox that cannot start stops the seat. On Linux, readiness names a missing `bwrap` or `socat` before a run with that implementer starts. `splitbrief spec` and `splitbrief review` do not need them.
- **An inline `shell` or `agent` runner asks for trust once more after this upgrade.** It no longer inherits the SPLITBRIEF environment; it gets its staged environment and the names in its `env` list. A headless run stays blocked until you confirm in a terminal or pass `--allow-repo-runners`.
- **Briefs are grouped by outcome, not by count.** One brief delivers one reviewable outcome with its tests, wiring and documentation, and a run may hold any number of briefs.
- **Staged-copy runs need no git.** A project without git no longer halts at its first brief. `splitbrief init` no longer writes `workflow.isolation`; unset reads `worktree`.
- **Old runs continue as one planning session.** A run that stopped at its spec, plan or briefs gate continues as one planning session that reads its earlier documents. A run saved before the typed plan and the run workspace still opens, but it loses the transcript rows of retired events (user edits, brief quality and readiness, pause selections) and its drift score.
- **One transcript, in time order.** Done, running and pending work reads in one scroller. A review row names its failed commands, failed checks and fix briefs. Event labels use sentence case; seat tags stay upper case.
- **One screen for a run, live or at rest.** The summary screen is gone. A stopped run stays on its run screen, and typing a correction continues it in place. A closed run shows a `Closed ─` block at the end of its transcript.
- **One name per seat on every surface.** `PLAN`, `BUILD` and `REVIEW` are the only seat words, and every surface names a seat as `<tool> · <model>` with the model's catalog label, for example `Claude Code CLI · Opus 5.5`.
- **An inherited review seat reads `REVIEW = PLAN`** on home, in Setup and Settings, in the picker and in the workflow.
- **Claude Code model aliases follow the current Claude Code CLI models.**
- **Settings.** Crew is the first section of Settings, with one row per seat, and the same rows build the first-run Setup screen. Settings explains the row under the cursor. Ready-made crews are offered in Setup.
- **The tool and model picker.** Effort, speed and thinking variants of a model are one row that expands into one child per option; effort is chosen there and shown read-only everywhere else. Providers route inline and show their sign-in state. A tool that cannot list its models says so, and a model with no display name shows its catalog name.
- **Readable terminal colours.** Secondary text stays readable on dark and light terminals. The TUI follows the terminal background and uses no faint text.
- **Layout.** Panels take their width from the terminal size. The workflow screen aligns every left edge on one column, and the workflow composer and transcript stay full-width.
- **23 runtime commands in five categories.** `/crew` opens Settings on PLAN, and `/crew <seat>` opens that seat's picker. On a recovery panel, **Change PLAN tool** (or BUILD or REVIEW) opens that seat's picker.
- **Codex takes its prompt on stdin**, so a prompt over 120,000 bytes works. An expired Codex or Claude Code planner session continues once on a fresh session with the conversation so far.
- **CLI model lists keep a model through one missing read.** A model is added at once and removed only after two agreeing reads.
- **Flag precedence is stated.** `--planner`, `--implementer`, `--provider` and `--reviewer` help states that a CLI tool id always selects the CLI. A `--*-api-base` flag on a non-API seat warns and is ignored.
- Home shows no recent-sessions section when there are none.
- Show diff keeps less open on its own screen with its `Press q to return.` prompt, also when `LESS` or `PAGER` sets `-e`, `-E`, `-F`, `-m`, `-M` or `-X`.
- **How long a run ran is stated once, when it closes.** The workflow header and sidebar no longer show a clock for the whole run. A closed run states how long it ran in its Run section, for example `Ran 1m 51s`. Time the run sat stopped, halted or at rest is left out, and time it waited on you while it ran counts. A run recorded before this release reads `Ran not recorded`.
- Ctrl+Delete and Alt+Delete in the composer and other text fields delete the word after the caret, as in the plan.json editor. Before, they deleted the word before it.
- When a brief fails again, the planner or reviewer now sees every change the brief made since it started and one line for each earlier failed attempt, not only the latest attempt.
- With `review: task`, each task review first runs again the required checks of the briefs it covers and of the criteria due at that review. A later brief that breaks an earlier brief's check is now found at that task review, not only at the final review. A run takes longer by these checks.
- `continue --action restore` says how many files it put back in your checkout, works without a terminal, and leaves the run ready to apply.
- A headless run stopped by Ctrl+C, SIGTERM or a closed terminal exits with code 130, 143 or 129 and prints the command that continues it.

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

- Cursor Agent CLI on Linux reads as signed in after `cursor-agent login`, and a token it refreshes during a run is kept in your own sign-in file.
- After Show diff opens the patch in less or in your editor in fullscreen mode, the line that says how to return no longer stays in your shell after SPLITBRIEF exits.
- OpenCode 2 signed in with `opencode auth login` now reads as signed in. Before, the model picker marked its `opencode/…` models `needs sign-in`, and a run on them did not start, with "OpenCode CLI is not signed in". Its models on the other providers it is signed in to now read `signed in · stored credential` instead of `available`.
- Session options, the command palette, help and `/` completion no longer offer End run while an Apply is unfinished; restore or retry Apply first.
- When a run continues into Apply, the header keeps Plan, Build and Review marked done and adds the Apply stage: `✗ Apply` while an Apply halt waits for you, and Apply as the current stage while Apply runs. Before, the header showed `○ Plan → ○ Build → ○ Review`, as if the run had not started.
- After **Re-run Apply** or **Restore backup** on an Apply halt, the transcript shows one Recovery row, such as `Recovery  Re-run Apply → continued`, then `Run continued`. Before, it split the choice and its outcome into two Recovery rows and named **Re-run Apply** as *Try again*.
- **Re-run Apply** finishes after an Apply was cut off and its re-run stopped part way. Before, the next **Re-run Apply** stopped with an error, and **Restore backup** followed by Apply could write leftover temporary files into your checkout.
- Backspace in the plan.json editor deletes the character before the caret, and Alt+Backspace or Ctrl+Backspace the word before it, as in the composer. Before, they deleted forward.
- A test check that names a command instead of a test file now goes back to the planner or the reviewer for one correction before any brief runs. Before, such a check in a fix brief could not run, and the run stopped at the final review with only End run to get out.
- A run started with `--allow-repo-runners` keeps the grant when you stop it and continue it while SPLITBRIEF stays open (Resume, `⏎`, `/resume` or `/sessions`), instead of being blocked by the trust policy. When a repository-local runner is blocked, the message now names the command to run again with `--allow-repo-runners`: `splitbrief start`, `continue`, `spec` or `review`.
- A consult after a very large change no longer sends the whole diff, which a tool could refuse with "Prompt is too long". The planner, or the reviewer for a fix brief, now sees the diff of the brief's own files up to 40,000 characters, so many generated files no longer push the brief's own code out of view. The consult names the files it cuts or leaves out, and the other files the brief changed, the first 20 and then a count, for the seat to read in the run workspace. When a run's planner tool refuses to resume its conversation as too long, SPLITBRIEF asks once more on a fresh conversation that carries the conversation so far. When the tool still refuses the call, the halt no longer offers Try again, and it recommends a seat switch when another tool or model is ready for the seat.
- Try again on a brief that halted after it ran restarts the brief at once. The brief's own files no longer read as a change someone else made, so no consult is spent on them. A file the brief creates still reads as created, and a later restore takes that file back. Before, Try again first asked about the brief's own files as if someone else had changed them.
- In the runner picker, a route row names the account the route runs through, the same provider that its sign-in state and its sign-in command name. An OpenCode model listed as `openrouter/deepseek/…` reads `openrouter`, a Kilo Code gateway model reads `kilo`, and a GitHub Copilot route reads `github-copilot`. Before, the row named the model's maker, such as `deepseek`, beside the sign-in state of another account.
- Saving a custom model, typed or from its saved row, on a provider that needs a sign-in now adds the same sentence and command to the save message as a route does: `OpenCode CLI has no credential for anthropic — run opencode auth login anthropic before start`. This holds for a seat and for its fallback.
- Skip on a halted brief takes back the files that brief wrote, so the final review, the run's file list and Apply no longer carry them. The same holds for a brief that a `pre_task` or `pre_validation` hook skips.
- A Kilo Code seat now names the provider its model runs through (`via github-copilot`, `via openai`, `via kilo`) in Setup, Settings, the home crew, the workflow header and sidebar, and the save message, as an OpenCode seat does, so two routes of one model no longer read the same.
- A check whose npm, yarn or bun script calls a program that is not installed now reads not run and names that program, such as `sh: mocha: command not found`, instead of saying that the package manager is not found. The halt that follows says to install what is missing, then run the checks again.
- While Apply writes to your checkout, the run screen says `Applying to your checkout` with a clock and marks Apply as the current stage, and the sessions list shows the run as running. In the window that runs Apply, Esc, Enter and `/home` wait until Apply finishes before they go home, Ctrl+C and `/quit` wait before they quit, and the screen says so; a halted Apply keeps you on the run and shows the halt. Other commands in that window run at once: `/resume`, `/steer`, `/end` and `/run` say `Apply is still writing to your checkout.`, `/stop` says `Nothing to stop: Apply finishes on its own.`, and the sessions list opens no run until Apply finishes. Another window that opens the run meanwhile says `Running in another process`, and Esc, Enter and `/home` go home at once. Before, the screen said `Stopped at Apply · ⏎ to continue`, the sessions list said `ready to apply` while files were still being written, a typed command could wait silently behind Apply, and leaving could cut Apply off.
- A save message on the home screen that names a sign-in step now shows whole, command included, on up to four rows, and stays long enough to read it. While it shows, the home screen keeps your crew and the count of more sessions in view.
- A save message that wraps in Settings or Setup no longer starts its next row with a space.
- End run on a run that stopped before its first brief no longer says that the files it wrote are still on disk.
- In the model picker, typing the name a model row shows now finds that row, also for a custom model whose id is spelled differently, such as `anthropic/claude-haiku-4-5` shown as Claude Haiku 4.5.
- A halt answered with **Skip task** (also after the brief wrote files), **Try again** with a note, **Fix again** with a note or **Send a correction** now shows one Recovery row, such as `Recovery  Skip task → skipped`, with your note after it. Before, one choice could show as two Recovery rows with another row between them.
- The warning that names the files a halt or a skip took back now counts them correctly, such as `Restored 1 failing task change`, and no longer says "after recovery" before you choose one.
- After you pick a new tool for a seat that halted, the screen no longer says `Finishing T<id>` and `Pause requested; no next brief will start`. When you save a setting that changes no seat while a brief runs or a halt waits, the screen no longer says this, and the run no longer stops at the end of the brief to check your tools again.
- Skip review no longer counts your note as an open finding: the Apply warning shows it once as your note, and a finding that ends with a period no longer shows two. A run whose final review passed after a skipped task review applies without asking for confirmation, and its Review stage shows a failed final review as failed.
- When OpenCode or Kilo Code is signed in to other providers, a fallback on a model that the picker marks `needs sign-in` now shows `needs sign-in` in Settings › Fallback. A signed-out or out-of-quota seat no longer moves to it by itself and halts a second time.
- The workflow sidebar keeps the OpenCode CLI name in a long seat identity: the tool, the model, and the route with its effort each take a row. On a short terminal each seat takes one row, and the crew never paints over the sidebar's bottom border.
- A long message in the composer stays inside its frame: no line runs into the right edge, every wrapped line starts at the same column, and ctrl+a moves to, and ctrl+u deletes back to, the start of the line you see.
- A check that did not run no longer shows an empty slot where its command goes, in the transcript, the build progress, the input footer and the stop menu: `Plan check K4 · not run · no affected test file found`.
- A slash command typed under a recovery menu, or in a reply to the planner or the reviewer, opens the command list as it does elsewhere. While the list is open, Tab fills in the highlighted row and keeps you in the composer. Once the list closes, the recovery menu reads `⏎ runs the command · tab back to the actions`. Before, no command list opened, and the menu said ⏎ would retry or continue with your text as the correction, though ⏎ ran the command.
- In the runner picker, over Setup and in Settings, a tool that is not installed or not signed in gives one short remedy that ends on the picker's own recheck: `Sign in to OpenCode CLI, then ctrl+r.` When its model listing timed out or failed for another reason, the failure follows on the row under the remedy, such as `Model detection timed out`, with no second `ctrl+r`. Before, the remedy said to run `splitbrief doctor` again, which names no tool before a crew is saved, and a failed listing hid the sign-in step.
- With `workflow.isolation: none`, `splitbrief doctor` and the readiness checks say that BUILD edits this checkout, or that SPLITBRIEF applies the edits BUILD returns to this checkout. Before, they said that BUILD edits files in the run workspace.
- A run whose Apply you undid with `/run reject confirm` reads `apply undone` in Sessions, the recent runs on home and the command palette, as its closed block does, and session search finds it by that word. `/run accept` on it reads `Apply already undone; the run is closed.`, and `splitbrief continue` names it `closed (undone)`. Before, these surfaces still called the run `applied`.
- A model route that OpenCode refuses halts at once on the PLAN, BUILD and REVIEW seat alike, and the halt names one of three causes. When the tool has no credential for the route's provider and its model listing serves no model of that provider, it reads ``OpenCode CLI has no credential for ollama-cloud. Run `opencode auth login ollama-cloud` in a separate terminal, then retry.``, and a seat with a fallback moves to it. With a credential, or when the listing serves a model of that provider, it reads ``Model <id> is not listed by OpenCode CLI; pick a listed model``, and nothing moves by itself; with no other tool, **Pick another BUILD model** opens the picker on the same tool. When the credential listing or the needed model listing cannot be read, one message names both remedies. Before, the run retried the brief and spent paid consults before it stopped. `splitbrief doctor` and the start of a run warn about an OpenCode or Kilo Code route that neither listing holds and name the tool's sign-in command. In the runner picker, a route row reads `available` when its model listing serves a model of the route's provider that no credential names, also when the tool holds no credential at all, `needs sign-in` when neither the credential listing nor the model listing holds the provider, and `sign-in unknown` when the provider has no credential and the model listing was not read. A route on the tool's own gateway needs its credential.
- An OpenCode or Kilo Code set up only with a provider in its own config, with no stored sign-in, now works on a model its model list serves. It starts, also on a first run with no config, and passes `splitbrief doctor`, the runner picker no longer marks it **Auth required**, Setup no longer names it as signed out and continues with it, and Settings › Fallback offers it with no note. A seat on a model the list does not serve still asks you to sign in. When no model list is saved, `splitbrief doctor` and the start of a run read it from the tool. Setup, its ready-made crews, `splitbrief doctor` and the start of a run check a seat on `auto` or with no model against the model the tool's own config selects. Before, every surface treated such a tool as signed out.
- When OpenCode is on a seat or a fallback, its model list also holds the providers that only the project's own `opencode.json` sets up, so a route on one of them reads `available` in the runner picker, passes `splitbrief doctor` and starts. To list them, your OpenCode server loads the project's OpenCode config with its plugins and its local MCP servers, as an OpenCode run in that project does. For a project whose crew does not use OpenCode, the list never names the project. Before, the list held only the providers of your stored sign-ins and of your global OpenCode config.
- OpenCode with `XDG_CONFIG_HOME` or `XDG_DATA_HOME` set uses the same config and sign-in as your own OpenCode, from the folders those variables name. Before, when those folders held no OpenCode files yet, a run used the config and sign-in under `~/.config/opencode` and `~/.local/share/opencode` and showed OpenCode as signed in while your own OpenCode was not.
- Kilo Code with `XDG_CONFIG_HOME` or `XDG_DATA_HOME` set uses the same config and sign-in as your own Kilo Code, from the folders those variables name. Before, when those folders held no Kilo Code files yet, a run used the config and sign-in under `~/.config/kilo` and `~/.local/share/kilo` and showed Kilo Code as signed in while your own Kilo Code was not.
- GitHub Copilot CLI on macOS signed in with `copilot login` now works in a run. Copilot keeps that sign-in in the macOS keychain, and a run now reaches it. Before, Setup and `splitbrief doctor` showed Copilot as signed in, and its first call then failed with a sign-in error. Copilot has no sign-in status command, so on macOS its sign-in now reads as unknown until the first call, unless a token variable is set. A start with `--plain` or `--json` on that unknown sign-in needs `--allow-unverified-auth`.
- GitHub Copilot CLI uses `COPILOT_GITHUB_TOKEN`, the token variable Copilot reads first, as well as `GH_TOKEN` and `GITHUB_TOKEN`. Before, a run dropped `COPILOT_GITHUB_TOKEN`, and Copilot read as not signed in.
- GitHub Copilot CLI with `COPILOT_HOME` set uses the config and sign-in in that folder, as your own Copilot does. Before, a run read `~/.copilot` only, and on Linux Copilot read as not signed in.
- A Copilot editor plugin's own sign-in files no longer show GitHub Copilot CLI as signed in on Linux. Only Copilot CLI's own config counts.
- The transcript row of a Seat down halt names the tool whose words it quotes, as the recovery panel does: `(OpenAI Codex CLI reported: …)`. Before, the row read `(runner reported: …)` while the panel named the tool.
- Saving a route that needs a sign-in in the runner picker adds the sentence and the command of `splitbrief doctor` to the save message: `OpenCode CLI has no credential for opencode — run opencode auth login opencode before start`. Before, the message said `Saved` twice and called the provider an "OpenCode account". Halts, warnings and the picker name a route's provider by the id its sign-in command takes, such as `ollama` or `opencode`, never by a tool's name.
- Every signed-out seat reads the same way as the other Seat down halts: ``Signed out of Claude Code CLI. Run `claude /login` …``, with the halt's name in the menu title.
- `/run reject confirm` works on a stopped or halted run in your checkout once nothing runs it, as the documentation says. Before, it always answered "unavailable while work is active".
- A slash command typed while a recovery menu or a question is open runs as a command. Before, it was taken as your correction, started the recommended action and went to the next seat as a message.
- A seat you change in the crew between a stop and a continue is listed in the review packet under Recovery Decisions with both seats and the cause `crew changed`, and the transcript shows it as one seat row. Before, the review packet only counted it as a warning.
- After a crash during Apply, `splitbrief continue <id> --action retry` and `--action restore` work at once. Before, they failed with "No pending recovery issue is available." until a plain `splitbrief continue` ran first.
- After a crash during Apply, Restore backup, Re-run Apply and undo leave no hidden temporary files in your checkout, and Restore and undo remove the empty folders that Apply made.
- End run on a worktree or staged-copy run names its `run.patch` once: in the closed run's `Patch` row, or on the close line of `splitbrief continue --action end-run` and `--action discard`. Before, a warning row repeated it.
- A review cut by a crash reads its time as `at least …`, because the exact end of the call is not known.
- Setup and `splitbrief init` leave your checkout unchanged until the first save. That save adds `.splitbrief/` to `.gitignore` when git does not ignore it yet, and the save line says so. Before, a seat save left `.splitbrief/` untracked, opening `init` and quitting left a `.splitbrief/` folder, and no screen showed the `.gitignore` change. `splitbrief init --yes` reports its save once.
- After a failed final review, the transcript names the action you chose, **Fix again**, as the recovery menu does. Before, it said **Send a correction**. The `splitbrief continue` line now names **Fix again** without the menu's hint. The transcript also names **Run the checks again** and **Skip review with a note** in the words of the menu.
- Every Backspace deletes one character in every text field, also when the terminal sends several Backspaces at once.
- Saved run patches preserve executable permissions and symlink additions, removals and target changes when you apply them with Git.
- A brief that only changes a file's permissions, or adds, removes or retargets a symbolic link, now shows that file in the transcript, in the review and in the review packet. Such a brief no longer fails as "exited without changing any files", and reverting it puts the link back.
- A saved run patch that removes one file and adds another with the same contents now applies with Git.
- Apply writes the file permission changes of a run and its new, changed or removed symlinks into your project, and Restore puts them back. Only a file or link that you and the run both changed in different ways is a conflict. A file whose permissions differ from what Git records no longer stops Apply.
- A plan can check a file mode or a symbolic link with `test -e`, `test -f`, `test -x` or `test -L <file>`. A request to make a script executable or to add a link no longer needs an extra test file to get a plan check.
- Checkout mode warns about uncommitted changes when a run starts: the warning says that the run edits your checkout and names the folder where a revert saves the files it replaces. Reverting an attempt leaves your other uncommitted files untouched.
- Each readiness warning appears under your request when a run starts, with what to do about it. Before, only `splitbrief doctor` showed it. The run's `readiness.json` and review packet keep each warning's details and fix.
- A readiness warning under your request now shows its details, such as the names of the changed files, in the words `splitbrief doctor` prints. In checkout mode it names the run's own folder for the files a revert saves. Before, it left the details out and showed `<id>` in place of the run's name.
- When a plan goes back to the planner, the warning lists every failed check in plain words, one per line. Before, it named only the first check, by its code, and hid the others behind `(+1 more)`. A refused plan check now says what to use instead: a command that plan checks allow, or a check of kind `test` that names a test file.
- A plan can check one test file with `node --test <test file>`, and a check can check a file's syntax with `node --check <file>`, also on a file the run changed. A plan `test` check no longer adds its file to a `package.json` test script that chains commands, where the file reached only the last command; it runs the script as written.
- Saved files, reports, screens and fallback notices use the same model names. Choosing an Antigravity effort level saves the model that runs at that level.
- The home list and `/sessions` show when a stopped run last stopped or ended, not when it started. The plan card keeps **Request changes** marked while you type.
- Reviewer check selection now sees the request you started the run with, the task briefs, plan decisions and your later instructions, including requests for specific checks.
- `splitbrief doctor` states each setup problem and its fix once, names every affected seat as PLAN, BUILD or REVIEW in that order, and gives specific fixes in text and JSON.
- Setup starts on the crew it shows, so Enter never applies a different crew, and confirms when it saves your configuration. An OpenCode seat shows its model name on every screen and in `splitbrief status`, not its raw model id. The transcript tells you when a plan sent back to the planner passes its checks.
- **Show diff** with no `VISUAL` or `EDITOR` set opens the run's changes in your pager (`PAGER`, else `less`) in the terminal, and `q` returns to the run. It no longer starts an installed GUI editor app that held the run screen until the whole app quit.
- A run started with uncommitted edits in your checkout no longer counts those edits as its own. The reviewer sees them as your work, apart from the run's changes, and a file you changed and the run changed too shows only the run's lines. A review can no longer ask to revert or delete your edits, and Apply keeps them.
- `splitbrief status` shows the same run status as the other screens, including Ready to apply.
- The **Final review** heading shows as soon as the final review starts, above its first plan check, and stays in place when the review ends. A running task review shows its **Review** heading too. A review stopped at its plan check reads *stopped* once the run continues.
- The run transcript hides protocol calls and names file and command activity in plain language.
- Each review attempt keeps its checks and activity in order, followed by its result and elapsed time. A continued run has a visible continuation row.
- Review activity names the current step, including reviews after your answer.
- A continued run keeps each seat call distinct from calls in earlier sessions.
- BUILD activity shows one row per tool use.
- A brief in the transcript names its files in one list and shows one time: the brief's own, the same time the closed run shows. The implementer's report row no longer gives a file count that can differ from that list.
- A brief that was stopped, steered, parked or halted and then continued shows its whole working time in the transcript, in the closed run and in the `post_task` hook's `duration`. The time the run sat stopped or parked is left out.
- A plan whose `cmd` check the plan command policy refuses from its text, such as `npm run lint` in a run that approves no plan, goes back to the planner once (`refused-check-command`), so the run no longer halts on it after Build. `npm run test`, `pnpm run test` and `yarn run test` run the same scripts as the bare `test` and pass the policy without a plan approval.
- A plan check that the plan command policy refuses when it runs, such as an npm script that `package.json` does not define, is recorded and shown as refused, not as a failed check. Its row names the rule it broke. The reviewer sees it as refused, so it is neither a pass nor a failure, and an optional refused check no longer fails a review or an Apply re-check. A required refused check still halts the run as a check that cannot run. A run that approves no plan tells the planner that it refuses `npm run <script>` checks. Check results in `state.json`, in the `checks_run` event and in the `post_validation` hook payload carry `status` (`pass`, `fail`, `refused`, `not-runnable` or `unknown`) in place of `passed`, and an older run's `passed` still loads.
- Continue or End run on a crashed run records each tool call that the crash cut as interrupted, before it restores, runs or closes anything. The run shows that call once as `current turn interrupted: SPLITBRIEF exited`, at rest, after Continue and after End run.
- At rest, a brief that a stop or a crash cut shows the stop mark of the rail, not the working mark, and drops its `working on <file>…` row.
- The final review reads `Final review`, `Final review after 1 fix cycle`, or `Final review re-run` when it ran again with no fix cycle between.
- While a continued run starts again, the byline reads `Resuming T002`, not `Paused`, and `esc` opens the stop sheet.
- A run that another process closed shows as closed on the next action on its screen. Home, `/sessions` and the palette read the run list again each time they open.
- A tool does not outlive a crashed SPLITBRIEF. A watchdog process ends every tool when SPLITBRIEF dies, also on `kill -9`. A tool that survives is stopped when SPLITBRIEF starts, when a run opens at rest and when a run ends.
- `splitbrief continue <run> --action end-run` closes any open run; a ready run closes as discarded and keeps `run.patch`.
- `splitbrief continue` on a closed run exits 1, with a JSON error under `--json`.
- Reject on a checkout run restores only the files that still hold what the run wrote, and names the files you changed since. It also works on a run that stopped or halted after a brief passed, and it refuses a closed run.
- A file that Reject recreates gets its recorded mode, and a folder that Reject, Apply or a restore recreates gets the normal mode, not owner-only.
- End run refuses an unfinished Apply until you restore or retry it.
- A run ended inside a brief lists in its `Files` section every file that `run.patch` holds, and it shows the stopped brief once. Its `Review` row reads `final review not run`.
- A run closed by End run, Discard or Apply no longer offers its removed workspace for Continue in its transcript.
- End run on a ready-to-apply run reads only as discarded. The transcript no longer shows `Stopped by you`, because nothing was running.
- `run.patch` names a created or deleted file `a/<path> b/<path>`, the way git writes a patch.
- A closed run's byline offers only the commands that the run can still take.
- The `resume` and `continue` help lines tell the most recent run apart from a run named by id.
- A repository with a large ignored directory, such as a nested `node_modules`, no longer fails every run with `Maximum call stack size exceeded`.
- A failed final review takes a correction from the recovery panel or the composer.
- Stop keys and the first typed input work after you resume a stopped run on the same screen, and `/resume` and `/end` work at the plan card.
- A stop settles unfinished check rows as `stopped`, live and in a reopened run.
- A call that you stopped reads `current turn interrupted: stopped by you`, with no `raw` tag after it.
- The result menu of a ready run marks an action only while the menu has the keyboard. While you type in the composer, the menu's legend reads `tab back to the actions`, as on the recovery menu.
- The command palette and the Skills list show a skill once, also when two skill folders declare the same skill name.
- No stop surface claims changes that a run never made, and a run ended at the plan card reads `nothing built`.
- A run whose final review passes as a stop arrives closes as complete, and End run during shutdown keeps a passed review.
- A pause between briefs names the next brief, for example `Paused before T003.`
- Ctrl+C presses that arrive together each count, and control bytes never go into the draft or a restored input history.
- Ctrl+C on a mouse selection copies once and shows its result.
- The byline clock leaves out waiting time and spells a step past an hour as `1:15:03`.
- A seat that is thinking no longer reads as silent, and a silent seat is reported once, with one count.
- Claude Code retries, model fallbacks, refusals, denied tool calls and rate-limit warnings show as warning or error rows; its bookkeeping frames no longer reach the transcript.
- A direct implementer's narration shows once.
- A brief stopped inside any implementer continues with the partial output and your note.
- A stopped brief keeps its work when the run continues. This applies after a stop or a *Seat down* halt, with or without a correction, and on the same tool or another tool. When the continued call finds the work done and changes nothing, the brief passes on the files it already wrote. It no longer fails and starts a retry that discards them.
- A correction you type for a brief now reaches the planner and the reviewer too, not only the implementer. This applies to a correction typed on a stopped run, a queued message, a message sent during a call and your answer to a planner question about the brief. The planner treats your corrections as your decisions: it confirms a change that carries one out, does not undo one, and keeps it as the default of any question about it. When the planner asks you about the implementer's decisions, the question shows your corrections for the brief, and SPLITBRIEF gives the planner your answer and asks it again. An answer that keeps the work sends the brief to its checks, and no longer fails the brief when the implementer finds nothing left to change.
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
- Two OpenCode seats that use the same model through different providers show the model name and provider, for example `OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go`, or `DeepSeek V4.1 Flash via opencode-go` on the short seat line, so you can tell them apart. A seat switch records that identity.
- The review lists each seat switch once.
- An unreadable or newer saved state no longer stops a run before it can report itself, a run cancelled before its first save closes, and a saved rewind survives a stop.
- A run that fails on a repair or revision call records `failed` instead of `interrupted`.
- A runner picker save is one write and keeps a concurrent change on disk.
- The inline (non-fullscreen) TUI no longer repaints one row low.
- The slash-completion menu reads as one table, and a recovery menu row keeps its words whole on a narrow panel.
- File snapshots are flushed to disk before they replace the old file, and worktree removal checks that the path is the run's own.
- A Codex seat keeps its sessions and history in the SPLITBRIEF sandbox and shares only its login with your `~/.codex`. A removed sandbox no longer leaves an entry in your Codex state that Codex reports as `state db returned stale rollout path`.
- `--plain` no longer prints a `phase:` line for each streamed chunk of the final review, and review usage is counted on the reviewer.
- The guides now state the configuration that takes effect: `temperature` is accepted but not sent to the server, a `shell` or `agent` runner cannot declare session resume, and the loader fills the stated defaults.
- The guides list all eight supported CLI tools, Antigravity included, and the llama.cpp endpoint default `http://localhost:8080/v1`.
- The guides state which seats take images: Cursor, Command Code and Antigravity take none.
- The guides describe the second `ctrl+c` press that quits within two seconds, exact slash-command names, and help that shows only the commands available on the current screen.
- The guides state that `splitbrief doctor --probe-seat` makes one paid call and records its result, and that `splitbrief review` needs no run.
- A red reviewer check that is not verified at the run base, and that the reviewer rejects with a reason, no longer fails the review: a correct run reaches Apply. Every other red check, and every Apply conflict, still fails the review whatever the reviewer answers, and offers no **Accept as is**. The review result row and `review.md` now count each red that still blocks as a blocking finding, so they agree with the halt below them. When a red check names no failing test, the base re-run row quotes its first error line, for example `both runs exited with code 1: Error: Cannot find module 'src'`, in place of `without diagnostics`.
- Run and review rows report only what happened. The base re-run row names the failing tests, new and pre-existing, and `--plain` prints the same names. `review.md` and the closed run's Review row name a reviewer check that also fails before the run's changes, with its tests. The review packet counts each brief's own checks, for example `T001 done: 1 of 1 checks passed`, so it agrees with its Checks Log. When a continued brief finds its earlier work complete, its row names every file it kept and reads `kept the interrupted attempt's work · no further change`. The stop byline says `Partial changes kept` only when the stopped brief changed files. A stopped CLI tool call reads as interrupted, not as an error. An activity block drops its running mark once its call finishes or a stop cuts it, even when the call's text split its activity into several blocks. A warning such as a rate limit no longer removes the `working on <file>…` row of a brief that is still running. After Continue, the `Workspace kept … for Continue` row goes away.
- A red `node --test` reviewer check names each failing test by its file and name and counts one failure per test. The base re-run row and the review no longer show stack or `location:` lines as failures, so a test that fails at the run base too reads as pre-existing. A test file that fails outside its tests counts as one failure named by its file, and a failed hook or timeout counts once, not once for each test it cancels. Paths in a failing check read relative to the project.
- `splitbrief init` and the first Setup save no longer change `.gitignore` when git already ignores `.splitbrief/`, for example through `.git/info/exclude`, your global excludes file, a parent `.gitignore` or a `.splitbrief` rule without the slash. A clean checkout stays clean, and a run workspace also keeps its `.gitignore` unchanged. When the save does add the `.splitbrief/` line, readiness no longer warns about a changed worktree for that line alone, the same way the run does not count it as a change you made before the run.
- The review packet reads `Checks: no warnings or blockers` when a run started with no setup warnings or blockers. `Checks: unavailable` now means only that no readiness was recorded.
- **Request changes** on the plan card opens an empty draft that is already your change request: everything you type goes to the planner, and `esc` takes you back to the card.
- A call you stop reads `stopped by you` in the transcript.
- The `/end` description no longer promises to keep every change on disk. It reads *Close the run, saving unapplied changes*, which is also true for a run that is ready to apply: End run discards it and saves its changes in `run.patch`.
- The run ages on home and in `/sessions`, such as `just now` and `4m ago`, now move on while the list stays open. Before, they changed only after you opened and closed another panel.
- `splitbrief doctor` names the REVIEW seat when you configure no separate reviewer: `REVIEW = PLAN · <tool> · <model>`, in text and in `--json`.
- Every change in Settings confirms its save under the list, for example `Saved End-of-run checks · off to .splitbrief/config.yaml`, the same way Setup and the picker confirm a save.
- A run whose Apply stopped on a conflict keeps the Apply stage on the header after you continue it, and a stop there reads *Stopped at Apply*. Before, the header marked the review as failed and the stop read *Stopped at the review*, although the review passed.
- `esc` on the recovery menu of an Apply conflict or of a failed final review opens Stop options, as on every other recovery menu. Before, only `ctrl+c` left that menu.
- When a coding tool changes during a run, for example when it updates itself, the halt names the tool and tells you that **Try again** checks it again. It no longer asks you to run `splitbrief doctor`.
- `plan.md`, `tasks.md` and `review.md` name the REVIEW seat beside PLAN and BUILD. `splitbrief status` lists the three seats as PLAN, BUILD and REVIEW.
- A correct change no longer fails its review over a test that already failed before the run. A reviewer check whose only failures also fail at the run base verifies the reviewer's claim and fails nothing. A minor finding stays a note in `review.md`, also when the reviewer could not verify it.
- A brief that changed more than one file keeps its file count, such as `+1 file`, on its transcript heading when the transcript is narrow, also beside the sidebar. Before, the heading dropped the count together with the `(modify)` note and named one file of two while the result menu said `2 files changed`. When room is short, the `(modify)` note goes first, then the path is shortened.
- When the final review passes, the header keeps Plan, Build and Review marked until the result menu opens, and a worktree or staged-copy run then adds the Apply stage. Before, a run that was ready to apply showed `done · 1/1 briefs passed` in the header for a moment.
- In the tool and model picker, a tool you are not signed in to shows only the keys that work on it, `↑↓ select · esc cancel`. Before, it also offered `←→ column` and `⏎ confirm`, which do nothing there.
- In the tool and model picker, the advice for a tool that is not ready, such as signing in, has its own line under the columns, above the tool's facts. Before, the advice ran into them, as in `…then run splitbrief doctor again. · Claude Code CLI · 9 aliases`.
- The help beside *No fallback* and beside a local server in the picker fills the width of its card. Before, it was broken into the same short lines at every width.
- After you change a Crew seat in Settings, the cursor comes back on that seat. Before, it could come back on a Fallback row you opened earlier, so the next `⏎` opened the wrong picker.
- The composer of a stopped, ready or closed run keeps its hint when it has focus, such as *Type a correction…*. The hint of a stopped run, or of a run that is waiting for you, no longer says what ⏎ does: the line under the composer names it, such as *⏎ to decide* on a halt. Before, the hint showed only while a menu above the composer had focus.
- During the final review, the byline shows *reviewing changes* with a clock that starts at that step. Before, it showed the time of the earlier step for a moment.
- A worktree or staged-copy run shows the same header stages when you stop it or open it again as while it runs: Plan, Build and Review, and Apply only once the run is ready to apply. Before, a stopped run added `○ Apply`.
- Setup shows every ready-made crew. A crew whose tools are not ready reads **Unavailable** and names the tools it needs. When installed tools are not signed in, Setup names them and gives the same sign-in step as the picker: sign in, then run `splitbrief doctor` again. Before, Setup hid these crews and gave no reason.
- A balance, billing or quota halt on OpenCode or Kilo Code names the provider of the model route, for example `Balance spent on deepseek (OpenCode CLI)`. Before, it named only the tool, although the provider account was the one that ran out.
- When a tool cannot list its models, the picker shows the tool's own error, not a progress line that came before it. A signed-out Antigravity now reads `Please sign in to view available models. Launch the CLI without arguments to sign in.` in full at 80 columns, and a signed-out tool no longer offers `ctrl+r to retry`, which cannot sign it in.
- A Markdown link whose label is code, such as ``[`name`](path)``, shows as a link also when an earlier link is in the same paragraph. Before, it showed as raw text with the full path.
- Settings › REVIEW describes the review mode you use. With the default `review: end`, it says that REVIEW reads the whole diff once after the last task.
- A fix the reviewer writes can no longer carry a check command that SPLITBRIEF refuses to run, such as `grep`. The same holds for a brief that is rewritten or split after it fails. The reviewer and the planner are told which commands a check may run and correct a refused one before the work starts. Before, the fix passed, the next review stopped on *Required checks cannot run*, and every retry stopped the same way.
- When PLAN rejects or rewords a decision that BUILD reported, the brief goes back to BUILD with PLAN's reason, and its work is checked only after that retry. The transcript says what PLAN decided and why, for example `PLAN rejected 1 decision for T002 · <reason>`. Before, the row read `PLAN confirmed 0 decisions`, the reason was not shown, and the brief went on as if PLAN had agreed.
- A failed review shows its blocking findings in the transcript, live and when you open the run again, for example `Blocking F1  The test file does not contain the four examples`. Before, the row showed only the number of blocking findings.
- A failed task review stays on record after a later review passes. `evidence.json` lists every review with its blocking findings, the review packet has a *Reviews* section, and the closed run names each earlier failed review and its findings under the Review row.
- With `workflow.review: task`, a message you type while a task review is due is labelled for REVIEW, the seat that reads it, for example `Message REVIEW · read at its verdict call…` and `1 queued for REVIEW`. Before, it was labelled for BUILD. A correction you type on a run stopped during a task review also goes to REVIEW; there the composer reads `Type a correction…`, as on every stopped run.
- When the planner confirms a decision the implementer reported but words it differently, the decision is rejected, the brief retries, and the row reads `PLAN rejected 1 decision for T003`. Only the decisions the planner confirms as reported join the decisions that later briefs and the review read, in the implementer's words. Before, the row read `PLAN confirmed 1 decision, rejected 1 for T003`, and the planner's wording joined those decisions. A decision that holds an escape such as `\u0300` now matches when the planner returns the character it stands for.
- In a repository whose `.gitignore` has no final newline, the `.splitbrief/` line that Setup adds no longer counts as your change. `splitbrief doctor` no longer warns about a dirty working tree, and the first run no longer says `Working tree has 1 changed file. Examples: .gitignore`.
- The review packet and the reviewer's prompt name the `.splitbrief/` line that Setup added to `.gitignore` as SPLITBRIEF's own setup change, apart from the run's changes and yours. Before, the reviewer saw an unexplained `.gitignore` change and could end a first run `pass with notes` with a note about it.
- A long blocking finding under the Review row of a closed run wraps at words and keeps its whole sentence. Before, it was cut in the middle, for example `F1 slugify does not fold accented Latin letters to their bas…lug.js line 3, but nothing …`.
- A `splitbrief continue` or `splitbrief resume` that carries a run on without `--json` or `--plain`, in a shell with no terminal, exits `1` with `interactive mode needs a TTY — use --json or --plain`, as `start` does. It exits before it answers a recovery action, so the run stays as it was. `--action apply` applies the run first; when the merged result goes through its checks and review again, that review needs `splitbrief continue <id> --plain`. Before, it crashed with a `Raw mode is not supported` error and a stack trace.
- After `/run reject confirm` closes a run that edited your checkout, the closed run says what the rejects did in the words of the `Rejected` rows, for example `Discarded · … · put back 1 replaced file, removed 3 created files`. Before, it claimed the files were saved in a `run.patch` that does not exist, a warning said the run's changes were "already there" although the reject had removed them, and the Files list named files you wrote after the stop while it left out the files of the stopped brief.
- `Ran` on a closed run counts the time after a ctrl+⏎ send or a Resume of a stopped call. Before, a run of 2m 41s read `Ran 1m 20s`, because the count stopped at the interrupt.
- Each `/run reject confirm` is now a `Rejected` row in the run's transcript, also when you open the run again. After a reject that left some files, the stopped run no longer reads `Partial changes kept` for the files the reject removed.
- The result of `/run reject confirm` is now readable in full in that transcript row: how many replaced files it put back and created files it removed, up to five paths it left as you changed them with a count of the rest, and the folder that holds the replaced files. Before, it was one feedback line cut at the window edge, with `file(s)`, `conflict(s)` and a raw snapshot id.
- While a brief runs its own checks, the screen names the check and its clock, for example `Plan check K2 · npm test 0:11`, and the composer reads `Message BUILD on T001 · read after its checks…`. Before, it read `Implementing…` and offered to message a BUILD call that was not running.
- When Claude Code refuses the final review with `Prompt is too long`, the run now stops on *Review input too large*. It names the size and offers **Skip review** and **End run**. Before, it offered only **Try again**, which sent the same prompt again, so the run could never reach Apply.
- After an Apply that was cut off and then re-run, no hidden `.<name>.tmp.<hex>` file stays in your checkout. Before, a temporary file could stay beside a file that Apply had already written.
- A worktree run whose workspace holds large uncommitted or new files no longer stops with `The workspace continuation record exceeds 8 MiB.` The run now stops, continues and retries however large those files are.
- The *Apply stopped part way* panel offers only **Re-run Apply** and **Restore backup**. Before, it also offered **End run**, which always failed with `Apply did not finish. Restore or retry Apply first`.
- After **Restore backup**, the transcript says what Restore did, for example `Restored Apply backup: put back 2 replaced files, removed 3 created files`. Undoing an Apply with `/run reject confirm` reports the same counts, for example `Apply undone: put back 1 replaced file, removed 1 created file.` Before, both counted the new files that were deleted as files put back.
- On a run ready to apply, `shift+↑↓` scrolls the transcript and leaves the Apply / Show diff / Discard choice where you put it. Before, each press also moved that choice, so the next `⏎` could apply or discard against your pick. The same holds for every menu above the composer.
- After a stop that cut a brief before it wrote a file, Session options says `Draft stays.` and End run reads `close this run`, matching the byline. Before, it said `Changes and draft stay.` and `keep changes` for a run with no changes.
- On a model row with several providers and one signed in, the picker line under the lists names the route that `⏎` saves. Before, it could name another provider's route while `⏎` saved the signed-in one, in Setup, in Settings › Fallback and in the seat pickers.
- In the seat picker, moving onto a tool and pressing `→` starts the Models cursor on the same row whichever row you came from. Before, arriving from `= PLAN` or `+ Add custom command…` started it on `+ Add custom model…`.
- When tools are not signed in, Setup names them and tells you to sign in, then press ⏎ on a seat and ctrl+r, which checks them again without leaving Setup. Before, it sent you to `splitbrief doctor`, which without a saved crew could not name them.
- A warning or failure from a tool reads as the tool's own message in the activity rows, for example `Warn  provider.quota: Insufficient Balance`. Before, a code came first, for example `Warn  opencode-error: provider.quota: …`.
- A brief that creates a file reads `create` on the closed run also after a retry or a Continue past its consult limit, not `modify`.
- A minor or out-of-scope review finding reads as a note in the closed run, the review packet and `splitbrief review`. The closed run and the review packet read the review count as `0 blocking, 3 notes`.
- `splitbrief continue --plain` or `--json` on a run that readiness blocks now prints the blockers and their fix on stderr, for example `splitbrief continue --allow-repo-runners`, instead of an error that points to blockers it did not show. `start --json` also prints the blockers on stderr.
- End run on a run that edits your checkout no longer says the files it wrote are still on disk, or that its changes are already there, after SPLITBRIEF put those files back.
- When a task review still fails after the run's fix cycles, has nothing left to fix, or reaches no verdict, the recovery panel and its error line name that review (for example `Review T004 failed after 2 fix cycles` or `Review T004 reached no verdict`) instead of the final review.
- **Skip task** on a brief that a skipped dependency blocked now shows as one Recovery row under that brief, instead of two rows split around it.
- A closed run's `Phases` row now counts the whole run, also after a stop and continue or a continue after a halt: planning is no longer dropped and the times are no longer only those of the last stretch. Runs closed by Apply, Discard or End run now show the row too.
- `Ran` no longer counts the time on the result menu and the Apply after Accept as is, or after an Apply that stopped part way and ran again.
- A brief you skipped no longer runs again when the final review fails and starts its fixes. The closed record keeps it as skipped, and Apply leaves its work out.
- `splitbrief start --plain`, `continue --plain` and `resume --plain` now print why a run failed on stderr, just before `Workflow failed`. Before, they only pointed to error output that was not shown.
- Taking a command from the palette no longer loses the text you had typed: the draft comes back whole once you send, run or clear the command, also when you hold Backspace. Text you type after that command is kept as well, below the draft, when you pick another command or leave the run and come back. A message the run cannot take now comes back in front of what you typed since, instead of replacing it.
- A halt's Files row now lists the brief's files, not only the first one.
- The closed run block keeps the words of a task or a review finding written on two lines apart.
- A seat you save in Settings or with `/crew` while a run waits on a halt is now used when the run goes on, and the other seats you saved stay as saved.
- In a narrow terminal, a Recovery row no longer leaves its arrow at the end of a line with the outcome, such as **skipped**, alone on the next line.
- A halt panel too short for its text now says how many lines it cuts instead of dropping them without a mark, and keeps the selected action in view with `↑ more` or `↓ more` for each side that hides other actions.
- A list two rows high now marks both sides when it hides items above and below.
- An expanded diff that hides one line now reads `1 more line`, not `1 more lines`.
- After a Seat down halt on one of several implementer profiles, the tool and model you pick in the BUILD picker, and a custom model you type there, go to the profile that halted. Your default implementer profile stays as it was, and picking its tool and model for the halted profile no longer reads as a cancelled change.
- A headless run with `--plain` now says on stderr when the planner takes no images and an attached image was not sent.
- A headless Apply that gets a stop signal finishes its work, and other windows no longer show the run as running.
- A halt panel after an Apply that stopped with many files left paints at once and answers the arrow keys at once.
- When the sessions list cannot open a run, the message now shows the reason first. A task written on several lines now reads with spaces wherever it shows on one line: the sessions list, the command palette, the Plan heading of the run, `splitbrief status`, and the resume and `splitbrief spec` lines.
- A brief that created a file still reads `create` after the planner rewrites or splits it, for every file it created, also an empty file.
- When you pick Re-run Apply after an Apply halt, the run screen now shows `Applying to your checkout` with its clock. Esc now waits for Apply to finish and then goes home; it no longer offers Stop now or End run.
- The drift warning for a brief that changed none of its files names every file of that brief, not only the first.
- A halt panel marks every shortened line with the same `…`.
- In a narrow terminal, the row that shows a seat moving to another tool or model no longer leaves its arrow at the end of a line or alone on a line; when the old and the new seat do not fit on one line, the arrow and the new tool and model start their own line.
- Saving a seat during a run no longer says the run is finishing or that no next brief will start, and the plan card keeps Waiting for your answer. Settings and the key legend now say the same thing about when the seat changes: after the running brief, after the next brief while the plan is made, or after a fix brief or at the next run during the final review.
- Text you type on home and do not send is still there when you come back from a run, also when a command from the palette stood in front of it.
- `splitbrief doctor` no longer says a seat is ready to start when its model has no sign-in. The seat reads ready with warnings, and the warning is counted once.
- `splitbrief doctor` no longer says that a start without the TUI would be refused for an OpenCode that uses the providers set up in its own config.
- A seat switch after a Seat down halt, automatic or chosen by you, keeps the seat's time limit. A switch to another model of the same tool also keeps the tool's idle limits, context length, temperature, arguments, output format, sign-in method and custom models. A custom model you add in the seat picker during the halt stays in `config.yaml` after the switch.
- After the planner rewrote or split a brief, the Ready line, the closed run and its Files list count every file the run changed, including the files of the earlier attempts, also when you end the run before the brief finishes or between the parts of a split brief; the review sees those files too.
- The model picker no longer lists a custom model you added for one tool under another tool, so picking, adding or deleting a custom model acts only on the tool it belongs to.
- In the model picker, Esc on an expanded row now collapses it and keeps what you typed in the filter.
- The model picker's key legend now says what Esc does: collapse a row, clear the filter or close the picker.
- While Re-run Apply writes to your checkout, picking a run from Sessions, the palette or home now says Apply is still writing to your checkout instead of asking you to stop the run on screen.
- A second window on a run no longer keeps saying Running in another process after that process is killed; it shows the run as it stands within a few seconds.
- After Apply, Discard or End run, a closed run names the crew that ran it, not the crew saved in Settings since.
- A closed run whose final review ran but returned no verdict says `final review no verdict` instead of `final review not run`.
- The phase times of a closed run add up to its `Ran` time.
- With `review: task`, a required check that cannot run (for example, a test runner that is not installed) now stops the run with *Required checks cannot run* and tells you what to install. Before, the task review failed and offered *Fix again*, and each try cost a review.
- A decision the planner accepts in its own words no longer counts as rejected and no longer costs a retry.
- After a reject that leaves some of your edits in place, continuing the run builds again each brief whose files the reject put back, and the closed run lists only files that are on disk. This is also true when the run was halted on a later brief or on the final review: the halt ends, and continuing the run builds that brief again.
- A build seat that times out or is cut for silence twice in a row on one brief now stops as *Seat down*, on every seat kind, API seats included, and the halt can move the seat to another ready tool. Before, the timeouts used up the brief's retries and planner consults, and the run stopped as a failed brief.
- After a *Seat down* halt, a tool and model you saved for the seat while the run waited are taken when you pick them in **Change BUILD tool** (or PLAN or REVIEW), also after you open the run again. Before, picking the saved row counted as no change, and the halt asked again.
- In **Change BUILD tool** (or PLAN or REVIEW), picking a ready tool that the halt did not list now moves the seat, and the switch names the seat the halted call ran on. Before, the run said it could not switch and kept the halt.
- After a BUILD seat on a named implementer profile stops, moving the seat or trying again runs the brief on that same profile until the brief passes, also after a stop or when you open the run again. Before, the brief could move to the default profile.
- While a halt waits on a named BUILD profile, `/crew build` changes that profile, and *Try again* runs the brief on the seat you saved. Before, the save went to the default profile.
- When a brief does not fit the BUILD profile it was moved to, the halt names that profile, so `/crew build` changes it and *Try again* runs the brief on the new seat. Before, *Try again* raised the same halt each time.
- A seat that goes down now moves to its declared fallback when the fallback tool is installed and can call the fallback's model, also in a headless run, a fresh clone or CI, and for a model on a provider set up only in the tool's own config. Before, the halt called the fallback not installed or not signed in until SPLITBRIEF had checked the tools once on the home screen.
- A slash command typed while the result menu, a halt menu, the stop menu, the reviewer checks card or a planner question holds the keys now goes to the composer and runs. Enter no longer applies the run or picks an action by accident.
- The composer hint now says what the focused menu takes, and no longer contradicts the menu's own key legend.
- After the planner splits a brief, a file that the first attempt wrote stays with the part that names it. With task review the passing part shows no false "not changed" warning, and after End run between the parts a finished file no longer reads as partial. Before, every such file went to the part that finished last.
- A halt now counts the attempts on the brief the same way the transcript does: after two timeouts it reads `after 2 attempts` and `Attempts: 2/8`, and a brief that failed every retry names all its attempts. A failed planner consult states no attempt count, since it is not an attempt on the brief. Before, the halt said `after 1 attempt` and `Attempts: 1/1`.
- A closed run you open again from Sessions names every BUILD seat that built its briefs, with retry counts and profile names. Before, it named only the last seat.
- A run that is ready to apply names the crew that built it in the header and the sidebar, also while an Apply halt waits and after you save another crew in Settings or open the run again. Before, it named the crew saved in Settings.
- After you reject part of a checkout run and continue it in the same window, the transcript shows each block once, also when the planner split a brief into parts. Before, blocks repeated and rows painted over each other until you opened the run again.
- With task reviews on, the heading of a final review counts the same fix cycles as the halt below it, also for the review Apply starts when your checkout changed a file the run also changed. Before, the heading could read "after 1 fix cycle" while the halt read "after 4 fix cycles".
- An earlier attempt of a brief that the run stopped or redid now shows the stop mark `×`, so only the brief the run works on shows as in progress. Before, the earlier attempt showed the same in-progress mark as the live brief.

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
