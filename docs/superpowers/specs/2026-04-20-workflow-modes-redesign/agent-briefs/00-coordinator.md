# 00 — Coordinator: Execution Order & Dependencies

> **Read this first if you are an agent picking up briefs in sequence.** If you are assigned a single brief only, skip to `0N-*.md`.

## Who is this doc for

An AI agent that has been tasked with "implement the workflow-modes-redesign spec" end-to-end. This doc tells you:

1. What order to execute briefs in.
2. What each brief assumes is already done.
3. Shared invariants you must respect across every brief.
4. How to verify progress between briefs.

You should have already read `spec.md` and `decisions.md`. If not, stop and read them now. This doc does not restate the design; it coordinates the implementation.

## Execution order

```
                01-mode-taxonomy (foundation)
                   |
       +-----------+-----------+-----------+
       |           |           |           |
     02-instant  03-speckit  04-approve  08-advisor
       |           |           |           |
       +-----------+-----------+-----------+
                   |
                (merge point: all four above complete)
                   |
       +-----------+-----------+
       |           |           |
     05-effort  06-images   07-git-settings   09-task-contract   10-test-cleanup
       |           |           |                   |                   |
       +-----------+-----------+-------------------+-------------------+
                   |
                (final: npm run test-ci passes)
```

- **Brief 01** is a hard prerequisite for 02, 03, 04, 08. No way around this.
- **Briefs 05, 06, 07, 09, 10** do not depend on any other brief. They can run before, during, or after the 01→04 chain.
- **Briefs in the same horizontal row** can be executed by parallel subagents if desired. They touch disjoint file sets.

## File ownership matrix

Each cell shows which brief OWNS each file. A brief may READ any file but may only WRITE files in its own column.

| File | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `src/core/schemas/enums.ts` | ✓ | | ✓* | | | | | | |
| `src/core/schemas/config.ts` | ✓ | | | ✓ | ✓ | | ✓ | | |
| `src/core/config/load/migrate.ts` | ✓ | | | | | | | | |
| `src/core/config/load/load.ts` | ✓ | | | ✓ | | | ✓ | | |
| `src/core/config/runtime/overrides.ts` | | | | ✓ | ✓ | | ✓ | | |
| `src/core/phases.ts` | | | ✓ | | | | | | |
| `src/core/state/machine.ts` | | ✓ | ✓ | | | | | | |
| `src/core/types/state-actions.ts` | | ✓ | ✓ | | | | | | |
| `src/core/settings/catalog.ts` | | | | ✓ | ✓ | | ✓ | | |
| `src/core/slash-commands/catalog.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/orchestrator/planning/run.ts` | | ✓ | ✓ | ✓ | | | | ✓ | |
| `src/engine/orchestrator/planning/instant.ts` | | ✓ | | | | | | | |
| `src/engine/orchestrator/planning/speckit.ts` | | | ✓ | | | | | | |
| `src/engine/orchestrator/planning/mode-advisor.ts` | | | | | | | | ✓ | |
| `src/engine/planners/types.ts` | | ✓ | | | ✓ | ✓ | | | |
| `src/engine/planners/base.ts` | | ✓ | | | | | | | |
| `src/engine/planners/claude-code.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/planners/cli.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/planners/api.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/planners/agent-sdk.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/claude-runner.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/cli-tools.ts` | | | | | ✓ | | | | |
| `src/engine/providers/anthropic/stream.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/providers/openai-stream.ts` | | | | | ✓ | ✓ | | | |
| `src/engine/spec/prompts/instant.ts` | | ✓ | | | | | | | |
| `src/engine/spec/prompts/constitution.ts` | | | ✓ | | | | | | |
| `src/engine/spec/prompts/clarify.ts` | | | ✓ | | | | | | |
| `src/engine/spec/prompts/analyze.ts` | | | ✓ | | | | | | |
| `src/engine/orchestrator/task-commit.ts` | | | | | | | ✓ | | |
| `src/cli/setup.ts` | | | | | | | ✓ | | |
| `src/cli/options.ts` | | | | ✓ | ✓ | | | | |
| `src/cli/init-stores.ts` | | | | ✓ | ✓ | | | | |
| `src/lib/git.ts` | | | | | | | ✓ | | |
| `src/components/input/multiline-input.tsx` | | | | | | ✓ | | | |
| `src/features/workflow/handlers.ts` | | | | | | ✓ | | | |
| `src/features/workflow/components/input-footer.tsx` | | | | | | | ✓ | ✓ | |
| `src/features/settings/mode-selector.tsx` | ✓ | | | | | | | | |
| `src/stores/workflow/*` | | | | | | ✓ | | | |
| `docs/WORKFLOW.md` | ✓ | ✓ | ✓ | ✓ | | | | | |
| `docs/TASK-CONTRACT.md` | | | | | | | | | ✓ |
| `docs/CONFIG.md` | | | | ✓ | ✓ | | ✓ | | | |
| `docs/SLASH-COMMANDS.md` | | | | ✓ | ✓ | ✓ | | | | |
| `CLAUDE.md` | ✓ | | | | | | | | | |
| various `*.test.ts` / `*.test.tsx` | | | | | | | | | | ✓ |

\* Brief 03 adds `constitution-check`, `clarifying`, `analyzing` to the phase enum. Brief 01 adds `instant` to the mode enum and removes `full`. They touch the same file but different arrays — merge conflicts are trivial.

