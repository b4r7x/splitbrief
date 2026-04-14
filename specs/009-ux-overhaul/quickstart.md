# Quickstart: 009-ux-overhaul

## What Changed

The UX overhaul replaces the command-line-first workflow with an interactive home screen, adds 4 permission modes, enables back navigation during planning, shows changeset summaries on regeneration, and redesigns event cards with box-drawing visual style.

## Starting diptych

### New way (interactive)

```
diptych
```

Opens the home screen:

```
                ┌─────────────────────────────────┐
                │                                 │
                │     t i n y - s p e c           │
                │     plan smart, build cheap     │
                │                                 │
                └─────────────────────────────────┘

  planner: claude-code       implementer: ollama / qwen2.5-coder:7b
  project: ~/my-app          git: main (clean)

  ┌──────────────────────────────────────────────────────────┐
  │ What do you want to build?                               │
  └──────────────────────────────────────────────────────────┘

  /models  /config  /status  /resume  /help        Ctrl+C quit
```

Type a feature description and press Enter to start. Type `/` for slash commands.

### Old way (still works)

```
diptych start "add user auth"
diptych start "add user auth" --mode supervised
```

## Permission Modes

Switch modes at any time by pressing Tab:

| Mode | Indicator | Behavior |
|------|-----------|----------|
| supervised | [S] | Approve everything — spec, plan, each task |
| normal | [N] | Approve spec and plan, tasks run automatically |
| auto | [A] | Everything runs without prompts |
| plan-only | [P] | Generate spec/plan/tasks, then stop |

Set via CLI: `--mode supervised`, config file: `mode: supervised`, or Tab key during workflow.

## Planning with Feedback

### Comment loop

During spec or plan review, press `c` to comment. The planner regenerates incorporating your feedback. A TLDR changeset card shows what changed:

```
 ┌─ [CHANGES] spec.md ──────────────────────────────────┐
 │                                                       │
 │ + Added: US-5 "OAuth2 provider integration"           │
 │ ~ Changed: US-1 login flow now uses OAuth2            │
 │ - Removed: FR-012 basic password hashing              │
 │                                                       │
 │ 4 stories -> 5  |  24 FRs -> 22                       │
 └───────────────────────────────────────────────────────┘
```

### Back navigation

Press `b` to go back:
- During plan review → back to spec review
- During review gate → back to plan review

If you change the spec after going back, the plan and tasks regenerate automatically.

### Review gate

Before implementation starts, you see a summary:

```
 ┌─ [REVIEW] Ready to implement ─────────────────────────┐
 │                                                        │
 │ 10 tasks | mode: normal | claude-code + qwen2.5:7b     │
 │                                                        │
 │  1. Create auth middleware          create  src/mid... │
 │  2. Add JWT validation              modify  src/uti... │
 │  3. Login endpoint                  create  src/rou... │
 │  ...                                                   │
 │                                                        │
 │ [Enter] start  [b] back to plan  [Tab] change mode     │
 └────────────────────────────────────────────────────────┘
```

## Dialog-Style Cards

Events display as bordered cards with flow arrows:

```
 ┌─ planner ─────────────────────────────────────────────┐
 │ Researching codebase...                                │
 │ Found: Express.js, JWT patterns, 3 auth-related files  │
 └────────────────────────────────────────────────────────┘
           │
           ▼  task >> implementer
           │
 ┌─ implementer · T3: Login endpoint ────────────────────┐
 │ model: qwen2.5-coder:7b                               │
 │                                                        │
 │ src/routes/auth.ts                                     │
 │  + router.post('/login', async (req, res) => {         │
 │                                                        │
 │ validate: tsc * lint * test x (1 failing)              │
 └────────────────────────────────────────────────────────┘
           │
           ▲  escalate << planner
           │
 ┌─ planner · hint ──────────────────────────────────────┐
 │ "validateJWT throws instead of returning null.         │
 │  Wrap in try/catch at auth.ts:15."                     │
 └────────────────────────────────────────────────────────┘
```

- `*` = pass, `x` = fail
- Planner cards in blue/cyan, implementer in green, escalation in yellow
- Completed tasks collapse to one line
- No emoji — pure ASCII and box-drawing characters

## Supervised Mode

In supervised mode, you control each task:

**Before implementation:**
```
 ┌─ [TASK 3/10] Login endpoint ───────────────────────────┐
 │ Action: create src/routes/auth.ts                       │
 │ Deps: T1 (auth middleware), T2 (JWT validation)         │
 │                                                         │
 │ [Enter] implement  [s] skip  [e] edit                   │
 └─────────────────────────────────────────────────────────┘
```

**After implementation:**
```
 ┌─ implementer · T3 ────────────────────────────────────┐
 │ ... diff ...                                           │
 │ validate: tsc * lint * test *                           │
 │                                                        │
 │ [Enter] commit  [d] diff  [r] retry  [s] skip  [e] edit│
 └────────────────────────────────────────────────────────┘
```

## Keyboard Shortcuts

Press `?` at any time to see available shortcuts for the current context.

## Footer

```
 T3/10 | [N] | Local: 87% | $0.02 | ~$1.40 saved | qwen:7b
```

Shows: task progress, mode indicator, local rate, cost, savings, model.
