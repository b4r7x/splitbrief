# 001 — Capability Matrix — Plan

## Data model

### New type: `PlannerCapabilities`

File: `src/engine/planners/types.ts`

```ts
export type PlannerCapabilities = {
  /** Planner can emit inline clarification questions during planning. */
  supportsConversationalPlanning: boolean;
  /** Planner can produce a short hint before escalating to full fix. */
  supportsHintEscalation: boolean;
  /** Backend exposes a session handle that can be reused on resume (e.g. Claude Code --session-id). */
  supportsSessionResume: boolean;
  /** A queued user message can be injected into the live session in parallel with the current turn. */
  supportsMidStreamInjection: boolean;
};
```

All fields required — no optional booleans.

### Updated interface: `Planner`

File: `src/engine/planners/types.ts`

Before (today, lines 39-82):

```ts
export interface Planner extends RunnerRuntime {
  plan(...): Promise<PlanResult>;
  regenerate(...): Promise<RegenerateResult>;
  escalateHint(...): Promise<EscalationResult>;
  escalateFull(...): Promise<EscalationResult>;
  quickPlan(...): Promise<PlanResult>;
  review(...): Promise<{ text: string; usage: TokenDelta | null }>;
  readonly supportsConversationalPlanning?: boolean | undefined;  // ← remove
}
```

After:

```ts
export interface Planner extends RunnerRuntime {
  plan(...): Promise<PlanResult>;
  regenerate(...): Promise<RegenerateResult>;
  escalateHint(...): Promise<EscalationResult>;
  escalateFull(...): Promise<EscalationResult>;
  quickPlan(...): Promise<PlanResult>;
  review(...): Promise<{ text: string; usage: TokenDelta | null }>;
  readonly capabilities: PlannerCapabilities;  // ← new, required
}
```

### Updated `createPlannerBase` config

File: `src/engine/planners/base.ts`

Before (lines 29-35):

```ts
export type PlannerBaseConfig = {
  invokePlan: (...) => ...;
  invokeEscalate: (...) => ...;
  supportsConversationalPlanning?: boolean;
  supportsHintEscalation?: boolean;
  escalateFullPostProcess?: (...) => EscalationResult;
};
```

After:

```ts
export type PlannerBaseConfig = {
  invokePlan: (...) => ...;
  invokeEscalate: (...) => ...;
  capabilities: PlannerCapabilities;
  escalateFullPostProcess?: (...) => EscalationResult;
};
```

`createPlannerBase` now reads `config.capabilities.supportsHintEscalation` to decide the early-return in `escalateHint` (lines 121-125 today). It also copies `config.capabilities` onto the returned `Planner` object (line 169 today now becomes a direct assignment of the capabilities struct instead of conditional flag projection).

### Config schema changes

Files: `src/core/types/schemas/runner-fields.ts`, `planner-config.ts`, `implementer-config.ts`

Add a Zod schema for `PlannerCapabilities`:

```ts
export const PlannerCapabilitiesSchema = z.object({
  supportsConversationalPlanning: z.boolean(),
  supportsHintEscalation: z.boolean(),
  supportsSessionResume: z.boolean(),
  supportsMidStreamInjection: z.boolean(),
}).strict();
```

Extend `ShellRunnerFields` and `AgentRunnerFields`:

```ts
export const ShellRunnerFields = z.object({
  // ...existing fields...
  capabilities: PlannerCapabilitiesSchema.partial().optional(),
});
```

`.partial().optional()` means: the whole `capabilities` block is optional, and each field inside it is independently optional (user declares only what they want to override; the rest stay at defaults).

`CliRunnerFields`, `ApiRunnerFields`, `AgentSdkRunnerFields` do **not** gain this field. Attempting to include `capabilities` in a `cli`/`api`/`agent-sdk` config triggers a Zod error because those schemas are `.strict()` and `.passthrough()` is not set.

### Capability resolution per planner

Each backend file exports a function that returns a `Planner`. Inside that function, a hardcoded `defaultCapabilities: PlannerCapabilities` is declared. For shell/agent kinds, it is merged with the user's config override:

```ts
// src/engine/planners/shell.ts (new pattern)
export function createShellPlanner(config: ShellRunnerFields): Planner {
  const defaultCapabilities: PlannerCapabilities = {
    supportsConversationalPlanning: false,
    supportsHintEscalation: false,
    supportsSessionResume: false,
    supportsMidStreamInjection: false,
  };
  const capabilities: PlannerCapabilities = {
    ...defaultCapabilities,
    ...(config.capabilities ?? {}),
  };
  return createPlannerBase({ /* ... */, capabilities });
}
```

`claude-code.ts`, `api.ts`, etc. declare the hardcoded struct directly with no merge step.

## How the orchestrator reads capabilities

The `WorkflowContext` type (`src/engine/orchestrator/run.ts:26-35`) already holds a `Planner` instance. Nothing new needs to go into the context — capabilities are a field on the planner and can be read anywhere the planner is visible:

```ts
// Current:
if (planner.supportsConversationalPlanning) { … }

// New:
if (planner.capabilities.supportsConversationalPlanning) { … }
```

Every read site gets mechanically updated. No conditional identity checks like `tool === 'claude-code'` remain in orchestrator code (there are none today in the planner capability paths, but we enforce this by lint rule / grep during review).

## Migration of existing flags

- `supportsConversationalPlanning` currently only read in `src/engine/orchestrator/planning.ts` and/or `clarifications.ts` (verify during T019-T021).
- `supportsHintEscalation` only read in `src/engine/planners/base.ts:121` for the early-return.

After this spec, both reads change to go through `planner.capabilities.*`.

No runtime behaviour change for users — this is a refactor.

## Dependencies

**Depends on:** nothing. This is foundational.

**Consumed by:**

- `004-persist-planner-session-id` reads `planner.capabilities.supportsSessionResume`.
- `007-queue-mid-phase` reads `planner.capabilities.supportsMidStreamInjection`.

Those specs assume this one is merged.

## Risk and open questions

- **Are codex/aider/opencode/copilot/kilo-code values in FR-003 correct?** Some of these probably *do* support conversational planning or mid-stream injection in their own way — the table above is a starting point, not gospel. Research per backend during T003-T008 and update the spec if a declared capability turns out wrong.
- **Does `base.ts` line 169 projection** (`...(config.supportsConversationalPlanning && { supportsConversationalPlanning: true as const })`) still need to exist? No — it was there to avoid setting the property when false. The new pattern sets `capabilities` unconditionally as a full object. Simpler.
- **What about implementers?** This spec scopes to planner capabilities only. Implementers have a similar pattern (they don't today expose capability flags) and could gain a `ImplementerCapabilities` struct later — tracked as a follow-up, not this spec.

## Success verification

Before marking spec done:

1. `npm run typecheck` passes.
2. `npm test` passes (57+ test files, 700+ tests).
3. `grep -rn "supportsConversationalPlanning\\b" src/` shows only: `types.ts` (definition), per-backend files (declaration inside `capabilities`), orchestrator (read site via `.capabilities.`). No bare flag on `Planner` interface.
4. Config validation: attempting `{ kind: 'cli', tool: 'claude-code', capabilities: {...} }` in YAML fails with Zod error mentioning `capabilities` not allowed on cli kind.
5. Docs task (T024-T025) completed and committed.
