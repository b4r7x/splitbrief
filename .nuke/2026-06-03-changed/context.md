# Audit context — diptych — 2026-06-03 (scope: working-tree changes vs HEAD)

## Project

diptych is an open-source, cost-aware task compiler for AI coding agents. An expensive
planner compiles Task Briefs; a cheaper implementer executes them. It is a Node.js CLI +
Ink TUI: a workflow state machine drives planning → task execution → validation → retry →
escalation → final review → completion, with tiered approval gates, snapshots, and resume.
Both planner and implementer accept five runner kinds dispatched in `src/engine/runners/factory.ts`.

## Stack

- Runtime: Node.js >=22, TypeScript 6.x (`typescript ^6.0.0`), ESM only (`.js` in imports)
- Runner: `tsx` ^4.21 (dev) / `tsc` → `dist/` (build)
- TUI: Ink ^6.8 (React ^19) + `fullscreen-ink` ^0.1, Shiki ^4 (WASM)
- Testing: Vitest ^4.1.2 (`ink-testing-library` ^4), colocated `foo.test.ts`
- Lint/format: Biome ^2 (single-quote; formatter NOT run in CI, only `format:check`)
- Validation: Zod ^4.3.6 · Config: `yaml` ^2 · Git: `simple-git` ^3 · CLI: `commander` ^14
- Agent SDK: `@anthropic-ai/claude-agent-sdk` ^0.3 (optional peer dep)
- Other: `openai` ^6, `better-sqlite3` ^12, tree-sitter, OpenTelemetry, `knip`

## Gates

```
npm run test-ci   = format:check && typecheck && lint && test && check:invariants
npm run typecheck = tsc --noEmit (src) && tsc --noEmit -p tsconfig.test.json
npm run lint      = biome check .
npm test          = vitest run
npm run check:invariants = tsx scripts/check-invariants.ts
```
(`format:check` = `biome format .` — no `--write`; format drift is caught, not auto-fixed.)

## Conventions (intentional — NOT findings)

- **Zero runtime classes** in production source (pure functions + module-scoped state). Test
  fixtures may use class syntax only when class behavior is under test.
- **ESM with `.js` extension** in every relative import (`'./config.js'`).
- **kebab-case** files/folders; single word where natural (`pricing.ts`).
- **No decorative comments / section banners.** Ordering is the documentation. (Explanatory
  *why* comments on non-obvious logic are allowed and present in this changeset.)
