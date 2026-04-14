# CLI Commands Contract (Updated for 006)

## `diptych start <feature>`

Full pipeline: plan with planner, implement with implementer.

**Changes**:
- If no config.yaml exists AND no CLI overrides provided → show interactive picker (planner + implementer)
- During planning: planner may ask clarifying questions in TUI (up to 5)
- At approval gates: new [c] comment option alongside [Enter] approve, [e] edit, [q] quit

**Options** (unchanged):
- `--auto` — Skip approvals and questions (planner uses best guesses)
- `--model <model>` — Override implementer model (skips picker)
- `--provider <provider>` — Override implementer provider (skips picker)
- `--planner <tool>` — Override planner backend (skips picker)
- `--planner-model <model>` — Override planner model
- `--project <dir>` — Project directory

**Exit codes** (unchanged): 0 success, 1 failure, 2 config error

## `diptych spec <feature>`

Generate spec/plan/tasks only (no implementation).

**Changes**:
- Uses planner factory (`createPlanner(config)`) instead of hardcoded Claude Code
- Respects `planner.tool` config setting
- Supports conversational mode if planner backend supports multi-turn

**Options** (unchanged):
- `--auto` — Auto-approve
- `--project <dir>` — Project directory

## `diptych init`

Create config with auto-detected models.

**Changes**:
- Detects available planners (claude, codex, opencode, aider) in addition to implementer models
- Interactive picker for both planner and implementer selection

**Options** (unchanged):
- `--reconfigure` — Overwrite existing config

## `diptych status` / `diptych resume`

No changes to these commands.

## Interactive Picker Flow (new)

Triggered when no config exists and no CLI overrides provided.

```
┌──────────────────────────────────────┐
│ diptych setup                      │
│                                      │
│ Detected planners:                   │
│ ❯ Claude Code (installed)            │
│   Codex (installed)                  │
│   Aider (not found)                  │
│                                      │
│ Select planner: [↑↓ Enter]           │
├──────────────────────────────────────┤
│ Detected implementers:               │
│ ❯ Ollama — qwen2.5-coder:7b         │
│   Ollama — qwen3:8b                  │
│   LM Studio — deepseek-coder        │
│                                      │
│ Select implementer: [↑↓ Enter]       │
├──────────────────────────────────────┤
│ Saved to .diptych/config.yaml      │
│ Starting workflow...                 │
└──────────────────────────────────────┘
```

## Approval Prompt (updated)

```
┌──────────────────────────────────────┐
│ spec generated. Review at            │
│ .diptych/current/spec.md           │
│                                      │
│ [Enter] approve  [e] edit  [c] comment  [q] quit │
└──────────────────────────────────────┘
```

When [c] is pressed:
```
┌──────────────────────────────────────┐
│ Type your feedback:                  │
│ > split the auth task into login     │
│   and registration separately        │
│                                      │
│ [Enter] to submit                    │
└──────────────────────────────────────┘
```

## Question Prompt (new)

```
┌──────────────────────────────────────┐
│ Question 1/3:                        │
│ I found Express + Passport in your   │
│ codebase. Which auth strategy?       │
│                                      │
│  1) JWT tokens (stateless)           │
│  2) Session-based (stateful)         │
│  3) OAuth2 delegation                │
│                                      │
│ > 1                                  │
│                                      │
│ [Enter] answer  [s] skip  [d] done   │
└──────────────────────────────────────┘
```

## Config Schema (updated)

```yaml
planner:
  tool: claude-code          # claude-code | codex | opencode | aider | agent-sdk | shell

implementer:
  type: api                  # api | shell (NEW, default: api)
  provider: ollama
  model: qwen2.5-coder:7b
  api_base: http://localhost:11434/v1
  context_length: 32768
  temperature: 0.3
  # Shell implementer fields (when type: shell):
  command: my-script         # NEW: required when type is shell
  args: []                   # NEW: optional args
  output_format: text        # NEW: stream-json | jsonl | text
```
