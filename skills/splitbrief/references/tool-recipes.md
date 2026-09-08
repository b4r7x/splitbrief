# Tool Recipes

Loaded in Phase 0 to probe the crew and in Phases 2–3 to build the spawn command. Placeholders: `$P` prompt file, `$M` model, `$E` effort, `$D` project dir, `$LOG` log file.

The `implementer:` / `reviewer:` lines of the seven CLI-backed tools are generated from the SPLITBRIEF CLI's own adapters (`src/engine/runners/cli-tools/*.ts`, via `npm run skills:sync`): they are the exact argv the CLI sends, with the prompt, model, effort and project dir replaced by placeholders. Do not edit them by hand — `npm run skills:check` fails when they differ from the adapters. `agy` is not in the CLI and is hand-maintained.

## Spawn rules (every tool)

- cwd = project root. `> $LOG 2>&1` on every spawn.
- Prompt transport: stdin (`< $P`) for claude; `"$(cat $P)"` as the positional argument for the rest. Refuse to spawn when the prompt's first character is `-` — the tool would read it as an option.
- Drop the model flag (`-m $M` / `--model $M`) and the effort flag (`--effort $E` / `--variant $E` / `-c model_reasoning_effort=$E`) when the seat carries no model or no effort.
- Timeouts: implementer 20 minutes, reviewer 10 minutes. Two consecutive timeouts on one brief = hard halt.
- Never add flags beyond the recipe; never pass this session's own permission flags down. The one exception is a spawn failure (last section): then the recipe itself is corrected — in the CLI adapter, since the recipe is generated from it.
- Success = exit code 0 AND, for the structured tools, the terminal record named below. Exit 0 without it = failure `ended without a terminal result`.
- `command -v <binary>` empty → halt `tool not installed`.

## claude — Claude Code

- binary `claude` · version `claude --version` · auth `claude auth status` · models: no listing (aliases `sonnet`/`opus`/`haiku` or full ids) · effort `low|medium|high`
<!-- generated: recipe:claude-code -->
- implementer: `claude -p --output-format stream-json --verbose --include-partial-messages --model $M --effort $E --permission-mode acceptEdits < $P > $LOG 2>&1`
- reviewer: `claude -p --output-format stream-json --verbose --include-partial-messages --model $M --effort $E --permission-mode plan < $P > $LOG 2>&1`
<!-- /generated -->
- terminal record: a line containing `"type":"result"`; its `result` field is the final text.

## codex — OpenAI Codex CLI

- binary `codex` · version `codex --version` · auth `codex login status` · models: no listing · effort `minimal|low|medium|high|xhigh`
<!-- generated: recipe:codex -->
- implementer: `codex --model $M -c model_reasoning_effort=$E --sandbox workspace-write --ask-for-approval never exec --ignore-user-config --json --skip-git-repo-check --cd $D "$(cat $P)" > $LOG 2>&1`
- reviewer: `codex --model $M -c model_reasoning_effort=$E --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --ephemeral --json --cd $D "$(cat $P)" > $LOG 2>&1`
<!-- /generated -->
- `--sandbox` and `--ask-for-approval` are global flags and must precede `exec`.
- terminal record: `"type":"turn.completed"`; `turn.failed` or `"type":"error"` = failure. Final text: the last `item.completed` whose item type is `agent_message`.

## opencode — OpenCode

- binary `opencode` · version `opencode --version` · auth `opencode auth list` · models `opencode models` (ids are `provider/model`) · effort = `--variant` (provider vocabulary such as `high`, `max`, `minimal`)
<!-- generated: recipe:opencode -->
- implementer: `opencode run --model $M --variant $E --format json --agent build "$(cat $P)" > $LOG 2>&1`
- reviewer: `opencode run --model $M --variant $E --format json --agent plan "$(cat $P)" > $LOG 2>&1`
<!-- /generated -->
- terminal record: none — exit 0 is success; a `{"type":"error"…}` line = failure regardless of exit code. Final text: the text events after the last tool event.

## kilo — Kilo Code

- binary `kilo` · version `kilo --version` · auth `kilo auth list` · models `kilo models` (`provider/model`) · effort = `--variant`
<!-- generated: recipe:kilo-code -->
- implementer: `kilo run --model $M --variant $E --agent code --auto "$(cat $P)" > $LOG 2>&1`
- reviewer: `kilo run --model $M --variant $E --format json --agent plan "$(cat $P)" > $LOG 2>&1`
<!-- /generated -->
- terminal record: none — exit 0; error envelope as opencode.

