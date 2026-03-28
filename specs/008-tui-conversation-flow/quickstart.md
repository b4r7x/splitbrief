# Quickstart: TUI Conversation Flow

## What Changed

The dual-pane raw text TUI is replaced with a single-column conversation flow. Everything the orchestrator does is now visible as structured event cards — you can see exactly what the planner said, what the implementer generated, whether validation passed, and how much you're saving.

## Usage

Same commands, new display:

```bash
npm run dev -- start "add user auth"    # Full workflow with new TUI
npm run dev -- start "add auth" --auto  # Auto mode (events render, prompts auto-approve)
npm run dev -- resume                   # Resume with new TUI
```

## What You See

```
tiny-spec │ add user auth │ ● res ● spec ● plan ◉ impl ○ rev │ 04:12
────────────────────────────────────────────────────────────────────

  ● Planner researching codebase...
    Found Express.js + JWT patterns in 12 files                42s

  ● Planner spec ready
    4 user stories, 12 requirements
    [Enter] approve  [e] edit  [c] comment  [q] quit

  ● Planner plan: 8 tasks

  ✓ T1 auth middleware — local, 12s
  ✓ T2 JWT utils — local, 8s
  ─── T3: Login endpoint ──────────────────────────────────────
  ⚡ implementer.generate(qwen2.5-coder:7b)                  12s
    → src/routes/auth.ts (+47 lines)
  ⚡ validate(tsc, lint, test)                                ✗ 8s
    → tests 2/3 — "invalid email returns 401"
  ⚡ retry(attempt 1/3)
  ⚡ implementer.generate(qwen2.5-coder:7b)                   9s
    → src/routes/auth.ts (patch +3 -1)
  ⚡ validate(tsc, lint, test)                                ✓ 7s
  ⚡ git.commit("feat(auth): login endpoint")

────────────────────────────────────────────────────────────────────
 Task 3/8 │ Local: 75% │ $0.02 │ Saved: ~$1.40 │ qwen2.5-coder:7b
```

## Keyboard Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll through events |
| `d` | Toggle diff expand/collapse on selected event |
| `Enter` | Approve (at approval prompts) |
| `e` | Edit file in $EDITOR (at approval prompts) |
| `c` | Comment (at approval prompts) |
| `q` | Quit workflow |

## Event Types

| Card | Meaning |
|------|---------|
| `● Planner ...` | Planner is thinking (research, spec, plan) |
| `⚡ implementer.generate(...)` | Local model generating code |
| `⚡ validate(...)` | Running tsc → lint → tests |
| `⚡ retry(...)` | Retrying failed task |
| `⚠ escalate(tier N)` | Planner helping stuck implementer |
| `⚡ git.commit(...)` | Changes committed |
| `✓ T{n} ...` | Completed task (collapsed) |
| `✗ T{n} ...` | Failed task (collapsed) |

## Cost Footer

The bottom bar shows real-time savings:
- **Task N/M** — current progress
- **Local: X%** — percentage completed by free local model
- **$X.XX** — estimated total cost
- **Saved: ~$X.XX** — savings vs using planner for everything
- **model-name** — which local model is running
