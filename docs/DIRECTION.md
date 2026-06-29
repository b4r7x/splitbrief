# diptych — Product & Engineering Direction

What diptych optimizes for, where it's going, and what tradeoffs we accept. Read `VISION.md` for identity and competitive framing; this doc is about **how we build**. Point-in-time status — what was built when, and what is still open — lives in the dated [Historical Appendix](#historical-appendix-2026-05-01) and the issue tracker, not in the durable sections above it.

---

## UX principles

diptych is a CLI tool. CLI tools are loved when they respect the developer's time and attention. Seven principles guide every UX decision:

### 1. Zero-ceremony entry

`diptych "fix the typo in README"` must work. No subcommand, no prior `init`, no config file for single-shot tasks. Auto-detect available models. Reserve `start` as explicit subcommand for power users; bare positional arg is the default path.

### 2. Savings as spectacle

The entire switching argument is one number: "You spent $0.12. All-planner alternative: ~$0.95. Saved 87%." This stat must be loud, prominent, and post-run. It should be copy-pasteable (for sharing). Historical tracking across sessions (`diptych stats`) makes the case cumulative.

### 3. Heartbeat over silence

Any wait > 5 seconds must show proof of life: token count incrementing, current phase name, or truncated excerpt. The 60-second spinner is where trust dies. Users alt-tab, forget, and the session completes without them.

### 4. One command for session continuity

Users should never think about session lifecycle. `diptych continue` (or `diptych last`) figures out the right thing: attach if running, resume if interrupted. Kill the tmux-complexity of 5 separate session commands for the 90% case.

### 5. Progressive disclosure everywhere

Default output is minimal. Details expand on keypress. Config starts at 3 lines (planner + implementer) and grows only when needed. Help shows examples, not just flags. Brief review exposes the active commands inline and sends text edits to the user's external editor.

### 6. Cost-gated approval

Before implementation starts, show: "12 tasks | Est. $0.14 | All-planner: ~$1.20 | Approve? [Y/n]". This transforms rubber-stamp approval into the moment the user feels smart for using diptych.

### 7. Streaming partial output

For API implementers, stream the last N lines being written in real-time. Transforms "generating foo.ts... 28s" into watching code materialize. Users watch instead of context-switching away.

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

Canonical example: `src/engine/orchestrator/task/step.ts` (474 → 283 LOC) was decomposed into four focused modules: `pre-task.ts` (pre-hook dispatch, task-start event, snapshot), `run-implementation.ts` (continuation loop, streaming, staging), `apply-changed-files.ts` (post-impl approval, promotion, conflict detection), and `resolve-deps.ts` (dependency resolution).

### AD-3: Selector narrowness is performance

Store selectors must select only the fields they read. `store.use(s => s)` defeats the entire optimization (`Object.is` check on the full state = re-render on any mutation). Narrow selectors are free; broad selectors are O(consumers × mutations).

### AD-4: One fuzzy algorithm, everywhere

Users expect consistent ranking across the palette, slash-commands, and file pickers. One library (`fzf`), one ranking behavior, normalized to [0, 1] score range.

### AD-5: DRY at 3 repetitions

Inline up to 2 repetitions. Extract on the 3rd. The routing decision spread (8 fields × 3 sites) is the canonical example of where extraction earns its keep.

### AD-6: Path safety in one place

All path-confinement checks (rejecting `..` traversals, absolute paths, Windows paths) must route through `assertPathConfined`. Duplicating the logic across files means inconsistent platform handling and silent security divergence.

### AD-7: Append-only tree session model

Session data should be append-only JSONL with `{id, parentId, type, timestamp}` entries forming a tree. A `leafId` pointer tracks the active execution path. Recovery decisions create branches — move the pointer backward and start a new child path. Nothing is deleted.

Entry types: `plan-step`, `agent-invocation`, `recovery-decision`, `compaction`, `branch-summary`, `file-state`, `custom` (metadata not for LLM).

Benefits:
- Sessions survive crashes (append-only)
- Branching is free (just move the pointer)
- Full audit trail (every attempt preserved)
- UUIDs as file names (time-sortable)

