# 07 - Trace Explain Run

> Self-contained implementation spec for one fresh AI context.
> This is one of seven implementation contexts for the cost-aware SOTA orchestration pack.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add a compact no-LLM explanation surface for a run.

The user should be able to ask: "why did diptych route this task this way, why was this cost unknown, and what happened?"

## Required Skills

Use these skills:

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `typescript`

Use `code-audit` only as a checklist. Do not run the full audit unless the user explicitly asks.

## Read First

1. `CLAUDE.md`
2. session artifact docs
3. `src/engine/orchestrator/review-packet.ts`
4. `src/engine/orchestrator/summary.ts`
5. existing session artifact readers/writers
6. existing CLI command patterns under `src/cli/commands/`
7. tests around summary/review/session artifacts.

## Owned Files

Primary ownership:

- explain service under existing session/orchestrator artifact ownership area,
- CLI command wiring if it follows existing command patterns,
- docs for explain output,
- trace/explain tests.

Do not edit:

- task execution logic,
- planner prompts,
- auto-split logic,
- readiness policy except to read its existing artifact output.

## Functional Requirements

### TER-001 - No LLM Calls

Trace/explain reads artifacts and metadata only.

No planner call. No implementer call. No provider call.

### TER-002 - Explain Decisions

Output should explain:

- routing choices,
- selected implementer/profile,
- context fit,
- context fallback/confidence,
- unknown pricing,
- cost estimate confidence,
- retries/escalations,
- task review gates,
- warnings that were silent during normal start,
- paths to relevant artifacts.

### TER-003 - Compact Output

Do not dump:

- full plan,
- full task briefs,
- full session log,
- source code.

Reference artifact paths instead.

### TER-004 - JSON If Easy

If existing CLI commands support `--json`, add JSON. If this would be a broad CLI refactor, keep human-readable output and document JSON as future work.

### TER-005 - Read-Only

Explain must not mutate session state.

## Suggested Output

Human-readable shape:

```text
Run explain

Cost:
- actual: ...
- baseline: ...
- savings: ...

Routing:
- T001 -> local-small: fits, explicit context length
- T002 -> cheap-api: tight, unknown price

Review:
- task review: disabled
- final review: created

Artifacts:
- summary: ...
- review packet: ...
```

Use existing terminology where possible.

## Implementation Steps

1. Inspect summary/review packet artifact shape.
2. Add pure explain builder.
3. Add formatter for human-readable output.
4. Wire CLI command only if it fits existing command patterns.
5. Update docs for usage.
6. Add fixture-based tests.

## Test Requirements

Required behavior tests:

- explanation from fixture artifacts,
- missing cost data handled gracefully,
- fallback context explanation visible,
- unknown pricing explanation visible,
- no mutation of artifacts,
- JSON output if implemented.

Do not add tests for private string helpers if CLI output covers them.

## Validation

Run targeted trace/explain tests.

Then run:

```bash
npm run typecheck
npm run lint
```

## Anti-Slop Checks

Before finishing:

- no LLM call,
- no artifact mutation,
- no huge dump,
- no new event system,
- no duplicate summary builder,
- docs match actual command behavior.

## Agent Prompt

```text
Implement spec 07 Trace Explain Run from docs/superpowers/specs/2026-04-29-cost-aware-sota-orchestration/implementation-specs/07-trace-explain-run/SPEC.md.
You are not alone in the codebase. Do not revert edits made by others.
Own only the files listed in the spec unless a narrow adjacent edit is necessary.
Do not run git add, git stage, git commit, or git stash.
No LLM calls. Read artifacts only. Use behavior tests only.
Report changed files, validation, skipped validation, risks, and git confirmation.
```
