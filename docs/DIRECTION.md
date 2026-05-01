# diptych — Product & Engineering Direction

What diptych optimizes for, where it's going, and what tradeoffs we accept. Read `VISION.md` for identity and competitive framing; this doc is about **how we build**.

---

## UX Principles

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

Default output is minimal. Details expand on keypress. Config starts at 3 lines (planner + implementer) and grows only when needed. Help shows examples, not just flags. The plan editor footer shows contextual keybindings, not a hidden `?` overlay.

### 6. Cost-gated approval

Before implementation starts, show: "12 tasks | Est. $0.14 | All-planner: ~$1.20 | Approve? [Y/n]". This transforms rubber-stamp approval into the moment the user feels smart for using diptych.

### 7. Streaming partial output

For API implementers, stream the last N lines being written in real-time. Transforms "generating foo.ts... 28s" into watching code materialize. Users watch instead of context-switching away.

---

## Testing Architecture

### Philosophy

Tests verify **behavior** — observable state, emitted events, files on disk, rendered output. Never wiring. Full rules in `TESTING.md`.

### The Faux Provider Pattern

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

## Architecture Decisions (2026-05-01 audit)

### AD-1: Events layer is foundational

`src/engine/events/` must not import from `src/engine/orchestrator/`. Types that both layers need live in `events/` or `core/schemas/`. Violation = layer inversion = refactoring hazard.

### AD-2: No god-functions in the orchestrator

Any function exceeding ~300 lines with 5+ responsibilities must be decomposed. Extract named helpers at the responsibility boundary. The orchestrator is the most-changed code; readability > compactness.

### AD-3: Selector narrowness is performance

Store selectors must select only the fields they read. `store.use(s => s)` defeats the entire optimization (`Object.is` check on the full state = re-render on any mutation). Narrow selectors are free; broad selectors are O(consumers × mutations).

### AD-4: One fuzzy algorithm, everywhere

Users expect consistent ranking across the palette, slash-commands, and file pickers. One library (`fzf`), one ranking behavior, normalized to [0, 1] score range.

### AD-5: DRY at 3 repetitions

Inline up to 2 repetitions. Extract on the 3rd. The routing decision spread (8 fields × 3 sites) is the canonical example of where extraction earns its keep.

### AD-6: Path safety in one place

All path-confinement checks (rejecting `..` traversals, absolute paths, Windows paths) must route through `assertPathConfined`. Duplicating the logic across files means inconsistent platform handling and silent security divergence.

### AD-7: Append-only session model (future)

Session data should be append-only (JSONL). Recovery decisions create branches — alternate paths in the same file. Nothing is deleted; a pointer (`leafId`) tracks the active path. Branch summarization injects "what was tried and why it failed" into retry context without carrying full token cost.

### AD-8: Structured compaction (future)

When planning context exceeds limits, use structured summaries: `Goal / Steps Completed / Current Step / Files Modified / Constraints Discovered / Remaining Work`. Summaries update incrementally (merge with previous, don't regenerate).

---

## Competitive Advantages (preserve these)

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

## UX Gaps (target state — not yet implemented)

| Area | Current state | Target |
|---|---|---|
| First-run | 3 steps + 17 commands visible | `diptych "feature"` works immediately |
| Planner wait | 60s spinner | Token counter + phase hint |
| Session mgmt | 5 commands | `continue` / `last` covers 90% |
| Plan editor | Hidden keybindings | Footer shows contextual actions |
| Cost narrative | Buried in sidebar | Hero stat post-run + `diptych stats` |
| Streaming | "generating..." then full diff | Last N lines in real-time |
| Config | 12+ top-level keys | 3-line minimal default |
| Plan rejection | Approve-all or rewind-all | Per-task reject + regenerate |

---

## What We Will NOT Build

These are conscious anti-goals, not TODO items:

- **Custom TUI framework** — Ink 6.x with incremental rendering is sufficient. Custom differential rendering is a multi-month effort with no user-visible gain.
- **Extension/plugin system** — Our hook system (allow/deny/warn/crash) is the right abstraction for an orchestrator. Extensions are for tools that own the agent loop; we don't.
- **Model registry** — We delegate model management to the providers (ollama, LM Studio, OpenRouter). No model catalog, no download management.
- **OAuth/login flows** — Authentication belongs to the child agents (claude-code, codex). We pass API keys in config.
- **Parallel same-checkout writes** — Git doesn't support this safely. Worktrees or sequential execution only.
