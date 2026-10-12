# Testing

Testing in this repo means exercising observable behaviour — rendered output, returned values, files on disk, events emitted — never wiring. We follow Kent C. Dodds' Testing Trophy shape: a fat middle of colocated unit tests for pure logic, feature-level integration tests (`ink-testing-library`) for UI flows, and real boundary tests at the I/O seam (filesystem, subprocess, HTTP, git). Everything else is deleted. If a test would break when you refactor internals without changing behaviour, it is testing implementation — rewrite or remove it.

## Core rules

| Rule | Why | Example |
|---|---|---|
| Assert on observable state, not on calls | Calls are wiring; users never see them | `expect(store.get().active).toBe('x')` not `toHaveBeenCalledWith('x')` |
| Mock only at system boundaries | Internal mocks build a parallel reality; refactors break prod silently | Stub `fetch`, real `fs` via `tmpDir` |
| Never `vi.mock()` a sibling module (`./`, `../`) | Couples the test to the file layout, not the contract | Import the real module |
| No `vi.spyOn` on internal module functions | It re-asserts the call graph | Observe returned state / emitted event |
| Fewer, longer tests beat many micro-tests | One flow = one user-visible behaviour | Cache lifecycle in one `it`, not four `describe`s |
| Don't re-test the framework / type checker | `useState`, `assertNever`, Zod `.strict()`, V8's `Error.captureStackTrace` already have tests | Skip `toBeInstanceOf(Function)` on a typed interface; skip `expect(err.stack).toContain(file)` |
| Don't re-assert a literal you just set up | `tsc` already proves passthrough | Test the transformation, not the echo |
| Don't copy production helpers into test files | Production can drift from the copy; tests re-implement instead of observe | Export the helper from source and import it |
| Prefer observable-state assertions over DI call-count assertions | Call counts observe wiring; state observes behaviour | Assert on store contents / files on disk / emitted events, not `toHaveBeenCalledTimes` |
| Accessible queries first in UI tests | Matches what a real consumer sees | `getByRole` > `getByTestId` |
| Test the contract of a hook, not its wiring | A hook is its inputs → outputs/effects | Extract pure logic, test that; hook becomes a thin wrapper |
| Zero failing tests, always | Project policy — enforced on every PR | `npm run release-check` green before merge |
| Neutral test voice | Tests are observed behaviour, not narration | Zero `// Observable:` prefixes, zero AI-assistant names, no section-divider banners (`// ═══ X ═══`) inside test files — same rule as production (`STRUCTURE.md` §No decorative comments) |

## Hermetic test environment

Unit, integration, workflow-screen, replay e2e and website tests load `testing/helpers/scrub-credentials.ts` before test modules. It removes credential-shaped names, including `*_API_KEY`, `*_TOKEN` and `*_AUTH_TOKEN`, plus provider/tool and AWS prefixes. Tests must set explicit fake credentials and restore them afterward. `state-home.ts` keeps the temporary `XDG_STATE_HOME` isolation. PTY children put temporary shims first and block catalog CLI aliases before the Node directory, preserving Node's trusted executable path.

Only `SPLITBRIEF_REAL_CLI_E2E=1` or `SPLITBRIEF_E2E_RECORD=1` disables the scrub. Live, release and publish scripts use `testing/e2e/vitest.live.config.ts`; recording uses `testing/e2e/vitest.e2e.config.ts` and excludes the guard. `eval:record` runs directly through `evals/cli.ts`, outside Vitest.

Prove the scrub in each project with fake credentials in the parent environment:

```bash
OPENAI_API_KEY=sk-fake ANTHROPIC_API_KEY=sk-fake npx vitest run --project unit --project integration testing/helpers/hermetic-env
OPENAI_API_KEY=sk-fake ANTHROPIC_API_KEY=sk-fake npx vitest run --config testing/e2e/vitest.e2e.config.ts testing/helpers/hermetic-env.test.ts
```

## Where does this test go?

Placement is mechanical: **count the top-level folders a test imports from.**

```
How many top-level folders does the test import from?
(top-level = engine/ core/ stores/ cli/ features/<f>/ lib/ utils/ components/ hooks/)

├── 1 folder → colocate next to source
│             foo.test.ts beside foo.ts
│
└── ≥ 2 folders → testing/integration/<layer>/
      │
      ├── drives a commander subcommand?     → testing/integration/cli/
      ├── drives runWorkflow() end-to-end?   → testing/integration/orchestrator/
      └── renders an Ink feature with
          engine-written store updates?      → testing/integration/ui/
```

The flowchart covers `src/**` source. Three trees outside it also hold tests: `scripts/` for repo tooling, `testing/visual/` for the deterministic TUI gallery, and the eval harness suites `evals/*.test.ts`. `vitest.config.ts` collects these trees in the `unit`, `integration`, and `workflow-screen` projects. `npm test` and `npm run test:integration` together run all three projects. The eval harness CLI (`evals/cli.ts`) records scenario traffic into `evals/cassettes/`; under `--replay` it needs no credential and no base URL — the endpoint and a prefix-valid placeholder credential are resolved from the provider catalog (`evals/connection.ts`), so a run can start from a cassette alone. Pricing follows the CLI's own seeding: the harness reads the cached models.dev catalog snapshot once per suite and hydrates it into the model cache for every workflow run; when no snapshot is cached it prints one line saying pricing is unavailable and continues — it never fetches the catalog itself, so a replay run stays offline, and cost metrics report `pricingAvailable: false` so the report renders `n/a` rather than a fabricated `$0.0000`.

Every suite — `vitest.config.ts`'s three projects and the e2e config alike — loads `testing/helpers/state-home.ts` as a setup file. It points `XDG_STATE_HOME` at a throwaway directory before the test file's modules load, because run isolation resolves its worktrees under the user state directory (`$XDG_STATE_HOME`, else `~/.local/state`): without it, every test that reaches `runWorkflow()` writes into the operator's own state directory and leaves the fixture repository's directory behind there. A test file that needs its own state home still overrides the variable itself.

An eval run preserves each scenario's session directory — `review.md`, `review-packet.json`, `evidence.json`, `drift-report.json`, `session.jsonl` — under `evals/results/sessions/<scenario>/<mode>/` before the temporary project copy is deleted; the path is recorded on the run's metrics and appears in the generated report JSON. That directory is gitignored, so recorded transcripts never reach a commit.