- **Error at boundaries** via `error()` + domain bag; no raw `throw new Error` (INVARIANTS #4).
  NOTE: the spec/new code uses `new Error(...)` in a couple of planning-failure paths — check
  whether those sites are sanctioned or a gate violation.
- **No unsafe assertions** (`!`, broad `as`) outside the SANCTIONED list:
  `src/utils/type-guards.ts`, `src/stores/create-store.ts`, `src/stores/use-stores.ts`,
  branded-ID ctors in `src/core/schemas/task.ts`, `Map.get(...)!` in
  `src/engine/codebase/graph.ts` & `pagerank.ts`, `as unknown` path-walking in
  `src/engine/hooks/substitute.ts` & `dispatch.ts`, and **`src/lib/terminal/filtered-stdin.ts`**
  (bridged `PassThrough` stdin satisfying the TTY members Ink reads — `filtered as unknown as
  NodeJS.ReadStream`, this is in the changeset and explicitly sanctioned).
- **Zero barrels** — no re-export-only `index.ts` anywhere in `src/` (INVARIANTS #1).
- **Zero memoization** — no `useMemo`/`useCallback`/`React.memo` (INVARIANTS #3).
- **No imperative handles** — no `forwardRef`/`useImperativeHandle`; extract to a store.
- **Zero engine→React imports** — `src/engine/` must not import `ink`, `react`,
  `features/`, `components/`, `hooks/`, `cli/` (INVARIANTS #12/#12b/#12c).
- **Zero failing gates** before any PR.

Runner kinds (`kind` discriminant always required; configs write `version: 3`, `version: 2`
migrated): `cli` (claude-code, codex, opencode, aider, copilot, kilo-code) · `api`
(OpenAI-compatible HTTP: Ollama, LM Studio, OpenRouter, DeepSeek, Groq, Together, Anthropic) ·
`shell` (stdin→stdout) · `agent` (subprocess writing files directly) · `agent-sdk` (Anthropic SDK call).

Workflow modes: `instant` (1 planner call, no gates) · `quick` (1 call, no gates) ·
`standard` default (4 calls, spec+briefs gates) · `speckit` (6–7 calls, spec+plan+briefs gates).
Set via `--mode`, config `workflow.mode`, or `/mode`. `full` is a legacy alias.

## Review bar extras

From PRINCIPLES.md and CODE-STANDARD.md (judgment calls grep cannot catch):

- **SRP per file** — describable in one sentence with no "and". No junk-drawer `shared.ts`/
  `helpers.ts`; no IO/routing under `components/`; no engine logic under `features/`; no
  function that both transforms and does IO.
- **Layer/import direction** one-way: `utils/ → lib/ → core/ → engine/ → (stores/) → features/`.
  `lib/` knows no diptych concept; `core/` has no React/subprocess/file-writes; `stores/` is the
  only engine↔UI channel; features never import another feature. Before duplicating a helper,
  move it down to the layer all consumers can import rather than copy.
- **Parameter design** (tightens rule 21): ≥4 params → options object; ≥3 params AND
  exported → options object; bare `boolean` param BANNED at any arity (boolean trap); two
  adjacent same-typed params BANNED (transposition hazard). Split oversized option objects by concern.
- **File size is a TRIGGER, not a verdict** — >300 LOC + >1 concern → split into a kebab folder
  (no barrel); a cohesive 400–650 LOC file is fine.
- **Naming** — file name matches primary export; no stutter beyond entry-file convention
  (`run/run.ts` ok); no duplicate sibling export names; banned `*-types.ts` / `src/types.ts`.
- **Single-source closed sets** — unions/enums defined once (Zod `z.enum` + `z.infer`), engine/UI
  derive from core, never re-spell. Value-returning `switch` over a closed union ends in `assertNever`.
- **Narrow, don't assert** — use guards / re-validate via Zod, no fake data to satisfy a type.
- **DRY at the 3rd occurrence**; delete dead code & dead exports (no "future use").
- **Tests assert observable behavior** — no `vi.mock` of `./` siblings, no `toHaveBeenCalledTimes`
  unless the count is the contract, no coupling to exact glyphs/spacing/verbatim copy in frames.

## Changeset intent

Per `docs/specs/full-loop-resume-sandbox-plan-2026-06-03.md`, this working-tree change targets
three goals plus a TUI input-handling rework:

1. **Fix planning resume.** A saved state with `awaitingContinue: true` in `researching`/
   `specifying`/`planning` was skipped (it jumped straight to the task loop). Now it re-enters
   planning and clears the flag via `CONTINUE_TURN` (`run/phases.ts`).
2. **Make final review a completion gate.** Previously advisory; now if planner review fails the
   workflow STAYS in `final-review`, emits no `workflow_complete`, does not call `onComplete`, and
   writes a review packet with `finalReviewStatus: "failed"`. Final-review prompt now also includes
   `tasks.md` (fallback rendered from state tasks).
3. **Harden the direct-implementer sandbox** (best-effort, not an OS sandbox): staged projects no
   longer copy `.git` or symlinks; child processes get a `.diptych-sandbox` HOME/TMP/XDG/npm/pip/
   cargo env; staged change-detection uses file-hash baselines when no `.git`; promotion is
   realpath/path-confinement guarded; `.gitignore` semantics preserved in staged copies.
4. **Provider/CLI config** — `apiKey: env:NAME` resolves through the API provider boundary
   (missing env fails); CLI start/resume overrides gain api-base, env-key refs, repeatable args,
   output-format, context-length for both planner & implementer; implementer overrides update the
   default `implementerProfiles` entry.
5. **Validation** — a *configured* (source: 'config') command that is missing now FAILS instead of
   silently skipping; auto-detected/default missing commands still skip.
6. **Quick mode** cancels planning on zero tasks (matching instant-mode guard).
7. **Recovery** — `planner-split-rebase` removed from new recovery issues/prompts (placeholder
   that blocked); enum/handler kept only for legacy saved states.
8. **TUI input rework** — `mouse.ts` deleted, its mouse parsing folded into a new `filtered-stdin.ts`
   (PassThrough bridge that strips mouse + bracketed-paste markers before Ink); new
   `escape-debounce.ts` defers ESC actions ~35ms so split escape sequences over slow links don't
   misfire; abort store moves from `pending: boolean` to `armed: 'none'|'exit'|'interrupt'|'cancel'`;
   Ctrl+C/ESC semantics rewritten in `app/keys.ts` (interrupt turn → cancel workflow → exit).

Many new/changed test files are behavior-first integration/e2e tests proving these flows end-to-end.

## Scope

Working tree vs HEAD: **94 tracked modified/deleted files + 17 new untracked files** (111 total),
roughly **+1849 / −863 lines**. Deleted: `src/lib/terminal/mouse.ts` and `mouse.test.ts`
(verified: NO dangling imports of `terminal/mouse` remain; `parseMouseEvents` now lives in
`filtered-stdin.ts`). Full enumerated list: `files.txt` next to this file.

## Chunk map

### CHUNK-A — app shell + CLI + core (14 files)
src/app.tsx, src/app/keys.ts, src/app/keys.test.tsx, src/cli/commands/start.test.ts, src/cli/headless.test.ts, src/cli/options.ts, src/cli/render.ts, src/cli/render.test.ts (new), src/core/config/runtime/overrides.ts, src/core/config/runtime/overrides.test.ts, src/core/keybindings/registry.ts, src/core/paths.ts, src/core/types/config-options.ts, testing/helpers/factories/config.ts

### CHUNK-B — engine backends/runners/streaming/spec/snapshots (12 files)
src/engine/agent-sdk-backend.ts, src/engine/change-detection.ts, src/engine/change-detection.test.ts (new), src/engine/claude-invoke.ts, src/engine/streaming/spawn-collect.ts, src/lib/process/spawn.ts, src/engine/runners/command-based.ts, src/engine/runners/sandbox-env.ts (new), src/engine/snapshots/checkpoint-summary.test.ts, src/engine/snapshots/files.ts, src/engine/spec/prompts/review.ts, src/engine/spec/prompts/review.test.ts

### CHUNK-C — implementers (8 files)
src/engine/implementers/agent-sdk.ts, src/engine/implementers/agent-sdk.test.ts, src/engine/implementers/agent.test.ts, src/engine/implementers/api.test.ts, src/engine/implementers/base.ts, src/engine/implementers/cli.ts, src/engine/implementers/command-invoke.ts, src/engine/implementers/types.ts

### CHUNK-D — planners + providers (10 files)
src/engine/planners/base.ts, src/engine/planners/claude-code.ts, src/engine/planners/cli.ts, src/engine/planners/command-invoke.ts, src/engine/planners/escalation.ts, src/engine/planners/types.ts, src/engine/providers/client.ts, src/engine/providers/errors.ts, src/engine/providers/registry.ts, src/engine/providers/registry.test.ts

### CHUNK-E — orchestrator approval + escalation (9 files)
src/engine/orchestrator/approval/file-snapshots.ts, src/engine/orchestrator/approval/gate-and-promote.ts, src/engine/orchestrator/approval/staged-project.ts, src/engine/orchestrator/approval/staged-project.test.ts, src/engine/orchestrator/escalation/local-retries.ts, src/engine/orchestrator/escalation/run-escalation-tier.ts, src/engine/orchestrator/escalation/step.ts, src/engine/orchestrator/escalation/step.test.ts, src/engine/orchestrator/escalation/types.ts

### CHUNK-F — orchestrator core (12 files)
src/engine/orchestrator/final-review.ts, src/engine/orchestrator/final-review.test.ts, src/engine/orchestrator/planning/quick.ts, src/engine/orchestrator/planning/quick.test.ts (new), src/engine/orchestrator/run/phases.ts, src/engine/orchestrator/run/phases.test.ts, src/engine/orchestrator/validation.ts, src/engine/orchestrator/validation.test.ts, src/engine/orchestrator/recovery/builders/recovery-actions.ts, src/engine/orchestrator/recovery/builders/task.ts, src/engine/orchestrator/recovery/builders/workflow.ts, src/engine/orchestrator/recovery/recovery.test.ts

### CHUNK-G — orchestrator task + user-edit (10 files)
src/engine/orchestrator/task/loop-recovery.test.ts, src/engine/orchestrator/task/loop-task-review.test.ts, src/engine/orchestrator/task/loop-user-edit.test.ts, src/engine/orchestrator/task/retry.test.ts, src/engine/orchestrator/task/routing.ts, src/engine/orchestrator/task/run-implementation.ts, src/engine/orchestrator/task/step.test.ts, src/engine/orchestrator/user-edit/conflicts.ts, src/engine/orchestrator/user-edit/conflicts.test.ts, src/engine/orchestrator/user-edit/detection.ts

### CHUNK-H — features/workflow (11 files)
src/features/workflow/components/feedback-row.tsx, src/features/workflow/handlers.ts, src/features/workflow/handlers.test.ts (new), src/features/workflow/hooks/use-mouse-scroll.ts, src/features/workflow/hooks/use-mouse-scroll.test.ts, src/features/workflow/hooks/use-workflow-keys.ts, src/features/workflow/keyboard.ts, src/features/workflow/recovery-prompt.ts, src/features/workflow/recovery-prompt.test.ts, src/features/workflow/user-edit-conflict-prompt.ts, src/features/workflow/user-edit-conflict-prompt.test.ts

### CHUNK-I — lib/terminal + stores (12 files)
src/lib/terminal/escape-debounce.ts (new), src/lib/terminal/escape-debounce.test.ts (new), src/lib/terminal/filtered-stdin.ts (new), src/lib/terminal/filtered-stdin.test.ts (new), src/lib/terminal/mouse.ts (DELETED — verify no dangling references), src/lib/terminal/mouse.test.ts (DELETED), src/stores/navigation/session-select.ts, src/stores/navigation/session-select.test.ts, src/stores/workflow/abort.ts, src/stores/workflow/abort.test.ts (new), src/stores/workflow/actions.test.ts, testing/helpers/filtered-stdin-harness.tsx (new)

### CHUNK-J — integration/e2e tests + docs (14 files)
testing/integration/orchestrator/abort-mid-task.test.ts, testing/integration/orchestrator/cli-planner-cli-implementer.test.ts (new), testing/integration/orchestrator/full-loop-validation-retry.test.ts (new), testing/integration/orchestrator/resume-planning-direct-implementer.test.ts (new), testing/integration/ui/esc-through-filtered-stdin.test.tsx (new), testing/e2e/scenarios/real-cli-planner-implementer.smoke.test.ts (new), CLAUDE.md, docs/APPROVAL-AND-RECOVERY.md, docs/FEATURES.md, docs/STORES.md, docs/TESTING.md, docs/WORKFLOW.md, docs/specs/full-loop-resume-sandbox-plan-2026-06-03.md

## Agent rules

1. READ-ONLY on the entire repository. Never edit, create, or delete any file. Never run git add / git commit / git stash / git checkout / git restore. Allowed git: status, diff, log, show, blame.
2. The audit scope is the WORKING-TREE CHANGE vs HEAD, not the whole repo. Use `git diff HEAD -- <file>` to see what changed; read new (untracked) files in full. You may read ANY file in the repo to trace evidence end-to-end, but findings must be anchored in the changeset (a changed/new file, or breakage directly caused by the change, e.g. dangling references to deleted files).
3. Evidence before existence: every finding needs exact file:line references and a completed end-to-end trace (caller→callee, write→read). No speculation.
4. Conventions listed above are intentional — do not report them as findings. Pre-existing issues in UNCHANGED lines are out of scope unless the changeset makes them worse or interacts with them.
5. Return findings as structured output only. Do not write any files.
6. Severities: critical | high | medium | low | info. Report EVERYTHING you find, including low and info — nothing is beneath recording.

## Quality bar

See quality-bar.md in this directory.
