# CLI Command Interface: Agent-Mode Changes

**Scope**: Changes to existing CLI commands for agent-mode support and version detection.

## Modified Commands

### `tiny-spec start <feature>` (modified)

No new flags. Agent mode is configured via `.tiny-spec/config.yaml`, not CLI flags.

**New behavior at startup**:
1. Detects planner CLI version (e.g., `claude --version` → `2.1.84`)
2. Adjusts planner flags based on detected version
3. If version unrecognized: shows warning, falls back to latest known flags
4. If planner CLI missing: shows actionable error with install guidance, exits code 2

**New behavior during implementation** (when `implementer.type: agent`):
1. Spawns agent command for each task (via `implementer.command` + `implementer.args`)
2. Task description delivered via stdin (or `{prompt}` placeholder in args)
3. Waits for process exit (subject to `implementer.timeout`)
4. Detects changed files via `git status`
5. If no files changed: treats as task failure
6. If files changed: runs validation pipeline (tsc → lint → test)
7. Retry/escalation/commit flow unchanged from API mode

### `tiny-spec init` (modified)

**New behavior during auto-detection**:
- Detects planner CLI version and displays it (e.g., "Claude Code v2.1.84 detected")
- If version is below minimum supported: shows warning

## Configuration Contract

### Agent-mode implementer config

```yaml
# .tiny-spec/config.yaml
implementer:
  type: agent                    # NEW: 'api' (default) | 'shell' | 'agent'
  command: claude-zai            # Required for agent/shell types
  args: ["-p", "{prompt}"]      # Optional. {prompt} replaced with task description.
  timeout: 300000                # Optional. Agent process timeout in ms. Default 5min.
  # These fields are ignored in agent mode (agent writes its own files):
  # provider, model, apiBase, contextLength, temperature, outputFormat
```

### Version detection behavior

```yaml
# No config needed. Version detection is automatic.
# The system runs `<planner-command> --version` at startup.
# Known version-to-flags mappings are built into the planner backends.
```

## Error Messages

| Condition | Message | Exit Code |
|-----------|---------|-----------|
| Planner CLI not found | `Error: Claude Code not found. Install: npm install -g @anthropic-ai/claude-code` | 2 |
| Planner version unrecognized | `Warning: Claude Code v{X.Y.Z} — unknown version. Using latest known flags.` | (continues) |
| Agent command not found | `Error: Agent implementer command not found: {command}. Check implementer.command in config.` | 2 |
| Agent command is shell function | (automatic fallback to `$SHELL -lc`) | (continues) |
| Agent timeout | `Error: Agent implementer timed out after {N}s for task "{title}". Entering retry flow.` | (retry) |
| Agent wrote no files | `Error: Agent implementer exited without changing any files for task "{title}". Entering retry flow.` | (retry) |
| Comment without session support | `Info: Comment requires session continuity (only supported by claude-code and agent-sdk). Available: approve, edit, quit.` | (re-prompt) |
