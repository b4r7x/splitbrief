# Tool Recipes

Loaded in Phase 0 to probe the crew and in Phases 2–3 to build the spawn command. Placeholders: `$P` prompt file, `$M` model, `$E` effort, `$D` absolute project dir (`agy --add-dir .` gives agy no workspace), `$LOG` log file, `$DONE` the attempt's `.done` file, `$PID` its `.pid` file.

Every `implementer:` / `reviewer:` line below is generated from the SPLITBRIEF CLI's own adapters (`src/engine/runners/cli-tools/*.ts`, via `npm run skills:sync`): the exact argv the CLI sends for a build call and for a review call, with the prompt, model, effort and project dir replaced by placeholders, wrapped in the detached spawn shape. Do not edit them by hand — `npm run skills:check` fails when they differ from the adapters.

## Spawn rules (every tool)

- cwd = project root. Every spawn is detached and writes its own terminal state: `nohup sh -c '<argv> > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`. The waiter (`scripts/wait-attempt.sh`, per the wait protocol in the skill's orchestration notes) runs in a separate tool call.
- Argv transport caps the prompt at 120 000 bytes; a longer prompt is refused, never truncated. `claude` and `codex` take the prompt on stdin and have no cap.
- Prompt transport: stdin (`< $P`) for claude and codex; codex's `-` argument makes it read stdin. The rest take `"$(cat $P)"` as the positional argument: refuse to spawn one of them when the prompt's first character is `-` — the tool would read it as an option.
- Drop the model flag (`-m $M` / `--model $M`) and the effort flag (`--effort $E` / `--variant $E` / `-c model_reasoning_effort=$E`) when the seat carries no model or no effort.
- Never add flags beyond the recipe; never pass this session's own permission flags down. The one exception is a spawn failure (last section): then the recipe itself is corrected — in the CLI adapter, since the recipe is generated from it.
- Success = exit code 0 AND, for the structured tools, the terminal record named below. Exit 0 without it = failure `ended without a terminal result`.
- `command -v <binary>` empty → halt `tool not installed`.

Timeouts:

<!-- generated: timeouts -->
- Implementer 20 minutes per attempt, reviewer 10 minutes. 2 consecutive timeouts on one brief = hard halt.
- The waiter is its own deadline: `scripts/wait-attempt.sh <run> <T00N> <n> --deadline 1200` kills the process group at 20 minutes. Never wrap a spawn in coreutils `timeout` — it does not exist on stock macOS.
<!-- /generated -->

## claude — Claude Code

- binary `claude` · version `claude --version` · auth `claude auth status` · models: no listing (aliases `sonnet`/`opus`/`haiku` or full ids) · effort `low|medium|high`
<!-- generated: recipe:claude-code -->
- implementer: `nohup sh -c 'claude -p --output-format stream-json --verbose --include-partial-messages --model $M --effort $E --permission-mode acceptEdits --settings '\''{"sandbox":{"enabled":true,"failIfUnavailable":false,"allowUnsandboxedCommands":false},"permissions":{"blockReadsOutsideWorkingDirectories":true}}'\'' < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode acceptEdits --settings '\''{"sandbox":{"enabled":true,"failIfUnavailable":false,"allowUnsandboxedCommands":false},"permissions":{"blockReadsOutsideWorkingDirectories":true}}'\'' < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'claude -p --output-format stream-json --verbose --include-partial-messages --model $M --effort $E --permission-mode plan --disallowedTools AskUserQuestion < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode plan --disallowedTools AskUserQuestion < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- terminal record: a line containing `"type":"result"`; its `result` field is the final text.

## codex — OpenAI Codex CLI

- binary `codex` · version `codex --version` · auth `codex login status` · models: no listing · effort `minimal|low|medium|high|xhigh`
<!-- generated: recipe:codex -->
- implementer: `nohup sh -c 'codex --model $M -c model_reasoning_effort=$E --sandbox workspace-write --ask-for-approval never exec --ignore-user-config --json --skip-git-repo-check --cd $D - < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'codex --sandbox workspace-write --ask-for-approval never exec --ignore-user-config --json --skip-git-repo-check --cd $D - < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'codex --model $M -c model_reasoning_effort=$E --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --ephemeral --json --cd $D - < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'codex --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --ephemeral --json --cd $D - < $P > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- `--sandbox` and `--ask-for-approval` are global flags and must precede `exec`.
- terminal record: `"type":"turn.completed"`; `turn.failed` or `"type":"error"` = failure. Final text: the last `item.completed` whose item type is `agent_message`.

## opencode — OpenCode

- binary `opencode` · version `opencode --version` · auth `opencode auth list` · models `opencode models` (ids are `provider/model`) · effort = `--variant` (provider vocabulary such as `high`, `max`, `minimal`)
<!-- generated: recipe:opencode -->
- implementer: `nohup sh -c 'opencode run --model $M --variant $E --format json --agent build "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'opencode run --format json --agent build "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'opencode run --model $M --variant $E --format json --agent plan "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'opencode run --format json --agent plan "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- terminal record: none — exit 0 is success; a `{"type":"error"…}` line = failure regardless of exit code. Final text: the text events after the last tool event.

## kilo — Kilo Code

- binary `kilo` · version `kilo --version` · auth `kilo auth list` · models `kilo models` (`provider/model`) · effort = `--variant`
<!-- generated: recipe:kilo-code -->
- implementer: `nohup sh -c 'kilo run --model $M --variant $E --format json --agent code --auto "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'kilo run --format json --agent code --auto "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'kilo run --model $M --variant $E --format json --agent plan "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'kilo run --format json --agent plan "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- terminal record: none — exit 0; error envelope as opencode.

## copilot — GitHub Copilot CLI

- binary `copilot` · version `copilot --version` · auth: no cheap probe — an auth signature in the first spawn's log halts · models: no listing · effort `low|medium|high`
<!-- generated: recipe:copilot -->
- implementer: `nohup sh -c 'copilot --model $M --effort $E -p "$(cat $P)" --allow-all --output-format json > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'copilot -p "$(cat $P)" --allow-all --output-format json > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'copilot --model $M --effort $E -p "$(cat $P)" --plan --allow-all-tools --no-ask-user --output-format json > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'copilot -p "$(cat $P)" --plan --allow-all-tools --no-ask-user --output-format json > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- terminal record: none — exit 0. The implementer and the reviewer both print JSON records, one per line.

## cursor — Cursor CLI

- binary `cursor-agent` (`agent` is the same binary) · version `cursor-agent --version` · auth `cursor-agent status` · models `cursor-agent --list-models` · effort: part of the model id (`gpt-5.3-codex-high`); an `@effort` on a cursor seat is refused at preflight with `cursor carries effort in the model id`
<!-- generated: recipe:cursor -->
- implementer: `nohup sh -c 'cursor-agent --print --output-format stream-json --force --trust --workspace $D --model $M "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'cursor-agent --print --output-format stream-json --force --trust --workspace $D "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'cursor-agent --print --output-format stream-json --mode plan --trust --workspace $D --model $M "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'cursor-agent --print --output-format stream-json --mode plan --trust --workspace $D "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- terminal record: `"type":"result"`.

## cmd — Command Code

- binary `cmd` · version `cmd --version` · auth `cmd status` · models `cmd --list-models` (`vendor/model`) · effort `low|medium|high`
<!-- generated: recipe:command-code -->
- implementer: `nohup sh -c 'cmd -p --output-format json --trust --skip-onboarding --no-auto-update --yolo -m $M --effort $E "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'cmd -p --output-format json --trust --skip-onboarding --no-auto-update --yolo "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'cmd -p --output-format json --trust --skip-onboarding --no-auto-update --permission-mode plan -m $M --effort $E "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'cmd -p --output-format json --trust --skip-onboarding --no-auto-update --permission-mode plan "$(cat $P)" > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- `--permission-mode auto-accept` is not enough in `-p` mode (verified on 1.50.1: every write and shell tool answers `requires permissions. Use --yolo`); `--yolo` is the headless write flag. The implementer recipe was exercised end-to-end on 1.50.1 on 2026-09-08.
- terminal record: the final `result` line of the NDJSON stream; its `finalText` field is the final text. Exit 8 = the `--max-turns` cap → failure `turn cap hit`.

## agy — Antigravity CLI

- binary `agy` · version `agy --version` (`agy --help` prints none) · auth `agy models` (fails when signed out) · models `agy models` (`<id>\t<display name>`, one row per effort variant) · effort `low|medium|high`
<!-- generated: recipe:antigravity -->
- implementer: `nohup sh -c 'agy -p "$(cat $P)" --dangerously-skip-permissions --add-dir $D --output-format stream-json --model $M --effort $E > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- implementer (no model): `nohup sh -c 'agy -p "$(cat $P)" --dangerously-skip-permissions --add-dir $D --output-format stream-json > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer: `nohup sh -c 'agy -p "$(cat $P)" --mode plan --add-dir $D --output-format stream-json --model $M --effort $E > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
- reviewer (no model): `nohup sh -c 'agy -p "$(cat $P)" --mode plan --add-dir $D --output-format stream-json > $LOG 2>&1; echo "exit=$?" > $DONE' & echo $! > $PID`
<!-- /generated -->
- terminal record: the last `{"event":"result",…}` line: `result.status` `SUCCESS` = success, with `result.response` as the final text; any other status = failure; exit 0 without it = failure `ended without a terminal result`.

## Halt signatures

Match the phrases as written, case-insensitively, in the last 60 lines of `$LOG`. A bare number is never a signature — NDJSON logs are full of them. An `auth`, `usage` or `missing-model` match halts the run: no retry, no escalation, report with the tool's login or plan page, and with the tool's model listing when it has one.

<!-- generated: halt-signatures -->
| Kind | Signatures |
|---|---|
| auth | `access token could not be refreshed`, `log out and sign in again`, `401 unauthorized`, `please run /login`, `invalid api key`, `oauth token has expired`, `oauth token revoked`, `authentication_error`, `not logged in`, `not authenticated`, `http 401`, `status 401`, `"status":401`, `login required`, `authentication failed` |
| usage | `rate limit exceeded`, `rate limit reached`, `usage limit`, `quota exceeded`, `too many requests`, `insufficient_quota`, `exceeded your current quota`, `credit balance is too low`, `http 429`, `status 429`, `"status":429`, `insufficient credits`, `quota reached`, `resource_exhausted`, `exhausted your` |
| missing-model | `unknown model`, `model not found`, `invalid model` |
| spawn | `requires permissions`, `use --yolo`, `blocked by permissions`, `not allowed in this mode`, `unknown option`, `unknown flag`, `unrecognized argument`, `sandbox required but unavailable` |
<!-- /generated -->

A `spawn` match is not the implementer's failure: the recipe's permission flags do not match the installed tool version. This is the `recipe-fix` rung of the ladder — correct the recipe in the SPLITBRIEF adapter it is generated from, then re-spawn as the next attempt number with the same prompt the failed spawn used (no new framing, no new error block). It consumes no local retry; `progress.md` records the rung as `recipe-fix`. A second spawn failure on the same brief is a halt.
