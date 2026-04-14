# Quickstart: Agent-Mode Implementer

## Using an Agent-Style Tool as Implementer

### 1. Configure agent mode

Edit `.diptych/config.yaml`:

```yaml
planner:
  tool: claude-code

implementer:
  type: agent
  command: claude-zai
  args: ["-p", "{prompt}", "--no-permissions"]
  timeout: 300000  # 5 minutes per task
```

The `{prompt}` placeholder in `args` is replaced with the task description. If no `{prompt}` placeholder is present, the task is sent via stdin.

### 2. Run the workflow

```bash
npm run dev -- start "add user authentication"
```

The workflow is identical to API mode:
1. Planner (Claude Code) researches the codebase and generates spec/plan/tasks
2. You approve the spec and plan (or edit/comment/quit)
3. For each task, the agent implementer runs your command with the task description
4. After the agent finishes, diptych validates (tsc → lint → test)
5. Pass → commit and move to next task
6. Fail → retry (up to 3x with error context), then escalate to planner

### 3. What's different in agent mode

| Aspect | API mode | Agent mode |
|--------|----------|------------|
| File writes | diptych extracts code from model output and writes files | The agent writes files directly |
| Output parsing | Code extraction from markdown fences | Output is for display only (progress) |
| Validation | Same | Same (tsc → lint → test) |
| Retry | Same | Same (re-invoke with error context) |
| Escalation | Same | Same (planner hints → planner full impl) |
| Git commits | Same | Same (per task) |

### 4. Shell functions as commands

If your command is a shell function (not on PATH), diptych will automatically resolve it through your login shell. No special configuration needed.

If resolution fails, you'll see:
```
Error: Agent implementer command not found: claude-zai
Check implementer.command in .diptych/config.yaml
```

Fix: ensure the function is defined in your shell profile (`~/.zshrc`, `~/.bash_profile`).

## Conversational Planning

### Clarification questions

During the research/spec phase, the planner may ask clarification questions. These appear in the TUI:

```
Question 1/3: What authentication method should be used?
  1) Email/password
  2) OAuth2
  3) Both
[Enter] answer  [s] skip  [d] done
```

Type a number to select an option, or type a custom answer. Your answers are incorporated into the spec.

### Comment on approval

After the spec or plan is generated, you can:
- **Enter**: Approve and continue
- **e**: Edit in your `$EDITOR`
- **c**: Comment (request changes — planner regenerates)
- **q**: Quit

Commenting requires session continuity (supported by claude-code and agent-sdk planners). For other planners, use edit mode instead.

## Version Detection

diptych automatically detects your planner CLI version at startup. If the version is unrecognized, you'll see a warning but the workflow will continue with the latest known flags.

If the planner CLI is not installed:
```
Error: Claude Code not found. Install: npm install -g @anthropic-ai/claude-code
```
