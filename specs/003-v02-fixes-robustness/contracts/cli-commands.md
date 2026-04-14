# CLI Contract: diptych v0.2

**Extends**: [v0.1 CLI contract](../../002-cost-optimized-orchestrator/contracts/cli-commands.md)

## Changes from v0.1

### All Commands  -  Config Validation at Startup

All commands that load config (`start`, `spec`, `resume`) now validate config at load time. Invalid config produces clear error messages listing all invalid fields and exits with code 2.

### `diptych start`  -  Token Tracking & Cost Display

The summary at workflow completion now displays:
- Planner tokens (input/output)
- Implementer tokens (input/output)
- Escalation tokens (input/output)
- Estimated cost savings (dollar amount + percentage)
- Correctly formatted elapsed time (e.g., "3m 12s", not "192000s")

### `diptych resume`  -  Actually Resumes

The resume command now passes the loaded `WorkflowState` to the orchestrator, which skips completed tasks and continues from `currentTaskIndex`. Previously, resume always restarted from scratch.

State versioning: v0.2 state files include a `stateVersion: 2` field. Unversioned files (v0.1) trigger a clear "incompatible state format" message suggesting the user re-run the workflow.

### `diptych init --reconfigure`  -  Fix

Now correctly writes snake_case YAML keys (e.g., `api_base` instead of `apiBase`), consistent with the standard config format.

### Exit Codes

| Code | Meaning | New in v0.2? |
|------|---------|--------------|
| 0 | Success | No |
| 1 | Runtime error | No |
| 2 | Configuration error | **Yes**  -  now actually used |
| 130 | Interrupted (SIGINT) | No |

### Startup Checks (new in v0.2)

Before entering the workflow, the tool now validates:
1. Config schema (types, ranges, enums)
2. Cloud provider API keys (if cloud provider configured)
3. Model capabilities (context length from Ollama/LM Studio)

Missing checks produce warnings or errors at startup, not mid-workflow.
