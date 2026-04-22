# Product Brief

## Product statement

Diptych is a **cost-aware task compiler for AI coding agents**.

The planner is the expensive reasoning step. The implementer is the cheaper execution step. Diptych exists to keep those two jobs separated and to make the handoff explicit enough that users can trust the result.

## Problem

AI coding work tends to waste tokens in three ways:

1. The system reasons too much about trivial changes.
2. The system executes without a stable contract, so follow-through is noisy.
3. The system reports progress without producing usable evidence.

Diptych solves this by compiling a user request into a Task Brief, then executing that brief with validation and escalation rules.

## Core artifact

The **Task Brief** is the core product artifact.

A Task Brief should answer, in a compact and durable form:

- what needs to change,
- why it matters,
- the intended scope and constraints,
- which files or areas are in play,
- how success will be validated,
- when the implementer should escalate instead of guessing,
- what final evidence must be produced.

Specs are optional. When work is large, risky, ambiguous, or cross-cutting, a spec can be created to support the Task Brief. For smaller work, the Task Brief alone is enough.

## Product goals

- Keep planner cost proportional to task risk.
- Preserve a stable contract between planner and implementer.
- Make validation and escalation part of the workflow, not an afterthought.
- Produce final evidence that a human can review quickly.
- Keep the common path short for small work and the rigorous path available for larger work.

## Non-goals

- Full autonomy without human review.
- Endless planning artifacts that do not change execution quality.
- A single preset that tries to fit every kind of work.
- Turning every request into a spec-first process.

## Workflow model

1. User provides a request.
2. Diptych chooses a mode or enters a spec flow when the work is large enough.
3. The planner compiles the request into a Task Brief, optionally after gathering more context.
4. The implementer executes the brief.
5. Diptych validates the result, retries when appropriate, escalates when necessary, and records evidence.

## Output expectations

The product should leave behind enough evidence to answer three questions:

- What was asked for?
- What changed?
- Why should we trust the result?

