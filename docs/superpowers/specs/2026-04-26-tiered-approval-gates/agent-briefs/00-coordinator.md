# 00 — Coordinator

> Use this only when coordinating the full Tiered Approval Gates spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
03 Config Schema
  └─ 01 Action Classifier
       └─ 02 Approval Gate Engine
            ├─ 04 TUI Approval Prompt
            ├─ 05 CLI Approval Management
            └─ 06 Evidence Rejection Recording
```

Recommended sequential order:

1. `03-config-schema.md` — defines `ActionClass`, `ApprovalConfig`, and `ApprovalsStore` types used by all subsequent briefs.
2. `01-action-classifier.md` — pure classifier; no I/O; depends only on types from brief 03.
3. `02-approval-gate-engine.md` — orchestrator integration; depends on classifier (01) and config types (03).
4. `04-tui-approval-prompt.md` — TUI component for approval prompts; depends on gate engine callback shape (02).
5. `05-cli-approval-management.md` — CLI subcommands and slash command; depends on approvals store (03).
6. `06-evidence-rejection-recording.md` — evidence ledger extension; depends on action class types (03) and gate engine rejection events (02).

Briefs 04, 05, and 06 can run in parallel once 01–03 are complete.

## Shared Files To Read

- `CLAUDE.md`
- `docs/decisions.md` (this spec)
- `src/core/paths.ts`
- `src/core/schemas/config.ts`
- `src/core/schemas/evidence.ts`
- `src/core/schemas/task.ts`
- `src/core/schemas/hooks.ts`
- `src/core/slash-commands/catalog.ts`
- `src/core/slash-commands/types.ts`
- `src/engine/orchestrator/approval.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/evidence.ts`
- `src/engine/hooks/run-pre-hook.ts`
- `src/engine/hooks/types.ts`
- `src/engine/hooks/builtins/registry.ts`
- `src/engine/events/types.ts`

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies beyond what is already in `package.json`. Exception: `micromatch` is already a transitive dep (via Vitest). Use `import micromatch from 'micromatch'` if glob matching is needed.
- No classes; no barrels.
- Use ESM `.js` import suffixes.
- Engine code must not import React, Ink, or any `src/features/` / `src/components/` module.
- Add new session/project artifact constants to `src/core/paths.ts` before using them in any other file.
- Use `src/lib/fs.ts` helpers for all file writes (`ensureSecureDir`, `SECURE_FILE_MODE`).
- Tests assert behavior, persisted artifacts, returned state, or emitted events — not private helper calls.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff:

```bash
npm run test-ci
```
