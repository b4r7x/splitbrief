# 03 - Planner Estimate Review

> Self-contained implementation spec for one fresh AI context.
> This is one of seven implementation contexts for the cost-aware SOTA orchestration pack.
> Depends on spec 02.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Let the user optionally ask the smart planner to critique the deterministic estimate.

Default must remain deterministic and cheap. This planner review exists only when the user chooses to spend extra planner tokens.

## Required Skills

Use these skills:

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `prompt-engineering` or `senior-prompt-engineer` if available.

Use `code-audit` only as a checklist. Do not run the full audit unless the user explicitly asks.

## Read First

1. `CLAUDE.md`
2. deterministic estimate implementation from spec 02
3. existing planner prompt modules
4. existing config/schema patterns
5. `src/engine/orchestrator/review-packet.ts`
6. tests around planner prompts and review packets.

## Owned Files

Primary ownership:

- planner estimate review packet builder under `src/engine/orchestrator/`,
- planner prompt/module using existing planner prompt patterns,
- config/schema flag for opt-in planner review,
- tests for opt-in behavior and packet shape.

Do not edit:

- auto-split mutation,
- task loop execution,
- profile doctor policy,
- summary UI.

## Functional Requirements

### PER-001 - Off By Default

Planner estimate review must not run by default.

Suggested config shape:

```text
plannerEstimateReview: false
```

If the repo already has a better config namespace, use it. Keep the meaning simple: `false` by default, `true` means ask planner to review estimate.

### PER-002 - User Pays Consciously

The UI/CLI should make clear this is an extra planner call.

Do not hide the cost under normal deterministic estimate.

### PER-003 - Compact Packet

Planner packet should include:

- deterministic estimate totals,
- task ids/titles,
- context fit,
- selected profile,
- unknown price/context warnings,
- overflow/tight tasks,
- user-selected profiles/modes.

It should not include:

- full repo map,
- full source code,
- huge task bodies unless needed,
- full previous session logs.

### PER-004 - Review Classification

Planner output should parse into one of:

- `ok`
- `split-suggested`
- `risk`
- `needs-user-decision`

Each result should include:

- affected task ids,
- short reason,
- recommended user decision.

### PER-005 - No Silent Model Reassignment

Planner can recommend using a stronger implementer, but diptych must not silently switch models outside existing user-configured routing behavior.

The user decides.

## Prompt Requirements

Prompt the planner to answer:

- Is the deterministic estimate likely enough?
- Which tasks are likely too big for the selected cheap implementer?
- Which tasks are risky for a weak implementer?
- Should any task be split?
- Is a user decision required before spending?

Keep response structured and short.

## Failure Behavior

If planner review fails:

- keep deterministic estimate,
- show planner review unavailable,
- do not block execution unless the user explicitly required planner review.

## Test Requirements

Required behavior tests:

- default config does not trigger planner review,
- opt-in builds planner packet,
- packet is compact and task-focused,
- planner review parses known classifications,
- planner failure falls back to deterministic estimate,
- extra planner call is visible in user-facing output or metadata.

Avoid giant prompt snapshots unless the repo already uses that style.

## Validation

Run targeted planner estimate tests.

Then run:

```bash
npm run typecheck
npm run lint
```

## Anti-Slop Checks

Before finishing:

- no default planner call,
- no full repo dump in prompt,
- no silent model reassignment,
- no broad plan rewrite,
- no brittle huge snapshots.

## Agent Prompt

```text
Implement spec 03 Planner Estimate Review from docs/superpowers/specs/2026-04-29-cost-aware-sota-orchestration/implementation-specs/03-planner-estimate-review/SPEC.md.
You are not alone in the codebase. Do not revert edits made by others.
Own only the files listed in the spec unless a narrow adjacent edit is necessary.
Do not run git add, git stage, git commit, or git stash.
Keep planner review opt-in and compact. Use behavior tests only.
Report changed files, validation, skipped validation, risks, and git confirmation.
```
