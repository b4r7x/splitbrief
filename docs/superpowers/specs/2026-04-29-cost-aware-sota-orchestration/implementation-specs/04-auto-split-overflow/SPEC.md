# 04 - Auto-Split Overflow

> Self-contained implementation spec for one fresh AI context.
> This is one of seven implementation contexts for the cost-aware SOTA orchestration pack.
> Depends on spec 02. Can consume spec 03 output if available.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Optionally split tasks that do not fit cheap implementer context.

This feature should reduce failed cheap runs. It must not rewrite the entire plan or act like a hidden planner.

## Required Skills

Use these skills:

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `plan-writing`

Use `code-audit` only as a checklist. Do not run the full audit unless the user explicitly asks.

## Read First

1. `CLAUDE.md`
2. `docs/TASK-CONTRACT.md`
3. `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
4. deterministic estimate implementation from spec 02
5. existing task parser/writer/compiler files
6. existing plan/brief review flow
7. tests around task parsing, brief quality, and plan review.

## Owned Files

Primary ownership:

- task split service under existing task compilation/orchestrator area,
- integration point that shows split result before execution,
- tests around targeted splitting.

Do not edit:

- worktree code,
- summary UI,
- profile doctor policy,
- unrelated plan editor refactors.

## Functional Requirements

### ASO-001 - Off By Default

Auto-split must be opt-in.

Suggested config:

```text
autoSplitOverflow: false
```

Use existing config style if there is a better place.

### ASO-002 - Target Only Overflow/High-Risk Tasks

Split only tasks that deterministic estimate marks as:

- overflow,
- tight with low confidence,
- explicitly flagged by planner estimate review as split-suggested.

Do not split every task.

### ASO-003 - Preserve Intent

Child tasks must preserve:

- parent task intent,
- acceptance criteria,
- file ownership,
- dependencies,
- validation expectations.

Add parent-child metadata if the existing task model can support it safely. If not, encode parent id in task title/description using existing task contract style.

### ASO-004 - Review Before Execution

User must see split output before implementation starts.

No silent plan rewrite.

### ASO-005 - Skip Bad Splits With Trace

Skip the automatic split and inform the user if splitting would:

- create too many tiny tasks,
- remove acceptance criteria,
- lose dependencies,
- produce empty child tasks,
- duplicate the same file ownership across many children.

This must not be treated as rejecting the original task. The original task should continue unless normal routing/recovery later requires a different action.

The skipped split must leave a trace:

- user-visible warning/info before implementation continues,
- task id,
- reason,
- statement that the original task is still being kept,
- session event or artifact metadata suitable for later trace/explain output.

If some tasks are split and other targeted tasks are skipped, the user must see both:

- the split task preview before execution,
- the skipped-split notices before execution.

## Split Heuristics

Use simple deterministic rules first:

- split by independent file groups,
- split by independent acceptance criteria,
- split docs/tests only if they are real separate work,
- keep setup/core/UI/tests together when separating them would make context worse,
- do not split a task that already fits.

Do not invent an AI planner here. This spec is deterministic auto-split plus optional consumption of planner-review suggestions.

## Implementation Steps

1. Inspect existing task model and parser.
2. Define minimal split result type.
3. Use deterministic estimate to select candidate tasks.
4. Implement safe split heuristics.
5. Surface split preview in existing plan/brief review flow.
6. Add tests.

## Test Requirements

Required behavior tests:

- feature is off by default,
- overflow task is split when enabled,
- fitting task is not split,
- acceptance criteria survive,
- dependencies survive or are explicitly rewritten,
- unsafe split is skipped with a visible non-blocking reason,
- partial success reports both split previews and skipped split notices,
- split output is reviewable before execution.

Do not add tests for private string helpers if public behavior covers them.

## Validation

Run targeted task parser/compiler/split tests.

Then run:

```bash
npm run typecheck
npm run lint
```

## Anti-Slop Checks

Before finishing:

- no full plan rewrite,
- no hidden planner call,
- no silly tiny child tasks,
- no lost acceptance criteria,
- no silent skipped split,
- no blocking merely because deterministic auto-split was unsafe,
- no worktree implementation,
- no broad plan editor refactor.

## Agent Prompt

```text
Implement spec 04 Auto-Split Overflow from docs/superpowers/specs/2026-04-29-cost-aware-sota-orchestration/implementation-specs/04-auto-split-overflow/SPEC.md.
You are not alone in the codebase. Do not revert edits made by others.
Own only the files listed in the spec unless a narrow adjacent edit is necessary.
Do not run git add, git stage, git commit, or git stash.
Keep auto-split opt-in and targeted. Use behavior tests only.
Report changed files, validation, skipped validation, risks, and git confirmation.
```
