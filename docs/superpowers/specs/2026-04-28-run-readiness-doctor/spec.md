# Spec: Run Readiness / Doctor

## User Stories

### Story 1: Start with confidence

As a user starting `diptych start "feature"`, I want to see whether config, runners, validation, repo state, context, and budget look safe before token spend, so I can continue or fix issues intentionally.

### Story 2: Diagnose setup without a run

As a user configuring diptych, I want `diptych doctor` to report readiness without creating `.diptych/active`, creating a session folder, or invoking planner/implementer model calls.

### Story 3: Use readiness in automation

As a user running headless `--json`, I want structured readiness output before model-backed execution begins, so automation can fail fast on hard blockers and surface warnings.

### Story 4: Avoid overwriting user work

As a user with local edits, I want readiness to distinguish clean, dirty, and risky repo states before any run begins, so I understand whether diptych may collide with my changes.

## Functional Requirements

### Report Content

The readiness report must include:

- config status: loaded path, in-memory config version/migration posture, validation errors or warnings;
- mode and approval posture: resolved mode, resolved approval gates, budget override posture;
- planner posture: kind, tool/provider/model when known, availability confidence, context length if configured or detected;
- implementer posture: default implementer or selected profile, available profiles summary, cost tier, write mode, context length posture;
- context sanity: whether configured context lengths are missing, suspiciously small, or likely adequate for selected mode;
- validation posture: enabled `typecheck`, `lint`, `test`, effective `testCommand`, missing package scripts or disabled checks;
- working tree posture: git repo status, dirty files count, untracked count, same-checkout risk, active-session conflict;
- cost posture: `workflow.maxBudget`, pause threshold, pricing availability, local/unpriced behavior, rough pre-run estimate posture if available;
- next action: `continue`, `run init`, `fix config`, `clean or isolate repo`, `raise context`, `set budget`, or `exit`.

### Severity Levels

Use four severities:

- `ok`: no action required.
- `info`: useful context, never blocks.
- `warning`: user should review, but can continue.
- `blocker`: run should not continue unless an explicit override is supported and documented.

### Blocking Rules

Block by default when:

- project is not a git repository;
- config cannot be loaded or validated;
- runner config is structurally invalid after CLI overrides;
- `.diptych/active` indicates another live session in the same checkout;
- dirty state affects a mode/path that cannot safely proceed, such as detach/worktree creation requiring a clean source checkout.

Warn, but do not block, when:

- context length is missing;
- implementer context is likely tight;
- validation checks are disabled;
- tests are configured but `testCommand` appears unavailable;
- budget is unset for priced API runners;
- working tree is dirty but no same-checkout conflict is known before tasks exist.

### Command Behavior

`diptych doctor`:

- is strictly read-only: it must not call `maybeMigrate`, `initConfig`, `writeConfig`, `ensureGitignore`, `beginSession`, worktree creation, snapshot creation, planner calls, implementer calls, validation commands, `git add`, `git stage`, `git commit`, or `git stash`;
- may use existing config parsing, in-memory config migration, and validation helpers to report posture, but if a disk migration or setup write is needed it must print the command/action to run, such as `diptych migrate`, `diptych init`, or `diptych init --reconfigure`;
- should support project selection through the same `--project` option pattern as workflow commands if available;
- should support a JSON output mode for automation.

`diptych start`:

- should compute readiness after project/config resolution and before planner/implementer model calls;
- may persist a compact readiness event or artifact in the active `start` session before model calls; this persistence belongs to execution/session history and is not a doctor history, kanban, or plan archive;
- should show a concise report in TUI mode and emit structured data in headless JSON mode;
- should not duplicate full setup UI; readiness is a pre-flight report, not a reconfigure wizard;
- may offer a continue action for warnings.

## Edge Cases

- Missing config with no overrides: current interactive setup behavior should remain; readiness may summarize that setup is needed.
- Missing config with overrides: existing default config creation path should remain compatible.
- Legacy config versions: readiness should report migrated/accepted posture without inventing a new migration flow. For `doctor`, that posture must be computed without writing; for `start`, existing start-time migration/setup behavior may remain but readiness itself should not be the writer.
- Optional `implementerProfiles`: if absent, report the single legacy `implementer` as default.
- Default profile missing: report as config blocker using existing accessor behavior.
- CLI runner availability unknown: warn rather than claim failure unless detection is deterministic.
- API runner availability unavailable offline: warn if probe is skipped; do not make network probes mandatory.
- Local Ollama/LM Studio unavailable: warn or block only if a deterministic local probe is explicitly implemented.
- `workflow.maxBudget` absent with local implementer: report `local/unpriced`, not fake savings.
- Dirty repo with untracked files: warn with counts; do not list huge file sets by default.
- `--detach --worktree`: preserve existing clean-source worktree requirement and validate before creating a worktree.
- `--json`: emit readiness before the first workflow event that spends tokens.

## Key Entities

- `ReadinessReport`: top-level result with `status`, `sections`, `nextAction`, and machine-readable metadata.
- `ReadinessSection`: named group such as `config`, `runners`, `context`, `validation`, `repo`, `cost`.
- `ReadinessCheck`: individual check with `id`, `severity`, `summary`, optional `details`, optional `fix`.
- `ReadinessStatus`: aggregate `ready`, `ready-with-warnings`, or `blocked`.
- `RunnerReadiness`: planner/implementer/profile posture derived from existing config and profile accessors.
- `RepoReadiness`: git state, active session, worktree/detach compatibility.
- `ValidationReadiness`: enabled checks and command availability posture.
- `CostReadiness`: budget/pricing posture without making model calls.
- `StartReadinessRecord`: optional compact `start` session event/artifact that records readiness status and summary before model calls.

## Success Criteria

- Users can understand in under ten seconds whether a run is safe to start.
- Future implementers can add the feature without changing core product boundaries.
- Warnings are actionable and concise.
- Hard blockers match existing command constraints and do not invent surprising new policy.
- Tests cover pure report aggregation, CLI JSON output, start integration ordering, and TUI/headless rendering.
