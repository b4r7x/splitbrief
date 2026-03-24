# Quickstart: tiny-spec v0.2

No changes to the user-facing workflow from v0.1. See [v0.1 quickstart](../002-cost-optimized-orchestrator/quickstart.md) for the full guide.

## What's New in v0.2

### Resume Actually Works

```bash
# Start a workflow
tiny-spec start "add user authentication"

# Interrupt at any point (Ctrl+C, close terminal, etc.)

# Resume from where you left off
tiny-spec resume
# → Continues from the exact task where you were interrupted
```

### Cost Savings Are Displayed

After a workflow completes, the summary now shows actual token usage and savings:

```
Summary:
  Tasks: 10 completed, 2 escalated, 0 failed
  Time: 3m 12s
  Tokens:
    Planner:     45,000 in / 12,000 out
    Implementer: 89,000 in / 34,000 out  (local, $0.00)
    Escalation:   8,000 in /  3,500 out
  Cost: $0.89 actual vs $4.12 all-Opus → saved $3.23 (78%)
```

### Config Validation

Invalid config is now caught at startup:

```bash
# If config has errors:
tiny-spec start "feature"
# → Error: Invalid configuration:
# →   implementer.provider: Must be one of: ollama, lm-studio, deepseek, openrouter (got "olama")
# →   implementer.temperature: Must be between 0 and 2 (got 5)
# → Fix .tiny-spec/config.yaml and try again.
```

### Safer Operations

- File writes are validated to stay within the project directory
- Ctrl+C properly cleans up (reverts only the current task's changes, preserves your other work)
- All subprocesses are terminated on exit (no orphans)
