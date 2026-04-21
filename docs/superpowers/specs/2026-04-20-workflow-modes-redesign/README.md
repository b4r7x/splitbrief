# Workflow Modes Redesign — 2026-04-20

> **Status:** draft — awaiting user review
> **Scope:** redesign of `workflow.mode`, orthogonal approval-gate flag, planner-effort pass-through, image pass-through, git-mode settings, local mode-downgrade heuristic, stable task contract documentation.
> **Out of scope:** tasks-as-JSON first-class, Kanban view in TUI, multi-planner ensemble, cross-session memory, auto-downgrade via LLM.

## Who this doc is for

Every brief in `agent-briefs/` is written to be picked up by a **fresh AI context** (zero prior conversation) that implements one and only one change. The briefs are deliberately verbose so the implementer does not need to re-explore or re-decide anything.

Humans reviewing the redesign read the three top-level docs (`spec.md`, `decisions.md`, `migration.md`) and `verification.md`. Humans do not read the briefs unless they want to validate what the implementer will do.

## Reading order

> **CRITICAL — READ FIRST:** `IMPLEMENTATION-STATUS.md` — a prior session partially implemented many briefs. This file tracks what is DONE vs. what remains. Implementing agents MUST read it before starting any brief.

| Step | File | Audience | Purpose |
|---|---|---|---|
| 0 | **`IMPLEMENTATION-STATUS.md`** | **AI (mandatory)** | **What is already implemented vs. what gaps remain. Read BEFORE any brief.** |
| 1 | `spec.md` | human + AI | **Ground truth.** What we are building and why, end-to-end. Start here. |
| 2 | `decisions.md` | human | One ADR per non-obvious decision. Captures alternatives and trade-offs so we can revisit later. |
| 3 | `migration.md` | human + AI | What happens to existing `.diptych/config.yaml` files and in-flight sessions. |
| 4 | `verification.md` | human + AI | Acceptance criteria, test plan, verification commands. |
| 5 | `agent-briefs/00-coordinator.md` | AI orchestrating multiple briefs | Execution order, dependency graph, shared invariants. |
| 6 | `agent-briefs/0N-*.md` | implementation AI | Copy-paste-ready change set for one independent feature. |

## Change-set summary

Nine independent briefs. Their dependency graph is in `agent-briefs/00-coordinator.md`.

| # | Brief | Touches | Depends on |
|---|---|---|---|
| 01 | `01-mode-taxonomy.md` — rename `full` → `speckit`, add `instant` | `src/core/schemas/enums.ts`, `src/core/schemas/config.ts`, `src/core/config/load/migrate.ts`, `src/features/settings/mode-selector.tsx`, `docs/WORKFLOW.md`, `CLAUDE.md` | — |
| 02 | `02-instant-mode.md` — implement new `instant` planner path | `src/engine/orchestrator/planning/run.ts`, `src/engine/orchestrator/planning/instant.ts` (new), `src/engine/spec/prompts/instant.ts` (new), `src/engine/planners/base.ts`, `src/engine/planners/types.ts` | 01 |
| 03 | `03-speckit-phases.md` — add constitution-check, clarifying, analyzing | `src/core/schemas/enums.ts`, `src/core/phases.ts`, `src/core/state/machine.ts`, `src/core/types/state-actions.ts`, `src/engine/orchestrator/planning/speckit.ts` (new), `src/engine/spec/prompts/{constitution,clarify,analyze}.ts` (new) | 01 |
| 04 | `04-approve-flag.md` — orthogonal `--approve <spec\|plan\|none\|all>` | `src/cli/options.ts`, `src/core/config/runtime/overrides.ts`, `src/engine/orchestrator/planning/run.ts`, `src/core/schemas/config.ts`, `src/core/settings/catalog.ts` | 01 |
| 05 | `05-planner-effort.md` — `--planner-effort` pass-through per backend | `src/engine/planners/types.ts`, `src/engine/claude-runner.ts`, `src/engine/cli-tools.ts`, `src/engine/planners/api.ts`, `src/engine/agent-sdk.ts`, `src/engine/providers/{anthropic,openai-stream}.ts`, `src/cli/options.ts`, `src/core/schemas/config.ts` | — |
| 06 | `06-image-passthrough.md` — drag-drop + attachment pipeline | `src/engine/planners/types.ts`, `src/components/input/multiline-input.tsx`, `src/features/workflow/handlers.ts`, `src/engine/planners/{claude-code,cli,api,agent-sdk}.ts`, `src/core/slash-commands/catalog.ts` (`/attach`) | — |
| 07 | `07-git-modes-settings.md` — expose commit/branch strategies in settings UI | `src/core/settings/catalog.ts`, `src/core/schemas/config.ts`, `src/engine/orchestrator/task-commit.ts`, `src/cli/setup.ts`, `src/lib/git.ts` | — |
| 08 | `08-downgrade-warning.md` — local heuristic “mode too heavy for this prompt” | `src/engine/orchestrator/planning/run.ts` (or new `src/engine/orchestrator/planning/mode-advisor.ts`), `src/features/workflow/components/input-footer.tsx` | 01 |
| 09 | `09-task-contract-doc.md` — document stable `Task` JSON contract for external tooling | `docs/TASK-CONTRACT.md` (new), `src/core/schemas/task.ts` (JSDoc only) | — |
| 10 | `10-test-cleanup.md` — remove trivial hook tests per test-behavior-not-implementation | various `*.test.ts` / `*.test.tsx` files | — |

Briefs **parallelizable in isolation**: 05, 06, 07, 09, 10 (plus 04 if 01 is done) — different files, no shared state. **Sequential chain**: 01 → 02 → 03 → 08 → 04.

## CLAUDE.md constraint

> **NEVER commit, NEVER stage.** All changes land as unstaged modifications. The user commits manually. Briefs reiterate this in their own headers.

## Non-goals (explicit)

The following were considered and deferred. Documented so future sessions do not re-open them without new evidence.

- **Tasks-as-JSON first-class** — `tasks.md` remains the source of truth. External Kanban/Jira tooling will read the existing shape. Brief 09 documents the contract so external tools have a stable target.
- **Auto-downgrade via LLM classifier** — rejected in conversation: would burn user tokens for a heuristic. Brief 08 implements a local (no-LLM) heuristic that warns only.
- **Multi-planner ensemble** — out of scope; conflicts with `docs/VISION.md` §5 ("don’t wrap agents in agents").
- **Cross-session memory / ubiquitous-language extraction** — separate feature, separate spec.
- **Non-TypeScript validator pipeline** — already deferred in `docs/FUTURE.md`.
- **Windows support** — already deferred in `docs/FUTURE.md`.
- **Removing the git-repo requirement** — diptych still requires a git repo at startup (`src/cli/setup.ts:24-28`). Working-tree and checkpoint commit strategies already cover the "no per-task commits" case.
