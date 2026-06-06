---
name: diptych-dev
description: Use at the start of any diptych development session to understand the project, its architecture, strategic decisions, and what NOT to build. Load this before doing any work on the codebase.
---

# diptych Development Context

## What Is This Project

diptych is a **cost-optimized AI coding orchestrator** with a **two-role architecture**. It splits work between an expensive planner (Claude Code / Opus) and a cheap implementer (Ollama / local models), saving 50%+ on AI coding costs. The collaboration between roles is made **visible and satisfying** through a conversation-flow TUI.

**Flow**: Feature description → Planner researches codebase & may ask clarifying questions → Creates spec/plan/tasks → User approves (approve, edit, comment, quit) → Implementer codes each task → Validation (tsc → lint → test) → Retry up to 3x → Escalate to planner if stuck → Commit per task → Final planner review.

## Read These Files First

1. **`CLAUDE.md`** — Tech stack, code conventions, project structure, all commands
2. **`docs/VISION.md`** — Strategic direction, competitive analysis, what we build and what we DON'T
3. **`.specify/memory/constitution.md`** — 6 constitutional principles governing all decisions (v1.3.1)

## Architecture at a Glance

```
User → CLI (commander) → Orchestrator (main loop)
         ↓                    ↓              ↓
    Planner (subprocess)  Implementer    Validator
    6 backends + shell    OpenAI API     tsc/lint/test
         ↓                    ↓              ↓
    spec/plan/tasks       code text      pass/fail
         ↓                    ↓              ↓
    Escalator ←──── retry ←── fail       git commit ← pass
    (hints → full)
```

- **TUI**: Ink 6.8 (React 19) conversation flow with structured event cards
- **Event model**: `TuiEvent` union type — planner events (conversational), implementer events (structured tool-call cards), validation, git, escalation
- **Conversational planning**: Planner embeds `<!-- Q:{JSON} -->` markers → `question.ts` extracts → TUI displays inline
- **Auto-detection**: `detection.ts` discovers planners and implementer endpoints; `cli/picker.ts` for interactive selection
- **State**: JSON snapshot per transition → resume support
- **Zero classes**: Pure functions, module-scoped state, ESM only

## Key Source Layout

```
src/core/     — config, types/, theme, commands, shortcuts, state-persistence
src/cli/      — picker, render, workflow command handlers (non-React)
src/engine/   — orchestrator/, planners/, implementers/, spec/, validator, extractor (zero React deps)
src/screens/  — home, workflow, summary (top-level Ink screens)
src/ui/       — 17 Ink components (all themed via core/theme.ts)
src/hooks/    — 14 React hooks
src/utils/    — diff, format, fs, git, highlight, process, sessions, event-sections
```

All 72 test files are colocated (`foo.test.ts` next to `foo.ts`).

## Key Decisions — DO NOT Revisit

| Decision | Rationale |
|----------|-----------|
| Whole-file replacement (not diffs) | 7B models can't produce reliable diffs (26% vs 59% accuracy) |
| OpenAI chat API for default implementer | Universal, simple, works with any endpoint |
| Stop validation on first failure | Speed — don't waste time on cascading errors |
| Varied retry strategy (temp 0.3→0.5) | Different approaches prevent the model from repeating the same mistake |
| Two-tier escalation (hints → full) | Hints are cheap (~500 tokens); full impl is last resort (~5000 tokens) |
| No tool calls for implementer | Small models can't reliably produce tool call format |
| Conversation flow TUI (not dual-pane) | Research: devs prefer structured output; dual-pane hides collaboration |
| Stay on Ink 6.x | Known, works, React 19. OpenTUI later if perf demands it |
| Full callback replace (events not strings) | `TuiEvent` union replaces `plannerLines: string[]` |

## What NOT to Build (Constitution Principle VI, v1.3.1)

These are **constitutional anti-goals**:

- **Universal AI connector** — we optimize cost, not connect arbitrary tools
- **Multi-agent orchestration** — we have 2 fixed roles, not N dynamic agents
- **Tool call support for implementer** — small models can't handle it
- **Features that blur the planner/implementer boundary**

**What IS encouraged**: Beautiful visualization of the two-role orchestration (event cards, diff views, pipeline progress, cost tracking) is product differentiation, not scope creep.

## Code Conventions (Summary)

- TypeScript 6.x, ESM only, `.js` extensions in imports
- Zero classes — pure functions only
- No unnecessary comments — code is self-explanatory
- Error at boundaries — internal functions propagate, callers decide
- JSX for Ink components (`.tsx`), plain TS for everything else (`.ts`)
- Colocated tests — `foo.test.ts` next to `foo.ts`

## Current Status

- **v0.1**: Done (45 tasks)
- **v0.2**: Done — pluggable backends, token dashboard, integration tests
- **v0.3**: Done — conversational planning, TUI picker, agent-mode implementer, version detection
- **v0.4**: Done — TUI redesign (conversation flow, event model, collapsible diffs, pipeline bar, cost savings)
- **v0.5**: Done — OpenCode visual restructure (Ink 6/React 19, Shiki highlighting, theme system, engine/ui architecture)
- **v0.6**: Done — Core extraction (core/, cli/, types/), colocated tests, slash commands, skills, global keys
- 110 source files, 72 colocated test files
