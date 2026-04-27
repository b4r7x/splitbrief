# Decisions

## ADR-001 — Three-Tier Model: Auto / Sticky / Confirm

**Status:** accepted

### Context

A single "approve everything" gate makes low-risk writes tedious. A single "approve dangerous things" gate still misses the medium-risk out-of-scope writes that cause most real incidents. Three tiers balances friction against safety.

### Decision

```
Tier 1 — auto      : reads, writes within task scope, local validation commands
Tier 2 — sticky    : writes outside task.file + declared deps but within project root
Tier 3 — confirm   : rm -rf, git reset --hard, git push --force, network calls,
                     db migrations, package install/uninstall
```

- Auto: no prompt, no log entry.
- Sticky: prompt once per session per file-glob pattern. User picks `approve-once` / `approve-for-session` / `always-approve`. Choice is recorded to `.diptych/approvals.json`.
- Confirm: always prompt, require user to type the phrase `I confirm` plus a reason string. NEVER bypass with a sticky or always-approve grant.

### Consequences

- Low-risk writes are silent; UX is unchanged for normal tasks.
- Medium-risk writes are auditable without being disruptive.
- High-risk writes are opt-in per invocation with an explicit audit record.

---

## ADR-002 — Action Classification Taxonomy

**Status:** accepted

### Context

The gate needs a stable, testable action classification. The set must be exhaustive enough to catch real blast-radius scenarios and small enough to be understood without documentation.

### Decision

Seven action classes, each bound to a default tier:

| Class | Default Tier | Examples |
|---|---|---|
| `read` | auto | file reads, directory listings, `find`, `cat`, `ls` |
| `write_in_scope` | auto | writes to `task.file` and files declared in `task.dependsOn` tasks |
| `validation` | auto | `tsc`, `eslint`, `biome`, `vitest`, `npm test`, `npm run typecheck` |
| `write_out_of_scope` | sticky | writes to any project file not in `task.file` / declared deps |
| `destructive` | confirm | `rm -rf`, `git reset --hard`, `git clean -f`, `git push --force`, `git branch -D` |
| `network` | confirm | `curl`, `fetch`, `wget`, `npm publish`, external HTTP calls |
| `package_change` | confirm | `npm install`, `npm uninstall`, `pip install`, package-lock mutations |

The config `approval.tiers` map overrides the default tier assignment for any class.

### Consequences

- Classification is deterministic; the full fixture test matrix covers all seven classes.
- Users can promote `write_out_of_scope` to `confirm` or demote `package_change` to `sticky` in config.

---

## ADR-003 — "In Scope" Determination

**Status:** accepted

### Context

The classifier needs to decide whether a write is `write_in_scope` or `write_out_of_scope` given only the action description and the current task.

### Decision

A write is **in scope** if all of the following hold:
1. The target path equals `task.file` OR matches a path listed in the implementing files of any task in `task.dependsOn`.
2. The path is inside `projectDir` (no `..` traversal outside root).

`task.scope.inBounds` (when present) extends the in-scope set: any path that matches a glob in `inBounds` is in-scope.

Path matching is done with `node:path.resolve` + `String.startsWith(projectDir)` for root containment, and exact string equality for file matching. No glob expansion for the base case; `inBounds` entries use the `micromatch` package (already a transitive dep via Vitest).

### Consequences

- Simple and testable with path fixtures.
- `task.scope.inBounds` gives the planner a way to pre-declare multi-file write scope.
- Writes to tmp dirs inside `projectDir` are in-scope only if they appear in `inBounds`.

---

## ADR-004 — Sticky Approval Persistence

**Status:** accepted

### Context

The user's spec example showed sticky approvals inside `config.yaml`. That is wrong: `config.yaml` is user-authored; runtime mutation to it would surprise users and cause merge conflicts.

### Decision

Sticky and always-approve grants are stored in `.diptych/approvals.json` (project-level, not session-level). The shape is:

```ts
type ApprovalGrant = {
  pattern: string;         // file-glob or action-class string
  class: ActionClass;
  scope: 'session' | 'always';
  sessionId?: string;      // present when scope === 'session'
  grantedAt: string;       // ISO timestamp
};
```

- `scope: 'session'` grants expire when `sessionId` changes. The gate engine checks `sessionId` at runtime.
- `scope: 'always'` grants persist until explicitly cleared by `diptych approval clear`.
- `config.yaml` `approval.stickyApprovals` is removed from the config schema. Config controls policy (which classes go to which tier); the runtime store controls granted approvals.

