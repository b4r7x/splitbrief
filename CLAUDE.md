# SPLITBRIEF

Open-source orchestrator for two AI coding tools. The stronger one plans, compiles Task Briefs, and reviews; the weaker one executes them. SPLITBRIEF holds the contract between them — the brief, validation, retry, escalation, and the evidence trail.

## CRITICAL — NEVER COMMIT, NEVER STAGE (subagents); checkpoint commits only (the orchestrating session)

Subagents, workflow agents and implementer tools do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass. Leave every change as an unstaged modification in the working tree.

The one exception is the orchestrating session, at an agreed checkpoint: after the gates of that checkpoint are green and the review findings are fixed, it stages and commits with the `/human-commit` style message, running the command prefixed with `SPLITBRIEF_OWNER_COMMIT=1 ` (the hook lets that prefix through). Nothing else commits, nothing pushes, nothing rewrites history.

**Enforcement (best-effort):** `.claude/hooks/block-git-commits.sh` is a `PreToolUse` hook that blocks `git add` / `git stage` / `git commit` (including `git -c …`, `git -C …`, and simple quoted/backslashed variants) with exit code 2. It is a guardrail, not a sandbox — sufficiently obfuscated invocations may still slip past, so the never-commit rule above is what binds you, not the hook. A `BLOCKED:` message in stderr means the guardrail fired — stop and report to the user.

## Commands

```bash
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec|init|status|resume
npm run typecheck                # tsc --noEmit (src + test configs)
npm run lint                     # Biome check
npm run format                   # Biome format --write
npm test                         # unit; no git, no fake CLIs
npm run test:integration         # git, worktree, run-loop, Apply, fake CLI and node shim tests
npm run release-check            # PR gate: format:check && typecheck && lint && test && test:integration && build && test:e2e && invariants && skills:check
npm run test-ci                  # exhaustive form: same, with test:coverage thresholds
npm run release:smoke            # npm pack, check the tarball contents, --engine-strict install in a temp project, load native better-sqlite3, run splitbrief --version and --help
node scripts/dangling-imports.mjs  # audit: relative imports that resolve to nothing (exit 1 on findings)
```

## Documentation map

Read the canonical doc **before** touching the matching area. Every link below exists.

**Start here:** New? Read [docs/MENTAL-MODEL.md](./docs/MENTAL-MODEL.md) → [docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) → [docs/WORKFLOW.md](./docs/WORKFLOW.md).

