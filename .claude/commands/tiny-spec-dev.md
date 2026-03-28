---
name: tiny-spec-dev
description: Use at the start of any tiny-spec development session to understand the project, its architecture, strategic decisions, and what NOT to build. Load this before doing any work on the codebase.
---

# tiny-spec Development Context

## What Is This Project

tiny-spec is a **cost-optimized AI coding orchestrator** with a **two-role architecture**. It splits work between an expensive planner (Claude Code / Opus) and a cheap implementer (Ollama / local models), saving 50%+ on AI coding costs. The collaboration between roles is made **visible and satisfying** through a conversation-flow TUI.

**Flow**: Feature description → Planner researches codebase & may ask clarifying questions → Creates spec/plan/tasks → User approves (approve, edit, comment, quit) → Implementer codes each task → Validation (tsc → lint → test) → Retry up to 3x → Escalate to planner if stuck → Commit per task → Final planner review.

## Read These Files First

1. **`CLAUDE.md`** — Tech stack, code conventions, project structure, all commands
2. **`docs/VISION.md`** — Strategic direction, competitive analysis, what we build and what we DON'T
3. **`docs/NEXT.md`** — Current priorities, recent decisions, what to work on
4. **`.specify/memory/constitution.md`** — 6 constitutional principles governing all decisions (v1.3.0)

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

- **TUI**: Ink 5.x conversation flow with structured event cards (v0.4, implemented)
- **Event model**: `TuiEvent` union type — planner events (conversational), implementer events (structured tool-call cards), validation, git, escalation
- **Conversational planning**: Planner embeds `<!-- Q:{JSON} -->` markers → `question-parser.ts` extracts → TUI displays inline
- **Auto-detection**: `planner-detection.ts` discovers planners and implementer endpoints; `picker.tsx` for interactive selection
- **State**: JSON snapshot per transition → resume support
- **Zero classes**: Pure functions, module-scoped state, ESM only

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
| Stay on Ink 5.x | Known, works, React-based. OpenTUI later if perf demands it |
| Full callback replace (events not strings) | `TuiEvent` union replaces `plannerLines: string[]` |

## What NOT to Build (Constitution Principle VI, v1.3.0)

These are **constitutional anti-goals**:

- **Universal AI connector** — we optimize cost, not connect arbitrary tools
- **Multi-agent orchestration** — we have 2 fixed roles, not N dynamic agents
- **Tool call support for implementer** — small models can't handle it
- **Features that blur the planner/implementer boundary**

**What IS encouraged**: Beautiful visualization of the two-role orchestration (event cards, diff views, pipeline progress, cost tracking) is product differentiation, not scope creep.

## Code Conventions (Summary)

- TypeScript 5.9+, ESM only, `.js` extensions in imports
- Zero classes — pure functions only
- No unnecessary comments — code is self-explanatory
- Error at boundaries — internal functions propagate, callers decide
- JSX for Ink components (`.tsx`), plain TS for everything else (`.ts`)

## Current Status

- **v0.1**: Done (45 tasks)
- **v0.2**: Done — pluggable backends, token dashboard, integration tests
- **v0.3**: Done — conversational planning, TUI picker, agent-mode implementer, version detection
- **v0.4**: Done — TUI redesign (conversation flow, event model, collapsible diffs, pipeline bar, cost savings). 47 tasks, 402 tests.
- **Active specs**: `specs/008-tui-conversation-flow/` (implemented)
- **Historical specs**: `specs/001-*` through `specs/007-*` (reference only)