## copilot — GitHub Copilot CLI

- binary `copilot` · version `copilot --version` · auth: no cheap probe — an auth signature in the first spawn's log halts · models: no listing · effort `low|medium|high`
<!-- generated: recipe:copilot -->
- implementer: `copilot --model $M --effort $E -p "$(cat $P)" --allow-all > $LOG 2>&1`
- reviewer: `copilot --model $M --effort $E -p "$(cat $P)" --plan --allow-all-tools --no-ask-user --output-format json > $LOG 2>&1`
<!-- /generated -->
- terminal record: none — exit 0. The implementer prints plain text; the reviewer prints JSON.

## cursor — Cursor CLI

- binary `cursor-agent` (`agent` is the same binary) · version `cursor-agent --version` · auth `cursor-agent status` · models `cursor-agent --list-models` · effort: part of the model id (`gpt-5.3-codex-high`); an `@effort` on a cursor seat is refused at preflight with `cursor carries effort in the model id`
<!-- generated: recipe:cursor -->
- implementer: `cursor-agent --print --output-format stream-json --force --trust --model $M "$(cat $P)" > $LOG 2>&1`
- reviewer: `cursor-agent --print --output-format stream-json --mode plan --trust --model $M "$(cat $P)" > $LOG 2>&1`
<!-- /generated -->
- terminal record: `"type":"result"`.

## cmd — Command Code

- binary `cmd` · version `cmd --version` · auth `cmd status` · models `cmd --list-models` (`vendor/model`) · effort `low|medium|high`
<!-- generated: recipe:command-code -->
- implementer: `cmd -p --output-format json --trust --skip-onboarding --no-auto-update --yolo -m $M --effort $E "$(cat $P)" > $LOG 2>&1`
- reviewer: `cmd -p --output-format json --trust --skip-onboarding --no-auto-update --permission-mode plan -m $M --effort $E "$(cat $P)" > $LOG 2>&1`
<!-- /generated -->
- `--permission-mode auto-accept` is not enough in `-p` mode (verified on 1.50.1: every write and shell tool answers `requires permissions. Use --yolo`); `--yolo` is the headless write flag. The implementer recipe was exercised end-to-end on 1.50.1 on 2026-09-08.
- terminal record: the final `result` line of the NDJSON stream; its `finalText` field is the final text. Exit 8 = the `--max-turns` cap → failure `turn cap hit`.

## agy — Antigravity CLI (hand-maintained; not in the CLI)

- binary `agy` · version: `agy --help` exits 0 (no version flag) · auth `agy models` (fails when signed out) · models `agy models` · effort `low|medium|high`
- implementer: `agy -p "$(cat $P)" --dangerously-skip-permissions --output-format json --print-timeout 20m [--model $M] [--effort $E] > $LOG 2>&1`
- reviewer: `agy -p "$(cat $P)" --mode plan --output-format json --print-timeout 10m [--model $M] [--effort $E] > $LOG 2>&1`
- terminal record: none — exit 0.

## Halt signatures

Match the phrases as written, case-insensitively, in the last 60 lines of `$LOG`. A bare number is never a signature — NDJSON logs are full of them. A match halts the run: no retry, no escalation, report with the tool's login or plan page.

| Kind | Signatures |
|---|---|
| auth | `not logged in`, `unauthorized`, `HTTP 401`, `status 401`, `"status":401`, `invalid api key`, `login required`, `authentication failed` |
| usage | `rate limit`, `usage limit`, `quota exceeded`, `HTTP 429`, `status 429`, `"status":429`, `insufficient credits`, `billing` |
| missing model | `unknown model`, `model not found`, `invalid model` — halt and print the tool's model listing when it has one |

## Spawn-failure signatures

`requires permissions`, `use --yolo`, `permission denied`, `blocked by permissions`, `not allowed in this mode` — the recipe's permission flags do not match the installed tool version, so the spawn failed, not the implementer. This is the `recipe-fix` rung of the ladder: correct the recipe (for a CLI-backed tool, in the SPLITBRIEF adapter it is generated from; for `agy`, in this file), then re-spawn as the next attempt number with the same prompt the failed spawn used (no new framing, no new error block). It consumes no local retry; `progress.md` records the rung as `recipe-fix`. A second spawn failure on the same brief is a halt.