| Kind | Location | Suffix |
|---|---|---|
| Unit test | next to source (`foo.test.ts` by `foo.ts`) | `.test.ts` / `.test.tsx` |
| Integration test touching one folder (real git repository or worktree, run loop, Apply, git launch, fake CLI or node shim) | next to source | `.integration.test.ts` / `.integration.test.tsx` |
| Boundary test (fs, http, short system tools) with no integration operation | next to source | `.test.ts` / `.test.tsx` |
| Repo tooling unit (gate runner, import-boundary checker) | next to source in `scripts/` (`check-invariants.test.ts` by `check-invariants.ts`) | `.test.ts` |
| Feature-seam Ink test (one feature's screen, no engine) | next to feature entry | `.test.tsx` |
| Multi-folder CLI flow (commander → engine → stores) | `testing/integration/cli/` | `.test.ts` |
| Multi-phase orchestrator flow (`runWorkflow()` + fakes) | `testing/integration/orchestrator/` | `.test.ts` |
| Multi-store UI flow (Ink screen + engine events via stores) | `testing/integration/ui/` | `.test.tsx` |
| End-to-end scenario (real planner/implementer or recorded cassette) | `testing/e2e/scenarios/` (cassettes in `testing/e2e/cassettes/`) | `.test.ts` — isolated by `testing/e2e/vitest.e2e.config.ts`, not by suffix |
| Deterministic TUI visual gallery | `testing/visual/` | `.test.ts` / `.test.tsx` |
| PTY terminal-boundary behavior | `testing/integration/cli/` | `.test.ts` |
| Shared factories (pure TS constructors) | `testing/helpers/factories/<domain>.ts` — ≥ 2 consumers | n/a |
| Shared test helpers (fakes, renderers, resetters) | `testing/helpers/*.ts` — ≥ 2 consumers, no `expect()` | n/a |
| Static fixtures (YAML, JSON, recorded HTTP bodies) | `testing/fixtures/<domain>/` | n/a |

## Unit and integration tests

An integration test builds a real git repository or worktree, drives the run loop or Apply, or launches git. A test that launches a fake CLI or node shim is also an integration test. Unit tests can launch short system tools: `ps`, `diff`, `sleep`, `node -e`, `mkfifo`, or a shell hook. An integration test that spans folders lives in `testing/integration/<layer>/`. A colocated integration test uses the name `<name>.integration.test.ts` or `<name>.integration.test.tsx`. Every other test is a unit test and keeps the plain `.test.ts` or `.test.tsx` name.

`npm test` runs the `unit` project. `npm run test:integration` runs the `integration` and `workflow-screen` projects. `release-check` and CI run both commands. `test:coverage` (and so `test-ci`) runs every project, so the coverage thresholds cover all tests. `test:watch` watches every project.

To run one unit file, use `npm test -- <path>`. To run one integration file, use `npm run test:integration -- <path>`. A command does not find a file of the other project.

A SPLITBRIEF run on this repository follows the same split. A brief's `test` check runs `npm test -- <file>`, so it finds only unit files. Name an integration test as a `cmd` check: `npm run test:integration -- <file>`. Before each review the reviewer chooses the commands that verify the change, for example `npm test`, `npm run test:integration` or `npm run test:e2e`, and SPLITBRIEF runs them.

Invariant gate 58 (`scripts/unit-test-launches.ts`) rejects unit files with integration helpers, direct `git` launches, the simple-git client, or node shim markers. The gate's marker also matches the same text in comments and strings. The gate does not detect every integration operation, so use the rule above to name each test.

## Performance harnesses

Performance tests live under `testing/integration/performance/` and are skipped unless `SPLITBRIEF_PERF=1` is set. Use `node --expose-gc` for these harnesses so tests can force collection around memory-sensitive measurements when they need it.

Current harnesses:

```bash
SPLITBRIEF_PERF=1 node --expose-gc ./node_modules/vitest/vitest.mjs run testing/integration/performance/conversation-flow-large-log.perf.test.ts
SPLITBRIEF_PERF=1 node --expose-gc ./node_modules/vitest/vitest.mjs run testing/integration/performance/runner-large-output.perf.test.ts
SPLITBRIEF_PERF=1 node --expose-gc ./node_modules/vitest/vitest.mjs run testing/integration/performance/events-store-cap.perf.test.ts
SPLITBRIEF_PERF=1 node --expose-gc ./node_modules/vitest/vitest.mjs run testing/integration/performance/conversation-flow-hover.perf.test.tsx
SPLITBRIEF_PERF=1 node --expose-gc ./node_modules/vitest/vitest.mjs run testing/integration/performance/event-sinks-throughput.perf.test.ts
```

`conversation-flow-large-log.perf.test.ts` covers the Phase 5 row projection path: 10k event projection reuse, visible-window materialization, markdown suffix append reuse, and cache-cap behavior. Keep thresholds as regression guards for the reference machine; do not treat them as portable benchmarks.

`conversation-flow-hover.perf.test.tsx` covers hover-only re-renders on a large real-store transcript: repeated `hoverStore` updates must stay bounded and must not change transcript text apart from the focus glyph. Run it only with `SPLITBRIEF_PERF=1` as above.

`runner-large-output.perf.test.ts` covers large runner stdout without a trailing newline and multi-megabyte stderr flood behavior through the real subprocess collector. `events-store-cap.perf.test.ts` covers capped workflow event ingestion and retained merged-text size after multi-megabyte planner text input. `event-sinks-throughput.perf.test.ts` covers JSONL and stdout-JSON sink throughput. There is no automated fullscreen-vs-inline replay perf harness yet; use the manual TUI smoke checklist below for fullscreen replay behavior until a stable local harness exists.

**Fixtures vs factories.** Split by kind:
- `testing/fixtures/<domain>/` = read-only **bytes on disk**. Consumers read via `fs.readFile`.
- `testing/helpers/factories/<domain>.ts` = pure **TypeScript constructors** returning typed objects with overrides. No I/O.
- **Rule of two:** data stays inline inside one test file until a second test needs it. Promotion happens on the second consumer, not the first.

**Feature sub-components get a colocated test when they carry behaviour.** A sub-component that renders a visible affordance off branching state — an approval prompt, the plan card, a pipeline bar — is tested next to its `*.tsx` against `lastFrame()` and observable store state, the same way `src/features/workflow/components/` already is. Styling-only or pure-passthrough sub-components stay covered transitively through the page seam (`app/screens/<x>.tsx` / `app/overlays/<x>.tsx`); do not add a "does not crash" test for them. Shared primitives in `src/components/` (`MultilineInput` → `input/multiline-input.test.tsx`, `ScrollWindow` → `pickers/scroll-window.test.ts`, `SessionRow` → `session-row.test.tsx`) carry their own colocated tests — their cost amortises across consumers. A primitive whose behaviour lives in a backing hook is covered through that hook's test instead (`FilterableList` via `src/hooks/use-filterable-list.test.tsx`).

**Decision-bearing orchestrator modules get a colocated test.** A module in `src/engine/orchestrator/` that makes a decision or owns observable control-flow behaviour — escalation tiers, queue drain order, signal-handler cleanup, planning-phase routing, recovery actions, the task loop and step — has a colocated test against its returned decision and the events it emits. Tests that use integration helpers have the `.integration.test.ts` suffix. This is why `escalation/step.integration.test.ts`, `queue/submit.test.ts`, `signals.test.ts`, `planning/*.test.ts`, `recovery/*.test.ts`, `task/loop-*.integration.test.ts`, `task/step.integration.test.ts`, and `run/workflow.integration.test.ts` (the same files the Recovery flow section below tells you to run) all exist. The `runWorkflow()` integration seam under `testing/integration/orchestrator/` covers the composition of these modules across a full multi-phase run, not the per-module decision. Reserve it for behaviour that only emerges from wiring several modules together (a phase progressing, a run reaching ready to apply, a workflow completing). Trivial glue with no branch of its own — a function that only forwards to an already-tested helper — stays covered transitively at that seam.

**CLI-protocol full-loop tests.** `testing/integration/orchestrator/full-loop-opencode-cli.test.ts`, `full-loop-codex-cli.test.ts`, and `full-loop-claude-code-cli.test.ts` drive `runWorkflow()` end to end against fake binaries that speak each tool's real protocol terminal (opencode `step_finish`, codex `turn.completed`, claude-code stream-json `result`). They pin that turn/result usage reaches the run summary's `tokenUsage` buckets — cache-adjusted for codex — and the first `taskBreakdown` entry, with the prompt transport (argv positional for opencode, stdin for codex and claude-code) exercised against the real arg vector. They cannot detect adapter/binary version drift by construction; that gap is covered by the gated real-binary smoke in `testing/e2e/scenarios/real-cli-planner-implementer-smoke.test.ts` (run with `npm run test:e2e:live:smoke`; the replay e2e config never collects it), which also asserts the real run records non-zero implementer input tokens.

**Default-strategy worktree coverage.** The two isolation strategies are not substitutable — a staged copy is one copy per run with no git metadata, restored per attempt by hash; a worktree is a linked checkout with its own branch, index and `.git` file — so the default strategy needs its own orchestrator-level coverage rather than the `makeCopyingIsolation` context every other test installs. `makeWorktreeIsolation` (`testing/helpers/orchestrator-factories.ts`) builds a real `createRunIsolation` handle over a real git fixture. `testing/integration/orchestrator/direct-writer-change-proof.test.ts` uses it to pin that a direct write in the run worktree stays in the run worktree and leaves the checkout alone, and that a rewrite of a file the worktree was *already* dirty in counts as a change; `src/engine/orchestrator/escalation/step.integration.test.ts` pins that a retry runs in the same worktree as the task it is retrying and that the shared worktree survives that task's `cleanup()`.

**Zod schemas do not get shape tests.** TS strict + Zod `.parse()` is first-class correctness — no runtime tests for schema shape. One repo-wide `.strict()` rejection test lives in `src/core/schemas/runner-fields.test.ts`; do not duplicate per schema.

Colocated support files under `src/**` that import `vitest` or another dev-only dependency must use the `*.test.ts` / `*.test.tsx` pattern so production builds exclude them. Shared support belongs under `testing/helpers/**`, which is already outside the production type-check graph.

**Coverage thresholds** (`vitest.config.ts`): `statements: 50, branches: 40, functions: 50, lines: 55`. These are **non-regression gates, not aspirational targets** — do not add dead tests to lift coverage. Static (TS strict + Zod) is a first-class tier and carries real safety even when it does not increment coverage numbers.

**Zero barrels anywhere in `testing/`**, not just `src/`. No `index.ts` inside `testing/helpers/`, `testing/helpers/factories/`, `testing/fixtures/`, or `testing/integration/*`. Consumers import directly from the file they need. Same rule and rationale as [`NO-BARRELS.md`](./NO-BARRELS.md).

**Hook tests follow behavior, not wiring.** Trivial hooks (≤30 LOC, no branching, thin selector wrappers) are covered transitively through their consumer's integration test — see [`HOOKS.md`](./HOOKS.md). Only behavior-bearing hooks (state machines, async race / cancellation, promise-based resolvers like `useInputMode`) get a dedicated colocated test, and that test asserts the observable contract: inputs, effects, and returned state. Do not test internal `useState` / `useEffect` calls.

## Current workflow policy

Cost-aware implementer routing, Apply, and the plan card follow the same rule: test the decision contract, not the private call graph.

**Routing and context fit.** Public pure helpers are valid unit-test targets when they encode product policy. Examples: context-window classification, prompt-size estimation, profile ordering, capable-profile selection, and no-capable-profile failure. These tests should assert the returned decision object, selected profile, rejection reasons, and fit status. Do not spy on internal sort helpers or duplicate the full prompt formatter in the test.

**Apply and the run lifecycle.** Apply tests build a real git checkout and run workspace (`startApplyRun`, `testing/helpers/apply-run.ts`) and assert the public result: the merged bytes in the checkout, the `apply-conflict` or `apply-partial` halt, the backup restore. A checkout edit during a run is not a halt, so there is no user-edit classification to test. The lifecycle matrix (`testing/integration/orchestrator/run-lifecycle-matrix.test.ts`) drives a run through `runWorkflow()`, `runApply()` and `closeRunIfOpen()` with a restart between steps, and checks that `deriveRunStatus`, the CLI resolve guard and the home session rows report the same status.

**Validation schedule.** The run owns verification, and `workflow.review` sets when it runs. With `end` (the default) an ordinary brief runs no check. With `task` each task runs its own checks and its due checks, then its scheduled review, whose reviewer checks run the tests related to the task's changed files. Before the final review, and again after each fix cycle, the run executes every check of the combined task and run registry on the current candidate, with a `render` check run through `validation.render`. Then the reviewer chooses the reviewer checks that verify the change (`validation.end_checks`, on by default), and SPLITBRIEF runs them in order under the reviewer command policy. The first reviewer check with new failures stops the list. Every new red reaches the reviewer, whose answer also supplies the fix work. A red reviewer check is first re-run at the run base with the same command text; plan and task checks do not re-run there. A matching failure is pre-existing and goes to no brief. Every run is recorded as one checks-log entry — id, command, exit code, a bounded output tail, artifact paths and their sha256, the workspace snapshot, and the time — and the review packet carries the log under `## Checks Log`. A required check that cannot run (`not-runnable`, `refused` or `unknown`) halts with `required-checks-unrunnable` instead of reaching the review.

**Plan card.** Pure `parseReviewCommand` cases live in `src/features/workflow/review-commands.test.ts`. Handler routing, external-editor spawn, and terminal handover during review input belong in `testing/integration/ui/review-input.test.ts`. The card's engine contract (approve, a typed correction, a re-validated `plan.json` edit, `approve: none`) lives in the `the plan card` block of `src/engine/orchestrator/planning/session.test.ts`. Avoid micro-tests for keybinding passthrough unless the helper is exported as a pure public parser; prefer grouping key maps with `it.each` when adding more cases.

**Input history persistence.** Debounced `~/.splitbrief/history` writes and teardown at the composer persistence boundary stay in `src/stores/ui/persistence.test.ts`.

**Hooks and wrappers.** No new `renderHook` tests for trivial wrappers, selector hooks, or `useState` / `useEffect` plumbing. Extract behavior-bearing logic into a public pure helper and test that helper, or cover the hook through the feature/component that uses it. Thin wrappers that only call an already-tested helper should not receive dedicated tests.

**Recovery flow.** Recovery tests should assert persisted `pendingRecovery`, emitted recovery events, headless JSON, prompt text/parser behavior, and file/evidence effects. In a dirty or shared checkout, do not run broad orchestration suites that exercise legacy Git-writing test fixtures. Prefer the focused recovery files:

```bash
npm test -- src/core/schemas/recovery.test.ts
npm test -- src/core/schemas/workflow.test.ts
npm test -- src/core/schemas/enums.test.ts
npm test -- src/core/state/machine.test.ts
npm test -- src/core/state/persistence.test.ts src/core/sessions/log-writer.test.ts src/core/payload-bounds.test.ts
npm test -- src/engine/orchestrator/recovery/actions.test.ts src/engine/orchestrator/recovery/actions-persistence.test.ts src/engine/orchestrator/recovery/builders/task.test.ts src/engine/orchestrator/recovery/builders/workflow.test.ts
npm run test:integration -- src/engine/orchestrator/task/loop-happy-path.integration.test.ts
npm run test:integration -- src/engine/orchestrator/task/step.integration.test.ts
npm run test:integration -- src/engine/orchestrator/run/workflow.integration.test.ts
npm test -- src/engine/orchestrator/session-lifecycle/finalize.test.ts
npm run test:integration -- src/engine/orchestrator/session-lifecycle/shutdown.integration.test.ts
npm run test:integration -- testing/integration/cli/headless-outcomes.test.ts
npm test -- src/features/workflow/recovery-prompt.test.ts
npm run test:integration -- testing/integration/orchestrator/run-lifecycle-matrix.test.ts
```

Run `npm run test:integration` only when the validation owner accepts tests that create git history in temporary repositories.

## Planner conformance testing

Planner conformance is deterministic CI, not a live smoke. "Planner mode does not grant artifact authority." A mode flag (`--agent plan`, `--permission-mode plan`, `--sandbox read-only`) is what the tool is told; the conformance harness proves what the tool did. Tests may not treat a flag or an argv snapshot as effect proof.

The black-box rows live in `testing/integration/orchestrator/runner-capability-matrix.test.ts` and `testing/integration/orchestrator/planner-effect-matrix.test.ts`, with the effect fixtures in `src/engine/runners/cli-tools/contract-harness-effects.integration.test.ts`. They drive the production factory against subprocess shims that speak each tool's real protocol terminal, with sentinel files and nonce edits as the observable effects. The doc-parity gate in `testing/docs/planners-and-implementers.test.ts` pins the admitted matrix to the runtime catalog.

Live authenticated checks (`npm run test:e2e:live:smoke`, `testing/e2e/scenarios/real-cli-planner-implementer-smoke.test.ts`) are opt-in drift evidence: they verify reality on a real machine with real credentials and never replace the deterministic matrix as the admission proof. See [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#planner-artifact-ownership) for the transport and role contract.

The stop/continue smoke lives in the e2e project too: `testing/e2e/scenarios/stop-continue.test.ts` spawns the CLI from source against a fixture repo whose planner and implementer are local scripts, so it proves stop → continue → finish at zero tokens and runs inside `npm run test:e2e` like any other replay scenario.

## Live CLI e2e tier

Above that single smoke sits a paid tier that drives whole workflows through real installed CLIs. It lives in `testing/e2e/scenarios/live/easy-<tool>.test.ts` and `heavy-<tool>.test.ts` — one file per tool pair — sharing `testing/e2e/helpers/live-harness.ts`. A pair is the same tool in both the planner and the implementer seat, so a red test names exactly one tool.

Two switches gate it. `SPLITBRIEF_REAL_CLI_E2E=1` is the master switch; nothing live runs without it. `SPLITBRIEF_REAL_CLI_TIER` selects `easy` (the default when unset), `heavy`, or `all`.

The separation from replay e2e is physical, not conventional: the live scenarios and the real-CLI smoke are excluded from `testing/e2e/vitest.e2e.config.ts` and collected only by `testing/e2e/vitest.live.config.ts`. `npm run test:e2e` — the step `test-ci`, `release-check`, and the ci.yml `e2e-replay` job run — cannot collect a billable case even with `SPLITBRIEF_REAL_CLI_E2E=1` ambient in the environment. Reaching the tier takes the live config, which only `npm run test:e2e:live`, `npm run test:e2e:live:heavy`, `npm run test:e2e:live:smoke`, `npm run test:e2e:release`, and `npm run test:e2e:publish` pass.

Skipping is two-layered. With the env unset every case reports skipped and the run exits `0`. With it set, a tool whose readiness detection is not `ready` — binary missing from `PATH`, not logged in — skips with a reason instead of failing, so a partial toolbox still runs what it can.

A per-tool skip prints the readiness reason from `liveToolBlocker`, the tool's own detection state; `ready` requires trusted + compatible + authenticated, so `not ready (…)` almost always means the binary is missing from `PATH` or the login expired. Fix it with the tool's own install or login command, not with SPLITBRIEF. A refused model pin throws instead of skipping. That is intentional: the ceiling exists to stop a mistyped `SPLITBRIEF_REAL_CLI_<TOOL>_MODEL` from billing a frontier model, and a silent skip would hide the typo.

Model pins are cheap by default: `claude-code` → `haiku`, `codex` → `gpt-5.6-luna`, `opencode` → `opencode-go/deepseek-v4.1-flash`, `antigravity` → `gemini-3.8-flash-low`, `command-code` → `deepseek/deepseek-v4-flash`. Each is overridable via `SPLITBRIEF_REAL_CLI_<TOOL>_MODEL`. Pins require no runtime discovery. A ceiling refuses any pin whose tokens include `opus`, `fable`, or `sol` outright, so a mistyped env var cannot burn credits on a frontier model.

Both tiers run the one planning session with `approve: none`; they differ in task and assertions. Easy asks for one file (`EASY_TIER`, a 4096-token implementer context) and has a 300 s per-case timeout. Heavy asks for two files (`HEAVY_TIER`, a 128k implementer context), also asserts planner tokens, a review packet from the final review the planner holds, and the evidence summary, and has a 900 s per-case timeout. The harness aborts preparation and the workflow 10 s before Vitest's timeout, awaits settlement, then applies a ready run before checking the checkout artifact. Rows never overlap.

Like `real-cli-planner-implementer-smoke.test.ts`, the live tier is opt-in drift evidence, never the admission proof.

### Fixture loop row

`testing/e2e/scenarios/live/fixture-loop.test.ts` runs the whole loop over the rows of `testing/e2e/live/fixture-rows.ts` — `fixture-claude-cmd-codex` (900 s), planning with `claude-code`, building with `command-code` and reviewing with `codex` — against a copy of the `add-endpoint` eval fixture, through the real binary in `--plain` mode. The row runs one planning session with `approve: none`; it has no mode field. It needs two switches: `SPLITBRIEF_REAL_CLI_E2E=1` and `SPLITBRIEF_LIVE_FIXTURE=1`, both set by `npm run test:e2e:live:fixture`. With either unset every row is `it.skip`, the reason is printed, and the file exits `0`. Readiness gating goes through the same `gateLiveMatrixRow` as the release matrix, so `SPLITBRIEF_LIVE_SKIP` skips a row whose tool is missing instead of failing it. Every outcome — pass, fail, or skip — appends a row to the same manifest; a passing row also copies `tasks.md`, `evidence.json`, `drift-report.json` and `review.md` beside `summary.json` and `session.jsonl`.

What a row proves lives in `testing/e2e/helpers/run-dir-assertions.ts`, four assertions over the finished run: `assertPlainStdout` (every stdout line matches the `--plain` grammar and none parses as JSON; `phase: implementing`, `review: passed` and a positive `done:` line are all present; it returns that count), `assertSessionDir` (brief count inside the row's range with at least one `modify`, non-empty `plan.md`, evidence ledger and drift report parse with drift `passed`, a `pass`/`pass_with_notes` verdict, `summary.json` complete with its `totalTasks` equal to the parsed briefs and to the stdout `done:` count, every task done locally on non-zero implementer tokens, and the `runner_call_started` counts per role with no `implementer_wrote_nothing` and no `runner_call_error`), `assertFixtureQuality` (the scenario's own quality checks against the built project) and `assertWorkingTree` (nothing outside the declared `files` and `.splitbrief/` changed). The module carries a colocated test against a synthetic session dir (`run-dir-assertions.integration.test.ts`). `npm run test:integration` covers these assertions and their git fixtures. The row itself is drift evidence like the tiers above — [RELEASING.md](./RELEASING.md) says when it may become a gate.

The skills' shell scripts are proven the same deterministic way, not by the live tier: `testing/integration/skills/wait-attempt.test.ts` and `testing/integration/skills/splitbrief-gate.test.ts` drive `skills/splitbrief-run/scripts/*.sh` under `sh` in a temp run dir with real child processes — exit 0, exit 1, a `--deadline 2` timeout that kills the group, a pre-existing `.done`, a missing pid file, a halt phrase in the log tail, `--reconcile`, and one stop-gate case per host. They run under `npm run test:integration`.

### Release matrix

Above the easy/heavy pairs sits the release matrix: `testing/e2e/scenarios/live/release-matrix.test.ts` runs one row per entry of `testing/e2e/live/matrix.ts` — `{ id, tier, plan, build, review?, task }` — covering the three task tiers of `MATRIX_TIERS` (`testing/e2e/helpers/live-harness.ts`; keyed `one-file`, `two-files` and `question-round` by what each tier tests; `question-round` answers the planner's question), a same-tool canary for every CLI tool in the catalog, and cross-vendor pairs where the plan and build tools differ. Seats resolve their pin through the same `liveModelPin` table as the tiers below.

Its switch is `SPLITBRIEF_RELEASE_LIVE=1` (the npm script `test:e2e:release` sets `SPLITBRIEF_REAL_CLI_E2E=1` itself); unset, the file prints `skipped: SPLITBRIEF_RELEASE_LIVE not set` and every row exits skipped. A tool listed in `SPLITBRIEF_LIVE_SKIP` skips its rows, ready or not, with reason `listed in SPLITBRIEF_LIVE_SKIP`. An unlisted tool that is missing or not `ready` fails its row.

The release live gate is the publish smoke plus the matrix rows for `claude-code`, `codex`, `opencode` and `antigravity`, with `SPLITBRIEF_LIVE_SKIP=cursor,copilot,kilo-code,command-code`. The manifest is the private release record: it names each skipped tool with its reason and is kept in `.release-records/<x>/manifest.json`, never in the changelog or the GitHub release. See [RELEASING.md](./RELEASING.md).

Every row — pass, fail, or skip — is appended to `.test-artifacts/live/manifest.json` with its resolved seats, outcome, reason, totals, and duration. After a run settles, the harness copies its available artifacts, including `summary.json` and `session.jsonl`, to `.test-artifacts/live/<row-id>/` before cleanup, even on failure. Failure reasons retain the halt or last error. Passing rows prove `ready-to-apply` → Apply → `applied` before evaluating the checkout artifact.

### Publish smoke

`testing/e2e/scenarios/live/publish-smoke.test.ts` is the one-row pre-publish check: the shipped crew pinned in code — `claude-code` · `opus` plans and reviews, `claude-code` · `sonnet` builds — through `runReleaseMatrixRow` on the `one-file` tier task, so the row is gated, configured, asserted and recorded exactly like a release-matrix row, plus two assertions read back from the copied artifacts: `summary.json` status `complete` and a `pass` / `pass_with_notes` verdict in `review.md`. Its switch is `SPLITBRIEF_PUBLISH_LIVE=1`, set by `npm run test:e2e:publish` together with `SPLITBRIEF_REAL_CLI_E2E=1`; unset, the file prints `skipped: SPLITBRIEF_PUBLISH_LIVE not set` and exits `0`. The pins sit above the live cost ceiling on purpose, which is why the row bypasses `liveModelPin` and never runs under the easy, heavy or release switches. One `one-file` tier run under the 300 s ceiling.

## Tests pass locally but fail in CI (or vice versa)

Diagnostic checklist:
- Node version: engines field requires `>=22`. Check `node --version` matches CI.
- `CI`: GitHub sets `CI=true`, and Ink paints no frames when `CI` is on. The `unit` and `integration` test steps set `CI=false`. A shell that exports `CI=1` makes Ink tests fail locally; run them with `CI=false npm test`.
- Temp dir state: some tests write under `os.tmpdir()`. Flake when runs don't clean up; rerun after `rm -rf $TMPDIR/splitbrief-*`.
- Credentials: `testing/helpers/scrub-credentials.ts` removes API-key and token env vars from every test process, so no test reads the keys in your shell. A test that needs a key sets a fake one.
- Workers: vitest runs at most 4 workers, and fewer on a host with fewer cores (`vitest.config.ts`). `--maxWorkers=<n>` overrides it.
- Reproduce CI's split gate with `npm run release-check` (the same steps minus coverage). CI runs `static`, `unit` (two vitest shards), `integration` (four shards), `e2e-replay` and `smoke` as parallel jobs. The `Website` workflow runs only when `website/`, `docs/`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` or a file that the website tests load (`testing/helpers/scrub-credentials.ts`, `testing/helpers/hermetic-env.ts`, `src/utils/redact.ts`) changes. The coverage workflow (`nightly-coverage.yml`) runs only when you start it by hand.
- Add the coverage run on top with `npm run test-ci` (format:check → typecheck → lint → test:coverage → e2e → invariants → skills:check) — the superset of the CI and coverage workflows.

## How to add an integration test

Integration tests live under `testing/integration/<layer>/`. One file per user-observable flow. Longer files with more assertions beat many short files (TkDodo: fewer, longer tests).

**Pick the layer.**
- Commander flow (`start`, `resume`, `init`, `status`) → `testing/integration/cli/`
- `runWorkflow()` state-machine flow → `testing/integration/orchestrator/`
- Feature screen that depends on engine-written store state → `testing/integration/ui/`

**Wire the setup.** In `beforeEach`, reset all stores and create a tmp dir when the test touches the filesystem:

```ts
import { beforeEach, describe, it, expect } from 'vitest';
import { resetAllStores } from '#testing/helpers/stores.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

beforeEach(() => resetAllStores());
```

**CLI flow — drive commander in-process** (`testing/helpers/commander.ts`):

```ts
import { runCommand } from '#testing/helpers/commander.js';

it('start writes state.json and exits 0', async () => {
  await withTempDir(async (dir) => {
    // seed config
    const { stdout, exitCode } = await runCommand([
      'start',
      '--project',
      dir,
      'add endpoint',
    ]);
    expect(exitCode).toBe(0);
    // assert on files in dir, not on stdout wording
  });
});
```

**Orchestrator flow — drive `runWorkflow()` with fakes** (`testing/helpers/faux/`):

```ts
import { fauxPlanner } from '#testing/helpers/faux/planner.js';
import { fauxImplementer } from '#testing/helpers/faux/implementer.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

afterEach(async () => {
  await settleTrackedWorkflows();
  cleanupTempDir(projectDir);
});

it('completes one task via local implementer', async () => {
  const task = makeTask();
  const { planner } = fauxPlanner({ plans: [{ tasks: [task] }] });
  const { implementer } = fauxImplementer({ steps: [{ success: true, output: 'done' }] });
  const events: EngineEvent[] = [];
  await runTrackedWorkflow({
    feature: 'add hello module',
    projectDir,
    config: makeConfig(),
    callbacks: { /* gating stubs: onApprovalNeeded, onPlannerReply, ... */ },
    sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    // The fakes MUST go through `_planner` / `_implementer` (RunWorkflowOptions).
    // Passing bare `planner` / `implementer` keys is silently ignored and spawns real subprocesses.
    _planner: planner,
    _implementer: implementer,
    _eventSink: (e) => events.push(e),   // subscribed to the internal EventBus
  });
  expect(events.at(-1)).toMatchObject({ type: 'workflow_complete' });
});
```

Teardown aborts and awaits runs left in flight by timed-out tests so their git calls cannot use deleted directories or reach the next test.

**Headless `--json` CLI flow** (`testing/integration/cli/`):

```ts
it('start --json emits NDJSON and exits 0', async () => {
  await withTempDir(async (dir) => {
    // seed config + fakes
    const { stdout, exitCode } = await runCommand([
      'start',
      '--project',
      dir,
      '--json',
      'add endpoint',
    ]);
    expect(exitCode).toBe(0);
    const events = stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: 'readiness_report' });
    expect(events.find((e) => e.type === 'workflow_started')).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: 'workflow_complete' });
  });
});
```
The headless driver (`src/cli/headless.ts`) wires `stdoutJsonSink` to the bus and stubs workflow host callbacks so integration tests can drive `splitbrief start --json` end-to-end and assert on the event sequence plus exit code. The plan card is approved unattended; a write to a protected path has no one to confirm it headlessly, so it fails closed. No Ink mount, no TTY detection.

**UI flow — render a feature + drive engine events through stores** (`testing/helpers/ink.ts`):

```ts
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';

it('workflow screen shows an escalation card when escalate event arrives', async () => {
  const { lastFrame } = renderFeature(<WorkflowScreen />);
  addEvent({ type: 'escalate', attempt: 2 /* ... */ });
  await tick();
  expect(lastFrame()).toContain('Escalation');
});
```

**Rules:**
- Use `testing/helpers/stores.ts:resetAllStores()` in `beforeEach`. Stores are module-scoped singletons.
- A test asserting width-dependent output must pass the viewport to `renderFeature` (`renderFeature(<WorkflowScreen />, { cols: 120, rows: 40 })`); without one it renders at the 100-column default.
- Use `testing/helpers/temp-dir.ts:withTempDir()` for filesystem work. Never mock `node:fs`.
- Use real `git` via `testing/helpers/git.ts:createTestGitRepo()`. Never stub `simple-git`.
- **Zero new fakes.** Use `fauxPlanner` / `fauxImplementer` from `testing/helpers/faux/`. Extend them via `phases`, `steps`, `escalations`, or `retries`, not by copying their shape into a new file.
- **No `vi.mock()` on internal modules** (`./`, `../`). The sanctioned repo-wide targets are `node:fs/promises` (write-failure / `mkdtemp` interception), `node:fs` (`statSync` ENOENT simulation), and `ink` + `fullscreen-ink` (CLI integration tests only).
- **Import `testing/helpers/**` from any test — under `src/**`, `testing/**`, or `evals/**` — via the `#testing/*` subpath import** (`import { makeConfig } from '#testing/helpers/factories/config.js'`), never a relative `../../helpers/...` or `../../../testing/helpers/...` path. The alias is defined once in `package.json` `imports` (`"#testing/*": "./testing/*"`), and gate 20 (`scripts/testing-helper-imports.ts`) fails any test in those three roots whose relative import resolves into `testing/helpers/**`.
- Exit codes via `isCliError`. `commander.exitOverride()` throws; `runCommand()` catches and returns the exit code.

## How to extend the fakes

`fauxPlanner` and `fauxImplementer` take declarative arrays that cycle on repeated calls. Read `testing/helpers/faux/planner.ts` and `testing/helpers/faux/implementer.ts` for the full option types.

**Planner (`fauxPlanner`):**

- `plans` — each typed planning call consumes the next entry (`tasks`, optional `usage`, or `throws`).
- `escalations` — entries for the legacy `escalateFull()` (`success`, `output`, `code`, `usage`, or `throws`).

**Implementer (`fauxImplementer`):**

- `steps` — each `implement()` call consumes the next entry (`success`, `output`, `error`, `usage`, `delayMs`, or `throws`).
- `retries` — same shape for `retry()`.

To cover a new scenario, add a test under `testing/integration/orchestrator/<scenario>.test.ts` and build the arrays for that path (success, fail-then-succeed, fail-3x-then-escalate, approval-pending, abort-midstream). Assert on returned `state` (`planCallCount`, `implementCallCount`, `receivedFeatures`, …), not `vi.fn` call counts.

**Do not** add a new fake class or copy the faux shape into a local helper. If the existing option types cannot express your scenario, extend the faux grammar in `testing/helpers/faux/` in one PR rather than forking a parallel fake.

**Legacy:** `makePlanner` and `makeImplementer` in `testing/helpers/orchestrator-factories.ts` are `vi.fn`-backed stubs for older tests and for `makeWctx` defaults. Prefer faux objects for new orchestrator coverage; use the legacy makers only when you need partial `vi.fn` overrides on the interface.

Real adapter boundaries (`Planner`, `Implementer`, `ProviderClient`) are the only sanctioned injection points. Everything else is a real import.

## CLI command DI pattern

CLI command handlers accept an optional `deps` parameter for dependency injection. This is the standard pattern for testing commands without `vi.mock`:

```ts
// src/cli/commands/start/types.ts
export interface StartDeps {
  runHeadless: typeof runHeadless;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  prepareExecution?: typeof prepareExecution | undefined;
}

// src/cli/commands/start/register.ts
export const defaultStartDeps: StartDeps = { runHeadless, initStores, renderApp, prepareExecution };

export function registerStartCommand(program: Command, deps: StartDeps = defaultStartDeps): void { ... }
```

In tests, inject fakes directly:

```ts
const program = new Command();
program.exitOverride();
registerStartCommand(program, fakeDeps); // fakeDeps: StartDeps with stubbed renderApp/runHeadless/…
```

**Commands using this pattern:** `start/register.ts` (`StartDeps` in `start/types.ts`) exposes `deps` on the `registerStartCommand(program, deps = default)` signature itself. `continue/register.ts` takes the same shape — `registerContinueCommand(program, deps = defaultContinueDeps)` — and threads `ContinueDeps` down to the internal helper (`continueCommand(…, deps = defaultContinueDeps)`).

**Rule:** `vi.mock` is now reserved for TRUE system boundaries only — `process.kill`, `execSync`, `node:net` sockets, and the sanctioned targets listed in [Test I/O and fixtures](#test-io-and-fixtures). All other test isolation uses the `Deps` interface pattern.

## Faux provider architecture

Orchestrator tests use **typed faux objects** that implement the real `Planner` / `Implementer` interfaces and track state declaratively. Legacy `makePlanner` / `makeImplementer` in `orchestrator-factories.ts` remain `vi.fn` stubs for older suites.

### Two levels

| Level | Seam | When to use |
|---|---|---|
| **L1: Faux objects** | `Planner` / `Implementer` interface | 90% of orchestrator tests. Declarative `phases` / `steps` arrays, no network, <50ms. |
| **L2: Faux HTTP server** | Localhost SSE (OpenAI / Anthropic protocol) | Testing `api.ts` runner: rate limits, malformed SSE, token accounting, effort parameters. Real fetch hits localhost. |

### L1 design

```
testing/helpers/faux/
  planner.ts         fauxPlanner(opts) → { planner: Planner, state: FauxPlannerState }
  implementer.ts     fauxImplementer(opts) → { implementer: Implementer, state: FauxImplementerState }
```

- Scripts are cycled: `steps: [{ success: true }, { success: false }]` alternates on repeated calls.
- State is tracked: `state.planCallCount`, `state.receivedFeatures`, `state.receivedErrors`.
- Assertions read state: `expect(state.implementCallCount).toBe(3)` — not `toHaveBeenCalledTimes(3)`.
- Zero `vi.fn`. Zero `vi.mock`. The faux IS the real interface; it just returns scripted data.

### L2 design

```
testing/helpers/faux/
  llm-provider.ts    startFauxLlmProvider(opts) → { baseUrl, receivedBodies, close }
```

Starts a local HTTP server that speaks OpenAI SSE (or Anthropic event format). Replaces the ad-hoc `http.createServer` patterns currently in `api.test.ts`. Tests pass `baseUrl` as `apiBase` in config.

### Migration path

L1 faux (`planner.ts`, `implementer.ts`) is the default for new orchestrator tests. Suites that still import `makePlanner` / `makeImplementer` or `makeWctx` from `orchestrator-factories.ts` can stay on those helpers until rewritten; new coverage should not add `vi.fn` planner/implementer stubs.

### What stays unchanged

- Cassette record/replay (`testing/helpers/cassette/`) for e2e tests — real protocol traffic.
- Shell runners (`kind: 'shell'`) in integration tests — real subprocess spawn with scripted stdout.
- `testing/helpers/factories/` (config, task, workflow-state) — pure constructors, no mock behavior.
- `testing/helpers/events/planner.ts`, `testing/helpers/events/implementer.ts`, `testing/helpers/events/runner-call.ts`, and `testing/helpers/events/task.ts` contain typed event factories.
- `makeBusRecorder` in `testing/helpers/orchestrator-factories.ts` captures EventBus events.

## Test shape

**Pure function tests.** No mocks. Inputs → outputs. Cover edges: empty, null, boundary values, unicode, negative numbers, NaN/Infinity where relevant. Use `it.each(...)` when 5+ tests differ only by parameter. Models: `src/utils/diff.test.ts`, `src/core/state/machine.test.ts`, `src/engine/orchestrator/summary/build.test.ts` and `src/engine/orchestrator/summary/costs.test.ts` (aggregate pricing cases also live in `src/engine/providers/cost/breakdown.test.ts` and `src/engine/providers/cost/task-usage.test.ts`).

**Schema tests.** Only invariants and error paths. Do not write "parse a valid literal returns that literal" — `tsc` proves it. Zod `.strict()` only needs one repo-wide rejection test; don't duplicate per schema.

**State machine tests.** Assert on transitions and invariants, not on method calls. Set up a state, run the transition, assert on the resulting state. No spying on internal helpers.

**Store tests.** One end-to-end flow per behavioural capability — set, read, expire, invalidate, reset — in one `it`. Do **not** shard one `describe` per getter/setter. The store contract is `use/set/subscribe/fan-out to dependents`, not each method in isolation.

**Component / feature tests.** Use `ink-testing-library`. Render with real stores (reset in `beforeEach`). Drive by setting store state or simulating input. Assert on `lastFrame()` text or observable store state. Never mock `ink`, `FilterableList`, or any internal component.

**CLI command tests.** Invoke the real commander handler. Use a real `tmpDir` with scripted `.splitbrief/` contents (pattern: `src/cli/commands/status.integration.test.ts`; config load and version admission are unit-tested in `src/core/config/load/io.test.ts`). Config load/write roundtrip (default shape, optional sections, snake_case conversion) belongs in `src/core/config/load/io-roundtrip.test.ts`, not a CLI integration file. `init` without a TTY fails before any config write — `testing/integration/cli/init-non-tty.test.ts`. Treat stdin / stdout / exit code as the boundary. Assert on exit code and output *shape* (non-empty, contains command name) — never exact user-facing wording.

## Forbidden patterns

| Pattern | Why forbidden | What to do instead |
|---|---|---|
| `vi.mock('./sibling.js')` / `vi.mock('../other.js')` | Parallel reality; refactors break prod silently | Import the real module; assert on observable state |
| `vi.spyOn(internalModule, 'method')` | Tests the call graph, not the contract | Observe the state the method changes |
| `expect(fn).toHaveBeenCalledWith(...)` on injected internals | Implementation detail; test title starts with "should call" | `expect(state.x).toBe(y)` |
| `expect(output).toContain('exact wording')` | Breaks on copy changes with no behaviour change | Assert shape (non-empty, includes a command name), or exit code |
| `renderHook` on a pure `useState`/`useEffect` hook | Re-tests React | Extract pure dispatcher to a module, test that; or test the consumer |
| Per-selector / per-getter `describe` shards for a store | Tautology per method; loses the lifecycle contract | One `it` covering set → read → expire → invalidate |
| `expect({...emitted}).toMatchObject({ field: value })` where `field: value` was set 2 lines up | `tsc` already proves the passthrough | Test the transformation (pricing math, merge order) |
| Snapshot test as default assertion | Locks rendered text to the current string | Assert on specific roles / values / visible affordances |
| Copy-paste of a production helper into the test file | Production can drift from the copy | Export the helper; import it |
| Mocking 5+ sibling modules to "focus" a test | Signals wrong test level | Write a pure unit OR a real boundary/feature test; never the middle |

## Good / bad pairs

**Emitting a domain event.**

Bad:
```ts
vi.mock('./events.js', () => ({ emitEvent: vi.fn() }));
await runPhase(state);
expect(emitEvent).toHaveBeenCalledWith({ type: 'phase-complete' });
```
Good:
```ts
import { createEventBus } from '../../../src/engine/events/bus.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

const events: EngineEvent[] = [];
const bus = createEventBus();
bus.subscribe((e) => events.push(e));
await runPhase(state, { bus });
expect(events.at(-1)).toMatchObject({ type: 'workflow_complete' });
```
Why: the real bus runs and the test observes the same stream a production sink would see. Gating callbacks (`onApprovalNeeded`, etc.) stay as `await`-able stubs; the event channel is a sink subscription.

**Resetting a workflow sub-store.**

Bad:
```ts
const resetSpy = vi.spyOn(stopStore, 'reset');
resetWorkflow();
expect(resetSpy).toHaveBeenCalled();
```
Good:
```ts
stopStore.request('stop-now');
resetWorkflow();
expect(stopStore.get().phase).toBe('idle');
```
Why: contract is "after reset, the stop intent is back to idle", not "reset invoked a named method".

**Sessions picker.**

Bad:
```ts
vi.mock('../../stores/project/sessions.js');
vi.mock('ink', () => ({ /* fake Box, Text */ }));
const { select } = renderHook(() => useSessionsPicker());
act(() => select(0));
expect(mockRouterStore.set).toHaveBeenCalledWith('workflow');
```
Good:
```ts
sessionsStore.setAll([makeSession({ id: 's1' }), makeSession({ id: 's2' })]);
const { lastFrame, stdin } = render(<SessionsPicker />);
stdin.write('\r');
expect(routerStore.get().screen).toBe('workflow');
expect(lastFrame()).toContain('s1');
```
Why: real stores, real Ink render, observable output + observable store state.

## Test I/O and fixtures

- Real filesystem via `createTempDir` / `withTempDir` (`testing/helpers/temp-dir.ts`). Do not `vi.mock('node:fs')` — the only sanctioned exception is disk-full simulation.
- Real subprocess via `spawn(...)` against `/bin/echo`, `node -e '...'`, or a canned script. Do not mock `node:child_process`. The login-shell fallback in agent tests has a 30 s timeout for a reason; do not lower it.
- Real git binary via `createTestGitRepo` (`testing/helpers/git.ts`). Do not stub `simple-git`.
- Real HTTP via `http.createServer` for provider tests.
- Data factories are TypeScript functions under `testing/helpers/factories/` — one file per domain (`factories/task.ts:makeTask`, `factories/config.ts:makeConfig`, `factories/session.ts:makeSession`, `factories/summary.ts:makeSummary`). On-disk artefacts live in `testing/fixtures/`; consumers reach them via a repo-root-relative path resolved from `import.meta.dirname` (`src/engine/providers/cli-model-catalog.test.ts`, `src/engine/codebase/parse.test.ts`, `src/engine/codebase/repomap.test.ts`), not from `process.cwd()`.
- Every config artefact this repository ships is loaded by the real `loadConfig` in `testing/ci/shipped-configs.test.ts`: the committed `evals/fixtures/*/.splitbrief/config.yaml` projects, the committed examples under `testing/fixtures/configs/`, and what `initConfig` / `writeConfig` themselves write. Add a new example by dropping a `.yaml` file into `testing/fixtures/configs/` — the glob picks it up.
- Every ```` ```yaml ```` fence in `README.md` or any `docs/*.md` that names a top-level `ConfigSchema` key is loaded by the real `loadConfig` in `testing/docs/configuration.test.ts` — whole configs as written, section fragments under a `version: 3` header, which is how a reader pastes them. The doc tree is enumerated, so a new doc is covered the moment it exists. The same gate asserts every documented `kind: api` block spells out `service` and `offering`, because the loader's default merge would otherwise let an `ollama` example pass while omitting them. Pseudo-YAML opts out with `<!-- config-shape-sketch -->` and nothing else does.
- Sanctioned `vi.mock` targets (whole repo): `node:fs/promises` (write-failure and `mkdtemp` interception — `engine/orchestrator/run/heartbeat.test.ts`, `engine/orchestrator/approval/staged-project-failure.integration.test.ts`), `node:fs` (`statSync` ENOENT simulation — `core/state/persistence.test.ts`), `ink` + `fullscreen-ink` (CLI integration tests only — suppresses `waitUntilExit()` / `withFullScreen` so commander handlers run to completion without a TTY; all other exports preserved). Anything else is a bug.

## Pre-merge PR checklist

1. Test asserts on user/consumer-observable state, not on internal calls.
2. No `vi.mock(...)` arg starts with `./` or `../`.
3. No `vi.spyOn` on internal modules (globals on `console` / `process` are last-resort and commented).
4. No test title contains "should call" / "calls X".
5. No `renderHook` on a pure `useState`/`useEffect` hook.
6. No assertion restates a literal set up in the same test.
7. Identical-shape tests (5+) are collapsed with `it.each`.
8. File is colocated; deviations justified in the PR.
9. Subprocesses, servers, tmpDirs clean up (`withTempDir`, `killProcess`, `server.close()`).
10. After the PR, no production code can be deleted without updating a test — if yes, that test was testing the removed code directly; reconsider its value.

## When NOT to write a test

- Pure `useState` / composition-only hook — covered by the consumer that uses it.
- Re-exports (we have zero barrels anyway; see [`NO-BARRELS.md`](./NO-BARRELS.md)).
- Thin wrappers that only delegate to an already-tested function.
- Zod schema literal accept/reject — covered once in `src/core/schemas/runner-fields.test.ts`; do not duplicate.
- Discriminated-union accessors enforced by `assertNever` — `tsc` already enforces exhaustiveness.
- Styling-only components with no conditional logic.
- Library internals (`Array.prototype.filter`, `fzf.find`, Zod `.strict()`).

## Low-value test audit

For the cost-aware implementer pool and plan card work, the audit target is narrow:

- Delete or rewrite tests that only prove a wrapper calls another helper, a hook stores React state, a schema accepts a literal already type-checked by TypeScript, or a component "does not crash."
- Keep tests that encode routing policy, context overflow behavior, conflict classification, external-editor round-trip behavior, visible plan card markers, or user-facing CLI wording.
- Prefer rewriting many one-key or one-getter cases into a table or a single lifecycle test over deleting behavior coverage.

## Convention cross-reference

When a testing rule appears in multiple docs, the canonical source is cited first.

| Convention | Canonical | Also in |
|---|---|---|
| Colocated tests (`foo.test.ts` next to `foo.ts`) | this doc §Where does this test go? | `STRUCTURE.md` §Test strategy, `CLAUDE.md` §Core conventions |
| Blast-radius rule for placement | this doc §Where does this test go? | `STRUCTURE.md` §Test strategy |
| `testing/integration/{cli,orchestrator,ui}/` structure | this doc §How to add an integration test | `STRUCTURE.md` §Test strategy |
| `testing/e2e/` layer (scenarios + cassettes, isolated by `vitest.e2e.config.ts`) | this doc §Where does this test go? | `STRUCTURE.md` §Test strategy |
| Zero `vi.mock()` on internal modules | this doc §How to add an integration test and §Test I/O | — |
| No new fakes — extend `fauxPlanner` / `fauxImplementer` | this doc §How to extend the fakes | — |
| Engine tested at `runWorkflow()` boundary | this doc | `STRUCTURE.md` §Test strategy |
| Ink tested at the feature seam | this doc | `STRUCTURE.md` §Test strategy |
| Fakes vs fixtures split | this doc §Where does this test go? | `STRUCTURE.md` §Test strategy |
| Static as a trophy tier (no Zod shape tests) | this doc §When NOT to write a test | — |
| Test behavior, not implementation | this doc §Core rules, §Forbidden patterns | `PRINCIPLES.md` rule 15 |
| Neutral test voice | this doc §Core rules | `STRUCTURE.md` §No decorative comments, `PRINCIPLES.md` rule 10 |
| Test escape hatches (`__testReset`, `_*Internal`) | `STORES.md` §Test escape hatches, §Cross-module writes | — |
| Testing helper rules (no barrels, promote on 2+ consumers) | this doc §Where does this test go? | — |
| Hook test rules (trivial covered transitively, non-trivial dedicated) | `HOOKS.md` §Rules of thumb | this doc §Non-trivial hooks, `STRUCTURE.md` §Test strategy |
| Zero `index.ts` barrels (incl. `testing/`) | `NO-BARRELS.md` | this doc §Zero barrels |
| ESM `.js` imports for TS source | `CLAUDE.md` §Core conventions | `NO-BARRELS.md` §Why |
| Store actions pattern (writes through actions module) | `STORES.md` §Domain Store Pattern, §Workflow actions module | — |

## TUI visual gallery

The visual gallery renders the production `App`, router, screens, and overlays against synthetic store fixtures. It writes terminal-cell diagnostics and derived images for design review. It does not run a planner, implementer, provider, or live workflow.

Use it when changing Ink layout, copy, color, terminal controls, responsive behavior, or a semantic crop. The ordinary test suite checks the contracts under `testing/visual/`. The gallery command writes artifacts that a person or Codex can inspect.

### Interactive preview

Open the gallery chooser in an interactive terminal, or open a scenario directly:

```bash
npm run tui-preview
npm run tui-preview -- --scenario home-empty
npm run tui-preview -- --list
```

`--list` prints each scenario's ID, title, declared viewports and element IDs without mounting Ink. Interactive mode requires both stdin and stdout to be TTYs. The chooser uses the same catalog and fixture session as image capture, then mounts the production `App` so you can type, open overlays and exercise the screen's supported interactions.

| Key | Action |
|---|---|
| `↑` / `↓`, then `Enter` | Choose and open a scenario. |
| `F2` | Leave the scenario and return to the chooser. |
| `F5` | Recreate the selected fixture at the current declared viewport, discarding preview changes. |
| `F6` | Cycle the scenario's declared viewports. In the chooser, `←` / `→` also cycle them. |
| `Ctrl+Q` | Quit the preview and release its terminal and fixture resources. |

These controls are reserved by the preview. Other input reaches the rendered screen; `Esc`, `q` and `/quit` are not substitutes for the preview's return or exit controls. `F6` resizes an open scenario in place when the next declared size fits; use `F5` when you also need fresh fixture state.

The selected catalog viewport determines application layout. Your terminal must be at least that wide and tall; a larger host does not enlarge the declared viewport. If the selected size does not fit, the preview stays in the chooser with a size warning. Shrinking the host below an open viewport closes that fixture and returns to the chooser. Enlarge the terminal or choose a smaller declared viewport, then press `Enter` to reopen it.

Preview interaction ports in `testing/visual/gallery/fixture-session.ts` keep configuration edits in fixture state, simulate preparation and connection checks, and confine run reads to the fixture project. Connection Retry returns synthetic catalog data; it does not contact a server. Operations without a fixture implementation report `Unavailable in preview` or decline the action instead of invoking real execution. Clipboard export, image attachment, discovery refresh and run snapshot actions are among those restricted operations. The preview does not call a model, log in, start a server or authorize Git writes. It is a UI exercise, not evidence that a live runner or server works.

Use `tui-shots` below for saved PNGs and cell diagnostics. Interactive preview does not replace capture review or the separate manual real-terminal selection check.

### Commands and selection

List the catalog without mounting the app:

```bash
npm run tui-shots -- --list
```

Capture one named element at one viewport:

```bash
npm run tui-shots -- \
  --scenario home-empty \
  --viewport 80x24 \
  --element header \
  --output .test-artifacts/ui/local-smoke
```

The flags mean:

- `--scenario <id>` selects a catalog scenario such as `home-empty`, `workflow-review`, or `overlay-help`.
- `--viewport <cols>x<rows>` selects an exact terminal size. The catalog sizes are `120x40`, `80x24`, and `60x18`.
- `--element <id>` selects a catalog-owned semantic crop such as `header`, `composer`, `sidebar`, or `approval-panel`. The element must belong to every selected scenario.
- `--profile <name>` selects a terminal profile: `unicode-color` (the default), `unicode-mono`, or `ascii-mono`. One profile per run.
- `--output <directory>` selects the artifact root. The default is `.test-artifacts/ui`.
- `--list` prints scenario IDs, viewports, checkpoints, and element IDs, then exits without rendering.

The profile owns the colour level of the capture, so `unicode-color` writes styled cells and `unicode-mono` writes none regardless of whether the launching shell has a TTY or a pipe on stdout.

Repeat `--scenario`, `--viewport`, or `--element` to select more than one value. The command validates the complete selection before it mounts a fixture. With no filters, it captures every catalog scenario at all three viewports, including each full frame and every declared crop.

The run directory is content-addressed from the normalized selection. Repeating the same command replaces that run atomically, so a failed or narrower rerun cannot leave stale success records in its manifest.

**The run screen's own scenarios.** There is no summary screen, so the four `summary-*` scenarios are gone. Nine scenarios cover the run screen when nothing is running on it, all under the `workflow` screen with the standard viewport matrix and the elements `header` / `transcript` / `composer`:

| Scenario | What it shows |
|---|---|
| `workflow-at-rest-paused` | paused mid-brief; `× build` on the rail, `Stopped at T003 · type a correction or ⏎ to continue` |
| `workflow-at-rest-halted` | a quota halt; `✗ build`, `Seat down · Quota spent on Ollama · ⏎ to decide` |
| `workflow-at-rest-left-isolation` | a left-isolation halt read back from its log; the transcript rows the halt wrote over the byline `Seat down · T002 left the isolation directory · ⏎ to decide` |
| `workflow-at-rest-waiting-gate` | an older run parked at its spec gate; `Waiting at the plan · ⏎ to continue` |
| `workflow-at-rest-quick` | an older run paused while it still researched; the three-stage rail folds that phase into Plan, `× plan` wears the stop, `Stopped at the plan · type a correction or ⏎ to continue` |
| `workflow-closed-complete` | three `●` (Plan, Build, Review), the `Closed ─` block, `esc home` in the legend and an empty byline |
| `workflow-closed-complete-needs-attention` | the same block with a failing review and a dirty scope |
| `workflow-closed-ended` | a run somebody ended inside T003; `× Ended · Build 1/5 · stopped in T003` |
| `workflow-replayed-history` | the transcript read back from `testing/fixtures/session-log/run.jsonl` |

The at-rest fixtures go through the production path: the fixture copies a real log into the session dir, calls `hydrateRun`, and inits the route at rest. Nothing is staged into the stores by hand. `workflow-plan-compiled` shows the planning session's two cards, `plan.md` and `tasks.md`, both rendered from `plan.json`; `workflow-at-rest-quick` is an old quick run at rest, which continues as one planning session.

`workflow-at-rest-paused` replays T001 and T002 passing, T003 starting, and a mid-step `turn_interrupted` from `paused-mid-brief.jsonl`. `workflow-review-base-mixed` shows the three completed brief rows before its reviewer checks. Both answered consult scenarios carry the planner call's start and completion, so the progress block shows a runner and recent event time.

### Artifact layout

A successful filtered run has this shape:

```text
.test-artifacts/ui/local-smoke/
└── catalog-1-<selection-digest>/
    ├── manifest.json
    └── home-empty/
        └── 80x24/
            └── ready/
                ├── frame.ansi
                ├── frame.txt
                ├── frame.cells.json
                ├── frame.svg
                ├── frame.png
                └── elements/
                    └── header/
                        ├── crop.ansi
                        ├── crop.txt
                        ├── crop.cells.json
                        ├── crop.svg
                        └── crop.png
```

`--output` names the first directory in the example. The `catalog-1-<selection-digest>` child is the deterministic run key. Scenario, viewport, and checkpoint form the path below it. Derived `frame.svg`, `frame.png`, `crop.svg`, or `crop.png` can be absent when their renderer reports a structured failure. The ANSI, TXT, and cells files are the diagnostic bundle.

`manifest.json` records:

- manifest, catalog, and cell schema versions;
- tool version and git revision;
- requested and resolved selection entries;
- the deterministic timezone, locale, terminal, color, clock, random, hyperlink, and motion settings;
- terminal-control and hyperlink policies;
- renderer name, version, font family, and cell metrics when derived images exist;
- every frame or crop identity, provenance, rectangle, dimensions, locator, and relative file path;
- warnings and structured failures.

A failed required artifact does not appear as a successful PNG. Its failure remains in the manifest with the stage and artifact identity.

### Frames, crops, and diagnostic truth

Each frame is a full viewport cell grid. Its identity includes scenario, checkpoint, fixture version, viewport, and a stable frame key. A crop is sliced from that frame's canonical cells before any serializer or renderer runs. Its manifest entry includes the semantic element ID, locator kind, rectangle, and parent frame key. This makes the crop an exact rectangular view of `frame.cells.json`, not a second render that may drift from its parent.

The files have different jobs:

- `*.cells.json` is the canonical structured cell grid. It preserves graphemes, wide-cell continuation, foreground and background colors, attributes, and sanitized hyperlink metadata.
- `*.txt` is control-free text reconstructed from the same cells. It preserves the fixed row count, blank rows, and trailing spaces.
- `*.ansi` is deterministic terminal diagnostic output. It retains documented styles and sanitized OSC-8 links.
- `*.svg` and `*.png` are derived from the cell grid. They are for visual inspection, not diagnostic authority.

Version 1 has no PNG baseline or pixel-diff gate. The manifest records the renderer and font metrics because font availability and rasterization can differ across machines. Do not expect byte-identical PNGs across different installed fonts or operating systems. Compare cells, TXT, ANSI, and SVG structure when deterministic equality matters.

The gallery test owns the frame-geometry gate: it mounts the `workflow-implementation` scenario at every required viewport and asserts that the header divider, the footer divider, and the composer frame each span exactly the declared viewport width. A mount that lays out at a width other than the declared viewport cannot satisfy all three at once — the xterm grid, which is constructed at the declared viewport, would agree with itself by construction and catch nothing.

### Fixture-only CI policy

CI uses synthetic fixtures only. It does not read live sessions, user prompts, provider credentials, real transcripts, or the contents of a developer's current project, and no captured fixture reads the operator's `~/.claude.json` model option cache — every visual fixture pins it before the first render. The representative CI smoke captures a bounded fixture at `80x24`; the complete catalog remains a local command because it creates many raster files.

The fixtures still use the production app composition. They reset stores, seed bounded data, mount one scenario, wait for its semantic checkpoint, capture it, unmount it, and only then start the next scenario. This tests real screen and overlay composition without network access.

The fixture runs are dated from one instant, `VISUAL_FIXTURE_EPOCH` (`testing/visual/fixtures/common.ts`), and the capture clock stands 42 seconds after it (`FIXED_CLOCK`, `testing/visual/gallery/environment.ts`). So a live header and byline paint `0:42`, and a build block's freshness line reads `last event …` rather than the silence warning, except in `workflow-implementation-silent`, whose seat is dated past the idle watchdog's warn (`RUNNER_IDLE_WARN_MS`, five minutes) on purpose. A resumed run's saved state carries that epoch as its start, never the wall clock the module loaded at. `testing/visual/gallery.test.tsx` fails when any of these clocks paints `0:00`.

The real CLI E2E suite under `testing/e2e/` has a different purpose. It checks planner and implementer protocol flows with real tools or recorded cassettes. It does not enumerate the visual catalog, render every viewport, resolve semantic crops, or publish visual artifact bundles. Passing E2E tests is not evidence that the gallery is complete, and a gallery pass is not evidence that a provider workflow works.

### PTY behavior contract

The terminal-boundary behavior harness lives under `testing/integration/cli/pty/`, with its tests in `testing/integration/cli/`. Run it without arguments:

```bash
npm run tui-shots:pty
```

The harness spawns at fixed `100x30` dimensions and mounts the production `App` through `renderApp` in an active `reviewing-plan` state. It types the approval prefix and presses Ctrl+E to open the run's `plan.json` in the editor overlay. Ctrl+O hands `plan.json` to a one-shot real editor child through `VISUAL`. The harness returns to the review, completes `approve`, submits the real approval callback, and sends Ctrl+Q. It checks terminal restoration, child exit, and process-group reaping. The isolated child environment uses an allowlist and temporary home and project roots; it does not contact a provider.

PTY teardown awaits child reaping before listeners, timers, and temporary roots are disposed.

`node-pty@1.1.0` is a tooling-only development dependency. An ordinary `npm install` or `npm ci` may install its native binary. Runtime-only installations can omit development dependencies with `npm ci --omit=dev`; running this test requires the development dependencies.

The command loads `node-pty` dynamically. In optional mode, only setup failures (`module-unavailable`, pre-spawn `api-incompatible`, or `spawn-failed`) print `PTY behavior SKIP` and exit `0`. Once a process boundary exists, every failure is fatal. A complete run prints `PTY behavior PASS`; fatal failures print `PTY behavior failed` and exit nonzero. Node 22 is required. Some platforms may also need a working native toolchain or a compatible prebuilt `node-pty` binary.

With `SPLITBRIEF_REQUIRE_PTY=1`, unavailable, incompatible, or spawn-failed PTY setup exits nonzero, and the command passes only after active review, editor return, approval, terminal restoration, and cleanup complete.

### Handing artifacts to Codex

For a focused UI task, run `--list`, capture the smallest relevant scenario, viewport, and element, then give Codex the run's `manifest.json` path. Include `frame.png` for surrounding layout and `crop.png` for the component under review. Point to `frame.txt` or `frame.cells.json` when exact copy, spacing, width, color, or hyperlink metadata matters.

Ask Codex to read the manifest before comparing files. The manifest distinguishes a missing derived file from a successful artifact and ties every crop to its source frame. Regenerate the same selection after a change and compare the diagnostic files. Do not hand off a live session directory or treat a cross-font PNG byte difference as a regression.

## Manual smoke checklist

`npm run test-ci` covers the vast majority of the surface. `npm run release-check` is the fast pre-PR gate — `format:check → typecheck → lint → test → test:integration → e2e replay → invariants → skills:check` — and `npm run test-ci` is the exhaustive form that additionally runs `test:coverage`, whose thresholds also run in `.github/workflows/nightly-coverage.yml` when you start it by hand (`workflow_dispatch`). A handful of flows need a real TTY, a fresh checkout, or an external process and therefore live outside the automated suite. Run the checks below after a fresh install or any change that touches the CLI entry point, the TUI mount, or hook dispatch.

### Headless terminal interaction

`npm run test:terminal` starts the app through `/bin/zsh` in a real PTY connected to xterm.js in headless Chromium. Playwright drives the terminal's virtual pointer, so the test does not move the desktop cursor, open an editor window or require macOS Accessibility/Screen Recording. Install its browser once with `npx --no-install playwright install chromium` if Chromium is unavailable.

The test uses the production fullscreen renderer for both App and Composer. It checks visible drag highlighting, exact copied text, composer draft selection, updates during a live workflow drag, wheel scrolling, and a Unicode copy/paste round trip. The production clipboard adapter invokes a private test executable on `PATH`, which captures its input without changing the system clipboard. A separate native-selection control uses xterm's copy-event handler. Reports and screenshots are saved under `.test-artifacts/terminal-browser/`. Exit codes are `0` for success, `1` for a product failure, and `2` for a setup or harness failure. A failing product interaction stays a failure even when the control passes. This harness proves xterm.js behavior through zsh; it does not certify native macOS shortcut dispatch or other terminal applications by changing `TERM`.

The run also saves `tracking-selected.ansi`, the real production output up to a selected workflow frame. Replay it in actual Ghostty/Kitty engines without opening a window:

```bash
node testing/integration/cli/terminal-browser/terminal-engine-compat.mjs ghostty /path/to/ghostty-vt.wasm /path/to/tracking-selected.ansi
node testing/integration/cli/terminal-browser/terminal-engine-compat.mjs kitty /path/to/kitty /path/to/tracking-selected.ansi
```

Use official artifacts: the probe was checked against Ghostty's `tip` VT WASM and Kitty 0.48.2's macOS executable. The Ghostty probe verifies rendered text and its selection API; Kitty feeds the recording through its VT parser and checks forwarded Cmd+C/Ctrl+C encodings. These engine checks complement the application E2E. Native window shortcut dispatch and the OS clipboard remain a separate boundary.

### M1. TUI smoke (full interactive render)

Ink needs a real TTY; automated terminal tests provide one through a PTY. The following manual smoke additionally checks the installed terminal and a full workflow:

```bash
mkdir /tmp/smoke-tui && cd /tmp/smoke-tui
git init && git config user.email x@x.com && git config user.name X
# Seed .splitbrief/config.yaml with a shell planner + shell implementer
#   (same shape as evals/fixtures/*/.splitbrief/config.yaml)
npm run dev -- --project /tmp/smoke-tui start "smoke tui test"
```

Verify: the fullscreen Ink TUI renders, phases progress visually, and the workflow completes with a `workflow_complete` banner. For keyboard changes, also verify workflow scroll with `Shift+↑` / `Shift+↓`, `PageUp` / `PageDown`, `Home` / `End`, `/scroll top`, `/scroll bottom`, `/scroll page-up`, `/scroll page-down`, and `Ctrl+A` plus `/activity` on a compact activity block. `Ctrl+B`, `Ctrl+E`, and `Ctrl+F` should stay in the composer during normal workflow input; `/scroll` is the reliable path.

If a terminal does not deliver a key as expected, rerun the smoke with key logging enabled:

```bash
SPLITBRIEF_DEBUG_KEYS=1 npm run dev -- --project /tmp/smoke-tui start "smoke tui keys"
```

The log is written under `.splitbrief/debug/keys-*.log` in the smoke project and records both raw bytes and parsed Ink key flags.

### M2. Headless `--json` mode

From any project with a valid `.splitbrief/config.yaml`:

```bash
node dist/cli.js start --json "smoke feature"
```

Verify: NDJSON on stdout, first line is `readiness_report`, the first model-backed workflow event is `workflow_started`, last workflow event is `workflow_complete`, and the process exits `0`. If `--json` is unrecognized, run `npm run build` — stale `dist/` is the most common cause.

### M3. Completion leaves Git untouched

The M3 completion fixture asserts that no staging, commit, or index-checkpoint operation is requested.

`src/engine/orchestrator/task/commit.test.ts` replaces `simple-git` with a recording mock. Accepted completion advances the task and records its outcome; rejected completion does not advance. The fixture asserts that neither path calls Git or emits `git_commit`/`git_checkpoint`. Its temporary directories contain state files, not committed repositories.

```bash
npm test -- src/engine/orchestrator/task/commit.test.ts
```

Inspect test setup and transitive imports before running any recipe. `npm run test:integration`, `release-check`, `test-ci`, and e2e include fixtures that stage or commit temporary repositories. They are not permitted under a no-Git-mutations instruction, even in a fresh checkout; run only inspected, explicitly selected safe tests in that environment. The full gate remains unverified until an authorized operator runs it.

### M4. Fresh checkout + install

```bash
rsync -a --exclude=node_modules --exclude=dist --exclude=.git . /tmp/splitbrief-fresh/
cd /tmp/splitbrief-fresh
npm ci && npm run test-ci
```

Verify: install completes, `npm run test-ci` (format:check → typecheck → lint → test:coverage → e2e → invariants → skills:check) is green.

## Import-integrity audit

`node scripts/dangling-imports.mjs` resolves every relative `import`/`export … from` and dynamic `import()` in `src/`, `testing/` and `scripts/` — tracked and untracked alike — against the filesystem, accounting for the ESM `.js`-for-`.ts` suffix. String and template-literal example imports (fixtures, prompt templates) are skipped. It prints `clean — <n> files scanned` and exits `0` when nothing dangles; otherwise it lists each `file:line -> specifier` and exits `1`.

Run it after a move, rename or deletion pass: `tsc` reports the same breakage, but this audit is safe to run when the typecheck gate itself is unavailable, and it covers files no tsconfig includes.

## References

- Skill: `test-behavior-not-implementation` — Kent C. Dodds Testing Trophy + TkDodo's testing principles. The spine of these rules.
- Skill: `react-senior-guide` — React 19 patterns, hook contracts, anti-pattern checklist.
- [`STRUCTURE.md`](./STRUCTURE.md) — file tree, test strategy summary, colocation rule, file-length thresholds.
- [`PRINCIPLES.md`](./PRINCIPLES.md) — rule 15: test behavior, not implementation.
- [`LAYERS.md`](./LAYERS.md) — layer boundaries that define what counts as a "boundary" test.
