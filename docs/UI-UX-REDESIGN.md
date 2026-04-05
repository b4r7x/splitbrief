# UI/UX Redesign (v0.8)

## Overview

Comprehensive TUI redesign based on research from 10+ competitive CLI tools (Claude Code, lazygit, k9s, Turborepo, Warp, Aider, Charm tools, Vercel CLI) and 5 rounds of critical UX analysis.

## Design Decisions & Rationale

### What We Built

| Feature | Decision | Rationale |
|---------|----------|-----------|
| Gutter system (`│` / `┆`) | Planner = solid `│` magenta, Implementer = dotted `┆` cyan with indent | Role differentiation via line style, not boxes. Boxes cause "box fatigue" with 10-60 events. |
| Progressive validation | Show `✓ tsc ✓ lint ⣾ test 3s` as each stage completes | Users see progress, not just final result. Per Evil Martians: "never show a bare spinner." |
| Spinner with context | Model name + elapsed time: `⣾ qwen2.5-coder:7b  generating...  4s` | Without timing, users can't tell if operations are stuck. |
| Feedback color split | Info = blue (`theme.info`), Error = red (`theme.error`) | Previously both used red, making info messages look like errors. |
| Input bar mode indicator | Border color: review = magenta, question = yellow | NN/G: "at least two visual indicators" for mode changes (placeholder text wasn't enough). |
| Review aliases | "yes"/"y"/"ok"/"lgtm" → approve, "no"/"reject" → quit | Users expected natural language, got silent failures. |
| Task summary file path | `✓ T3 JWT service  src/auth/jwt.ts  local 15s` | File path answers "what changed?" without expanding. |
| Diff discoverability | `▸ src/file.ts (+45 -0)  Ctrl+D` visible hint | Users didn't know diffs were expandable. |
| Scroll badge | `─── ↓ N new events ───` when scrolled up | Users missed events during scroll. Implicit follow/browse (no explicit mode). |
| Unified `/settings` | Merged ConfigPicker + SettingsOverlay into one | Had 3 overlays touching config — confusing. Now one command for everything. |
| `/mode` selector | 3-option picker with descriptions | Previously text-only, no discoverability. |
| Real-time cost | `cost-update` event from orchestrator → CostFooter | Was hardcoded to $0.00 during entire workflow. |
| Home screen labels | "Planner", "Implementer", "Mode" with provider visible | "Model:" was ambiguous (planner or implementer?). |

### What We Explicitly Rejected

| Rejected Feature | Reason | Source |
|------------------|--------|--------|
| Browse mode (cursor on event cards) | Mode trap. tmux copy mode has same problem — users get stuck. 6 modes in one screen is too many. | NN/G modes research, tmux scrollback issues |
| Detail view (expand prompt/response) | Raw prompts are developer-of-tool info, not user info. Users need diffs and errors, not system prompts. | Chrome DevTools "progressive disclosure" pattern |
| Footer keybinding hints row | Wastes vertical space. On 80x24 terminal, 5-6 rows of chrome leaves only 18 rows for content. Claude Code/Vim/tmux don't show hints. | btop/lazygit analysis |
| Bordered boxes for implementer | With 10-60 boxes in a flow, borders lose signaling value ("box fatigue"). Gutter lines are lighter. | gh run watch analysis |
| Tab-switching model picker | Planner tool vs implementer model aren't comparable. NN/G: tabs work for "parallel, comparable content." | Nielsen Norman Group tabs research |
| Provider chain in header | `cc → ollama:qwen2.5` is insider knowledge. Home screen already shows full config. | Full UX audit agent |
| Sidebar default visible | Duplicates header pipeline bar + footer cost. Only useful on demand (Ctrl+E). | Turborepo analysis |
| Rotating spinner verbs | Claude Code's pattern. Explicitly rejected by stakeholder. | Stakeholder decision |

## Visual Language

```
Planner (flush-left, solid gutter):
│ planner  ● researching  3.1s
│   Analyzing project structure...

Implementer (indented, dotted gutter):
  ┆ qwen2.5-coder:7b  ⣾ generating...  4s
  ┆ validate  ✓ tsc  ✓ lint  ✓ test  1.8s
  ┆ committed  feat: add jwt service

Escalation (gutter switches to planner):
│ escalate  tier 1 — hint
│   Use bcrypt.compare() instead of ===

Completed task (1 line):
✓ T3 JWT service  src/auth/jwt.ts  local 15s

Diff (collapsed with hint):
  ┆   ▸ src/auth/jwt.ts (+45 -0)  Ctrl+D

Footer (3 metrics):
Task 4/7 │ Local: 73% │ Saved: ~$1.22
```

## Architecture Changes

### New Files
- `src/components/gutter.tsx` — Gutter wrapper component (planner/implementer/escalation roles)
- `src/components/mode-selector.tsx` — 3-option workflow mode picker overlay

### Deleted Files
- None (ConfigPicker kept as fallback via `'picker'` overlay type → now routes to SettingsOverlay)

### Modified Files (key changes)

| File | Changes |
|------|---------|
| `event-card.tsx` | Gutter wrapping, progressive validation, cost-update handling |
| `spinner.tsx` | Added `startTime` prop with elapsed time tracking |
| `settings-overlay.tsx` | Added planner/implementer picker fields, sub-picker overlay, immediate apply |
| `commands.ts` | `/config` → settings, `/mode` → selector overlay, `/planner` + `/implementer` → pickers |
| `workflow.ts` (store) | Added `tokenUsage` field, handles `cost-update` events |
| `events.ts` (types) | Added `cost-update` TuiEvent type |
| `helpers.ts` | `addUsageAndSave` now optionally emits `cost-update` events |
| `validator.ts` | Added `onStageComplete` callback for progressive validation |
| `cost-footer.tsx` | Trimmed to 3 metrics: task/local%/saved |
| `input-bar.tsx` | Feedback color from isError flag + mode-based border color |
| `home.tsx` | Config block with clear role labels |
| `use-workflow.ts` | Review aliases (yes/y/ok/lgtm/reject/no) |
| `event-sections.ts` | Forward file path to completed-task summaries |
| `task-summary.tsx` | Added file prop, dropped comma separators |
| `conversation-flow.tsx` | Scroll badge, scrollToBottom handle |
| `diff-view.tsx` | ▸/▾ disclosure triangles + Ctrl+D hint |
| `overlay.ts` | Added `focus` field for auto-navigation |
| `ui.ts` (types) | Added `mode-selector` overlay type, focus param on openOverlay |

### Cost Data Pipeline

```
Orchestrator (task-loop/planning/escalation)
  → addUsageAndSave(... callbacks)
    → emits cost-update TuiEvent with TokenUsage
      → workflowStore.addEvent() stores tokenUsage
        → workflow.tsx reads tokenUsage from store
          → calculateCostBreakdown() computes savings
            → CostFooter displays real-time: Saved: ~$X.XX
```

### Settings Unification

```
Before: /config → ConfigPicker (dual-panel), /settings → SettingsOverlay (scalar fields)
After:  /config = /settings → SettingsOverlay (all fields including planner/implementer pickers)
        /planner → PlannerPicker (two-column: backend + model)
        /implementer → ImplementerPicker (two-column: provider + model)
        /mode → ModeSelector overlay (3 options with descriptions)
```

## Research Sources

Key research that informed decisions:
- Claude Code source analysis (rendering, spinner patterns, collapsed tool groups)
- lazygit, k9s, Turborepo (settings patterns, footer hints, split-pane)
- Evil Martians CLI UX (progress display patterns, spinner context)
- NN/G (modes, response time thresholds, tabs research)
- clig.dev (CLI interface guidelines)
- Smashing Magazine (agentic AI UX patterns)
- Stack Overflow 2025 (AI trust gap: 84% use, 29% trust)
