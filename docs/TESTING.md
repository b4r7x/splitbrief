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
| Don't re-test the framework / compiler | `useState`, `assertNever`, Zod `.strict()`, V8's `Error.captureStackTrace` already have tests | Skip `toBeInstanceOf(Function)` on a typed interface; skip `expect(err.stack).toContain(file)` |
| Don't re-assert a literal you just set up | `tsc` already proves passthrough | Test the transformation, not the echo |
| Don't copy production helpers into test files | Production can drift from the copy; tests re-implement instead of observe | Export the helper from source and import it |
| Prefer observable-state assertions over DI call-count assertions | Call counts observe wiring; state observes behaviour | Assert on store contents / files on disk / emitted events, not `toHaveBeenCalledTimes` |
| Accessible queries first in UI tests | Matches what a real consumer sees | `getByRole` > `getByTestId` |
| Test the contract of a hook, not its wiring | A hook is its inputs → outputs/effects | Extract pure logic, test that; hook becomes a thin wrapper |
| Zero failing tests, always | Project policy — enforced on every PR | `npm test` green before merge |
| Neutral test voice | Tests are observed behaviour, not narration | Zero `// Observable:` prefixes, zero AI-assistant names, no section-divider banners (`// ═══ X ═══`) inside test files — same rule as production (`STRUCTURE.md` §No decorative comments) |

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

The flowchart covers `src/**` source. Two trees outside it also hold colocated tests: `scripts/` (repo tooling such as `check-invariants.test.ts` and `import-boundaries.test.ts`, kept next to `check-invariants.ts` / `import-boundaries.ts`) and the single eval driver `evals/eval.test.ts`. Discovery is configured in `vitest.config.ts` via `include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,tsx}', 'testing/integration/**/*.test.{ts,tsx}', 'testing/helpers/**/*.test.{ts,tsx}', 'evals/eval.test.ts']` — five globs, all picked up by a single `npm test`.

