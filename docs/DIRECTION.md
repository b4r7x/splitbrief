# SPLITBRIEF — Product & Engineering Direction

What SPLITBRIEF optimizes for, where it's going, and what tradeoffs we accept. Read `VISION.md` for identity and competitive framing; this doc is about **how we build**. Point-in-time status — what was built when, and what is still open — lives in the dated [Historical Appendix](#historical-appendix-2026-05-01) and the issue tracker, not in the durable sections above it.

---

## UX principles

SPLITBRIEF is a CLI tool. CLI tools are loved when they respect the developer's time and attention. Seven principles guide every UX decision:

### 1. Zero-ceremony entry

`splitbrief "fix the typo in README"` must work. No subcommand, no prior `init`, no config file for single-shot tasks. Auto-detect available models. Reserve `start` as explicit subcommand for power users; bare positional arg is the default path.

### 2. Heartbeat over silence

Any wait > 5 seconds must show proof of life: token count incrementing, current phase name, or truncated excerpt. The 60-second spinner is where trust dies. Users alt-tab, forget, and the session completes without them. The pre-review suite and a red re-run at the run base publish `full_suite` running rows naming each stage and command. Their byline and build block show the command and its clock. The 60 seconds this principle names are now a threshold in the code: the Build progress block prints `last event 8s ago`, counting every second. Once the idle watchdog has warned that a seat on a call has sent nothing, the line names what the seat is doing: `running <command> · 5m 12s` for a tool still open, `a tool is running · 5m 12s` for a runner that reports tools only when they end, otherwise `No update for 5m 12s` in the warning colour; the watchdog's warn is `RUNNER_IDLE_WARN_MS` (five minutes by default, tunable per runner as `idleWarnMs`), and the block never paints the warning below the 60-second floor `UI_IDLE_WARN_MS` (`src/features/workflow/display/build-progress.ts`).

### 3. One command for session continuity

Users should never think about session lifecycle. `splitbrief continue` figures out the right thing: it resolves the session by alias, id or the active pointer and resumes it from saved state. Kill the tmux-complexity of separate session commands for the 90% case.

### 4. Progressive disclosure everywhere

Default output is minimal. Details expand on keypress. Config starts at 3 lines (planner + implementer) and grows only when needed. Help shows examples, not just flags. The plan card shows its rows inline and opens `plan.json` in the in-app editor or the user's external editor.

### 5. Streaming partial output

For API implementers, stream the last N lines being written in real-time. Transforms "working on foo.ts…" into watching code materialize. Users watch instead of context-switching away.

---

## What we measure

A run is judged by whether the change holds up, not by what it cost. Three numbers, in this order:

| Metric | What it answers |
|---|---|
| First-pass rate | Share of tasks that passed validation on the implementer's first attempt — no retry, no escalation. This is what the Task Brief contract, the implementer prompt, and the isolation are tuned against. |
| Cross-lab review effectiveness | What the planner's review of the run diff caught that the deterministic pipeline did not — logic errors and edge cases, where the cross-lab gap is widest. |
| Spend | Reported alongside the other two, per run. Alone it proves nothing: a first-pass rate bought on the stronger tool is not a result. A run that recorded no priced usage reports that instead of a fabricated zero. |

`evals/` is scored on the first two, not on spend.

---

## Testing architecture

### Philosophy

Tests verify **behavior** — observable state, emitted events, files on disk, rendered output. Never wiring. Full rules in `TESTING.md`.

### The faux provider pattern

Orchestrator tests should exercise the full pipeline (planner → tasks → implementer → validation) with **scripted responses at the interface level** — no subprocess, no network, no `vi.mock`.

Two levels:

| Level | Seam | Use case |
|---|---|---|
| L1: Faux objects | Planner/Implementer interface | 90% of orchestrator tests. Declarative scripts: `{ tasks: [...], success: true }`. No network, <50ms. |
| L2: Faux HTTP server | Localhost OpenAI/Anthropic SSE | Testing `api.ts` parser: rate limits, malformed SSE, token accounting. Real fetch hits localhost. |

Existing infrastructure (cassette record/replay, shell runners) stays for e2e and integration. The faux layer fills the gap between "mock the interface with `vi.fn`" (implementation coupling) and "spawn a real process" (slow, flaky).

Design goals:
- `fauxPlanner(opts)` returns `{ planner: Planner, state }` — typed, tracks calls
- `fauxImplementer(opts)` returns `{ implementer: Implementer, state }` — typed, cycles scripts
- `createFauxWorkflow(opts)` composes both with bus + config + temp dir
- Zero `vi.fn`, zero `vi.mock`. Assertions read `state.planCallCount` or `harness.events`

### What we do NOT mock

- Sibling modules (`./`, `../`) — import the real module
- Internal functions — observe returned state
- Stores — use real stores with `__testReset`
- The state machine — it's 50 lines, exercising it is free

---

## Architecture decisions (2026-05-01 audit)