**Merge conflict handling:** Where two briefs touch the same file, they touch different symbols. If conflict appears, 01 takes precedence (it is foundational).

## Shared invariants (MUST hold after every brief)

### Global invariants from `CLAUDE.md`

1. **NEVER commit, NEVER stage.** Every brief ends with unstaged changes in the working tree. The user commits manually. A pre-commit hook (`.claude/hooks/block-git-commits.sh`) will block `git add` / `git stage` / `git commit`.
2. **Zero classes** in `src/`. Pure functions, module-scoped state. Error subclasses are the only exception.
3. **ESM imports with `.js` extension** (`import x from './y.js'`, not `'./y'`).
4. **Zero barrels.** No re-export-only `index.ts`. Imports are always direct.
5. **Zero memoization** (no `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle`).
6. **Zero engine→React imports.** `src/engine/**` never imports from `src/features/`, `src/components/`, `src/hooks/`, React, or Ink.
7. **Zero failing tests.** `npm run test-ci` passes before claiming a brief done.

### Spec-specific invariants

1. **Mode resolution is single-source-of-truth.** Exactly one function, `resolveMode()`, lives in `src/core/config/runtime/resolve.ts` (created by brief 01). Every caller uses it. No ad-hoc `mode === 'full'` checks anywhere in code.
2. **Approve-level resolution is single-source-of-truth.** Same pattern, `resolveApproveLevel()`.
3. **Effort-level resolution is single-source-of-truth.** Same pattern, `resolveEffortLevel()` (created by brief 05).
4. **Every new `EngineEvent` variant is added to `src/engine/events/types.ts`** in the discriminated union, and a renderer in `src/features/workflow/components/event-cards/event-card.tsx` unless it is a log-only event (in which case, add a minimal fallback renderer).
5. **Every new slash command is added to `src/core/slash-commands/catalog.ts`** with a test in the catalog test file. **Additionally, every new slash command must be documented in `docs/SLASH-COMMANDS.md`** in the same patch. Brief 04 proposed an approval-level runtime command in this archived design; briefs 05 (`/effort`) and 06 (`/attach`, `/detach`) each add slash commands and MUST update that doc.
6. **No new environment variables** without an entry in `docs/CONFIG.md`. No briefs add env vars in v1. (The `DIPTYCH_LEGACY_MODES` escape hatch was considered and rejected — v3 schema is the only runtime shape; rollback is via `npm install diptych@<prev>`.)
7. **Doc updates colocated with code changes.** Each brief updates `docs/WORKFLOW.md`, `docs/CONFIG.md`, `docs/SLASH-COMMANDS.md`, etc. in the same patch as the code change. No "doc follow-up" deferred work.

## Verification between briefs

Run these checks after each brief:

```bash
# Type check, lint, test.
npm run test-ci

# Verify no forbidden patterns.
rg --type ts 'useMemo|useCallback|React\.memo|forwardRef|useImperativeHandle' src/ && echo "FORBIDDEN MEMO/FWD-REF" && exit 2
rg --type ts "from '[^']*[^j][^s]'" src/ | grep -v node_modules | grep -v '\.json' && echo "MISSING .js EXTENSION" && exit 2
find src -name 'index.ts' -print | grep . && echo "BARREL FOUND" && exit 2
rg --type ts '\bclass\s+[A-Z]' src/ | grep -v 'Error\b' | grep -v '.test.ts' && echo "CLASS FOUND" && exit 2
```

Expected: all silent, exit 0.

## Scope discipline

**You may make implementation choices within a brief** where the brief leaves latitude (e.g., "add a helper function for X" — you pick the name).

**You may NOT:**

- Invent new config keys not specified here.
- Invent new CLI flags not specified here.
- Refactor code outside your brief's file-ownership list.
- "Improve while you're there" — clean-code, naming, or DRY refactors are out of scope. File a separate issue.
- Touch tests outside your brief's concern (except to update tests that reference renamed symbols).
- Add dependencies (`npm install <pkg>`).

If you encounter an obstacle that blocks a brief:

1. Document it inline in the brief's agent-brief as a `> BLOCKED:` comment with full context.
2. Leave your changes unstaged (per CLAUDE.md you never commit).
3. Stop. The user reviews.

Do NOT:

- Skip the check and hope it works.
- Add a comment like "TODO: revisit this".
- Work around by scope-creeping into another brief.

## Estimates

Not binding. For planning only.

| Brief | Code LOC (approx) | Tests LOC | Docs LOC |
|---|:---:|:---:|:---:|
| 01 | ~150 | ~100 | ~80 |
| 02 | ~250 | ~150 | ~40 |
| 03 | ~500 | ~300 | ~100 |
| 04 | ~120 | ~100 | ~40 |
| 05 | ~200 | ~180 | ~60 |
| 06 | ~350 | ~250 | ~80 |
| 07 | ~150 | ~120 | ~50 |
| 08 | ~80 | ~80 | ~30 |
| 09 | ~30 | ~30 | ~400 |
| 10 | 0 | ~-200 (deletions) | ~20 |
| **total** | **~1830** | **~1110** | **~900** |

Total: ~3.8 kLOC across code + tests + docs.

Total: ~4 kLOC across code + tests + docs.
