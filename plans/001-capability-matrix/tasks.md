# 001 — Capability Matrix — Tasks

Atomic tasks in execution order. Each task is independently completable by an agent with no prior context from the design session.

**Conventions:**

- Tasks `T001`–`T025` are numbered contiguously.
- Phases are advisory grouping; tasks inside a phase may run in any order unless noted.
- Each task names the file(s) it touches, the exact change, and the verification step.
- When a task says "update tests", tests live colocated next to implementation (`*.test.ts` / `*.test.tsx`).
- Do **not** commit or stage anything. The user reviews and commits manually. A hook at `.claude/hooks/block-git-commits.sh` blocks `git add`/`git commit`.

---

## Phase 1 — Type foundation

### T001 — Define `PlannerCapabilities` type

**File:** `src/engine/planners/types.ts`

Add this type above the `Planner` interface:

```ts
export type PlannerCapabilities = {
  supportsConversationalPlanning: boolean;
  supportsHintEscalation: boolean;
  supportsSessionResume: boolean;
  supportsMidStreamInjection: boolean;
};
```

All four fields are required. No optional, no undefined.

**Verify:** `npm run typecheck` passes.

### T002 — Replace `supportsConversationalPlanning` flag on `Planner` interface

**File:** `src/engine/planners/types.ts`

The `Planner` interface today has (line 81):

```ts
readonly supportsConversationalPlanning?: boolean | undefined;
```

Replace with:

```ts
readonly capabilities: PlannerCapabilities;
```

Remove the old optional flag.

**Verify:** `npm run typecheck` fails with errors in every planner factory (expected — will be fixed by T003-T012). Confirm the errors all point to "missing property `capabilities`" on objects returned from `createXxxPlanner`.

---

## Phase 2 — Per-backend capability declarations

Each task declares the capabilities for one backend. Values taken from `plans/001-capability-matrix/spec.md` FR-003 table. Tasks are independent — can run in any order.

### T003 — Declare capabilities in Claude Code planner

**File:** `src/engine/planners/claude-code.ts`

Remove (lines 32-33):

```ts
supportsConversationalPlanning: true,
supportsHintEscalation: false,
```

Pass a `capabilities` field to `createPlannerBase` instead:

```ts
capabilities: {
  supportsConversationalPlanning: true,
  supportsHintEscalation: false,
  supportsSessionResume: true,
  supportsMidStreamInjection: true,
},
```

**Verify:** file typechecks; `npm test src/engine/planners/claude-code.test.ts` passes (or add a test if none).

### T004 — Declare capabilities in Codex planner

**File:** `src/engine/planners/cli.ts` (or wherever Codex is wired — confirm by reading `src/engine/runners/factory.ts`).

Before hardcoding values, read the existing Codex-specific code to confirm whether `hintEscalation` is currently supported. Today's default `supportsHintEscalation` is `true` (base.ts accepts it unless explicitly false), which implies hint escalation is enabled for all CLI tools that don't explicitly opt out.

Declare:

```ts
capabilities: {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsMidStreamInjection: false,
},
```

If research during this task uncovers that Codex CLI *does* natively support session resume (e.g. a `--continue` flag), update `supportsSessionResume: true` and note the discovery in a comment. The spec is a starting point, not a fence.

**Verify:** typecheck + relevant tests pass.

### T005 — Declare capabilities in OpenCode planner backend

Same pattern as T004. File TBD by grep; default values per FR-003 table.

### T006 — Declare capabilities in Aider planner backend

Same pattern. Aider is text-output (no JSON stream), so `supportsConversationalPlanning: false` (no `<!-- Q:{...} -->` marker channel).

### T007 — Declare capabilities in Copilot planner backend

Same pattern.

### T008 — Declare capabilities in Kilo Code planner backend

Same pattern.

### T009 — Declare capabilities in API planner

**File:** `src/engine/planners/api.ts`

```ts
capabilities: {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
  supportsSessionResume: false,
  supportsMidStreamInjection: false,
},
```

API is stateless (no native session), but hint escalation works (same pattern as base planner).

### T010 — Declare capabilities in agent-sdk planner

**File:** `src/engine/planners/agent-sdk.ts`

```ts
capabilities: {
  supportsConversationalPlanning: true,
  supportsHintEscalation: false,
  supportsSessionResume: true,
  supportsMidStreamInjection: true,
},
```

Agent SDK is programmatic Claude Code; same capabilities as `cli` claude-code.

### T011 — Declare capabilities in shell planner (default-false + config merge)

**File:** `src/engine/planners/shell.ts`

Declare default capabilities (all false) inside the factory function. Merge the user's `config.capabilities` (if provided, guaranteed to be a `Partial<PlannerCapabilities>` by Zod — see T013) over the defaults:

```ts
const DEFAULT_CAPABILITIES: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: false,
  supportsSessionResume: false,
  supportsMidStreamInjection: false,
};

const capabilities: PlannerCapabilities = {
  ...DEFAULT_CAPABILITIES,
  ...(config.capabilities ?? {}),
};
```

Pass `capabilities` to `createPlannerBase`.

**Verify:** typecheck. Add unit test that a `capabilities: { supportsSessionResume: true }` in config produces a planner whose `capabilities.supportsSessionResume` is `true` and whose other fields remain `false`.

### T012 — Declare capabilities in agent planner (default-false + config merge)

**File:** `src/engine/planners/agent.ts`

Same pattern as T011 but for agent kind.

---

## Phase 3 — Config schema for shell/agent override

### T013 — Add `PlannerCapabilitiesSchema` Zod type

**File:** `src/core/types/schemas/runner-fields.ts` (or a new schemas file if this one is planner-specific — confirm by reading neighbouring files).

