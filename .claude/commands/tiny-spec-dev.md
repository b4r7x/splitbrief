---
name: tiny-spec-dev
description: Use at the start of any tiny-spec development session to understand the project, its architecture, strategic decisions, and what NOT to build. Load this before doing any work on the codebase.
---

# tiny-spec Development Context

## What Is This Project

tiny-spec is a **cost-optimized AI coding orchestrator**. It splits work between an expensive planner (Claude Code / Opus) and a cheap implementer (Ollama / local models), saving 50%+ on AI coding costs.

**Flow**: Feature description → Planner researches codebase & may ask clarifying questions → Creates spec/plan/tasks → User approves (approve, edit, comment, quit) → Implementer codes each task → Validation (tsc → lint → test) → Retry up to 3x → Escalate to planner if stuck → Commit per task → Final planner review.

## Read These Files First

1. **`CLAUDE.md`** — Tech stack, code conventions, project structure, all commands
2. **`docs/VISION.md`** — Strategic direction, competitive analysis, what we build and what we DON'T, known problems
3. **`.specify/memory/constitution.md`** — 6 constitutional principles governing all decisions (v1.1.0)

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

- **TUI**: Split-pane Ink 5.x + @inkjs/ui (left: planner, right: implementer)
- **Conversational planning**: Planner can embed `<!-- Q:{JSON} -->` markers in stream; `question-parser.ts` extracts them; `question-prompt.tsx` displays options in TUI
- **Auto-detection**: `planner-detection.ts` discovers available planners and running implementer endpoints; `picker.tsx` lets user choose interactively
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
| Principle VI: Identity & Anti-Goals | Constitutional guard against scope creep toward generic multi-agent orchestration |

## What NOT to Build (Constitution Principle VI)

These are **constitutional anti-goals** — reject any proposal that moves toward them:

- **Universal AI connector** — we optimize cost, not connect arbitrary tools
- **Multi-agent orchestration** — we have 2 fixed roles, not N dynamic agents
- **Tool call support for implementer** — small models can't handle it
- **Features that blur the planner/implementer boundary** — the two-role split is the core identity
- **Features that increase Opus token usage** without proportional quality gain

## Code Conventions (Summary)

- TypeScript 5.9+, ESM only, `.js` extensions in imports
- Zero classes — pure functions only
- No unnecessary comments — code is self-explanatory
- Error at boundaries — internal functions propagate, callers decide
- JSX for Ink components (`.tsx`), plain TS for everything else (`.ts`)

## Current Status

- **v0.1**: Done (45 tasks)
- **v0.2**: In progress on `004-token-dashboard-integration-tests`
- **v0.3**: In progress on `006-conversational-planning` (47 tasks implemented, known problems discovered)
- **Active specs**: `specs/003-*` (fixes), `specs/004-*` (tokens), `specs/006-*` (conversational planning)
- **Historical specs**: `specs/001-*`, `specs/002-*` (reference only, don't modify)
