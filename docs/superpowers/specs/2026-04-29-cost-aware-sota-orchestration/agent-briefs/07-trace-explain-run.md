# 07 - Trace Explain Run

> Proposed implementation brief for a fresh, cheap AI context.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You add a compact explain surface for completed or in-progress sessions. It reads artifacts and metadata; it does not call an LLM.

## Required Skills

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `typescript`

Use `code-audit` only as a checklist if needed. Do not run a full audit.

## Read First

- `CLAUDE.md`
- session artifact docs,
- `src/engine/orchestrator/review-packet.ts`
- summary/review artifact writers,
- existing CLI command patterns under `src/cli/commands/`.

## Primary Write Scope

Own trace/explain files:

- explain service under the existing session/orchestrator artifact ownership area,
- CLI command wiring if it follows existing command patterns,
- docs for explain output,
- trace/explain tests.

Ask coordinator before editing task execution or planner prompts.

## Requirements

Explain output should include:

- routing choices,
- context-fit fallback and confidence,
- cost estimate confidence,
- retries or escalations,
- review gates triggered,
- warnings suppressed during normal start,
- links/paths to relevant artifacts.

It should not:

- call an LLM,
- dump huge task or plan bodies,
- duplicate the whole summary,
- mutate session state.

## Output Modes

Prefer:

- human-readable CLI output,
- optional JSON if existing command style supports it.

Keep formatting separate from the pure explanation builder.

## Tests

Add behavior tests for:

- explanation from fixture artifacts,
- missing cost data handled gracefully,
- fallback context explanation,
- no mutation of artifacts,
- JSON output if implemented.

## Validation

Run targeted trace/explain tests, then:

```bash
npm run typecheck
npm run lint
```

## Expected Report

Include changed files, explain behavior, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