```ts
import { z } from 'zod';

export const PlannerCapabilitiesSchema = z.object({
  supportsConversationalPlanning: z.boolean(),
  supportsHintEscalation: z.boolean(),
  supportsSessionResume: z.boolean(),
  supportsMidStreamInjection: z.boolean(),
}).strict();
```

Export from `src/core/types/schemas/index.ts` so other modules can import it.

### T014 — Extend `ShellRunnerFields` schema with optional `capabilities`

**File:** `src/core/types/schemas/runner-fields.ts`

Add to the `ShellRunnerFields` object schema:

```ts
capabilities: PlannerCapabilitiesSchema.partial().optional(),
```

Each field inside `capabilities` is independently optional; the whole block is optional too.

### T015 — Extend `AgentRunnerFields` schema with optional `capabilities`

Same as T014 but for `AgentRunnerFields`.

### T016 — Verify `CliRunnerFields`, `ApiRunnerFields`, `AgentSdkRunnerFields` reject `capabilities`

**File:** `src/core/types/schemas/runner-fields.ts`

Ensure these three schemas are `.strict()` (Zod's default for `z.object()` is non-strict unless explicitly set — verify and add `.strict()` if missing). This causes a Zod error if the user includes `capabilities` in a cli/api/agent-sdk config.

Add a test asserting the rejection:

```ts
it('rejects capabilities on cli kind', () => {
  const result = PlannerConfigSchema.safeParse({
    kind: 'cli',
    tool: 'claude-code',
    capabilities: { supportsSessionResume: true },
  });
  expect(result.success).toBe(false);
});
```

---

## Phase 4 — Orchestrator wiring

### T017 — Remove `supportsConversationalPlanning` from `createPlannerBase` config

**File:** `src/engine/planners/base.ts`

Today (line 31): `supportsConversationalPlanning?: boolean;` on `PlannerBaseConfig`. Remove.

Replace with `capabilities: PlannerCapabilities;` (required).

Update the return object (line 169, currently projects the flag conditionally): return `capabilities` directly as part of the planner object — no conditional spread.

### T018 — Remove `supportsHintEscalation` from `createPlannerBase` config

**File:** `src/engine/planners/base.ts`

Today (line 33): `supportsHintEscalation?: boolean;`. Remove.

The early-return in `escalateHint` (line 121-125) now reads `config.capabilities.supportsHintEscalation === false` instead. Update.

### T019 — Route clarifications on capability

**File:** `src/engine/orchestrator/planning.ts` (and/or `clarifications.ts`)

Find every `planner.supportsConversationalPlanning` read. Replace with `planner.capabilities.supportsConversationalPlanning`. Grep confirms completeness.

### T020 — Route escalation-hint on capability

**File:** `src/engine/orchestrator/escalation.ts`

Find every use of the old hint flag. Replace with `planner.capabilities.supportsHintEscalation`.

### T021 — Grep sweep for residual old flag reads

Run:

```
grep -rn "supportsConversationalPlanning\\b\\|supportsHintEscalation\\b" src/ \\
  | grep -v "\\.capabilities\\." \\
  | grep -v types\\.ts \\
  | grep -v schemas/
```

Any match that is *not* a definition (types.ts, schemas/) and *not* a read via `.capabilities.` is a bug — fix in place.

---

## Phase 5 — Tests

### T022 — Add per-backend capability table tests

**File:** `src/engine/planners/capabilities.test.ts` (new)

For each backend factory, construct a minimal planner and assert its `capabilities` struct matches the expected row from the FR-003 table. 10 assertions (one per built-in backend + shell default + agent default).

### T023 — Add config override tests for shell/agent

**File:** same as T022

Construct a shell planner with `{ capabilities: { supportsSessionResume: true } }`. Assert merged result has `supportsSessionResume: true` and all other fields `false`. Repeat for agent.

### T024 — Run the test suite

Run `npm test`. Expect all 700+ tests to pass, including the new capability tests. If any unrelated test breaks, investigate — this spec is a refactor and should not change behaviour.

---

## Phase 6 — Doc Sync

### T025 — Update `docs/CONCEPTS.md` §"Capability matrix"

**File:** `docs/CONCEPTS.md`

The section today describes four fields. Confirm the description matches the implemented struct. Add a note that `shell` and `agent` kinds accept an optional `capabilities` config field to override defaults, with a short YAML example (reuse the `claude-zai` example from `plans/001-capability-matrix/spec.md`). Link to `src/engine/planners/types.ts` for the canonical definition.

### T026 — Update `docs/ARCHITECTURE.md` §"Capability matrix"

**File:** `docs/ARCHITECTURE.md`

Today's table shows per-backend capability values as prose rather than something tied to code. Update the table with the actual declared values from T003-T012 (they should match FR-003 but were possibly revised during research). Add a column or footnote explaining the config-override behaviour for shell/agent kinds. Reference the new `PlannerCapabilitiesSchema` Zod type in `src/core/types/schemas/runner-fields.ts`.

### T027 — Run docs through a final consistency pass

Read the two updated docs end-to-end. Check that:

- Every claim about capability behaviour matches the implemented code.
- No leftover mentions of the old `supportsConversationalPlanning` loose flag.
- The shell YAML example compiles against the Zod schema (sanity-check manually).

---

## Task summary

Phases 1-6, 27 atomic tasks total. Estimated order of completion:

1. T001-T002 (types) — blocking, do first
2. T013-T016 (schemas) — can run in parallel with Phase 2 but keep sequence
3. T003-T012 (per-backend, 10 tasks) — parallelizable among themselves
4. T017-T018 (base.ts cleanup) — after Phase 2
5. T019-T021 (orchestrator wiring) — after T017-T018
6. T022-T024 (tests) — after wiring
7. T025-T027 (docs) — last, after everything implemented and tests green
