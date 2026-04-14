---
name: diptych-add-feature
description: Design flow for a new feature that is not yet covered by any spec in plans/. Use when the user wants to add a feature to diptych, extend the workflow, add a new backend, or change an architectural decision. Produces a new plans/<NNN>-<slug>/ folder with spec.md, plan.md, tasks.md — not code.
---

# Add a new feature to diptych

This skill designs a new feature by producing a new spec under `plans/`. It does **not** implement the feature. Use `diptych-implement-spec` for that, after the user reviews and approves the spec.

## Prerequisites

Read if not already loaded:

- `CLAUDE.md`
- `docs/CONCEPTS.md`
- `docs/ARCHITECTURE.md`
- `docs/WORKFLOW.md`
- `docs/FUTURE.md`
- `plans/README.md`

Without these, the produced spec will duplicate or contradict existing decisions.

## Step 1 — Understand the ask

Talk with the user. Do not jump to a proposal. Ask:

1. What problem does the feature solve? (Not "what does it do" — "why does it exist".)
2. Who feels the pain today? What do they do now as a workaround?
3. What's the smallest thing that would solve 80% of this?
4. Is this already in `docs/FUTURE.md`? If yes, are we promoting it to implementation, or expanding it?
5. Does it touch the state machine, storage layout, or user-facing interaction? (These are load-bearing — changes here deserve extra discussion.)

Keep asking until you can state the feature in one sentence that both you and the user agree with.

## Step 2 — Check for conflicts

Before writing anything, grep:

- `docs/CONCEPTS.md` — is there a term that already covers this, or contradicts it?
- `docs/WORKFLOW.md` Part 2 "Still open" — is this one of the deferred items?
- `docs/FUTURE.md` — is this deferred with a different design in mind?
- `plans/` — is there an in-flight spec that overlaps?

Report conflicts to the user before proceeding. Wait for a decision.

## Step 3 — Decide the spec number

The next number after the highest existing folder in `plans/`. If the feature depends on a still-unimplemented earlier spec, note that dependency in the new spec's `plan.md` (do not invert the dependency order).

The slug is `kebab-case-description`. Keep under 40 chars.

## Step 4 — Write `spec.md`

Use the same section structure as existing specs (see `plans/001-capability-matrix/spec.md` for the template). Required sections:

- **Problem** — the status quo and why it's bad
- **Goal** — one paragraph describing the target
- **User stories** — 2-4 bullet stories, concrete
- **Functional requirements** — numbered FR-001, FR-002, …; each testable
- **Success criteria** — grep-ables, manual smoke-tests, or concrete assertions
- **Non-goals** — explicit scope exclusions

Reference existing concepts by name (link to `docs/CONCEPTS.md` if a term is load-bearing).

## Step 5 — Write `plan.md`

Sections:

- **Data model** — any schema / type changes, exact file paths, diff-like before/after where illuminating
- **Architecture** — how the feature fits into the existing layers (engine / ui / stores / CLI); what new modules are needed; what existing modules change
- **Code paths to change** — enumerate the files and specific functions touched
- **Dependencies** — which earlier specs must be merged; which later specs consume this
- **Risk** — known trade-offs, race conditions, failure modes
- **Success verification** — concrete commands and manual steps

Sharp is better than thorough. Prefer specific file paths and function names to hand-wavy prose.

## Step 6 — Write `tasks.md`

Atomic tasks numbered `T001`, `T002`, … grouped into phases. Each task must include:

- File(s) it touches
- Exact change (code snippet or diff-like description)
- Verification (usually `npm run typecheck` or a specific test file)

End with a **Phase N — Doc Sync** section containing one task per doc file that will need to change (CONCEPTS / ARCHITECTURE / WORKFLOW, sometimes FUTURE or README).

Tasks must be executable by an agent with no other context. Assume they read only `CLAUDE.md` + the docs + this spec.

## Step 7 — Update `plans/README.md`

Add a row to the "9 planned specs" table with the new number. Update the dependency graph ASCII art. If the new spec is numbered after 009, consider that 009 is the "finalization" spec and everything after 009 is really a follow-up — ask the user whether to renumber 009 or to leave it and use 010+ for follow-ons.

## Step 8 — Review with the user

Before finishing, summarize:

- Spec number + slug
- One-sentence goal
- Number of tasks
- Dependencies on earlier specs
- Files touched count
- Estimated complexity (S / M / L based on task count)

Wait for user feedback. Revise based on comments.

## Constraints

- Do **not** implement anything. This skill only produces spec files.
- Do **not** modify `docs/` in this skill — docs are updated only during implementation (Doc Sync phase of the target spec).
- Do **not** commit or stage.
- Do **not** propose feature flags, A/B rollouts, or gradual migration unless the user explicitly asks. Direct implementation is the default.
- Do **not** add error handling, validation, or abstractions beyond what the feature strictly requires (project value — see `CLAUDE.md`).

## When to say no

If the user asks for a feature that contradicts the project identity:

- Multi-agent coordination (we have exactly two roles)
- Parallel task execution (tasks are sequential)
- Tool-call output from the implementer (small models can't produce it reliably)
- Implementer mid-task interjection (small models lose coherence)
- Non-TypeScript language support (validator pipeline is TS-shaped)
- Windows-specific features (not tested)

…stop and explain, pointing to the relevant section of `docs/VISION.md` or `docs/ARCHITECTURE.md` → "What is deliberately not in this repo". Do not paper over the conflict.
