# Quickstart: Pluggable Orchestrator & Token Dashboard

## Prerequisites

- **Node.js 22+**
- **Git** initialized in target project
- At least one planner backend installed:
  - Claude Code (`claude --version`)
  - Codex CLI (`codex --version`)
  - OpenCode (`opencode --version`)
  - Aider (`aider --version`)
- At least one implementer available:
  - Ollama running (`curl http://localhost:11434/api/tags`)
  - LM Studio running (`curl http://localhost:1234/v1/models`)

## Setup

```bash
# Install diptych
npm install -g diptych

# Initialize config (auto-detects available backends)
cd your-project
diptych init

# Or manually create .diptych/config.yaml:
cat > .diptych/config.yaml << 'EOF'
planner:
  tool: claude-code
implementer:
  provider: ollama
  model: qwen2.5-coder:7b
EOF
```

## Usage with Different Planners

### Claude Code (default — uses existing subscription)
```bash
diptych start "add user authentication"
# Uses claude -p subprocess, $0 extra cost
```

### Codex CLI
```bash
diptych start "add user auth" --planner codex --planner-model o3
# Or set in config.yaml: planner.tool: codex
```

### OpenCode
```bash
diptych start "add rate limiting" --planner opencode
# Uses opencode run --agent plan for planning
```

### Aider (architect mode)
```bash
diptych start "refactor auth module" --planner aider
# Uses aider --architect for planning
```

## Token Dashboard

After workflow completes, the TUI shows a full-screen summary:

```
                     diptych  Complete

  Overview
    Feature              add user authentication
    Total time           18m 32s
    Estimated savings    $38.15

  Tasks
    Completed (local)    8                        ██████████████████░░ 80%
    Escalated            2
    Failed               0
    Skipped              0
    Escalation rate      20%

  Token Usage
    Category         Input       Output      Total
    Planner          89.3K       45.1K       134.4K
    Implementer      32.7K       18.9K       51.6K
    Escalation       2.1K        1.4K        3.5K
    ─────────────────────────────────────────────
    Total                                    189.5K

  Cost Breakdown
    Hypothetical (all planner)    $42.50
    Actual cost                    $4.35
    Savings                       $38.15 (89.7%)

  Press q or Enter to exit
```

## Running Integration Tests

```bash
# Unit tests only (fast, no external deps)
npm test

# Integration tests (requires Ollama running)
INTEGRATION=true npm run test:integration

# All tests
INTEGRATION=true npm run test:all

# Specific backend tests
TEST_OLLAMA=true npm run test:integration
TEST_CLAUDE=true npm run test:integration  # costs subscription tokens!
```

## Switching Backends

```yaml
# .diptych/config.yaml

# Option 1: Claude Code (subscription, $0 extra)
planner:
  tool: claude-code

# Option 2: Codex (API key, pay per token)
planner:
  tool: codex
  model: o3

# Option 3: OpenCode (API key, any provider)
planner:
  tool: opencode
  model: anthropic/claude-4-sonnet

# Option 4: Aider (API key, architect+editor split)
planner:
  tool: aider
  model: claude-sonnet-4-20250514
```
