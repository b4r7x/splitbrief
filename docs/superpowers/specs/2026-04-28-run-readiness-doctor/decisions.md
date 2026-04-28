# Decisions: Run Readiness / Doctor

## ADR 001: Add a `doctor` Command and Pre-Start Report

**Status:** planned.

**Decision:** Implement both a standalone `diptych doctor` command and a pre-start readiness report inside `diptych start`.

**Rationale:** Users need a no-token diagnostic command while configuring diptych, and they also need the same safety posture at the moment they start a real run. Keeping both paths backed by one report model prevents drift.

**Consequences:**

- `doctor` is strictly read-only, creates no session, and persists no readiness history.
- `start` uses the same checks before planner/implementer calls and may persist a compact readiness event/artifact in its active execution session.
- CLI, TUI, and headless output must share the same underlying `ReadinessReport`.

## ADR 002: Fail Open for Warnings, Fail Closed for Local Blockers

**Status:** planned.

**Decision:** Warn on uncertain or advisory checks; block only on deterministic local preconditions that make a run invalid or unsafe.

**Blockers:**

- not a git repository;
- invalid config after existing loader/schema validation;
- unresolved default implementer profile;
- active same-checkout session conflict;
- dirty source checkout where a requested worktree/detach path requires clean state.

**Warnings:**

- missing context length;
- disabled validation;
- missing budget for priced API posture;
- dirty working tree without known task conflicts;
- unknown runner availability;
- skipped network probe.

**Rationale:** Readiness should prevent obvious mistakes without becoming a paternalistic gate. Diptych already relies on approval gates, validation, conflict detection, and checkpoints later in the run.

## ADR 003: Validation Strategy Is Posture, Not Execution

**Status:** planned.

**Decision:** Readiness inspects validation configuration and command availability posture, but does not run `npm run typecheck`, `npm run lint`, or `npm test`.

**Rationale:** The feature goal is pre-token readiness, not pre-run CI. Running validation can be slow and may mutate caches. The task loop already runs validation after implementation tasks.

**Consequences:**

- Detect disabled checks from `validation` config.
- Optionally inspect package scripts for obvious missing commands without executing those scripts.
- Report `testCommand` exactly enough to help users fix it.
- Leave full validation commands to `verification.md` and future implementation tests.

## ADR 004: Dirty Repo Handling Is Risk Reporting Before Tasks Exist

**Status:** planned.

**Decision:** Before Task Briefs exist, dirty working tree state is a repo risk summary, not task-aware conflict resolution.

**Rationale:** Task/file ownership is not known before planning. The readiness report can warn about local edits and same-checkout risk, but precise conflict handling belongs to task execution once scopes are known.

**Consequences:**

- Report counts and representative paths, capped for readability.
- Do not block ordinary dirty state by default.
- Preserve stricter behavior for paths that already require clean source state, such as creating isolated worktrees.
- Do not overwrite, stage, stash, or commit user edits.

## ADR 005: No New Product Surface Beyond Readiness

**Status:** planned.

**Decision:** Run Readiness is not a plan archive, setup wizard, kanban board, MCP tool surface, or multi-agent scheduler.

**Rationale:** The value is a concise pre-run safety report. Expanding it into workflow management would conflict with the cost-aware implementer direction.

**Consequences:**

- No saved `doctor` readiness history in v1.
- `diptych start` may write one compact readiness event/artifact into the current execution session before model calls.
- No plan libraries or cross-plan dependency tracking.
- No MCP write tools.
- No same-checkout fan-out.
- No automatic config edits unless a separate feature explicitly designs that behavior.

## ADR 006: Doctor Never Migrates or Repairs State

**Status:** planned.

**Decision:** `diptych doctor` reports migration/setup posture but never writes config, session, worktree, snapshot, git, or migration state.

**Rationale:** A diagnostic command must be safe to run in any checkout, including production repositories and CI probes. Existing helpers that perform writes, such as `maybeMigrate`, `initConfig`, or `writeConfig`, are valid for `start` or explicit commands but not for `doctor`.

**Consequences:**

- `doctor` may call read-only parsing, schema validation, and in-memory migration helpers.
- If a config or legacy session migration is needed, `doctor` prints the command/action to run and exits according to readiness status.
- Tests must assert behavior and observable side effects, not private helper calls.