### Consequences

- `config.yaml` remains user-controlled and VCS-safe.
- Runtime grants are project-scoped and survive TUI restarts.
- `diptych approval list` and `diptych approval clear` operate on `.diptych/approvals.json`.

---

## ADR-005 — Typed-Confirm Phrase Mechanism

**Status:** accepted

### Context

Destructive actions must never be auto-approved or sticky-approved. A simple yes/no prompt still allows accidental approvals.

### Decision

Confirm-tier prompts display the action description and require the user to type the exact phrase `I confirm` (case-sensitive, no trimming) before the reason field is accepted. The phrase is hardcoded; it is not configurable. The reason field (any non-empty string) is recorded in evidence alongside the grant.

No "approve for session" or "always approve" option is shown for confirm-tier actions.

### Consequences

- Explicit, deliberate friction for destructive actions.
- Evidence always contains a human-authored reason for every confirm-tier grant.
- Hardcoded phrase prevents config-driven bypass.

---

## ADR-006 — Reason-On-Reject Recording

**Status:** accepted

### Context

Silent rejections give the planner nothing to learn from. Structured rejection events with reasons feed the evidence ledger and can optionally be injected into the next planner re-prompt.

### Decision

When a user rejects (any tier) or the typed-confirm phrase mismatches:

1. A `rejection` entry is appended to the evidence ledger's top-level `rejections` array (see ADR-009 for schema).
2. An `approval_rejected` engine event is emitted with `reason`, `tier`, `actionClass`, and optional `taskId`.
3. On next planner call, the orchestrator optionally prepends a rejection summary section to the planner prompt context: `Previous rejections: ...`.

The optional planner re-injection is controlled by `approval.feedRejectionsToPlanner` (default `true`).

### Consequences

- Rejection reasons are durable in `evidence.json` and visible in the summary screen.
- Planner prompt context becomes sharper on re-runs after human corrections.

---

## ADR-007 — Headless Mode Behavior

**Status:** accepted

### Context

CI and scripted runs (headless, no TUI) must not block on a prompt. Each tier needs a clear non-interactive policy.

### Decision

| Tier | Headless behavior |
|---|---|
| auto | allow (silent) |
| sticky | check `.diptych/approvals.json` for an `always` grant; if none found, exit 1 with `APPROVAL_REQUIRED` error |
| confirm | always exit 1 with `APPROVAL_REQUIRED` error; never auto-approve |

Headless mode is detected when `approval.headless` is `true` in config or when `process.stdout.isTTY` is `false`. The error message includes the action description and class so CI logs are actionable.

### Consequences

- CI never silently destroys data.
- Pre-populated `scope: 'always'` grants in `.diptych/approvals.json` enable semi-trusted CI environments to allow sticky-tier writes.

---

## ADR-008 — Composition With Existing Hooks

**Status:** accepted

### Context

The existing `runPreHooks` pipeline in `src/engine/hooks/run-pre-hook.ts` supports `allow / deny / warn / crash` outcomes. User hooks can already block actions. Tiered approval must not bypass user hooks, and user hooks must not bypass tiered approval.

### Decision

Tiered approval runs as a new step **before** `runPreHooks`. The gate returns `{ decision: 'allow' | 'deny', reason? }`. If the gate returns `deny`, `runPreHooks` is not called. If the gate returns `allow`, `runPreHooks` runs as normal and can still deny.

Tiered approval is not implemented as a builtin hook inside `BUILTIN_HOOKS` because it requires the `OrchestratorCallbacks.onTieredApproval` callback (TUI bridge) which user-hooks and builtin hooks cannot access.

### Consequences

- Layered defense: tiered approval gates first, user hooks gate second.
- Tiered approval is transparent to the existing hook registry; no changes to `registry.ts` or `dispatch.ts`.
- User hooks remain composable with the new gate.

---

## ADR-009 — Evidence Schema Extension

**Status:** accepted

### Context

`EvidenceLedger` (defined in `src/core/schemas/evidence.ts`) currently captures validation and final-review events. Rejection events are not persisted.

### Decision

Add a top-level optional `rejections` array to `EvidenceLedger`:

```ts
EvidenceRejectionSchema = z.object({
  ts: z.string(),               // ISO timestamp
  tier: z.enum(['sticky', 'confirm']),
  actionClass: ActionClassSchema,
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  reason: z.string(),           // user-supplied or 'user_cancelled'
});
```