### AD-8: Branch summarization on recovery

When execution branches (recovery decision moves the leaf backward), call an LLM to summarize the abandoned branch using a structured format:

```
## Goal
## Progress: Done / In Progress / Blocked
## Key Decisions
## Constraints Discovered
## Next Steps
```

Inject the summary with preamble: "A previous agent attempt was abandoned. Summary of what was tried:" — so the next attempt automatically knows what didn't work without carrying full token cost.

Track `readFiles` and `modifiedFiles` across compactions. Use an incremental UPDATE prompt: when compacting again, pass previous summary to LLM and ask to merge, not regenerate.

### AD-9: Custom entries for heterogeneous orchestration state

The session tree won't be (user, assistant) pairs. It's heterogeneous:
- `plan-step` definitions (what to do)
- `agent-invocation` records (which agent, what prompt, exit code, tokens, duration)
- `file-state` snapshots (files modified so far)
- `recovery-rationale` (why we branched)
- `cost-checkpoint` (accumulated spend at this point)

Each entry carries a `display` flag controlling what the user sees in TUI vs. internal bookkeeping. On session reload, walk entries by type to reconstruct orchestrator state.

### AD-10: Tree navigation with active-path markers

A plan-tree viewer showing execution history as a visual tree:
- ASCII connectors (`├─`, `└─`, `│`) for parent-child
- Active-path marker (`*`) on every entry from root to current leaf
- Filter modes: all steps, failed-only, active-path-only
- Labels (user bookmarks) for important decision points
- Fold completed sub-trees to reduce noise

### AD-11: Unified autocomplete

One mental model for discovery:
- `/` at line start → slash commands (orchestrator control: `/pause`, `/retry`, `/switch-agent`, `/plan`, `/cost`)
- `@` mid-text → file path completion (via `fd`, respects `.gitignore`)
- Tab → per-command argument completion (e.g., `/switch-agent clau` → "claude-code")

All three use the same fuzzy ranking algorithm (AD-4).

### AD-12: Structured compaction for long plans (partial)

Implemented for transcript compaction: `workflow.compactionFormat` supports `auto`, `freeform`, and `structured`; `auto` selects structured JSON for `api` and `agent-sdk` planners and freeform for subprocess planners. Structured summaries use `Plan Goal / Steps Completed / Current Step / Files Modified / Constraints Discovered / Remaining Work`, update incrementally by merging with the previous structured summary, and fall back to freeform text on validation failure. Still future: tree-session compaction entries and read-file tracking across branches.

---

## Competitive advantages (preserve these)

These are diptych-only features that no comparable tool offers:

| Feature | What it does |
|---|---|
| `ps` / `attach` / `detach` | Background sessions as first-class citizens |
| `doctor` | Pre-flight readiness check with blockers/warnings/suggestions |
| Recovery system | Typed `RecoveryIssue` → user chooses `RecoveryAction` (skip, retry, abort, switch-profile) |
| `explain` | Post-hoc reasoning about routing/cost/review decisions |
| Budget tracking | Real-time cost prediction, budget gates, `budget_exceeded` events |
| Mode system | `instant`/`quick`/`standard`/`speckit` — adjusts ceremony to task complexity |
| Drift detection | Detects when implementation diverges from plan |
| Worktree integration | Auto-creates git worktrees for isolated work |
| 114 typed events + `--json` | NDJSON event stream for CI/automation |
| Tiered approval | Sticky session/always scopes with per-action classification |
| Task Brief contract | Precise, structured handoff artifact between planner and implementer |

---

## Historical appendix (2026-05-01)

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
| First-run experience | 9/10 | `diptych "feature"` shorthand, `@file` syntax, `--help` with examples |
| Core feedback loop | 9/10 | Planner heartbeat, streaming partial output from API implementers |
| Error UX | 7/10 | Crash diagnostics excellent; recovery prompts lack consequence descriptions |
| Session management | 9/10 | `continue`/`last`, numeric aliases in `ps` |
| Planning phase UX | 9/10 | Per-task reject+regen, contextual footer keybindings |
| Cost visibility | 9/10 | Hero savings stat, `diptych stats`, cost-gated approval |
| Streaming output | 9/10 | Live partial output during API implementer generation |
| Configuration | 6/10 | Progressive disclosure missing, three approval escape hatches |