### AD-1: Events layer is foundational

`src/engine/events/` must not import from `src/engine/orchestrator/`. Types that both layers need live in `events/` or `core/schemas/`. Violation = layer inversion = refactoring hazard.

### AD-2: No god-functions in the orchestrator

Any function exceeding ~300 lines with 5+ responsibilities must be decomposed. Extract named helpers at the responsibility boundary. The orchestrator is the most-changed code; readability > compactness.

Canonical example: `src/engine/orchestrator/task/step.ts` was decomposed into focused modules: `pre-task.ts` (pre-hook dispatch, task-start event, snapshot), `run-implementation.ts` (continuation loop, streaming, staging), `attempt-gate.ts` (the protected-write gate over an attempt's changes in the run workspace), `rollback.ts` (snapshot restore in the run workspace after hook denial, retry exhaustion or an interrupted attempt), and `resolve-deps.ts` (dependency resolution). Colocated tests split across `step.integration.test.ts` (completion/abort/evidence), `step-approval.integration.test.ts`, `step-user-edit.integration.test.ts`, and `step-recovery.integration.test.ts`.

### AD-3: Selector narrowness is performance

Store selectors must select only the fields they read. `store.use(s => s)` defeats the entire optimization (`Object.is` check on the full state = re-render on any mutation). Narrow selectors are free; broad selectors are O(consumers × mutations).

### AD-4: One fuzzy algorithm, everywhere

Users expect consistent ranking across the palette, slash-commands, and file pickers. One library (`fzf`), one ranking behavior, normalized to [0, 1] score range.

### AD-5: DRY at 3 repetitions

Inline up to 2 repetitions. Extract on the 3rd. The routing decision spread (8 fields × 3 sites) is the canonical example of where extraction earns its keep.

### AD-6: Path safety in one place

All path-confinement checks (rejecting `..` traversals, absolute paths, Windows paths) must route through `assertPathConfined`. Duplicating the logic across files means inconsistent platform handling and silent security divergence.

### AD-7: Append-only tree session model — superseded

Superseded: the append-only session tree was removed. A session is a JSONL event log plus `summary.json` under `.splitbrief/sessions/<id>/`.

### AD-8: Branch summarization on recovery

When execution branches (a recovery decision sends execution back to an earlier point), call an LLM to summarize the abandoned branch using a structured format:

```
## Goal
## Progress: Done / In Progress / Blocked
## Key Decisions
## Constraints Discovered
## Next Steps
```

Inject the summary with preamble: "A previous agent attempt was abandoned. Summary of what was tried:" — so the next attempt automatically knows what didn't work without carrying full token cost.

Track `readFiles` and `modifiedFiles` across compactions. Use an incremental UPDATE prompt: when compacting again, pass previous summary to LLM and ask to merge, not regenerate.

### AD-9: Custom entries for heterogeneous orchestration state — superseded

Superseded with AD-7: there are no tree entry types; the session log records engine events.

### AD-10: Tree navigation with active-path markers — superseded

Superseded with AD-7: there is no plan-tree viewer.

### AD-11: Unified autocomplete

One mental model for discovery:
- `/` at line start → slash commands (orchestrator control: `/pause`, `/retry`, `/switch-agent`, `/plan`, `/cost`)
- `@` mid-text → file path completion (via `fd`, respects `.gitignore`)
- Tab → per-command argument completion (e.g., `/switch-agent clau` → "claude-code")

All three use the same fuzzy ranking algorithm (AD-4).

### AD-12: Structured compaction for long plans (partial)

Implemented for transcript compaction: `workflow.compactionFormat` supports `auto`, `freeform`, and `structured`; `auto` selects structured JSON for `api` planners and freeform for subprocess planners. Structured summaries use `Plan Goal / Steps Completed / Current Step / Files Modified / Constraints Discovered / Remaining Work`, update incrementally by merging with the previous structured summary, and fall back to freeform text on validation failure.

---

## Competitive advantages (preserve these)

The niche has direct competitors now (`VISION.md`). Any single row here can be matched; the set is what makes a two-tool split usable, so protect the set:

| Feature | What it does |
|---|---|
| `doctor` | Pre-flight readiness check with blockers/warnings/suggestions |
| Recovery system | Typed `RecoveryIssue` → user chooses `RecoveryAction` (skip, retry, abort, switch-profile) |
| Planning session | One typed planning session: up to 2 rounds of questions, a checked `plan.json`, one optional plan card |
| Drift detection | Detects when implementation diverges from plan |
| Worktree isolation | One git worktree per run for every implementer, project dependencies linked in; the reviewed result reaches the checkout once, at Apply, through one hash-guarded write. Isolates files, not the runtime — it is not a security boundary |
| 92 typed events + `--json` | NDJSON event stream for CI/automation |
| Protected-path confirmation | Per-action classification; a write to a protected path asks once per path per run, and approving the plan card confirms the protected writes the plan lists |
| Task Brief contract | Precise, structured handoff artifact between planner and implementer |

---

## Historical appendix (2026-05-01)

Kept verbatim as a dated record. Some rows below name commands and features that have since been removed; they are history, not the current surface.

Point-in-time tracker content captured during the 2026-05-01 audit. These tables are a snapshot, not durable direction — scores were self-assigned against a private audit with no checkable rubric, and the open/done status drifts as work lands. Live status belongs in the issue tracker; this section is kept only as a dated historical record. Durable direction is the UX Principles, Architecture Decisions, and Competitive Advantages above.

### Open at the time (2026-05-01)

These were specced in DIRECTION but not yet built as of the audit. Each is a standalone feature, implementable independently. Current status lives in the issue tracker.

1. **Unified autocomplete** (AD-11) — `/` for slash commands, `@` for file paths, Tab for per-command argument completion. One fuzzy-ranked dropdown for all discovery.
2. **Structured compaction follow-ups** (AD-12, partial) — Core structured/freeform transcript compaction exists. Remaining direction: tree-session compaction entries and read-file tracking across branches.
3. **External `$EDITOR` integration** — Open user's editor for writing long feature descriptions. Pasting multi-paragraph specs into terminal input is painful.
4. **HTML/Markdown session export** — Export workflow results as shareable artifact. For sharing reports, demonstrating value, onboarding teammates.

### Area ratings (post-implementation, 2026-05-01)

| Area | Score | Status |
|---|---|---|
| First-run experience | 9/10 | `splitbrief "feature"` shorthand, `@file` syntax, `--help` with examples |
| Core feedback loop | 9/10 | Planner heartbeat, streaming partial output from API implementers |
| Error UX | 7/10 | Crash diagnostics excellent; recovery prompts lack consequence descriptions |
| Session management | 9/10 | `splitbrief continue` resolves by numeric alias, id, or the active pointer (the separate `last`, `ps` and `attach` commands were retired) |
| Planning phase UX | 9/10 | Per-task reject+regen, contextual footer keybindings |
| Spend visibility | 9/10 | Cost row on a closed run (the separate `splitbrief stats` command was retired) |
| Streaming output | 9/10 | Live partial output during API implementer generation |
| Configuration | 6/10 | Progressive disclosure missing, three approval escape hatches |

### Specific feature targets (status as of 2026-05-01)

| Feature | What it does | Status |
|---|---|---|
| `splitbrief "feature"` shorthand | Bare positional arg = `splitbrief start "feature"`, resolving the mode the usual way | ✅ |
| `@file` syntax | `splitbrief "refactor auth" @context.md @screenshot.png` enriches planner context | ✅ |
| `--help` with 14 real examples | Not just flag descriptions — concrete command examples with explanations | ✅ |
| `splitbrief continue` | Smart command: attaches if running, resumes if interrupted | ✅ |
| `splitbrief last` | Attach or resume the most recent session | Retired — `splitbrief continue 1` targets the most recent session, and the bare form resumes the active pointer |
| `splitbrief stats` | Cumulative spend across all sessions | Retired — per-run spend lives on the run screen |
| Planner heartbeat | Token counter or phase hint during long waits | ✅ |
| Streaming partial output | Last N lines from API implementer in real-time | ✅ |
| Per-task reject + regen | Flag tasks, press `R` to send back to planner | ✅ |
| Contextual footer keybindings | Footer changes based on cursor position | ✅ |
| Recovery consequence text | "retry-task: re-runs prompt, costs ~$0.02" | — |
| Auto-expand active diffs | Diffs expanded for running task, collapsed for completed | — |
| Unify approval flags | `--auto` and `--approve` removed; `workflow.approve: none` skips the plan card; `--yolo` is removed | ✅ |
| Session numeric aliases | `splitbrief continue 1` instead of the full `20250412-143022-abc` id | ✅ (on `continue`; the `attach` command was retired) |
| HTML/Markdown session export | Export workflow results as shareable artifact | — |
| External `$EDITOR` integration | Open editor for long feature descriptions | — |
| Agent/profile cycling keybind | Ctrl+P cycles implementer profiles | — |

---

## What we will NOT build

These are conscious anti-goals, not TODO items:

- **Custom TUI framework** — Ink 6.x is sufficient; the whole-frame rewrite at the 30fps cap is fast enough, and `incrementalRendering` stays off until ink >= 7.0.0. Custom differential rendering is a multi-month effort with no user-visible gain.
- **Extension/plugin system** — Our hook system (allow/deny/warn/crash) is the right abstraction for an orchestrator. Extensions are for tools that own the agent loop; we don't.
- **Model registry** — We delegate model management to the providers (ollama, LM Studio). No model catalog, no download management.
- **OAuth/login flows** — Authentication belongs to the child agents (claude-code, codex). We pass API keys in config.
- **Parallel same-checkout writes** — Git doesn't support this safely. Worktrees or sequential execution only.