Auto-tier actions are never rejected so they never produce rejection entries.
Cross-task rejections (e.g. destructive command not tied to any running task) use `taskId: undefined`.

`EvidenceLedger.version` stays at `1`; the new field is optional, so old ledgers remain valid.

### Consequences

- Rejection history is durable and queryable.
- Evidence summary can show `rejectionCount` without breaking existing consumers.
- No `stateVersion` bump required (evidence.json is a session artifact, not the workflow state machine).

---

## ADR-010 — Backward Compatibility With Document-Level Approval

**Status:** accepted

### Context

`src/engine/orchestrator/approval.ts` gates spec, plan, and briefs documents. This spec adds a separate action-level gate. They must coexist.

### Decision

The document-level loop (`runApprovalLoop`) is untouched. Action-level gating is added as a new export `gateAction` in `src/engine/orchestrator/tiered-approval.ts`. The orchestrator calls `gateAction` before applying any implementer write or running any implementer subprocess. `OrchestratorCallbacks` gains one new optional field `onTieredApproval`.

No existing `OrchestratorCallbacks` consumer is broken; the field is optional and defaults to a no-op allow.

### Consequences

- Existing tests for `approval.ts` continue to pass unchanged.
- Tiered approval can be enabled incrementally; setting `approval.enabled: false` in config disables the new gate completely.

---

## ADR-011 — Configuration Schema Version

**Status:** accepted

### Context

`ConfigSchema` currently accepts `version: 2 | 3`. Adding an `approval` section is an additive, backward-compatible change.

### Decision

Add `approval: ApprovalConfigSchema.optional()` to the existing v3 `ConfigSchema`. Do not introduce v4. Old configs without an `approval` key continue to parse successfully; default behavior is `approval.enabled: true` with default tier assignments from ADR-002.

### Consequences

- No migration needed.
- Users on existing configs get sensible defaults on upgrade.

---

## ADR-012 — Runner-Kind Interception Scope (v1)

**Status:** accepted

### Context

Diptych supports five runner kinds: `cli`, `api`, `shell`, `agent`, and `agent-sdk`. The orchestrator's ability to intercept writes before they are applied differs per kind:

- **`api` / `shell`** — runner returns a text/diff string; orchestrator applies it. The gate can run before `apply`.
- **`agent-sdk`** — SDK emits tool-use events that the orchestrator receives before application; the gate can intercept per tool call.
- **`cli` / `agent`** — the subprocess writes files directly; orchestrator only sees the diff post-hoc via `implementer.implement()` result. Per-write interception is structurally impossible without OS-level sandboxing.

### Decision

**v1 scope: task-level gating for `cli`/`agent`; action-level gating for `api`/`shell`/`agent-sdk`.**

For `cli` and `agent` runners:
- Gating happens at the task level: `gateAction` is called once before `runSingleTask` begins (not per write), with action description derived from `task.action + task.file`.
- The action class is determined from the task metadata alone (task.file, task.scope.inBounds, task.dependsOn). Out-of-scope file access by the subprocess is not intercepted in real time; it appears post-hoc in changed-files evidence.
- The confirm tier blocks the entire task start for `cli`/`agent`; no sub-write level distinction is available.

For `api`, `shell`, and `agent-sdk` runners:
- Gating runs per implementer action (write, subprocess call) before application.

**Call site in `src/engine/orchestrator/task-step.ts`:**

`gateAction` is called after `publishTaskStart` and before the `withContinuationLoop` block in `runSingleTask`. For `cli`/`agent` kinds, the classification input is:
```
actionDescription = `${task.action} ${task.file}`;
```

For `api`/`shell`/`agent-sdk`, the implementer calls `gateAction` per action via a pre-apply hook passed as part of the `implement(...)` options. This hook is an extension to the `Implementer` interface: `beforeApply?: (description: string) => Promise<boolean>`. Brief 02 specifies this contract.

This v1 scoping is explicit and does not claim per-write interception for `cli`/`agent`.

### Consequences

- `cli`/`agent` users get task-level approval, not write-level. This is documented in the TUI prompt ("Approving this task will allow the implementer to proceed — subprocess writes are not individually gated for this runner kind").
- `api`/`shell`/`agent-sdk` users get per-action gating.
- v2 can add OS-level sandboxing (e.g., macOS sandbox profiles, seccomp) for `cli`/`agent` without changing the approval model.
- The `Implementer.implement()` interface gains an optional `beforeApply` hook parameter; existing implementers that don't use it remain compatible.
