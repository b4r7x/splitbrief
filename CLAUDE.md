# SPLITBRIEF

Open-source orchestrator for two AI coding tools. The stronger one plans, compiles Task Briefs, and reviews; the weaker one executes them. SPLITBRIEF holds the contract between them — the brief, validation, retry, escalation, and the evidence trail.

## CRITICAL — NEVER COMMIT, NEVER STAGE (subagents); checkpoint commits only (the orchestrating session)

Subagents, workflow lanes and implementer tools do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass. Leave every change as an unstaged modification in the working tree.

The one exception is the orchestrating session the owner talks to, at an agreed checkpoint (owner decision 2026-10-03): after the gates of that checkpoint are green and the review findings are fixed, it stages and commits with the `/human-commit` style message, running the command prefixed with `SPLITBRIEF_OWNER_COMMIT=1 ` (the hook lets that prefix through). Nothing else commits, nothing pushes, nothing rewrites history.

**Enforcement (best-effort):** `.claude/hooks/block-git-commits.sh` is a `PreToolUse` hook that blocks `git add` / `git stage` / `git commit` (including `git -c …`, `git -C …`, and simple quoted/backslashed variants) with exit code 2. It is a guardrail, not a sandbox — sufficiently obfuscated invocations may still slip past, so the never-commit rule above is what binds you, not the hook. A `BLOCKED:` message in stderr means the guardrail fired — stop and report to the user.

## Stack

- **Runtime:** Node.js 22+, TypeScript 6.x, ESM only (`.js` extension in imports)
- **Runner:** `tsx` (dev) / `tsc` → `dist/` (build)
- **TUI:** Ink 6.x (React 19) + `fullscreen-ink`
- **Testing:** Vitest 4.x, colocated (`foo.test.ts` next to `foo.ts`)
- **Lint/format:** Biome 2.x
- **Validation:** Zod 4.x. **Config:** `yaml`. **Git:** `simple-git`. **CLI:** `commander`

## Commands

```bash
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec|init|status|resume
npm run typecheck                # tsc --noEmit (src + test configs)
npm run lint                     # Biome check
npm run format                   # Biome format --write
npm test                         # vitest run
npm run release-check            # PR gate: format:check && typecheck && lint && test && test:e2e && invariants && skills:check
npm run test-ci                  # exhaustive form: same, with test:coverage thresholds
node scripts/dangling-imports.mjs  # audit: relative imports that resolve to nothing (exit 1 on findings)
```

## Documentation map

Read the canonical doc **before** touching the matching area. Every link below exists.

**Start here:** New? Read [docs/MENTAL-MODEL.md](./docs/MENTAL-MODEL.md) → [docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) → [docs/WORKFLOW.md](./docs/WORKFLOW.md).

