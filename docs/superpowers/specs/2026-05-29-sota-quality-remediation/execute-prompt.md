# Execute Prompt: SOTA Quality Remediation

## Model

- **Implementers and validators: Opus.** The meta-fixes (type-system, schema
  derivation) and the parameter-object refactors need strong reasoning; the audit was
  Opus and the closure should match it.
- Validators are spawned **fresh and unbiased** — they never see the implementer's
  reasoning, only the brief + audit rows + the actual diff.

## How this is run

Sequentially, wave by wave (see `agent-briefs/00-coordinator.md`). Writes are
serialized — one brief implemented and validated before the next. Per brief:

```
implement (opus) → validate (opus, unbiased) → gaps? → fix (opus) → re-validate (≤2) → wave gate
```

The orchestration is driven by per-wave Workflow scripts (one workflow per wave keeps
the main context unbloated — each returns only a compact summary). To resume or run a
wave manually, paste the prompt below.

## Prompt to paste (manual / resume)

```text
You are executing the SOTA Quality Remediation spec for diptych:

docs/superpowers/specs/2026-05-29-sota-quality-remediation/

Goal: close EVERY finding in docs/audits/sota-quality-audit-opus-2026-05-28.md
(~190: 1 critical, ~50 high, ~95 medium, ~45 low). Surgical, behavior-preserving
edits only. No new features.

Hard repository rules:
- NEVER run git add / git stage / git commit / git stash (a PreToolUse hook blocks
  them; a BLOCKED: message means stop and report). The owner commits manually.
- Never revert another brief's edits or the user's working-tree changes.

Project constraints:
- Node 22+, TS 6.x, ESM only; every relative import ends in .js
- Zero runtime classes (the one exception: `class X extends Error`, see decisions.md D2)
- Zero barrels (no index.ts); zero useMemo/useCallback/React.memo/forwardRef
- engine/ must not import ink/react/features/components/hooks
- Colocated tests; tests verify behavior, not implementation
- No decorative comments; no dead/commented-out code

Required reading, in order:
1. CLAUDE.md
2. docs/superpowers/specs/2026-05-29-sota-quality-remediation/README.md
3. .../decisions.md
4. .../agent-briefs/00-coordinator.md
5. .../traceability.md  (your coverage spine)

Execution (sequential, by wave — coordinator has the order):
For each brief B## in wave order:
  1. Implement ONLY that brief (read .../agent-briefs/B##-*.md — it is self-contained).
  2. Run: npm run typecheck && npm run lint && npm test -- <brief's affected globs>
  3. Spawn a SEPARATE unbiased validator (.../validation/validator-protocol.md):
     it re-derives from the diff whether EVERY finding in the brief is addressed,
     plus regressions / new slop / green gate. It returns a structured verdict.
  4. If verdict != "clean": fix the gaps, re-validate (max 2 rounds), else escalate.
  5. Check the brief's rows in traceability.md only after a clean verdict.
At the end of each wave: npm run test-ci must be green before the next wave starts.

Final handoff report:
- Files changed; traceability rows now checked; per-brief validator verdicts.
- npm run test-ci result (must be green).
- Confirmation that no git add/commit/stash was run.
```

## Resuming mid-run

`traceability.md` is the durable state. Any unchecked row is unfinished. Re-enter at
the first wave with an unchecked owned row; earlier waves are done when their rows are
checked and the wave gate was green.
