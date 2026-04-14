# 001 — Capability Matrix

## Problem

Today, backend feature flags (`supportsConversationalPlanning`, `supportsHintEscalation`) live as optional fields scattered between `Planner` interface (`src/engine/planners/types.ts:81`) and the shared `createPlannerBase` config (`src/engine/planners/base.ts:31-33`). Only Claude Code explicitly declares them. All other backends get implicit defaults (undefined → falsy) which means the orchestrator cannot reliably branch on capability without defensive `?? false` checks.

As we introduce two new capabilities — `supportsSessionResume` (for 004) and `supportsMidStreamInjection` (for 007) — this scattering becomes worse. We need a single, explicit capability struct on every backend.

Additionally, users running `shell` or `agent` kind with custom commands (e.g. `claude-zai`, which is a Claude wrapper supporting session chaining) cannot currently declare what their command supports. The orchestrator treats every shell backend as "supports nothing", stranding real capability behind an impossible-to-configure default.

## Goal

Introduce a `PlannerCapabilities` struct as the single source of truth for what a given backend can do. Each built-in backend declares its capabilities inline. `shell` and `agent` kinds can have their default (all-false) overridden via config. The orchestrator branches on capability flags, never on backend identity.

## User stories

- **As a backend author**, I declare capabilities in one struct when I implement a new planner, so the orchestrator knows what features to enable without my having to update ad-hoc flag checks.
- **As an orchestrator developer**, I write `if (planner.capabilities.supportsX)` and trust that every backend — built-in or user-provided — gave a truthful answer.
- **As a user of `shell` kind with a custom Claude wrapper**, I set `capabilities.supportsSessionResume: true` in my `.diptych/config.yml` and get native resume behaviour without writing a new planner backend.

## Functional requirements

**FR-001.** `src/engine/planners/types.ts` defines `PlannerCapabilities` as a plain object type with exactly four boolean fields: `supportsConversationalPlanning`, `supportsHintEscalation`, `supportsSessionResume`, `supportsMidStreamInjection`. All fields are required (not optional) — the backend must answer yes or no.

**FR-002.** The `Planner` interface has a readonly `capabilities: PlannerCapabilities` field. The previous optional flags `supportsConversationalPlanning?: boolean | undefined` and the equivalent on `createPlannerBase` config are removed.

**FR-003.** Every built-in planner backend declares its capabilities struct inline (hardcoded, not configurable). Initial values, to be confirmed per-backend during implementation:

| Backend | conv. planning | hint escalation | session resume | mid-stream inject |
|---------|:---:|:---:|:---:|:---:|
| `cli` claude-code | true | false | true | true |
| `cli` codex | false | true | false | false |
| `cli` opencode | false | true | false | false |
| `cli` aider | false | true | false | false |
| `cli` copilot | false | true | false | false |
| `cli` kilo-code | false | true | false | false |
| `api` (any OAI-compat) | false | true | false | false |
| `agent-sdk` | true | false | true | true |
| `shell` (default) | false | false | false | false |
| `agent` (default) | false | false | false | false |

**FR-004.** `shell` and `agent` planner config schemas accept an optional `capabilities` object. When present, its fields override the backend defaults. Example:

```yaml
planner:
  kind: shell
  command: claude-zai
  args: ["-p", "--output-format", "stream-json"]
  outputFormat: stream-json
  capabilities:
    supportsConversationalPlanning: true
    supportsSessionResume: true
    supportsMidStreamInjection: true
```

**FR-005.** Config override is rejected (Zod validation error) for `cli`, `api`, and `agent-sdk` kinds. Those backends have hardcoded capabilities and allowing override would create footgun risk (user claims a capability the underlying tool doesn't actually have).

**FR-006.** The orchestrator (`src/engine/orchestrator/**`) branches on `planner.capabilities.*` everywhere it today branches on backend identity or the old flags. No `if (plannerTool === 'claude-code')` style checks remain.

**FR-007.** When `capabilities` is read in a hot path (per-phase decisions), it is memoised on `WorkflowContext` at run start. Capabilities never change mid-run.

**FR-008.** Unit tests assert the capability matrix: one test per backend confirming its declared values match the table in FR-003; one test confirming shell/agent config override merges correctly; one test confirming config override on cli/api/agent-sdk kinds is rejected by the schema.

## Success criteria

- `grep -r "supportsConversationalPlanning" src/` returns hits only in `types.ts` (definition), per-backend files (declaration), and orchestrator (usage). No loose optional flags on `Planner` or config shapes.
- `grep -r "=== 'claude-code'" src/engine/orchestrator/` returns zero matches (no backend-identity branching in orchestrator).
- A user can configure `shell` kind with `capabilities: { supportsSessionResume: true }` and the capability is honoured by the orchestrator.
- All existing tests pass. New capability tests added and passing.
- `docs/CONCEPTS.md` §"Capability matrix" and `docs/ARCHITECTURE.md` "Capability matrix" table are updated to reflect the implemented state (including config-override note for shell/agent).

## Non-goals

- Adding new capability flags beyond the four listed. Later specs (004, 007) *use* two of these flags but do not add more.
- Changing the behavior gated by `supportsConversationalPlanning` or `supportsHintEscalation` — this spec is purely a refactor of how those flags are declared and read.
- Capability override on cli/api/agent-sdk kinds — explicitly rejected (FR-005).
- Auto-detecting capabilities by probing the backend command at startup — out of scope.
- Versioning the capability struct. If we add a flag later, we add it; migration story is "backend authors update, config override users add the new key if they want it".

## Out of scope for this spec, deferred

- Any use of `supportsSessionResume` (covered by spec 004)
- Any use of `supportsMidStreamInjection` (covered by spec 007)
- Runtime feature-flag UI for toggling capabilities per-session
