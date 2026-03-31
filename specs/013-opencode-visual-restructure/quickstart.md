# Quickstart: OpenCode Visual Restructure

## What Changes

1. **Visual**: TUI looks like opencode — dark backgrounds, left accent lines, syntax-highlighted diffs, no box borders on cards
2. **Structure**: `src/orchestrator/` → `src/engine/`, `src/tui/` → `src/ui/` (flat)
3. **Framework**: Ink 5 → 6.8, React 18 → 19
4. **New**: Shiki syntax highlighting, theme system

## What Stays the Same

- All 5 CLI commands (start, spec, init, status, resume)
- TuiEvent data model
- Orchestrator logic, planner backends, implementer backends
- Config format (.tiny-spec/config.yaml)
- State persistence (state.json, events.jsonl)
- All existing functionality

## After Restructure

```bash
npm run dev -- start "add user auth"   # Same command, new visuals
npm test                                # All tests pass (updated imports)
npx tsc --noEmit                       # Zero errors
```

## New Project Layout

```
src/
├── cli.ts, app.tsx, types.ts, config.ts, state.ts
├── engine/          # Business logic (zero React)
│   ├── orchestrator.ts, implementer.ts, validator.ts, escalator.ts
│   ├── planners/    # 8 planner backends
│   ├── implementers/# shell + agent backends
│   ├── spec/        # parser, formatter, templates
│   └── highlight.ts # Shiki singleton
├── ui/              # Ink components (flat, ~14 files)
│   ├── theme.ts     # Color palette
│   ├── layout.tsx, header.tsx, conversation-flow.tsx, ...
│   └── diff-view.tsx# Now with syntax highlighting
├── hooks/           # use-workflow, use-app-navigation
└── utils/           # git, fs, format, process, diff, version
```

## Visual Changes

Before (Ink 5, box borders):
```
┌─ tiny-spec │ feature │ ● res ● spec ◉ impl ○ rev │ 04:12 ─┐
│ ● Planner researching...                                     │
│ ⚡ implementer.generate(qwen2.5-coder:7b)  12s               │
│   → src/routes/auth.ts (+47 lines)                           │
│ Task 4/8 │ Local: 75% │ $0.02 │ Saved: ~$1.40               │
└──────────────────────────────────────────────────────────────┘
```

After (Ink 6, opencode style):
```
 tiny-spec │ feature │ ● res ● spec ◉ impl ○ rev │ 04:12

 ┃ Planner researching codebase...
 ┃ Found 12 relevant files, analyzing patterns...

 ✓ T1 auth middleware — local, 12s
 ✓ T2 JWT utils — local, 8s

 ─── T3: Login endpoint ───
 . implementer.generate(qwen2.5-coder:7b)    12s
   → src/routes/auth.ts (+47 -0)          [d] diff
 . validate(tsc, lint, test)                  ✓ 7s
 . git.commit("feat(auth): login endpoint")   1s

 Task 4/8 │ Local: 75% │ $0.02 │ Saved: ~$1.40 │ qwen2.5-coder:7b
```
