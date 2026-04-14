# Phase 0 Research — Symmetric Runner Config

All architectural decisions for this feature were resolved during an interactive planning session. There are zero unresolved `NEEDS CLARIFICATION` markers. This document records the decisions, the alternatives considered, and the rationale for each.

## Decision 1 — Overall config shape

**Decision**: Composed-field approach. Keep the current flat YAML shape. Define runner kinds ONCE as shared field building blocks (`CliRunnerFields`, `ApiRunnerFields`, `ShellRunnerFields`, `AgentRunnerFields`, `AgentSdkRunnerFields`). Compose them into role-specific `PlannerConfigSchema` and `ImplementerConfigSchema` via `z.object({ ...fields, ...commonFields })` inside a `z.discriminatedUnion('kind', ...)`.

**Rationale**:
- Minimal YAML change for users (kind renames on implementer side only).
- Zod discriminated unions work naturally — TypeScript narrowing via `kind` is preserved.
- Single source of truth for each kind's field shape: add a field once, both roles get it.
- Easy to test: each composed variant is a plain `z.object` and can be validated independently.
- No runtime dispatch on string → type is enforced at parse time.

**Alternatives considered**:
1. **Named backends + role references** (top-level `backends:` map referenced from `planner:` / `implementer:`). Most DRY when the same backend is reused across roles, and matches a natural user mental model ("I have these backends, plug them into roles"). **Rejected**: biggest YAML change of any option; users must relearn the file shape; introduces a reference-resolution layer in the code; adds indirection without enabling any feature users have asked for.
2. **Backend + params split** (nested `backend` object + flat generation params). Cleanly separates transport from generation. **Rejected**: more nesting than today's flat shape; the separation is already captured internally by per-variant field assignment; no user benefit.
3. **Minimal tightening** (keep 10-variant implementer schema, only fix `tool: z.string()` → `tool: z.enum(...)`). Smallest diff. **Rejected**: doesn't fix illegal states (`{ kind: 'api', tool: 'claude-code' }` still validates because `'claude-code'` is in the old `PROVIDER_IDS` enum), doesn't fix DRY (6 near-duplicate CLI schemas stay), doesn't symmetrize planner/implementer, doesn't eliminate `implementerCrossFieldErrors` post-load check. The whole point of the refactor is to let the types encode the rule — a tighter enum on a shared field is still a shared field fighting the union's intent.

## Decision 2 — Custom provider identifier flexibility

**Decision**: `provider` field on `ApiRunnerFields` is typed as `z.string().min(1)` (not a closed enum). `apiBase` is unconditionally required via `z.string().min(1)`. Known providers get `apiBase` auto-filled during migration and default-config creation through a single `resolveDefaultApiBase(provider)` function. Custom providers must supply `apiBase` explicitly.

**Rationale**:
- Preserves the existing custom-endpoint capability documented in `specs/002-cost-optimized-orchestrator/quickstart.md:166`.
- The constraint "custom provider requires apiBase" becomes trivially expressed by making `apiBase` always required — migration fills known providers, so end users only notice the rule when they supply an unknown provider.
- Removes the need for a post-zod `implementerCrossFieldErrors` check (one of the named cleanup targets).
- Adding a new known provider is a one-liner in `KNOWN_API_BASE_URLS`.

**Alternatives considered**:
1. **Closed enum for providers only** (`z.enum(['anthropic', 'openrouter', 'deepseek', 'ollama', 'lm-studio'])`). Strictest types. **Rejected**: breaks custom self-hosted endpoints.
2. **Split into `api-known` and `api-custom` variants**. Most type-pure. **Rejected**: adds a 6th discriminator value, forces migration to infer which variant to pick, and the picker UI has to handle two API cases instead of one.

## Decision 3 — Generation parameters (contextLength / temperature / timeout) scope

**Decision**: Move generation parameters to a shared `GenerationCommonFields` block that both planner and implementer variants spread into their schemas. All three fields stay optional on both roles.

