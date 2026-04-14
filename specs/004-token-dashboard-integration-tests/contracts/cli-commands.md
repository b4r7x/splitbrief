# CLI Commands Contract Update

## Modified Commands

### `diptych init`

New interactive prompts for planner selection:

```
$ diptych init

Planner configuration:
  Select planner: (Use arrow keys)
  > claude-code  (Claude Code CLI — uses existing subscription)
    codex        (OpenAI Codex CLI)
    opencode     (OpenCode CLI)
    aider        (Aider architect mode)
    agent-sdk    (Anthropic Agent SDK — requires API key)

  [If codex/opencode/aider selected]
  Checking if <tool> is installed... ✓ Found

  [If agent-sdk selected]
  Enter ANTHROPIC_API_KEY: sk-ant-...

Implementer configuration:
  (unchanged from current)
```

### `diptych start <feature>`

New `--planner` flag:

```
$ diptych start "add user auth" --planner codex --model o3
```

**New flags**:
- `--planner <provider>` — Override planner from config (claude-code, codex, opencode, aider, agent-sdk)
- `--planner-model <model>` — Override planner model

**Status bar change**:
```
Phase: implementing | Task: 3/10 | Planner: claude-code | Impl: qwen2.5-coder:7b | Tokens: 45.2K | ~$2.15 | Retries: 0
```

### `diptych status`

Now shows planner info:

```
$ diptych status

Feature: add user authentication
Phase: implementing (task 5/12)
Planner: claude-code (Opus 4.6)
Implementer: ollama / qwen2.5-coder:7b
Tokens: 89.3K planner + 45.1K impl + 2.1K escalation = 136.5K total
Est. cost: $2.35 (saved ~$38.15 vs all-planner)
```

## Planner Backend Subprocess Contracts

### Claude Code Backend

```bash
# Planning
claude -p "<prompt>" --output-format stream-json [--session-id <id>]

# Escalation (hint)
claude -p "<hint prompt>" --output-format stream-json

# Escalation (full)
claude -p "<full prompt>" --output-format stream-json
```

Output: NDJSON lines, each `{"type":"assistant"|"result",...}`

### Codex Backend

```bash
# Planning
codex exec --json --full-auto --cd <project> "<prompt>"

# With model override
codex exec --json --full-auto -m o3 "<prompt>"
```

Output: JSONL lines with `thread.started`, `item.completed`, `turn.completed`

### OpenCode Backend

```bash
# Planning (read-only analysis)
opencode run --format json --agent plan "<prompt>"

# Building (when used as both planner+builder)
opencode run --format json --agent build "<prompt>"
```

Output: NDJSON lines with `text`, `step_finish`, `tool_use`

### Aider Backend

```bash
# Planning (ask mode, no file changes)
aider --chat-mode ask --model <model> --yes-always --no-stream --no-pretty --message "<prompt>" --read src/

# Architect mode (plan + implement)
aider --architect --model <model> --editor-model <model> --yes-always --no-stream --no-pretty --no-auto-commits --message "<prompt>" files...
```

Output: Plain text to stdout. Token info as text line: `Tokens: 12.3k sent, 1.2k received. Cost: $0.04`

### Agent SDK Backend

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: "<prompt>",
  options: {
    model: "claude-opus-4-6",
    allowedTools: ["Read", "Glob", "Grep", "Write"],
    permissionMode: "acceptEdits",
    cwd: "<project>",
  }
})) {
  // Handle SDKMessage types
}
```

Output: Typed `SDKMessage` stream with `assistant`, `result`, `system` types.

## Config Schema Update

```yaml
# .diptych/config.yaml
planner:
  tool: claude-code        # claude-code | codex | opencode | aider | agent-sdk
  model: ""                # optional model override (backend-specific)
  apiKey: ""               # for agent-sdk, codex (or use env vars)
  apiBase: ""              # custom API endpoint

implementer:
  provider: ollama         # ollama | lm-studio | deepseek | openrouter
  model: qwen2.5-coder:7b
  apiBase: ""              # auto-detected
  contextLength: 32768
  temperature: 0.2

validation:
  typecheck: true
  lint: true
  test: true

workflow:
  maxRetries: 3
  autoApprove: false
```