| When you're about to… | Read |
|---|---|
| Learn what SPLITBRIEF is | [docs/MENTAL-MODEL.md](./docs/MENTAL-MODEL.md) |
| Follow the data flow end to end | [docs/HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) |
| Change the workflow state machine or the planning session | [docs/WORKFLOW.md](./docs/WORKFLOW.md) |
| Change the orchestrator or the EventBus | [docs/ENGINE.md](./docs/ENGINE.md) |
| Change a planner, implementer or reviewer seat | [docs/PLANNERS-AND-IMPLEMENTERS.md](./docs/PLANNERS-AND-IMPLEMENTERS.md) |
| Change a screen, an overlay or anything under `src/stores/` | [docs/STORES-AND-UI.md](./docs/STORES-AND-UI.md) |
| Change the plan card, approvals or recovery | [docs/APPROVAL-AND-RECOVERY.md](./docs/APPROVAL-AND-RECOVERY.md) |
| Change a supporting subsystem (hooks, repo-map, evidence ledger) | [docs/SUBSYSTEMS.md](./docs/SUBSYSTEMS.md) |
| See the layers and what exists today | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Look up a term | [docs/CONCEPTS.md](./docs/CONCEPTS.md) |
| Change the Task Brief or `state.json` contract | [docs/TASK-CONTRACT.md](./docs/TASK-CONTRACT.md) |
| Find what a user-facing feature does | [docs/FEATURES.md](./docs/FEATURES.md) |
| Touch the workflow conversation scroll | [docs/WORKFLOW-CONVERSATION-SCROLL.md](./docs/WORKFLOW-CONVERSATION-SCROLL.md) |
| Upgrade across the 2026-04-20 EventBus release | [docs/MIGRATION.md](./docs/MIGRATION.md) |
| Add a command, event, store, or backend | [docs/EXTENDING.md](./docs/EXTENDING.md) |
| Run SPLITBRIEF for the first time | [docs/GETTING-STARTED.md](./docs/GETTING-STARTED.md) |
| Look up a CLI command | [docs/CLI-REFERENCE.md](./docs/CLI-REFERENCE.md) |
| Look up a runtime command (`/name`) | [docs/SLASH-COMMANDS-REFERENCE.md](./docs/SLASH-COMMANDS-REFERENCE.md) |
| Configure SPLITBRIEF or tune the planner repo-map | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) |
| Find a recipe | [docs/USAGE-EXAMPLES.md](./docs/USAGE-EXAMPLES.md) |
| Debug a failing workflow | [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) |
| Add or move any file | [docs/STRUCTURE.md](./docs/STRUCTURE.md) |
| Decide `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/` | [docs/LAYERS.md](./docs/LAYERS.md) |
| Add or move a type | [docs/TYPES.md](./docs/TYPES.md) |
| Create an `index.ts` | [docs/NO-BARRELS.md](./docs/NO-BARRELS.md) |
| Add or refactor a React hook | [docs/HOOKS.md](./docs/HOOKS.md) |
| Add a startup step | [docs/BOOTSTRAP.md](./docs/BOOTSTRAP.md) |
| Create a new error type | [docs/ERRORS.md](./docs/ERRORS.md) |
| Place a test or run the look-and-logic loop | [docs/TESTING.md](./docs/TESTING.md) |
| Cut a release | [docs/RELEASING.md](./docs/RELEASING.md) |
| Enforce a cross-cutting rule | [docs/INVARIANTS.md](./docs/INVARIANTS.md) |
| Orient yourself (§6) or judge code against the review bar | [docs/CODE-STANDARD.md](./docs/CODE-STANDARD.md) |
| Check strategic direction | [docs/VISION.md](./docs/VISION.md), [docs/FUTURE.md](./docs/FUTURE.md), [docs/DIRECTION.md](./docs/DIRECTION.md) |
| Check what has already been decided | `.specify/memory/constitution.md`, then the local record `.nuke/2026-08-04-decisions.md` (untracked) |
| Browse the whole docs folder | [docs/README.md](./docs/README.md) |
| Contribute, or maintain the agent skills | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Work with API keys | [docs/API-KEYS.md](./docs/API-KEYS.md) |
| Develop SPLITBRIEF with SPLITBRIEF itself | [docs/DOGFOODING.md](./docs/DOGFOODING.md) |
| Work with workflow hooks | [docs/HOOKS-CONFIG.md](./docs/HOOKS-CONFIG.md) |
| Install the pipeline as agent skills | [docs/SKILLS.md](./docs/SKILLS.md) |
| Look up release history | [CHANGELOG.md](./CHANGELOG.md) |
| Continue the 2026-10 finish-pipeline work after a compaction | `.nuke/2026-10-03-finish-pipeline/HANDOFF.md`, then `LOG.md` next to it (local) |

## Core conventions

These rules apply everywhere. The linked doc holds the detail.