| When you're about to… | Read |
|---|---|
| Understand what SPLITBRIEF is | [docs/MENTAL-MODEL.md](./docs/MENTAL-MODEL.md) — the concept, no code |
| Understand how it works end-to-end | [docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) — data flow with file paths |
| Understand the workflow state machine | [docs/WORKFLOW.md](./docs/WORKFLOW.md) — phases, transitions, the planning session |
| Understand the orchestrator and EventBus | [docs/ENGINE.md](./docs/ENGINE.md) — orchestrator, sinks, callbacks vs events |
| Understand planner/implementer/reviewer pipeline | [docs/PLANNERS-AND-IMPLEMENTERS.md](./docs/PLANNERS-AND-IMPLEMENTERS.md) — runner kinds, the three seats, Task Brief, token accounting |
| Understand stores and UI | [docs/STORES-AND-UI.md](./docs/STORES-AND-UI.md) — store factory, screens, overlays |
| Understand approval gates and recovery | [docs/APPROVAL-AND-RECOVERY.md](./docs/APPROVAL-AND-RECOVERY.md) — plan card, protected-path confirmation, escalation, drift |
| Understand supporting subsystems | [docs/SUBSYSTEMS.md](./docs/SUBSYSTEMS.md) — hooks, snapshots, repo-map, runtime commands, detection, compaction, evidence ledger |
| Understand how the code is laid out and what exists today | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layer diagram and design rationale, plus a verified inventory of events, commands, paths and public API |
| Look up a term used in `src/` or the docs | [docs/CONCEPTS.md](./docs/CONCEPTS.md) — concepts and glossary |
| Read or change the Task Brief / `state.json` contract | [docs/TASK-CONTRACT.md](./docs/TASK-CONTRACT.md) — Product Task Brief v1, `plan.json`, state v4 boundary |
| Find what a user-facing feature does and how to invoke it | [docs/FEATURES.md](./docs/FEATURES.md) — capability reference with config and on-screen output |
| Touch the workflow conversation scroll | [docs/WORKFLOW-CONVERSATION-SCROLL.md](./docs/WORKFLOW-CONVERSATION-SCROLL.md) — the row-counted scroll model |
| Upgrade across the 2026-04-20 EventBus release | [docs/MIGRATION.md](./docs/MIGRATION.md) — integrator API changes and config additions |
| Add a command, event, store, or backend | [docs/EXTENDING.md](./docs/EXTENDING.md) — step-by-step recipes |
| Get SPLITBRIEF running for the first time | [docs/GETTING-STARTED.md](./docs/GETTING-STARTED.md) — onboarding |
| Look up a CLI command | [docs/CLI-REFERENCE.md](./docs/CLI-REFERENCE.md) — command reference |
| Look up a runtime command (`/name`) | [docs/SLASH-COMMANDS-REFERENCE.md](./docs/SLASH-COMMANDS-REFERENCE.md) — runtime commands |
| Configure SPLITBRIEF | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) — config reference |
| Run end-to-end scenarios / find a recipe | [docs/USAGE-EXAMPLES.md](./docs/USAGE-EXAMPLES.md) — recipes |
| Hit a problem | [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — symptoms & fixes |
| Add or move any file | [docs/STRUCTURE.md](./docs/STRUCTURE.md) — file tree, feature anatomy |
| Decide `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/` | [docs/LAYERS.md](./docs/LAYERS.md) |
| Touch anything under `src/stores/` | [docs/STORES.md](./docs/STORES.md) |
| Add or move a type | [docs/TYPES.md](./docs/TYPES.md) |
| Create an `index.ts` | [docs/NO-BARRELS.md](./docs/NO-BARRELS.md) — zero barrels, enforced |
| Add or refactor a React hook | [docs/HOOKS.md](./docs/HOOKS.md) |
| Add a startup step | [docs/BOOTSTRAP.md](./docs/BOOTSTRAP.md) |
| Create a new error type | [docs/ERRORS.md](./docs/ERRORS.md) |
| Place a test | [docs/TESTING.md](./docs/TESTING.md) |
| Cut a release | [docs/RELEASING.md](./docs/RELEASING.md) — the live release matrix and its manifest |
| Enforce a cross-cutting rule | [docs/INVARIANTS.md](./docs/INVARIANTS.md) — pre-merge grep gates |
| Orient yourself in the codebase | [docs/PRINCIPLES.md](./docs/PRINCIPLES.md) — one-page rule index |
| Judge code against the SOTA review bar | [docs/CODE-STANDARD.md](./docs/CODE-STANDARD.md) — consolidated quality standard + reviewer checklist |
| Check what has already been decided | `.specify/memory/constitution.md` — the ADRs of the 2026-08-04 realignment are folded into it, `docs/VISION.md` and the docs. `.nuke/2026-08-04-decisions.md` is the local decision record for that pass: untracked, present only in the working copy |
| Check strategic direction | [docs/VISION.md](./docs/VISION.md), [docs/FUTURE.md](./docs/FUTURE.md), [docs/DIRECTION.md](./docs/DIRECTION.md) — how we build, [docs/IMPLEMENTER-DIRECTION.md](./docs/IMPLEMENTER-DIRECTION.md) — implementer direction |
| Browse the whole docs folder | [docs/README.md](./docs/README.md) — the docs index, grouped by task |
| Contribute to this project | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Work with API keys | [docs/API-KEYS.md](./docs/API-KEYS.md) |
| Debug a failing workflow | [docs/DEBUGGING.md](./docs/DEBUGGING.md) |
| Develop SPLITBRIEF with SPLITBRIEF itself: run the built CLI on this repo, end the run on a tool defect, fix, rebuild, start a new run | [docs/DOGFOODING.md](./docs/DOGFOODING.md) — the dogfooding procedure, the stop/continue smoke |
| Work with workflow hooks | [docs/HOOKS-CONFIG.md](./docs/HOOKS-CONFIG.md) |
| Tune the planner repo-map | [docs/REPOMAP.md](./docs/REPOMAP.md) |
| Install the pipeline as agent skills | [docs/SKILLS.md](./docs/SKILLS.md) — four pipeline skills, supervised dogfooding, grammar, sync script |
| Look up release history | [CHANGELOG.md](./CHANGELOG.md) |
| Continue the 2026-10 finish-pipeline work (S9 verification, S11, plan close) in any session or after a context compaction | `.nuke/2026-10-03-finish-pipeline/HANDOFF.md` — read it first; the state is in `LOG.md` next to it (local, untracked folder) |

Reference also: `.specify/memory/constitution.md` — 6 constitutional principles (linked from VISION).

## Core conventions

These are the rules that apply everywhere; deeper specifications live in the linked doc.

- **Zero runtime classes.** Pure functions and module-scoped state in production source; test fixtures may contain class syntax when that is the behavior under test.
- **ESM with `.js` extension** in every import: `'./config.js'` not `'./config'`.
- **kebab-case** file and folder names (`models-dev.ts`, `lm-studio.ts`). Single-word where natural (`pricing.ts`).
- **No decorative comments.** No section banners. Ordering is the documentation.
- **Error at boundaries.** Internal functions propagate; callers decide. See [ERRORS.md](./docs/ERRORS.md).
- **No unsafe assertions.** No incidental `!` or broad `as` in production. Sanctioned exceptions: `src/utils/type-guards.ts`, `src/stores/create-store.ts`, `src/stores/use-stores.ts`, the `as AppError` factory cast in `src/utils/error.ts`, `Map.get(...)!` in `src/engine/codebase/graph.ts` and `src/engine/codebase/pagerank.ts` (Map.get after pre-population — invariant documented inline), `as unknown` for path-walking arbitrary shapes in `src/engine/hooks/substitute.ts` (recursive Record traversal), and `src/lib/terminal/filtered-stdin/create.ts` (bridged `PassThrough` stdin that satisfies the TTY members Ink reads).
- **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`. `find src -name 'index.ts'` must return nothing. See [NO-BARRELS.md](./docs/NO-BARRELS.md).
- **Zero memoization.** No `useMemo`, `useCallback`, or `React.memo`. Store selectors make them unnecessary. See [STORES.md](./docs/STORES.md).
- **No imperative handles.** No `forwardRef` / `useImperativeHandle`. Extract state to a store instead.
- **Zero engine → React imports.** `src/engine/` must not import from `ink`, `react`, or `src/features/`, `src/components/`, `src/hooks/`.
- **Zero failing gates.** `npm run release-check` (format:check → typecheck → lint → test → e2e → invariants → skills:check) must pass before any PR; `npm run test-ci` is the exhaustive form that additionally enforces the coverage thresholds.
- **Run contract.** A run is a durable record. `deriveRunStatus` (`src/core/sessions/run-status.ts`) supplies one status: `running`, `open`, `ready-to-apply` or `closed`. An open run is `waiting-for-you` (on a question, a gate or a halt) or `stopped` (paused, failed or interrupted), so a user sees five states: running, waiting for you, stopped, ready to apply, closed. Every listing, guard and screen reads it. An open run stays continuable; a ready run is not continued, it takes Apply or Discard. In worktree and staged-copy mode, a passing review makes it ready to apply. Apply, Discard or `CLOSE_RUN` closes it. In checkout mode (`workflow.isolation: none`), or on an older run without a workspace, a passing review or Accept as is override closes the run, with no Apply. The override preserves the failed verdict. A *Seat down* halt moves its seat at once when the seat declares a `fallback` and the halt is an account refusal or a long reset; this happens once per run and seat, and each switch is recorded in `seatSwitches`. `idle` exists only before `START`; gates never reject, and `continueRun` owns continuation. See [WORKFLOW.md](./docs/WORKFLOW.md#run-status).
- **Change discipline, always.** Load the `change-discipline` skill before you implement, fix or review code, and follow it. Fix the root cause at the function every caller routes through. Reuse what the project already has. Migrate callers and delete the old path in the same change. Do not add speculative options, guards or fallbacks that hide errors. Hand back in its §9 form.
- **Targeted edits only.** Do not rewrite entire files or modules. Provide targeted patches or unified diffs showing only the modified lines with 3 lines of context.

## Look-and-logic verification (binding for every user-visible change)

A change to anything a user sees — a screen, an overlay, a row, a byline, a picker, copy — is not done when tests pass. It is done when the agent has looked at the rendered result, critiqued it the way the owner would, fixed what it found, and can say "a paying user would call this finished". The session that owns the change runs this loop: a developer, a supervising session, a reviewer or a verifier; a hand-back that skips it is invalid. An implementer seat running under SPLITBRIEF does not render or run the project gates; SPLITBRIEF validates every brief in the run workspace and collects the renders through `validation.render`, and the reviewer and the supervising session critique them.

1. **Render it, then look at it.** After every visual change run `npm run tui-shots -- --scenario <id>` for every gallery scenario that covers the touched surface (`npm run tui-shots -- --list`; picker work → the `overlay-*-picker*` and `overlay-settings*` scenarios, crew work → `setup-initial` too) and open the PNG under `.test-artifacts/ui/` with the Read tool. No scenario covers the surface → add one to `testing/visual/catalog.ts` first. Surfaces fed by real data (model catalogs, detection, tool listings) are additionally checked against real output (`npm run dev`, the PTY harness, or the tool's own `--list-models` / `--help`), never only against fixtures.
2. **Critique before fixing.** Write the defect list from the render before touching code: glyphs that do not connect (a bullet beside a box-drawing branch), columns that do not align, a chevron or marker used two ways, a label a first-time user cannot decode ("variant"), a value with no vocabulary ("—"), a row rendered twice, copy that differs from the neighbouring surface. "It renders" and "tests pass" are not verdicts. Anything short of "I would ship this to a paying user" is an open list, not a result.
3. **Iterate until it looks designed.** Fix → re-render → re-critique. Stop only at zero open items. Report the final render's critique, not just that a render happened.
4. **One concept, one home.** Before adding any control or column, grep for where that concept is already chosen or displayed. Model, effort, speed, thinking, variant, tool: each is *selected* in exactly one place; every other surface shows it read-only, derived from that selection. Two editable homes for one value is a defect regardless of which came first.
5. **Data completeness is a visual check.** A list that paints is not a list that is right. Compare the rendered rows against the source of truth (the tool's own listing, the documented alias table, the provider's vocabulary) and name every missing, extra, duplicated or orphaned entry. "2 static models" for a tool that serves more, a model listed four times, or a bare alias with no metadata row are bugs even when the panel looks tidy.
6. **Cross-surface consistency.** The same value must read identically on every surface that shows it (home, Settings, Setup, picker mirror, workflow header/sidebar). When a shared formatter or row model changes, render the neighbours too.

## Current TUI architecture

- **Composer** lives in `src/components/composer/`. Do not recreate `input-bar` modules or compatibility shims.
- **Runtime commands** live in `src/core/runtime/commands/`. They use slash names, and the registry backs both composer `/` input and the command palette. 22 commands in five categories; `/crew <seat>` is the only seat command; `/stop` reopens the inline session-options menu; `/usage` opens token and monetary details on a workflow. Main workflow screens have no cost counter, Show spend control or Commit strategy setting.
- **App shell** lives in `src/app/`: composition root `root.tsx` (mounts `<AppProvider><Router/>`), `router.tsx` (`renderScreen` + `renderOverlay` switches → `<Layout>`), `provider.tsx` (`AppProvider`; today only `ThemeProvider`), `layout.tsx` (header + body + footer), plus app-wide keys in `keys.ts` and runtime-command context in `command-context.ts`. The shell lives entirely under `src/app/`; there is no monolithic root component or layout file at the `src/` root.
- **Screens and overlays are FLAT pages** under `src/app/screens/` (`home`, `workflow`, `setup`) and `src/app/overlays/` (`help`, `palette`, `skills`, `sessions`, `settings`, `runners`, `usage`, `editor`). Each page composes its feature; feature components/hooks/helpers stay in `src/features/<x>/` and are imported via `../../features/<x>/…`. `help`, `sessions`, `setup`, and `skills` are dissolved (pure-entry) — the page is the whole surface, no `features/<x>/` folder. Pages must not import each other (they coordinate via stores) or the shell modules; see [docs/INVARIANTS.md](./docs/INVARIANTS.md) gate 9.
- **Command palette** lives in `src/features/palette/`; source assembly is `sources.ts`, ranking is `results.ts`, and the overlay entry is the page `src/app/overlays/palette.tsx`.
- **Settings** overlay entry is the page `src/app/overlays/settings.tsx`.
- **Runner selection** is the `src/features/runners/` feature; its picker entry is the page `src/app/overlays/runners.tsx`. One `ToolModelPicker` serves three roles (`SeatPickerRole`: planner · implementer · reviewer) — do not fork a per-role picker. `ToolModelPicker` is a component name, not a `tool-picker` folder boundary. The picker's expanded model row is the one place a seat's `effort`, `fast` and `thinking` are chosen (`OptionAxisName`, `src/features/runners/model-catalog/option-axis.ts`); every other surface mirrors that choice read-only.
- **Crew** is the `src/features/crew/` feature (`row-view.tsx`, `rows.ts`, `format.ts`, `preset-row.tsx`, `use-crew.ts`) rendered by the Settings page as its first section and by the Setup screen; seat, row, identity and preset models live in `src/core/crew/` — the UI derives from core, never the reverse; there is no standalone crew overlay. A crew row is a read-only mirror of its seat (`deriveCrewRows`, `src/core/crew/rows.ts`, one row per seat, keyed `seat:<id>`): it edits nothing, and `⏎` on it opens that seat's picker (`crewActivate`, `src/features/crew/rows.ts`), which is where tool, model and effort are chosen.
- **Sizing** — every overlay panel and the home body and composer take their width from `overlayRect` (`src/core/navigation/overlay-rect.ts`, densities `compact`/`roomy`/`wide`); home applies a local 108-column cap. `OverlayPanel` has no `maxWidth`. The workflow screen — composer included — the transcript and the full-bleed `editor` overlay stay full-width (see the workflow bullets below), live or at rest.
- **Seat identity** — one formatter (`src/core/crew/identity.ts`, `<tool> · <model>` plus one ` · <word>` per axis the seat's effort channel carries, in effort → thinking → fast order, sanitized before measurement) feeds home, Settings, Setup, the picker mirror and the workflow header/sidebar. The short/collapsed form carries no axis, and when the collapsed line overruns its width a seat loses its whole identity (`REVIEW …`) rather than half a model name.
- **Workflow live status** renders in the composer byline (`InputFooter` + `deriveLiveStatus`), not as a transcript row — do not recreate `live-status-row`; status derives from `lifecycle.phaseFirstSeenTs`, not a scan of the events array; a running full-suite stage leads the byline with its stage, command and own clock (`Pre-review suite · npm test 10:02`, `Base re-run · <command>`). The transcript has no max-width cap; the sidebar (a clamped 25% share — floor 34, cap 48, only above the 120-column workflow breakpoint — plus a 2-col gap) is the only width constraint. Transcript and review overlay share the pure markdown core (`src/utils/markdown/`), which covers links, leading-pipe GFM tables, headings h1–h6, strikethrough, and lowlight-highlighted fenced code; markdown HTML comments — including planner `<!-- Q:… -->` clarification markers — never render. File-path links display project-relative and emit OSC 8 hyperlinks when the terminal supports them (in-house env sniff in `src/lib/terminal/hyperlinks.ts`, overridable via `FORCE_HYPERLINK`). Ordinary planner replies wait for an answer in the composer; optional structured questions use the bordered `QuestionPrompt` in every run. Recovery uses an inline keyboard menu above the composer, titled with its halt — `Needs you · <cause>` or `Seat down · <cause>` (`haltOf`, `src/core/recovery/halt.ts`) — with Tab switching focus and a scrollable list of the offered actions; taking `switch-seat` opens the halted seat's own picker on the offered tool rather than listing tools in the panel.
- **Stop, leave, quit** — the `stop-sheet` focus token renders an inline menu above the workflow composer, preserving fullscreen and transcript. Running: `esc` opens, another `esc` stops resumably; the next `esc` returns home after cleanup and persistence (rapid `esc esc esc` works). Parked: `esc` returns home. `ctrl+c` stops active work; another press quits after cleanup. At rest/home, two presses within two seconds quit; other interaction clears confirmation. End run is explicit in the menu or `/end`, never inferred from Escape or quit. On a ready run, End run means Discard and preserves `run.patch`. After stopping the menu offers Resume / End run / Back to sessions; Tab dismisses, `/stop` or the palette reopens it. The outer workflow abort settles questions, approvals and boundary waits; only the process registry owns termination timing. Failed cleanup/saving offers Retry stop and prevents departure. Full unsent draft documents are saved per session in `draft.json`, flushed before departure, and restored on reopening.
- **Build progress block** — during `implementing` and the final review the workflow screen paints fixed chrome under the header rail from `deriveBuildProgress` (`src/features/workflow/display/build-progress.ts`): the counts line (`attempt <a> of <max>` joins it only from attempt 2), the activity line (the seat and what it is doing, the gate command it is inside, or the full-suite stage and its command) and freshness. The block is two rows at 120 columns and wider and three below (`buildProgressRowCount(width)`). There is no ETA on any surface. The only fraction any surface shows is *passed* briefs — neither the byline nor the sidebar counts a started or escalated brief as settled.
- **Run screen at rest** — the workflow screen is the run's home whether anything is running on it or not. Opening a run from `/sessions`, home or the palette replays its `session.jsonl` into the workflow stores (`hydrateRun`, `src/features/workflow/run-history.ts`) and shows it at rest (`execution: { kind: 'at-rest' }` on the workflow route); the live bus appends from there, and continuing it flips the execution back to `local` in place without navigating (`continueRunInPlace`, `src/stores/navigation/session-select.ts`). The header rail marks the stage the run stopped on with the mark its stop earned (`✗` a halt or a failure, `×` every other stop, three `●` ready-to-apply or complete — Plan, Build, Review — `atRestRailStages`, `src/features/workflow/at-rest.ts`). A failed review is the Review stage, never done, and an ended run has no Apply stage; the closed block reads the same rail. An open run's composer takes a correction and a bare `⏎` continues it. A ready-to-apply run shows Apply · Show diff · Discard above the composer (`src/features/workflow/result/`). Tab switches focus; bare letters select no action. An override labels Apply as **Apply as is** and asks once. End run on a ready run preserves `run.patch` and closes it as discarded. A **closed** run (applied, discarded, ended, or older complete) takes `/commands` only, `⏎` goes home, and its ledger is appended to the tail of its own transcript as a `Closed ─` block naming the run and its applied, discarded, ended or older complete outcome, over `Briefs ─ / Files ─ / Run ─` (`closedTranscriptBlock`, `src/features/workflow/closed/block.tsx`) — one scroller, never a second. A closed run takes the whole width: the sidebar stands down rather than restating today's crew beside the block that states the run's own, and the transcript announces nothing as queued. Every closed fact is derived once by `deriveSummaryView` (`src/features/workflow/closed/view-model.ts`) from the `RunRecord` the route carries and spelled by `copy.ts`. After End run the closed byline (`bylineText`) speaks: `Ended · …`. The open-run byline is `openRunByline` (`src/features/workflow/closed/byline.ts`), which reads the record's stop reason. One fact, one home: absence is `not run` / `not checked` / `not estimated`, never `—`, `n/a` or `$0.00`. There is no summary screen.

## Runner kinds

Planner, reviewer, and implementer all accept four runner kinds. The reviewer is optional — with no `reviewer:` block the planner holds the review seat (`resolveReviewerRunner`, the only module that branches on `config.reviewer`). The `kind` field is the discriminant and is always required. Configs declare `version: 3` — the only accepted version; any other value fails the load.

| `kind` | What it is | Example |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity` |
| `api` | OpenAI-compatible HTTP endpoint | Ollama, LM Studio, or any OpenAI-compatible custom endpoint |
| `shell` | Arbitrary command (stdin → stdout; no shell/network sandbox) | Custom scripts |
| `agent` | Subprocess that writes files directly (no stdout extraction; no shell/network sandbox) | Custom file-writing tools |

Factory: `src/engine/runners/factory.ts` — `createPlanner(config)` / `createReviewer(config)` / `createImplementer(config)` dispatch by `kind`.

Full config schemas and YAML examples: [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

## Planning session

Every run plans in one typed planning session (`runPlanSession`, `src/engine/orchestrator/planning/plan-session.ts`, driven by `session.ts`). There are no workflow modes and no fixed chain of planner documents.

1. **Questions.** The planner may ask at most 3 questions per round, each with a default, for at most 2 rounds. An empty `⏎` takes the defaults. Answers go back on the same native planner session.
2. **Typed plan.** The planner answers `{ result }` against `PlanAnswerSchema` (`src/core/schemas/plan.ts`): acceptance criteria, checks, validation commands and tasks (`TaskSpec`). SPLITBRIEF validates it with Zod and writes `plan.json`, then renders `plan.md` and `tasks.md` from it.
3. **Deterministic checks.** `checkPlan` (`src/engine/spec/plan-checks.ts`) plus the context fit (`estimatePlanContextFits`) check the plan. A failing plan goes back to the planner once; a second failure halts the run.
4. **Plan card.** With `workflow.approve: plan` (the default) one plan card opens: approve, request changes, edit `plan.json` (re-validated), or end the run. Approving it confirms the protected writes the plan lists. `approve: none` skips the card. The retired keys (`workflow.mode`, `task_review`, `brief_review`, `speckit`, `approval.tiers`, and the old approve values) load with one notice each.

An old run parked in a retired phase or at a spec or briefs gate continues as one planning session; only a plan card with a saved plan re-opens. `splitbrief spec` runs the same session without a build. Detailed semantics: [docs/WORKFLOW.md](./docs/WORKFLOW.md).

## Known limitations

- macOS and Linux only — several path and sandbox semantics need POSIX; Windows support is planned but not available yet.
- Validation is generic over the five registry stacks (TypeScript, JavaScript, Python, Go, Rust); any other stack runs review-only (`gates: NONE`).

## Response Language Standard — ASD-STE100

Write every response in Simplified Technical English (ASD-STE100).

- Use one word for one meaning. Do not introduce a synonym for a concept you already named.
- Write short sentences. Use a maximum of 20 words in an instruction and 25 in a description.
- Use the active voice. Name the actor that does the action.
- Use simple tenses only: present, past, future.
- Give one instruction per sentence.
- Start each paragraph with its topic sentence. Use a maximum of 6 sentences per paragraph.
- Keep noun clusters to 3 words or fewer.
- Use articles (`the`, `a`) where the grammar permits them.
- Do not use idioms, slang, metaphors, or rhetorical questions.
- Do not delete technical detail to make a sentence simple. Split the sentence instead.

When you reply in a language other than English, apply the same rules in that language.