**Rationale**:
- Enables the symmetry user story (#2 in spec.md): a user can tune a planner's temperature or context length if they want. Today, putting `temperature` under `planner:` is rejected because the planner schema doesn't allow it.
- Keeps types truly symmetric — "the same block of config works under either role" becomes structurally true.
- Optional on both means CLI planners (which manage their own context/temperature) can omit the fields harmlessly.

**Alternatives considered**:
1. **Implementer-only fields** (current behavior). Simpler but leaves the asymmetry the user explicitly rejected.
2. **Required on implementer, optional on planner** (two different common-field blocks). Most faithful to reality but duplicates the field list.

## Decision 4 — Agent planner implementation

**Decision**: Implement `createAgentPlanner` at `src/engine/planners/agent.ts`. It runs a user-specified command (via the shared `invokeCommandBasedRunner` primitive) with a prompt that instructs the command to write `spec.md`, `plan.md`, and `tasks.md` to the project directory. After the command completes, it reads the files from disk and synthesizes a `PlanResult` with populated `phases[]`. Methods that don't map naturally to a file-writing agent (e.g., `regenerate`, `review`, `escalateHint`, `escalateFull`) fall back to prompting the command with a different instruction and reading the output.

**Rationale**:
- Required by Decision 5 (5-kind symmetry). Without this, the planner side would have only 4 kinds and the claim "same 5 runner kinds" would be a lie.
- User explicitly called this out: "diptych will be writing with the planner files of the spec. We should make it DRY and mostly reusable." The file-writing pattern IS how diptych planners already behave (they produce spec.md/plan.md/tasks.md) — adding an agent kind just gives users a way to substitute their own command.
- DRY requirement satisfied by the shared `invokeCommandBasedRunner` primitive consumed by shell-planner, agent-planner, shell-implementer, and agent-implementer.

**Alternatives considered**:
1. **Drop agent from planner** (4 planner kinds, 5 implementer kinds). Honest about current capability. **Rejected**: user wants full symmetry; the asymmetry would propagate into the types and the picker, contradicting FR-006 and FR-009.
2. **Drop agent from implementer too, adding `extractsCode` flag to shell**. Simplest total surface. **Rejected**: shell vs agent use different spawn utilities and have opposite `extractsCode` semantics verified by direct read of `engine/implementers/shell.ts` and `agent.ts`. Merging would lose the distinction.

## Decision 5 — Umbrella naming: `Runner`

**Decision**: Rename the umbrella concept from `Backend` to `Runner` throughout the codebase. Type names, helper functions, file names, and directory names all use `Runner`. The only exception is the optional peer dep `@anthropic-ai/claude-agent-sdk` which is not renamed.

**Rationale**:
- User explicitly rejected "backend" as the name ("it's really wrong naming imo"). The word is generic and doesn't describe what the thing does.
- `Runner` is descriptive ("the thing that runs an AI call"), casual, reads naturally in sentences ("the planner runner", "each runner has a kind"), and doesn't collide with anything in the current codebase.
- Existing `src/engine/` directory name is preserved (it refers to diptych's core workflow engine, which is a different level of abstraction than the Runner concept).

**Alternatives considered**: `Driver`, `Adapter`, or no umbrella term at all. `Driver` is more formal but has hardware connotations. `Adapter` matches the GoF pattern name but implies wrapping an external interface (only literally true for some variants). "No umbrella term" (just `CliFields`, `ApiFields`, etc.) was considered minimal but loses the ability to talk about "a runner" as a concept.

## Decision 6 — Config version field

**Decision**: Add `version: z.literal(2)` to the root `ConfigSchema`. Configs without a `version` field are treated as v1 and migrated on load via `migrateV1ToV2`. The migration runs lazily inside `loadConfig()`; users see no prompt and take no action.

**Rationale**:
- diptych is pre-deployment (user confirmed), so we can break cleanly. A version marker makes future migrations unambiguous.
- Lazy in-place migration: after a successful load, the next save operation writes the v2 shape to disk. Subsequent loads short-circuit the migration path.
- No separate migration command or user prompt needed.

**Alternatives considered**:
1. **Shape-detection migrations without a version field** (infer from field names). Works for this refactor but future migrations will be murkier — two schema changes in the same shape could be ambiguous.
2. **One-shot explicit migration command**. User must run it manually. **Rejected**: creates friction for a refactor that doesn't benefit from it.

## Decision 7 — Factory file: static imports, sync dispatch

**Decision**: The new `src/engine/runners/factory.ts` uses static imports at the top of the file for all factory functions (`createCliPlanner`, `createApiPlanner`, ..., `createCliImplementer`, `createApiImplementer`, ...). Registries are defined at module scope as `Record<RunnerKind, (config: Config) => Planner | Implementer>`. The generic dispatcher `dispatchRunner<T, A>` lives in `src/utils/runner-dispatch.ts` and is fully generic (no domain imports).

**Rationale**:
- The current codebase mixes dynamic `await import()` for factory modules and static imports for everything else. Reading `src/engine/planners/factory.ts:8-31` shows the dynamic imports are lazy-loading for no real benefit — nothing reaches into the optional peer dep at that layer.
- Verified by reading `src/engine/agent-sdk.ts:37-46:loadSdk()`: the optional `@anthropic-ai/claude-agent-sdk` peer dep is already isolated inside its own dynamic import one layer deeper. Factory modules above it can be statically imported safely.
- Consistency: all factory modules are imported the same way. No cognitive overhead figuring out "why is this one dynamic?".
- Slight startup performance win: modules load once at startup instead of on first dispatch.

**Alternatives considered**:
1. **All dynamic imports** (current). Consistent but pointlessly lazy.
2. **Mixed** (eager for most, dynamic for agent-sdk). Reflects reality but inconsistent. **Rejected**: the agent-sdk dynamic import is already one layer deeper in `loadSdk()` — the factory layer doesn't need to know about it.

## Decision 8 — Shared `createCommandBasedRunner` / `invokeCommandBasedRunner` primitive

**Decision**: Extract a single primitive at `src/engine/runners/command-based.ts` that handles spawn/stdin/placeholder substitution, `spawnAndCollect` vs `spawnWithShellFallback`, output-format parsing, and the `detectChanges` hook. Both `shell.ts` and `agent.ts` on both planner and implementer sides become thin wrappers over this primitive.

**Rationale**:
- DRY across 4 call sites (2 roles × 2 variants).
- Captures the real behavioral axis: `extractsCode: boolean` (shell) vs `extractsCode: false + detectChanges` (agent). This matches what `ImplementerBase` at `src/engine/implementers/base.ts:68-86` already does internally; the primitive just lifts it one level.
- Satisfies user's explicit "DRY and mostly reusable" requirement for the agent kind.

**Alternatives considered**:
1. **Keep spawn logic per-variant** (current). 30 lines × 4 files = 120 lines of near-duplicate code. **Rejected**: exactly the DRY violation the user called out.

## Decision 9 — `implementerCrossFieldErrors` deletion

**Decision**: Delete the entire function at `src/core/config/validation.ts:48-63` and its call site at line 135. Every constraint it enforces (`shell kind requires command`, `api kind requires apiBase for unknown providers`) is now enforced by the zod schema directly.

**Rationale**:
- After the schema swap, `apiBase` is unconditionally required on `ApiRunnerFields`, and `command` is unconditionally required on `ShellRunnerFields` / `AgentRunnerFields`. The cross-field check becomes redundant.
- Post-zod runtime checks are a smell: they imply the schema doesn't fully express the intent.
- Test assertions that previously surfaced as "implementer cross-field error" now surface as zod validation errors at the same field path with a similar (not identical) message. Tests are updated accordingly.

## Decision 10 — `config-transforms.ts` cleanup

**Decision**: Delete `toImplementerKind` (the silent 'api' fallback), delete `implementerApiPatch` (the manual catalog lookup), and rewrite `commitImplementerSelection` / `commitPlannerSelection` / `commitCustomCommand` / `commitCustomModel` to delegate to a single `buildRunnerConfig(role, opts)` shared constructor in `src/core/config/build-runner.ts`.

**Rationale**:
- Eliminates all three smell functions identified in the audit.
- The picker UI becomes a thin layer: take a selection, pass it to `buildRunnerConfig`, save the result. No config-shape reasoning inside UI code.
- `buildRunnerConfig` is also used by `stores/config.ts:applyPlannerOverrides` and `applyImplementerOverrides`, making CLI overrides and picker commits go through identical logic (fixes the asymmetric-validation hole in the current `stores/config.ts:72-80`).

## Decision 11 — `PROVIDER_IDS` enum cleanup

**Decision**: Delete `PROVIDER_IDS`, `PLANNER_TOOL_IDS`, `PLANNER_KINDS`, `IMPLEMENTER_KINDS`, `API_PLANNER_PROVIDER_IDS`. Add `RUNNER_KINDS`, `CliToolIdSchema`, `CLOUD_API_PROVIDERS`, `LOCAL_API_PROVIDERS`, `KNOWN_API_PROVIDERS`.

**Rationale**:
- `PROVIDER_IDS` conflated CLI tool names (`claude-code`, `aider`) with API vendor names (`anthropic`, `ollama`) in a single enum — different semantic concepts that happened to both be "strings the user can pick".
- After the refactor, the picker builds its flat "things you can pick" list from `CLI_TOOL_IDS + KNOWN_API_PROVIDERS + ['shell', 'agent', 'agent-sdk']`, which is explicit and unambiguous.
- `RUNNER_KINDS = ['cli', 'api', 'shell', 'agent', 'agent-sdk']` becomes the single authoritative list of discriminants, used by both roles.

## Decision 12 — File split of `schemas/config.ts`

**Decision**: Split the current 285-line `src/core/types/schemas/config.ts` into 4 files:
1. `schemas/runner-fields.ts` — shared field blocks
2. `schemas/planner-config.ts` — `PlannerConfigSchema` composed from runner fields
3. `schemas/implementer-config.ts` — `ImplementerConfigSchema` composed from runner fields + per-variant narrowing types
4. `schemas/config.ts` — minimal root `ConfigSchema` with `version: 2`

**Rationale**:
- SRP: each file has one responsibility (fields, planner, implementer, root).
- Easier to review PRs touching one role without scanning the whole file.
- Contributor onboarding is faster: "planner config" and "implementer config" are findable by filename.
- Total LOC across the 4 files drops below the current 285 because the 6 duplicate CLI schemas collapse to 1.

## Out-of-scope items (explicitly deferred)

- **`Planner` interface simplification** (currently 6 methods vs `Implementer`'s 2). A future refactor could unify these, but it's a separate PR and would require rewriting every planner backend. Out of scope for 024.
- **`tokenUsage` duplication** between `WorkflowState` (persisted) and `WorkflowViewState` (UI store). Minor; UI stays coherent because resume reloads from the persisted state. Out of scope for 024.
- **`TuiEvent` shape changes**. Audit confirmed the union is already clean. No changes needed.
- **Changes to `ImplementerBase` / `createImplementerBase`**. The base stays; only the shell and agent wrappers that sit below it change.

## Dependencies & references

- The approved architectural plan document at `/Users/voitz/.claude/plans/tranquil-mapping-fog.md` contains the complete file change list and code snippets.
- Direct file reads performed during planning:
  - `src/core/types/schemas/config.ts` — verified the ImplementerSharedFields.tool: z.string() issue at line 49 and the `.default('api')` at line 59
  - `src/core/types/schemas/enums.ts` — verified the PROVIDER_IDS conflation at lines 14-28
  - `src/components/overlays/tool-model-picker/config-transforms.ts` — verified the three smell functions at lines 7-9, 19-27, 40-52
  - `src/engine/implementers/shell.ts` + `src/engine/implementers/agent.ts` — verified the `extractsCode` true/false distinction justifies keeping both kinds
  - `src/engine/planners/factory.ts` — verified the dynamic-import pattern is lazy-loading without real benefit
  - `src/engine/agent-sdk.ts` — verified the optional peer dep is isolated in `loadSdk()` at lines 37-46
  - `src/core/config/planner-config.ts` — verified the existing `getPlannerToolName` helper structure; also caught the latent bug at line 26 (api-config produced without `apiBase`)
  - `src/engine/implementers/base.ts` — verified the `extractsCode` + `detectChanges` runtime dispatch at lines 68-86
  - `src/stores/config.ts` — verified the asymmetric validation hole between `applyPlannerOverrides` and the implementer path
