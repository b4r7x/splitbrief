# Implementation Plan: Run Readiness / Doctor

## Likely Source Touch Areas

CLI:

- `src/cli.ts` for registering a new `doctor` command.
- New `src/cli/commands/doctor.ts` and `src/cli/commands/doctor.test.ts`.
- `src/cli/commands/start.ts` to place readiness before planner/implementer calls. Prefer computing before `beginSession()` where feasible, but allow a minimal `start` session first when needed to persist the compact readiness record.
- `src/cli/setup.ts` for shared project/config/git preconditions; any doctor-specific helper here must be read-only and must not call `initConfig()` or `maybeMigrate()`.
- `src/cli/options.ts` if `doctor` should reuse `--project` or `--json` option helpers.
- `src/cli/headless.ts` and `src/cli/headless.test.ts` for structured readiness emission in JSON mode.

Config/runtime:

- `src/core/config/load/load.ts` for existing config load behavior only if a reusable read-only helper is missing. Do not use `initConfig()` or `writeConfig()` from `doctor`.
- `src/core/config/load/migrate.ts` for in-memory config migration posture only.
- `src/core/config/load/validate.ts` for config schema and API-key posture.
- `src/core/config/runtime/resolve.ts` for effective mode/approval/effort resolution.
- `src/core/config/runtime/overrides.ts` for applying CLI overrides consistently.
- `src/core/config/accessors/implementer-profiles.ts` for implementer profile posture.

Engine/core:

- New `src/core/readiness/types.ts` for report, section, check, severity, status, next-action, and compact start record types.
- New `src/core/readiness/status.ts` for aggregate status and next-action priority.
- New `src/core/readiness/checks.ts` for pure config, runner, context, validation, repo, and cost check assembly from supplied inputs.
- New `src/core/readiness/collect.ts` for adapting existing config/git/package-script data into pure check inputs.
- New `src/core/readiness/format.ts` for human output and JSON-safe serialization.
- New tests `src/core/readiness/status.test.ts`, `src/core/readiness/checks.test.ts`, and `src/core/readiness/format.test.ts`.
- Existing git helpers in `src/lib/git.ts` and worktree helpers in `src/engine/git/worktree.ts` for repo/dirty state and worktree compatibility.
- Existing cost/pricing helpers under `src/engine/providers/*` or cost store helpers for pricing posture.
- Validation readiness must inspect configuration fields from `src/core/config/load/validate.ts`, package/test-file posture from `src/core/validation/test-discovery.ts` when useful, and command semantics from `src/engine/orchestrator/validation.ts` without running validation commands.

TUI:

- New `src/features/workflow/components/readiness-panel.tsx` and `src/features/workflow/components/readiness-panel.test.tsx` for compact rendering if interactive start needs an Ink view.
- `src/features/workflow/screen.tsx` and `src/stores/navigation/router.ts` only if the chosen design needs a pre-workflow route/state handoff.
- Existing status/cost presentation components for compact rendering.
- Avoid adding a persistent dashboard or kanban-style view.

Tests:

- Colocated tests beside new readiness modules.
- CLI command tests in `src/cli/commands/doctor.test.ts` and existing `src/cli/commands/start.test.ts`.
- Rendering tests using existing Ink/TUI test patterns.

## Phase 1: Readiness Model and Pure Checks

Create a small typed model:

- aggregate status calculation;
- check IDs and severities;
- stable JSON shape;
- section ordering;
- next-action selection.

Implement pure checks first:

- config loaded/invalid;
- mode and approve resolution;
- implementer profile summary;
- validation configuration summary;
- budget/pricing config posture;
- repo status input normalization.

Complexity notes:

- Keep probing conservative. Deterministic local checks are fine; remote network probes should be optional or skipped by default.
- Missing context length is a warning, not a blocker.
- Runner availability should distinguish `known`, `unknown`, and `unavailable`.

## Phase 2: CLI Doctor Command

Add `diptych doctor` as a read-only command.

Expected behavior:

- resolve project directory;
- assert git repo or report blocker;
- load config using existing error formatting;
- do not call `maybeMigrate()`, `initConfig()`, `writeConfig()`, or any helper that writes `.diptych/`, `.git/`, `.trees/`, snapshots, sessions, or config;
- apply shared override logic only if supported by command options;
- print concise human output by default;
- print stable JSON with `--json`;
- exit non-zero only for `blocked` status.

Complexity notes:

- Do not call `initConfig()` or `maybeMigrate()` from doctor. If setup or migration is required, report the explicit command/action to run.
- Do not create sessions, active locks, snapshots, or worktrees.

## Phase 3: Start Integration

Integrate readiness into `diptych start`.

Ordering target:

1. resolve project directory;
2. validate flag combinations that must precede side effects;
3. apply worktree option only after its own clean-source precondition remains satisfied;
4. load/setup config;
5. compute readiness;
6. display/emit readiness;
7. if a `start` session is created before model calls, optionally persist a compact readiness event/artifact into that session;
8. only then start planner/implementer workflow work.

Complexity notes:

- `start --json` currently requires a feature and begins a session before `runHeadless()`. Readiness should be emitted before model calls. If session creation remains necessary before emission, the only allowed write before readiness output is the minimal active execution session needed to record and resume the run.
- Interactive no-config setup must keep current behavior.
- Detach/server path should validate readiness before spawning a server.

## Phase 4: Presentation

Human output:

- one-line status;
- six compact sections;
- blocker/warning count;
- one next action.

TUI:

- concise pre-run panel or modal before workflow screen;
- continue on warnings;
- exit/fix on blockers;
- no multi-screen setup flow.

JSON:

- stable schema including `status`, `nextAction`, `checks`, and selected config metadata;
- no secrets, API keys, or raw environment values.

## Phase 5: Tests and Docs

Add tests for:

- aggregate status and next-action priority;
- config invalid blocker;
- dirty repo warning;
- validation disabled warning;
- missing budget warning for priced API posture;
- single implementer vs implementer profiles;
- start integration ordering before model calls, with no pre-readiness writes except minimal `start` session creation when needed;
- optional compact start readiness event/artifact persistence before model calls;
- doctor JSON shape.

Update public docs only during implementation, not in this pack:

- CLI reference for `doctor`;
- features catalog for Run Readiness;
- troubleshooting examples for common blocker/warning messages.

## Deferred Items

- Active network probes for remote APIs.
- Benchmarking token/context estimates against real model tokenizers.
- Full readiness report archives beyond the compact `start` session record.
- Project-wide or cross-session readiness history/trends.
- Auto-fixing config or validation scripts.
- Same-checkout parallel-write support.
