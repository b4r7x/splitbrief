# Execution Order

Status: executed as of 2026-04-29.

Use GPT-5.5 with reasoning `xhigh` for each pack coordinator.

## Order

1. `2026-04-28-run-readiness-doctor`
2. `2026-04-28-plan-review-trust`
3. `2026-04-28-recovery-flow`
4. `2026-04-28-checkpoint-review-packet`

## Why This Order

1. Run Readiness creates the pre-run signals and session evidence that later packs consume.
2. Plan Review Trust uses readiness/routing/context posture before execution approval.
3. Recovery Flow uses readiness, routing, validation, conflict, and review semantics to stop safely.
4. Checkpoint Review Packet packages the final session evidence after readiness, review, and recovery exist.

## Execution Rule For Every Pack

- Coordinator model: `GPT-5.5`, reasoning `xhigh`.
- Use subagents for implementation slices and audits so the main context stays small.
- Same-checkout writer subagents must run sequentially.
- Read-only audit subagents may run in parallel.
- Parallel source implementation is allowed only in isolated worktrees or equivalent sandboxes.
- For each pack, use that pack's `execute-prompt.md`.

## Required Loop

This was the required loop for each pack:

1. Paste the pack's `execute-prompt.md` into a fresh implementation context.
2. Coordinator reads the required docs and dispatches the first bounded worker brief.
3. Worker implements only its owned slice.
4. Coordinator runs targeted validation.
5. Coordinator dispatches read-only audit subagent(s).
6. If audit finds blocker/strong issues, fix with a bounded worker or small coordinator patch.
7. Repeat validation and audit until PASS.
8. Run final validation for the pack.
9. Only then start the next pack.

Do not merge the four packs into one giant context.
