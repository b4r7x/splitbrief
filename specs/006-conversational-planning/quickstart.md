# Quickstart: diptych with Interactive Planning

## First Run (No Config)

```bash
cd your-project
diptych start "add user authentication with JWT"
```

If no `.diptych/config.yaml` exists, the interactive picker appears:

1. **Select planner** — auto-detected from your system (Claude Code, Codex, etc.)
2. **Select implementer** — auto-detected running models (Ollama, LM Studio)
3. Config saved to `.diptych/config.yaml` for future runs

## Conversational Planning

After setup, the planner researches your codebase. If it finds ambiguities, it asks up to 5 targeted questions:

```
Question 1/3:
I found Passport with local strategy in your codebase.
Should I reuse it or switch to JWT?

  1) Reuse Passport local strategy
  2) Switch to JWT (stateless)
  3) Add JWT alongside existing Passport

> 2
```

Your answers are saved to `.diptych/current/spec.md` under a `## Clarifications` section. You can also edit spec.md directly in your editor at any time.

**Commands during questions**:
- Type answer + Enter → answer recorded
- `skip` → planner uses its best guess (noted as assumption)
- `done` → stop questions, proceed with remaining assumptions

## Reviewing & Refining

At each approval gate (spec, plan), you have 4 options:

- **[Enter]** — Approve and continue
- **[e]** — Open in $EDITOR for manual edits
- **[c]** — Type a comment in TUI (planner regenerates the artifact with your feedback)
- **[q]** — Quit

The comment option is the fastest way to refine: type "make the tasks smaller" and the planner regenerates the plan within the same session.

## Custom Implementer (Shell)

Use any command as the implementer:

```yaml
# .diptych/config.yaml
implementer:
  type: shell
  command: my-custom-script
  args: ["--format", "markdown"]
  output_format: text
```

The command receives the task prompt on stdin and returns code on stdout. Same retry/escalation logic applies.

## Auto Mode

Skip all interactions:

```bash
diptych start "add auth" --auto
```

Questions are answered with planner's best guesses. Specs and plans auto-approved.

## Files Produced

All artifacts are markdown files in `.diptych/current/`:

| File | Content |
|------|---------|
| `spec.md` | Feature specification with clarifications |
| `plan.md` | Implementation plan |
| `tasks.md` | Atomic tasks for implementer |
| `state.json` | Workflow state (for resume) |
| `events.jsonl` | Event log |

These are the source of truth. The TUI is a convenience layer — everything important is in the files.
