# 01 - Detach and Approval Semantics

> Fresh AI context brief. Implement only this change. Never stage, commit, or stash.

## Goal

Make detached workflows semantically equivalent to inline workflows, and make tiered approvals protect the worktree before writes are applied.

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md`
- `docs/superpowers/specs/2026-04-26-tiered-approval-gates/README.md`
- `docs/superpowers/specs/2026-04-26-tiered-approval-gates/decisions.md`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/implementers/types.ts`
- `src/engine/implementers/base.ts`
- `src/engine/ipc/protocol.ts`
- `src/engine/ipc/server-entry.ts`
- `src/engine/ipc/server.ts`
- `src/engine/ipc/client.ts`
- `src/features/workflow/hooks/use-ipc-client.ts`
- `src/features/workflow/hooks/use-workflow-keys.ts`
- `src/features/workflow/hooks/use-workflow-runner.ts`
- `src/cli.ts`
- `src/cli/commands/attach.ts`
- `src/cli/commands/ps.ts`

## Scope

**In bounds:**

- Detached server callback behavior for approval, external changes, clarification, budget, and continuation.
- IPC request/response messages for interactive decisions.
- `diptych detach` CLI command.
- `start --detach --worktree` compatibility in coordination with brief 06.
- Tiered approval ordering before user `pre_task` hooks and before writes are applied.
- Rejection context reinjection into planner when configured.
- Safe handling of git snapshot/diff helper failures during drift/approval analysis.

**Out of bounds:**

- Multi-client read-only fan-out.
- Remote attach over TCP/TLS.
- New runner implementations.
- Redesigning the TUI.

## Required Fixes

### 1. Detached server does not auto-answer interactive callbacks

Current detached server code must stop returning unconditional approval/empty answers for interactive callbacks. The server should:

- publish a pending IPC request with enough data for the attached TUI to render the same prompt,
- wait for a client response for interactive workflows,
- fail fast only for explicitly headless modes,
- record a clear event when no client is attached and a prompt is pending.

Prompts covered:

- spec/plan/brief approval,
- tiered approval,
- external changes,
- planner questions,
- budget pause/exceeded,
- continuation prompts.

### 2. Add `diptych detach`

Add a CLI command that detaches the currently attached client from a running session without killing the server. It should match the 2026-04-26 detach spec and share protocol types with the TUI Ctrl-D path.

Expected behavior:

- sends the same detach message shape used by Ctrl-D,
- exits the client only,
- leaves the server visible in `diptych ps`,
- leaves the session attachable with `diptych attach <session-id>`.

### 3. Approval is pre-apply

Writes must be classified and approved before `applyCode` mutates files. Denied approval must leave the target file unchanged.

The final order for task execution is:

```text
classify intended write
run tiered approval
run user pre_task hooks
apply write
record evidence/events
```

If a runner cannot expose intended writes before application, it must write into a safe temporary/staging boundary and only promote changes after approval.

For implementers that produce a diff or file set before `applyCode`, changed-file approval must run after output is available but before state marks the task sent, validation runs, commits/checkpoints are created, or any file is mutated.

### 4. Rejection context is used

When approvals are rejected and `approval.feedRejectionsToPlanner` is enabled, production planner prompts receive the rejection summary. Existing helper functions must be wired, not left unused.

### 5. Drift/approval git helper failures warn, not abort

Snapshot and diff helper failures around drift and approval analysis must be caught and converted into warning events/artifacts. They must not abort the workflow unless the underlying write itself fails.

Approval gates should fail closed when they cannot classify a write because git status/diff information is unavailable. The error should describe the failed git intent, not just raw stderr.

## Acceptance Criteria

- `diptych start --detach` does not silently auto-approve any prompt that would require a user in inline mode.
- `diptych attach <id>` can answer pending approval/question/budget prompts.
- If no client is attached and an interactive prompt is pending, the server waits and records a pending-input event; explicitly headless mode fails closed.
- `diptych detach` exists and disconnects a client without stopping the server.
- Denying a sticky or confirm-tier write leaves the target file unchanged.
- Tiered approval runs before `pre_task` hooks.
- Rejection summaries are injected into the next planner call when enabled.
- Git snapshot/diff analysis failures emit warnings and continue.
- Git failures needed for approval classification fail closed with an actionable error.
- Existing inline `diptych start` behavior remains backward compatible.

## Tests

Add behavior tests covering:

- detached workflow emits and resolves a pending approval through IPC,
- no attached client does not auto-approve,
- `diptych detach` command sends the expected detach request,
- denied write does not modify a file,
- approval runs before pre hooks,
- rejection context appears in planner input,
- git diff helper failure emits warning and does not abort.

## Verification Commands

```bash
npm test -- src/engine/ipc src/cli/commands src/engine/orchestrator
npm run typecheck
npm run lint
npm test
```