- **Zero runtime classes.** Pure functions and module-scoped state in production source. See [CODE-STANDARD.md §6](./docs/CODE-STANDARD.md#6-the-hard-conventions-enforced--summarized-linked).
- **ESM with `.js` extension** in every import, and **kebab-case** file and folder names. See [CODE-STANDARD.md §5](./docs/CODE-STANDARD.md#5-naming--file-naming).
- **No decorative comments.** No section banners. See [STRUCTURE.md](./docs/STRUCTURE.md#no-decorative-comments).
- **Error at boundaries.** Internal functions propagate; callers decide. See [ERRORS.md](./docs/ERRORS.md).
- **No unsafe assertions.** No incidental `!` or broad `as` in production. Sanctioned exceptions: `src/utils/type-guards.ts`, `src/stores/create-store.ts`, `src/stores/use-stores.ts`, the `as AppError` factory cast in `src/utils/error.ts`, `Map.get(...)!` in `src/engine/codebase/graph.ts` and `src/engine/codebase/pagerank.ts` (Map.get after pre-population — invariant documented inline), `as unknown` for path-walking arbitrary shapes in `src/engine/hooks/substitute.ts` (recursive Record traversal), and `src/lib/terminal/filtered-stdin/create.ts` (bridged `PassThrough` stdin that satisfies the TTY members Ink reads).
- **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`. See [NO-BARRELS.md](./docs/NO-BARRELS.md).
- **Zero memoization, no imperative handles.** No `useMemo`, `useCallback`, `React.memo`, `forwardRef` or `useImperativeHandle`. See [STORES-AND-UI.md](./docs/STORES-AND-UI.md#store-rules).
- **Zero engine → React imports.** `src/engine/` must not import from `ink`, `react`, or the UI folders. See [LAYERS.md](./docs/LAYERS.md#engine--workflow-orchestration).
- **Zero failing gates.** `npm run release-check` must pass before any PR; `npm run test-ci` also enforces the coverage thresholds. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [INVARIANTS.md](./docs/INVARIANTS.md).
- **Run contract.** A run is a durable record; `deriveRunStatus` supplies one status and every surface reads it. See [WORKFLOW.md](./docs/WORKFLOW.md#run-status).
- **Change discipline, always.** Load the `change-discipline` skill before you implement, fix or review code, and follow it. Fix the root cause at the function every caller routes through. Reuse what the project already has. Migrate callers and delete the old path in the same change. Do not add speculative options, guards or fallbacks that hide errors. Hand back in its §9 form.
- **Targeted edits only.** Do not rewrite entire files or modules. Provide targeted patches or unified diffs showing only the modified lines with 3 lines of context.

## Reporting findings (binding)

A finding from a review, a live check, a test run or an audit is reported only when it is confirmed. Every finding states four things:

1. **Evidence.** The raw evidence that shows it: a capture, a log line, a `session.jsonl` event, a test output. Name the file.
2. **Cause.** The code that causes it, with `file:line`, read in the current tree.
3. **Who hits it, and its kind.** `PRODUCT` when a normal user in a normal setup hits it (their own HOME, their signed-in tools, normal input). `TEST` when only the test conditions cause it (a temporary HOME, exported API keys in the tester's shell, a fake tool, an odd input the tester typed, parallel runs on one machine, a flaw in the test or the harness). `ENV` when an outside service failed (an outage, a rate limit).
4. **What the user sees.** One sentence in plain words. A `PRODUCT` finding also has a class: 1 blocks work, loses data or gives a wrong outcome; 2 shows wrong or misleading text; 3 is cosmetic.

A `PRODUCT` finding is fixed in the product. A `TEST` finding is fixed in the test, the harness or the check setup; it blocks a release only when it breaks the gate or CI. An `ENV` finding is recorded, not fixed.

Drop a finding that cannot be confirmed. Never report a guess as a defect.

An independent skeptic, not the agent that found it, checks every finding against these four points and tries to refute it before it is reported or fixed. Only the findings the skeptic confirms go to the owner or to a fix.

## Fixing a defect (binding)

1. **Confirm first.** Before any edit, confirm the defect as "Reporting findings" requires: the evidence, the cause at `file:line`, and that a normal user hits it. A finding that cannot be confirmed is not fixed; report it as not confirmed.
2. **Plan, then change.** Load the `change-discipline` skill. Write the plan: the one function every caller routes through, the callers to migrate, the old path to delete. Then implement it; no guessed design.
3. **Tests at the end.** Planning, implementing, reviewing and fixing run no tests (typecheck, lint and format only). After the review passes, run the tests of the change once at the end. When a test fails, fix the root cause, review the fix, and run the tests again until they pass.
4. **No flaky tests.** Write every test to be deterministic: wait on an event, a file or an output line, never on a fixed sleep; inject the clock, the random source and the order. A test that passes on one run and fails on the next is a defect, never a verdict. Find the race and fix it at the root, in the test (`TEST`) or in the product (`PRODUCT`). A longer timeout, a retry, `.skip` or a re-run is never the fix. Prove the fix with the file green 5 runs in a row. See [TESTING.md](./docs/TESTING.md#core-rules).
5. **Real red.** A new test must fail on the old code and pass on the new code. A test that passes on the old code proves nothing. When a test fails, first find out if the code is wrong, and fix the code. Do not fit the test to the code. Change a test only when the test itself is proven wrong, and state why.

## User-facing text

Text a user can read must not show how SPLITBRIEF is built. This covers the shipped docs (the Markdown files in `package.json` `files`), `CHANGELOG.md` and the GitHub release notes, CLI and TUI strings, the website, and the skills a user installs (the skills in `.claude-plugin/marketplace.json` and every skill not marked `metadata.internal: true`).

Never write these there:

- **Admissions.** Do not say that something is untested, unverified, not verified live, not captured live or not checked on a platform, and do not list such tools or "known gaps". State what is supported. Say "not supported" only where the user needs it to act.
- **Internal process.** No notes about how the project is built: no review rounds, verdicts or handoffs, no agent or model names used to build it, no work lanes or internal decisions, and no dates of internal passes. No finding, task or issue ids (`N-7`, `DOC-2`, `REL-04`, `S11`, `T-080`, `#67`) and no private paths.
- **Implementation detail in the changelog.** No function names, file paths, gate numbers, internal types or state-machine events. Write what the user gets or what changed for the user, grouped as Added, Changed, Fixed and Removed.
- **Unfinished or apologetic words.** No "for now", "hack", "TODO", "temporary", "we hope" or "should work".

Contributor docs (`docs/RELEASING.md`, `TESTING.md`, `DOGFOODING.md`, `INVARIANTS.md`, `CODE-STANDARD.md` and the other docs outside `package.json` `files`) may use process language. A contributor skill carries `metadata.internal: true`, so skills.sh hides it, and the marketplace does not list it. The live-matrix manifest is a private release record: it never goes into the changelog or a GitHub release ([RELEASING.md](./docs/RELEASING.md#the-release-rule)). Invariant gate 59 (`scripts/user-facing-text.ts`) checks the clear markers.

## Look-and-logic verification (binding for every user-visible change)

A change to anything a user sees is done only when the agent has looked at the rendered result, critiqued it, fixed what it found, and can say "a paying user would call this finished". The session that owns the change runs this loop: a developer, a supervising session, a reviewer or a verifier; a hand-back that skips it is invalid. An implementer seat running under SPLITBRIEF does not render or run the project gates; SPLITBRIEF validates every brief in the run workspace and collects the renders through `validation.render`, and the reviewer and the supervising session critique them. The examples for each point are in [TESTING.md › Look-and-logic loop](./docs/TESTING.md#look-and-logic-loop).

1. **Render it, then look at it.** Run `npm run tui-shots -- --scenario <id>` for each scenario of the touched surface and open its PNG under `.test-artifacts/ui/`. No scenario → add one to `testing/visual/catalog.ts` first.
2. **Critique before fixing.** Write the defect list from the render before you touch code. "It renders" and "tests pass" are not verdicts.
3. **Iterate until it looks designed.** Fix, re-render and re-critique until zero items are open. Report the final render's critique.
4. **One concept, one home.** Each value (model, effort, speed, thinking, variant, tool) is selected in exactly one place, and every other surface shows it read-only. Two editable homes for one value is a defect.
5. **Data completeness is a visual check.** Compare the rendered rows against the source of truth. Name every missing, extra, duplicated or orphaned entry.
6. **Cross-surface consistency.** The same value reads identically on every surface that shows it. When a shared formatter or row model changes, render the neighbours too.

## Current TUI architecture

- Read [docs/STORES-AND-UI.md](./docs/STORES-AND-UI.md) before you change a screen, an overlay, the composer, a picker or the run screen.
- Zero `useMemo`: store selectors make memoization unnecessary.
- One value has one editable home: the seat picker chooses a seat's tool, model, effort, fast and thinking, and every other surface mirrors it read-only.

## Runner kinds

Planner, reviewer and implementer accept four runner kinds (`cli`, `api`, `shell`, `agent`); the `kind` field is always required, and configs declare `version: 3`. See [PLANNERS-AND-IMPLEMENTERS.md](./docs/PLANNERS-AND-IMPLEMENTERS.md#four-runner-kinds-in-practice).

## Planning session

Every run plans in one typed planning session: at most 2 rounds of questions, one typed plan that `checkPlan` checks, then the plan card. See [WORKFLOW.md](./docs/WORKFLOW.md#3-the-planning-session).

## Known limitations

- macOS and Linux only; Windows support is planned but not available yet. The check limits are in [CONFIGURATION.md](./docs/CONFIGURATION.md#what-a-check-can-reach) and the command policy in [CONFIGURATION.md](./docs/CONFIGURATION.md#reviewer-checks).

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