| Kind | Location | Suffix |
|---|---|---|
| Pure unit / single-folder integration | next to source (`foo.test.ts` by `foo.ts`) | `.test.ts` / `.test.tsx` |
| Boundary test (fs, git, subprocess, http) touching one folder | next to source | `.test.ts` |
| Repo tooling unit (gate runner, import-boundary checker) | next to source in `scripts/` (`check-invariants.test.ts` by `check-invariants.ts`) | `.test.ts` |
| Feature-seam Ink test (one feature's screen, no engine) | next to feature entry | `.test.tsx` |
| Multi-folder CLI flow (commander → engine → stores) | `testing/integration/cli/` | `.test.ts` |
| Multi-phase orchestrator flow (`runWorkflow()` + fakes) | `testing/integration/orchestrator/` | `.test.ts` |
| Multi-store UI flow (Ink screen + engine events via stores) | `testing/integration/ui/` | `.test.tsx` |
| End-to-end scenario (real planner/implementer or recorded cassette) | `testing/e2e/scenarios/` (cassettes in `testing/e2e/cassettes/`) | `.test.ts` — isolated by `testing/e2e/vitest.e2e.config.ts`, not by suffix |
| Shared factories (pure TS constructors) | `testing/helpers/factories/<domain>.ts` — ≥ 2 consumers | n/a |
| Shared test helpers (fakes, renderers, resetters) | `testing/helpers/*.ts` — ≥ 2 consumers, no `expect()` | n/a |
| Static fixtures (YAML, JSON, recorded HTTP bodies, migration snapshots) | `testing/fixtures/<domain>/` | n/a |

**Fixtures vs factories.** Split by kind:
- `testing/fixtures/<domain>/` = read-only **bytes on disk**. Consumers read via `fs.readFile`.
- `testing/helpers/factories/<domain>.ts` = pure **TypeScript constructors** returning typed objects with overrides. No I/O.
- **Rule of two:** data stays inline inside one test file until a second test needs it. Promotion happens on the second consumer, not the first.

**Feature sub-components do not get dedicated tests.** Ink is tested at the feature seam (`screen.tsx` / `overlay.tsx` / `picker.tsx`). Shared primitives in `src/components/` (`FilterableList`, `MultilineInput`, `TwoColumnPicker`) are the exception — their cost amortises across consumers.

**Orchestrator internals do not get dedicated tests.** Pure decision modules in `src/engine/` do (parsers, state machine, layout math, pricing math). Control-flow modules (`approval`, `continuation`, `escalation/*`, `task/loop.ts`, `task/step.ts`, `queue`, `signals`, `planning/*`, `run/*`) are covered only via integration tests at the `runWorkflow()` seam.

**Zod schemas do not get shape tests.** TS strict + Zod `.parse()` is first-class correctness — no runtime tests for schema shape. One repo-wide `.strict()` rejection test lives in `src/core/schemas/runner-fields.test.ts`; do not duplicate per schema.

Colocated support files under `src/**` that import `vitest` or another dev-only dependency must use the `*.test.ts` / `*.test.tsx` pattern so production builds exclude them. Shared support belongs under `testing/helpers/**`, which is already outside the production type-check graph.

**Coverage thresholds** (`vitest.config.ts`): `statements: 50, branches: 40, functions: 50, lines: 55`. These are **non-regression gates, not aspirational targets** — do not add dead tests to lift coverage. Static (TS strict + Zod) is a first-class tier and carries real safety even when it does not increment coverage numbers.

**Zero barrels anywhere in `testing/`**, not just `src/`. No `index.ts` inside `testing/helpers/`, `testing/helpers/factories/`, `testing/fixtures/`, or `testing/integration/*`. Consumers import directly from the file they need. Same rule and rationale as [`NO-BARRELS.md`](./NO-BARRELS.md).

**Hook tests follow behavior, not wiring.** Trivial hooks (≤30 LOC, no branching, thin selector wrappers) are covered transitively through their consumer's integration test — see [`HOOKS.md`](./HOOKS.md). Only behavior-bearing hooks (state machines, async race / cancellation, promise-based resolvers like `useInputMode`) get a dedicated colocated test, and that test asserts the observable contract: inputs, effects, and returned state. Do not test internal `useState` / `useEffect` calls.

## Current workflow policy

Cost-aware implementer routing, user-edit conflict handling, and Plan Review v2 follow the same rule: test the decision contract, not the private call graph.

**Routing and context fit.** Public pure helpers are valid unit-test targets when they encode product policy. Examples: context-window classification, prompt-size estimation, profile ordering, cheapest-capable selection, and no-capable-profile failure. These tests should assert the returned decision object, selected profile, rejection reasons, and fit status. Do not spy on internal sort helpers or duplicate the full prompt formatter in the test.

**User-edit conflicts.** Conflict tests should set up real task/file ownership data and assert the public classification or emitted event: conflict kind, affected task ids, `safeToContinue`, and available actions. Do not assert that a particular detector function was called. Orchestrator-level coverage belongs at the task loop or `runWorkflow()` seam when the behavior is "pause before overwriting the user" or "continue on unrelated external edits."

**Plan Review v2.** Keep pure editor reducers/actions colocated with the store or hook module when they have branching behavior. Component tests should render the Plan Review surface and assert visible markers the user depends on: selected worker, context fit or overflow, dirty state, save error, and conflict labels. Avoid micro-tests for keybinding passthrough unless the helper is exported as a pure public parser; prefer grouping key maps with `it.each` when adding more cases.

**Hooks and wrappers.** No new `renderHook` tests for trivial wrappers, selector hooks, or `useState` / `useEffect` plumbing. Extract behavior-bearing logic into a public pure helper and test that helper, or cover the hook through the feature/component that uses it. Thin wrappers that only call an already-tested helper should not receive dedicated tests.

**Recovery flow.** Recovery tests should assert persisted `pendingRecovery`, emitted recovery events, headless JSON, prompt text/parser behavior, and file/evidence effects. In a dirty or shared checkout, do not run broad orchestration suites that exercise product git behavior (`git add`/commit/checkpoint helpers). Prefer the focused recovery files:

```bash
npm test -- src/core/schemas/recovery.test.ts
npm test -- src/core/schemas/workflow.test.ts
npm test -- src/core/schemas/enums.test.ts
npm test -- src/core/state/machine.test.ts
npm test -- src/core/state/persistence.test.ts
npm test -- src/engine/orchestrator/recovery/recovery.test.ts
npm test -- src/engine/orchestrator/budget/check.test.ts
npm test -- src/engine/orchestrator/task/loop-happy-path.test.ts
npm test -- src/engine/orchestrator/task/step.test.ts
npm test -- src/engine/orchestrator/run/workflow.test.ts
npm test -- src/engine/orchestrator/session-lifecycle.test.ts
npm test -- src/cli/headless.test.ts
npm test -- src/features/workflow/recovery-prompt.test.ts
npm test -- src/features/workflow/user-edit-conflict-prompt.test.ts
```

Full `npm test` is appropriate only when it is safe for the checkout and the validation owner accepts suites that may create git history in temporary repos.

## How to add an integration test

Integration tests live under `testing/integration/<layer>/`. One file per user-observable flow. Longer files with more assertions beat many short files (TkDodo: fewer, longer tests).

**Pick the layer.**
- Commander flow (`start`, `resume`, `init`, `migrate`, `status`) → `testing/integration/cli/`
- `runWorkflow()` state-machine flow → `testing/integration/orchestrator/`
- Feature screen that depends on engine-written store state → `testing/integration/ui/`

**Wire the setup.** In `beforeEach`, reset all stores and create a tmp dir when the test touches the filesystem:

```ts
import { beforeEach, describe, it, expect } from 'vitest';
import { resetAllStores } from '../../helpers/stores.js';
import { withTempDir } from '../../helpers/temp-dir.js';

beforeEach(() => resetAllStores());
```

**CLI flow — drive commander in-process** (`testing/helpers/commander.ts`):

```ts
import { runCommand } from '../../helpers/commander.js';

it('start writes state.json and exits 0', async () => {
  await withTempDir(async (dir) => {
    // seed config
    const { stdout, exitCode } = await runCommand(['start', 'add endpoint'], { cwd: dir });
    expect(exitCode).toBe(0);
    // assert on files in dir, not on stdout wording
  });
});
```

**Orchestrator flow — drive `runWorkflow()` with fakes** (`testing/helpers/orchestrator-factories.ts`):

```ts
import { createFakePlanner, createFakeImplementer } from '../../helpers/orchestrator-factories.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';

it('quick mode completes one task via local implementer', async () => {
  const planner = createFakePlanner({ script: [/* ... */] });
  const implementer = createFakeImplementer({ script: [/* success */] });
  const events: EngineEvent[] = [];
  await runWorkflow({
    planner,
    implementer,
    _eventSink: (e) => events.push(e),   // subscribed to the internal EventBus
    callbacks: { /* gating stubs: onApprovalNeeded, onQuestionAsked, ... */ },
  });
  expect(events.at(-1)).toMatchObject({ type: 'workflow_complete' });
});
```

**Headless `--json` CLI flow** (`testing/integration/cli/`):

```ts
it('start --json emits NDJSON and exits 0', async () => {
  await withTempDir(async (dir) => {
    // seed config + fakes
    const { stdout, exitCode } = await runCommand(['start', '--json', 'add endpoint'], { cwd: dir });
    expect(exitCode).toBe(0);
    const events = stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: 'readiness_report' });
    expect(events.find((e) => e.type === 'workflow_started')).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: 'workflow_complete' });
  });
});
```
The headless driver (`src/cli/headless.ts`) wires `stdoutJsonSink` to the bus and stubs workflow host callbacks so integration tests can drive `diptych start --json` end-to-end and assert on the event sequence plus exit code. Tiered approvals still use approval config and fail closed when headless sticky/confirm has no grant. No Ink mount, no TTY detection.

**UI flow — render a feature + drive engine events through stores** (`testing/helpers/ink.ts`):

```ts
import { renderFeature, tick } from '../../helpers/ink.ts';
import { addEvent } from '../../../src/stores/workflow/actions.js';
import { WorkflowScreen } from '../../../src/features/workflow/screen.js';

it('workflow screen shows an escalation card when escalate event arrives', async () => {
  const { lastFrame } = renderFeature(<WorkflowScreen />);
  addEvent({ type: 'escalate', attempt: 2 /* ... */ });
  await tick();
  expect(lastFrame()).toContain('Escalation');
});
```

**Rules:**
- Use `testing/helpers/stores.ts:resetAllStores()` in `beforeEach`. Stores are module-scoped singletons.
- Use `testing/helpers/temp-dir.ts:withTempDir()` for filesystem work. Never mock `node:fs`.
- Use real `git` via `testing/helpers/git.ts:createTestGitRepo()`. Never stub `simple-git`.
- **Zero new fakes.** Use `createFakePlanner` / `createFakeImplementer` from `testing/helpers/orchestrator-factories.ts`. Extend them via their `script` parameter, not by copying their shape into a new file.
- **No `vi.mock()` on internal modules** (`./`, `../`). The sanctioned repo-wide targets are `@anthropic-ai/claude-agent-sdk` (optional peer dep), `node:os` (persistence home-dir), `node:fs` (disk-full simulation), and `ink` + `fullscreen-ink` (CLI integration tests only).
- **Import `testing/helpers/**` from `src/**` tests via the `#testing/*` subpath import** (`import { makeConfig } from '#testing/helpers/factories/config.js'`), never a long relative `../../../testing/helpers/...` path. The alias is defined once in `package.json` `imports` (`"#testing/*": "./testing/*"`).
- Exit codes via `isCliError`. `commander.exitOverride()` throws; `runCommand()` catches and returns the exit code.

## How to extend the fakes

`createFakePlanner` and `createFakeImplementer` in `testing/helpers/orchestrator-factories.ts` accept a deterministic `script` — a sequence of return values driving the workflow. To cover a new scenario:

1. Open `testing/helpers/orchestrator-factories.ts`. Read the existing `script` shape.
2. Add a new test file in `testing/integration/orchestrator/<scenario>.test.ts`. Build the `script` array that represents your scenario (success, fail-then-succeed, fail-3x-then-escalate, approval-pending, abort-midstream).
3. **Do not** add a new fake class. Do not copy the fake shape into a local helper. If the existing script grammar cannot express your scenario, propose a grammar extension in a dedicated PR — new grammar gets one pull request, not N parallel implementations.

Real adapter boundaries (`Planner`, `Implementer`, `ProviderClient`) are the only sanctioned injection points. Everything else is a real import.

## CLI command DI pattern

CLI command handlers accept an optional `deps` parameter for dependency injection. This is the standard pattern for testing commands without `vi.mock`:

```ts
// src/cli/commands/start.ts
export interface StartDeps {
  spawnServer: (opts: SpawnServerOptions) => Promise<SpawnServerResult>;
  runHeadless: typeof runHeadless;
  runRpc: typeof runRpc;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
}

const defaultStartDeps: StartDeps = { spawnServer, runHeadless, runRpc, initStores, renderApp };

export function registerStartCommand(program: Command, deps: StartDeps = defaultStartDeps): void { ... }
```

In tests, inject fakes directly:

```ts
const program = new Command();
program.exitOverride();
registerStartCommand(program, fakeDeps); // fakeDeps: StartDeps with stubbed renderApp/runHeadless/…
```

**Commands using this pattern:** `start.ts` (`StartDeps`) and `worktree.ts` (`WorktreeDeps`) expose `deps` on the `register*Command(program, deps = default)` signature itself. `attach.ts` (`AttachDeps`) and `last.ts` (`LastDeps`) keep `register*Command(program)` thin and inject `deps` one level down, on the internal helper (`attachCommand(…, deps = defaultDeps)`, `lastCommand(…, deps = defaultDeps)`).

**Rule:** `vi.mock` is now reserved for TRUE system boundaries only — `process.kill`, `execSync`, `node:net` sockets, and the sanctioned targets listed in [Test I/O and fixtures](#test-io-and-fixtures). All other test isolation uses the `Deps` interface pattern.

## Faux provider architecture

The `orchestrator-factories.ts` fakes work but are `vi.fn` wrappers — assertions tend toward `toHaveBeenCalledWith` (implementation coupling). The faux architecture replaces them with **typed faux objects** that implement the real interface and track state declaratively.

### Two levels

| Level | Seam | When to use |
|---|---|---|
| **L1: Faux objects** | `Planner` / `Implementer` interface | 90% of orchestrator tests. Declarative scripts, no network, <50ms. Replaces `createFakePlanner`/`createFakeImplementer`. |
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

`testing/helpers/faux/` is implemented (L1: `planner.ts`, `implementer.ts`). New tests use faux objects; old tests using `orchestrator-factories.ts` continue to work and are gradually migrated. Once all consumers migrate, the old factories will be deprecated and removed.

### What stays unchanged

- Cassette record/replay (`testing/helpers/cassette/`) for e2e tests — real protocol traffic.
- Shell runners (`kind: 'shell'`) in integration tests — real subprocess spawn with scripted stdout.
- `testing/helpers/factories/` (config, task, workflow-state) — pure constructors, no mock behavior.
- `testing/helpers/events.ts` — event capture at the EventBus boundary.

## Test shape

**Pure function tests.** No mocks. Inputs → outputs. Cover edges: empty, null, boundary values, unicode, negative numbers, NaN/Infinity where relevant. Use `it.each(...)` when 5+ tests differ only by parameter. Models: `src/utils/diff.test.ts`, `src/core/state/machine.test.ts`, `src/engine/orchestrator/summary-build.test.ts` (pricing/cost cases now live in `src/engine/providers/cost.test.ts`).

**Schema tests.** Only invariants and error paths. Do not write "parse a valid literal returns that literal" — `tsc` proves it. Zod `.strict()` only needs one repo-wide rejection test; don't duplicate per schema.

**State machine tests.** Assert on transitions and invariants, not on method calls. Set up a state, run the transition, assert on the resulting state. No spying on internal helpers.

**Store tests.** One end-to-end flow per behavioural capability — set, read, expire, invalidate, reset — in one `it`. Do **not** shard one `describe` per getter/setter. The store contract is `use/set/subscribe/fan-out to dependents`, not each method in isolation.

**Component / feature tests.** Use `ink-testing-library`. Render with real stores (reset in `beforeEach`). Drive by setting store state or simulating input. Assert on `lastFrame()` text or observable store state. Never mock `ink`, `FilterableList`, or any internal component.

**CLI command tests.** Invoke the real commander handler. Use a real `tmpDir` with scripted `.diptych/` contents (pattern: `src/cli/commands/status.test.ts`; config-migration logic itself is unit-tested in `src/core/config/load/migrate.test.ts`). Treat stdin / stdout / exit code as the boundary. Assert on exit code and output *shape* (non-empty, contains command name) — never exact user-facing wording.

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
const clearSpy = vi.spyOn(abortStore, 'clear');
resetWorkflow();
expect(clearSpy).toHaveBeenCalled();
```
Good:
```ts
abortStore.arm('exit');
resetWorkflow();
expect(abortStore.get().armed).toBe('none');
```
Why: contract is "after reset, abort is cleared", not "reset invoked a named method".

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
- Data factories are TypeScript functions under `testing/helpers/factories/` — one file per domain (`factories/task.ts:makeTask`, `factories/config.ts:makeConfig`, `factories/session.ts:makeSession`, `factories/summary.ts:makeSummary`). On-disk artefacts live in `testing/fixtures/`; the single consumer currently reaches them via a relative path (`src/core/migration/executor.test.ts`).
- Sanctioned `vi.mock` targets (whole repo): `@anthropic-ai/claude-agent-sdk` (optional peer dep), `node:os` (home dir for `stores/ui/persistence`), `node:fs` (disk-full only), `ink` + `fullscreen-ink` (CLI integration tests only — suppresses `waitUntilExit()` / `withFullScreen` so commander handlers run to completion without a TTY; all other exports preserved). Anything else is a bug.

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
- Discriminated-union accessors enforced by `assertNever` — the compiler already enforces exhaustiveness.
- Styling-only components with no conditional logic.
- Library internals (`Array.prototype.filter`, `fzf.find`, Zod `.strict()`).

## Low-value test audit

For the cost-aware implementer pool and Plan Review v2 work, the audit target is narrow:

- Delete or rewrite tests that only prove a wrapper calls another helper, a hook stores React state, a schema accepts a literal already type-checked by TypeScript, or a component "does not crash."
- Keep tests that encode routing policy, context overflow behavior, conflict classification, save/round-trip behavior, visible Plan Review markers, or user-facing CLI wording.
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
| No new fakes — extend `createFakePlanner` / `createFakeImplementer` | this doc §How to extend the fakes | — |
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

## Manual smoke checklist

`npm run test-ci` covers the vast majority of the surface. A handful of flows need a real TTY, a fresh checkout, or an external process and therefore live outside the automated suite. Run the checks below after a fresh install or any change that touches the CLI entry point, the TUI mount, hook dispatch, or the OTel sink.

### M1. TUI smoke (full interactive render)

Ink needs a real TTY; the agent test runner cannot drive it. Manual steps:

```bash
mkdir /tmp/smoke-tui && cd /tmp/smoke-tui
git init && git config user.email x@x.com && git config user.name X
# Seed .diptych/config.yaml with a shell planner + shell implementer
#   (same shape as evals/fixtures/*/.diptych/config.yaml)
npm run dev -- --project /tmp/smoke-tui start "smoke tui test"
```

Verify: the fullscreen Ink TUI renders, phases progress visually, and the workflow completes with a `workflow_complete` banner.

### M2. Headless `--json` mode

From any project with a valid `.diptych/config.yaml`:

```bash
node dist/cli.js start --json --mode quick "smoke feature"
```

Verify: NDJSON on stdout, first line is `readiness_report`, the first model-backed workflow event is `workflow_started`, last workflow event is `workflow_complete`, and the process exits `0`. If `--json` is unrecognized, run `npm run build` — stale `dist/` is the most common cause.

### M3. block-secrets hook

Enable `commitStrategy: per-task` + `hooks.builtin.block-secrets: true` and have the implementer write `AKIAIOSFODNN7EXAMPLE` into the target file:

```bash
node dist/cli.js start --json --mode quick "add secret file"
```

Verify: a `warning` event with `pre_commit blocked ... AWS access key` fires, no `git_commit` event is emitted, HEAD is unchanged, and `task_completed` still advances (non-fatal skip).

### M4. OTel activation

Any of the three paths below should emit `diptych.workflow`, `diptych.phase.*`, and `diptych.task` spans on stdout:

```bash
OTEL_TRACES_EXPORTER=console   node dist/cli.js start --json --mode quick "otel test"
DIPTYCH_OTEL_EXPORTER=console  node dist/cli.js start --json --mode quick "otel test"
node dist/cli.js start --otel-exporter=console --json --mode quick "otel test"
```

See [`OTEL.md` §Design decisions](./OTEL.md) for why the bootstrap has to run before commander parses.

### M5. Fresh checkout + install

```bash
rsync -a --exclude=node_modules --exclude=dist --exclude=.git . /tmp/diptych-fresh/
cd /tmp/diptych-fresh
npm ci && npm run test-ci
```

Verify: install completes, `npm run test-ci` (format:check → typecheck → lint → test → invariants) is green.

## References

- Skill: `test-behavior-not-implementation` — Kent C. Dodds Testing Trophy + TkDodo's testing principles. The spine of these rules.
- Skill: `react-senior-guide` — React 19 patterns, hook contracts, anti-pattern checklist.
- [`STRUCTURE.md`](./STRUCTURE.md) — file tree, test strategy summary, colocation rule, file-length thresholds.
- [`PRINCIPLES.md`](./PRINCIPLES.md) — rule 15: test behavior, not implementation.
- [`LAYERS.md`](./LAYERS.md) — layer boundaries that define what counts as a "boundary" test.
