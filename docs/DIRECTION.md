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

### AD-7: Append-only tree session model (future)

Session data should be append-only JSONL with `{id, parentId, type, timestamp}` entries forming a tree. A `leafId` pointer tracks the active execution path. Recovery decisions create branches — move the pointer backward and start a new child path. Nothing is deleted.

Entry types: `plan-step`, `agent-invocation`, `recovery-decision`, `compaction`, `branch-summary`, `file-state`, `custom` (metadata not for LLM).

Benefits:
- Sessions survive crashes (append-only)
- Branching is free (just move the pointer)
- Full audit trail (every attempt preserved)
- UUIDs as file names (time-sortable)

### AD-8: Branch summarization on recovery (future)

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

### AD-9: Custom entries for heterogeneous orchestration state (future)

The session tree won't be (user, assistant) pairs. It's heterogeneous:
- `plan-step` definitions (what to do)
- `agent-invocation` records (which agent, what prompt, exit code, tokens, duration)
- `file-state` snapshots (files modified so far)
- `recovery-rationale` (why we branched)
- `cost-checkpoint` (accumulated spend at this point)

Each entry carries a `display` flag controlling what the user sees in TUI vs. internal bookkeeping. On session reload, walk entries by type to reconstruct orchestrator state.

### AD-10: Tree navigation with active-path markers (future)

A plan-tree viewer showing execution history as a visual tree:
- ASCII connectors (`├─`, `└─`, `│`) for parent-child
- Active-path marker (`*`) on every entry from root to current leaf
- Filter modes: all steps, failed-only, active-path-only
- Labels (user bookmarks) for important decision points
- Fold completed sub-trees to reduce noise

### AD-11: Unified autocomplete (future)

One mental model for discovery:
- `/` at line start → slash commands (orchestrator control: `/pause`, `/retry`, `/switch-agent`, `/plan`, `/cost`)
- `@` mid-text → file path completion (via `fd`, respects `.gitignore`)
- Tab → per-command argument completion (e.g., `/switch-agent clau` → "claude-code")

All three use the same fuzzy ranking algorithm (AD-4).

### AD-12: Structured compaction for long plans (future)

When planning context exceeds limits, use structured summaries: `Plan Goal / Steps Completed / Current Step / Files Modified / Constraints Discovered / Remaining Work`. Summaries update incrementally (merge with previous, don't regenerate). Track files read/modified across compactions.

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

### Area Ratings (2026-05-01 audit)

| Area | Score | Key gap |
|---|---|---|
| First-run experience | 5/10 | 3 steps minimum, 17 commands on first contact |
| Core feedback loop | 7/10 | Long-wait dead zones, no planner streaming |
| Error UX | 7/10 | Crash diagnostics excellent; recovery prompts lack consequence descriptions |
| Session management | 6/10 | 5 commands for what should be 1, opaque session IDs |
| Planning phase UX | 7/10 | Powerful but undiscoverable, no per-task reject |
| Cost visibility | 6/10 | Savings story buried, no hero stat, no historical tracking |
| Streaming output | 7/10 | No live preview during generation, diffs collapsed by default |
| Configuration | 6/10 | Progressive disclosure missing, three approval escape hatches |

### Specific feature targets

| Feature | What it does | Why |
|---|---|---|
| `diptych "feature"` shorthand | Bare positional arg = `diptych start "feature"` in instant mode | Zero-ceremony entry. No subcommand for the happy path. |
| `@file` syntax | `diptych "refactor auth" @context.md @screenshot.png` enriches planner context | Ad-hoc context injection without config or interaction. |
| `--help` with 10+ real examples | Not just flag descriptions — concrete command examples with explanations | First-impression quality. Users learn by example, not by flags. |
| `diptych continue` | Smart command: attaches if running, resumes if interrupted | Replaces mental model of ps/attach/detach/resume. |
| `diptych last` | Attach or resume the most recent session | 90% use case: "I left, I came back." |
| `diptych stats` | Cumulative savings across all sessions | Retention hook: "You've saved $47 across 23 sessions this month." |
| Hero savings post-run | "$0.12 actual vs $0.95 all-planner — 87% saved" | The one number that makes people switch. Copy-pasteable. |
| Cost-gated approval | "12 tasks \| Est. $0.14 \| Approve? [Y/n]" before impl starts | Transforms approval into the moment the user feels smart. |
| Planner heartbeat | Token counter or phase hint during long waits | Proof of life. "analyzing dependencies..." beats "still waiting..." |
| Streaming partial output | Last N lines from API implementer in real-time | Watch code materialize instead of staring at a spinner. |
| Per-task reject + regen | Flag tasks, press `R` to send back to planner | Don't rewind-all for one bad task in a 12-task plan. |
| Contextual footer keybindings | Footer changes based on cursor position | "Enter: expand \| e: edit \| d: delete \| Y: approve all" |
| Recovery consequence text | "retry-task: re-runs prompt, costs ~$0.02" | Users must understand what each recovery action DOES. |
| Auto-expand active diffs | Diffs expanded for running task, collapsed for completed | Don't make users press Ctrl+D to see what just happened. |
| Unify approval flags | `--auto` / `--approve none` / `--yolo` → one concept | Three escape hatches for the same thing is confusing. |
| Session numeric aliases | `diptych attach 1` instead of `diptych attach 20250412-143022-abc` | Respect the user's time. |
| HTML/Markdown session export | Export workflow results as shareable artifact | Share reports, demonstrate value, onboard teammates. |
| External `$EDITOR` integration | Open editor for long feature descriptions | Pasting multi-paragraph specs into a terminal input is painful. |
| Agent/profile cycling keybind | Ctrl+P cycles implementer profiles | Zero-friction switching mid-workflow. |

---

---

## Session Model Direction (future architecture)

The current session model is file-based (state.json + session.jsonl + artifacts). The target model adds tree structure and typed entries. This is the foundation for intelligent recovery, cost tracking, and workflow visibility.

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

Linear sessions lose context on recovery. When an agent attempt fails and we try a different approach, the linear model either:
- Keeps the failed context (wastes tokens)
- Deletes it (loses learning)

The tree model preserves both paths. Branch summarization extracts the learning into a compact form for the new branch.

---

## What We Will NOT Build

These are conscious anti-goals, not TODO items:

- **Custom TUI framework** — Ink 6.x with incremental rendering is sufficient. Custom differential rendering is a multi-month effort with no user-visible gain.
- **Extension/plugin system** — Our hook system (allow/deny/warn/crash) is the right abstraction for an orchestrator. Extensions are for tools that own the agent loop; we don't.
- **Model registry** — We delegate model management to the providers (ollama, LM Studio, OpenRouter). No model catalog, no download management.
- **OAuth/login flows** — Authentication belongs to the child agents (claude-code, codex). We pass API keys in config.
- **Parallel same-checkout writes** — Git doesn't support this safely. Worktrees or sequential execution only.