### Specific feature targets (status as of 2026-05-01)

| Feature | What it does | Status |
|---|---|---|
| `diptych "feature"` shorthand | Bare positional arg = `diptych start "feature"` in instant mode | ✅ |
| `@file` syntax | `diptych "refactor auth" @context.md @screenshot.png` enriches planner context | ✅ |
| `--help` with 14 real examples | Not just flag descriptions — concrete command examples with explanations | ✅ |
| `diptych continue` | Smart command: attaches if running, resumes if interrupted | ✅ |
| `diptych last` | Attach or resume the most recent session | ✅ |
| `diptych stats` | Cumulative savings across all sessions | ✅ |
| Hero savings post-run | "$0.12 actual vs $0.95 all-planner — 87% saved" | ✅ |
| Cost-gated approval | "12 tasks \| Est. $0.14 \| Approve? [Y/n]" before impl starts | ✅ |
| Planner heartbeat | Token counter or phase hint during long waits | ✅ |
| Streaming partial output | Last N lines from API implementer in real-time | ✅ |
| Per-task reject + regen | Flag tasks, press `R` to send back to planner | ✅ |
| Contextual footer keybindings | Footer changes based on cursor position | ✅ |
| Recovery consequence text | "retry-task: re-runs prompt, costs ~$0.02" | — |
| Auto-expand active diffs | Diffs expanded for running task, collapsed for completed | — |
| Unify approval flags | `--auto` / `--approve none` / `--yolo` → one concept | — |
| Session numeric aliases | `diptych attach 1` instead of `diptych attach 20250412-143022-abc` | ✅ |
| HTML/Markdown session export | Export workflow results as shareable artifact | — |
| External `$EDITOR` integration | Open editor for long feature descriptions | — |
| Agent/profile cycling keybind | Ctrl+P cycles implementer profiles | — |

---

## Session model (implemented 2026-05-01)

The session model uses an append-only JSONL tree with typed entries. This is the foundation for intelligent recovery, cost tracking, and workflow visibility. Implementation: `src/core/sessions/tree/`.

The `TreeRecorder` EventSink (`src/engine/events/sinks/tree-recorder.ts`) is registered in `run/init.ts` and actively records every workflow execution. It maps `EngineEvent` instances to tree entries and branches on recovery. This runs alongside the existing JSONL sink — the tree provides structured navigation while JSONL provides raw replay.

### Data model

```
session-<uuid>.jsonl (append-only)
├── entry: { id, parentId, type, timestamp, ...payload }
├── entry: { id, parentId, type, timestamp, ...payload }
└── ...

Pointer: leafId → current active entry (tip of active branch)
```

### Tree operations

| Operation | What happens |
|---|---|
| Normal execution | Append entry with `parentId = previousLeafId`, update leafId |
| Recovery branch | Move leafId to decision point, append new entry from there |
| Compaction | Append `compaction` entry with structured summary, update context window |
| Resume | Walk from leafId to root, rebuild orchestrator state from entries |

### Why tree, not linear

Linear sessions lose context on recovery. When an agent attempt fails and we try a different approach, the linear model either keeps the failed context (wastes tokens) or deletes it (loses learning). The tree model preserves both paths. Branch summarization (AD-8) extracts the learning into a compact form for the new branch.

---

## What we will NOT build

These are conscious anti-goals, not TODO items:

- **Custom TUI framework** — Ink 6.x with incremental rendering is sufficient. Custom differential rendering is a multi-month effort with no user-visible gain.
- **Extension/plugin system** — Our hook system (allow/deny/warn/crash) is the right abstraction for an orchestrator. Extensions are for tools that own the agent loop; we don't.
- **Model registry** — We delegate model management to the providers (ollama, LM Studio, OpenRouter). No model catalog, no download management.
- **OAuth/login flows** — Authentication belongs to the child agents (claude-code, codex). We pass API keys in config.
- **Parallel same-checkout writes** — Git doesn't support this safely. Worktrees or sequential execution only.
