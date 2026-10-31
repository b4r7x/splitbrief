# SPLITBRIEF — Product & Engineering Direction

What SPLITBRIEF optimizes for, where it's going, and what tradeoffs we accept. Read `VISION.md` for identity and competitive framing; this doc is about **how we build**. Point-in-time status — what was built when, and what is still open — lives in the issue tracker.

---

## UX principles

SPLITBRIEF is a CLI tool. CLI tools are loved when they respect the developer's time and attention. Seven principles guide every UX decision:

### 1. Zero-ceremony entry

`splitbrief "fix the typo in README"` must work. No subcommand, no prior `init`, no config file for single-shot tasks. Auto-detect available models. Reserve `start` as explicit subcommand for power users; bare positional arg is the default path.

### 2. Heartbeat over silence

Any wait > 5 seconds must show proof of life: token count incrementing, current phase name, or truncated excerpt. The 60-second spinner is where trust dies. Users alt-tab, forget, and the session completes without them. Each reviewer check and each gate command at the run base publish `full_suite` running rows naming the check id and command. A reviewer check's byline and build block show its command and its clock. A gate command at the run base shows its id and clock at the end of the build block's counts line. While a reviewer check waits on the run of the same id at the run base, the byline and the activity line name that base command and its clock instead. The 60 seconds this principle names are now a threshold in the code: the Build progress block prints `last event 8s ago`, counting every second. Once a seat on a call has sent no output for 60 seconds (`UI_IDLE_WARN_MS`, `src/features/workflow/display/build-progress.ts`), the line names what the seat is doing: `No output for m:ss · running <command>` for a tool still open, `No output for m:ss · tools report when done` for a runner that reports tools only when they end, otherwise `No output for m:ss`. The watchdog's warn is `RUNNER_IDLE_WARN_MS` (five minutes by default, tunable per runner as `idleWarnMs`). It never ends the call.

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

## Architecture decisions

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

### AD-8: Branch summarization on recovery

When execution branches (a recovery decision sends execution back to an earlier point), call an LLM to summarize the abandoned branch in a structured format: Goal, Progress (Done / In Progress / Blocked), Key Decisions, Constraints Discovered, Next Steps.

Inject the summary with preamble: "A previous agent attempt was abandoned. Summary of what was tried:" — so the next attempt automatically knows what didn't work without carrying full token cost.

Track `readFiles` and `modifiedFiles` across compactions. Use an incremental UPDATE prompt: when compacting again, pass previous summary to LLM and ask to merge, not regenerate.

### AD-11: Unified autocomplete

One mental model for discovery:
- `/` at line start → slash commands (orchestrator control: `/pause`, `/retry`, `/switch-agent`, `/plan`, `/cost`)
- `@` mid-text → file path completion (via `fd`, respects `.gitignore`)
- Tab → per-command argument completion (e.g., `/switch-agent clau` → "claude-code")

All three use the same fuzzy ranking algorithm (AD-4).

### AD-12: Structured compaction for long plans (partial)

Implemented for transcript compaction: `workflow.compactionFormat` supports `auto`, `freeform`, and `structured`; `auto` selects structured JSON for `api` planners and freeform for subprocess planners. Structured summaries use `Plan Goal / Steps Completed / Current Step / Files Modified / Constraints Discovered / Remaining Work`, update incrementally by merging with the previous structured summary, and fall back to freeform text on validation failure.

---

## Implementer direction

> Status: product direction, implementation guidance.
> Last updated: 2026-08-04. Realigned to ADR-1 through ADR-4, which are folded into [the constitution](../.specify/memory/constitution.md).

This section is the source of truth for implementer direction. Other docs should describe the same product boundary in local terms, not redefine it.

### Purpose

SPLITBRIEF's non-goals are the canonical NOT-list in [VISION.md](./VISION.md). The core product direction is narrower:

```text
the stronger tool plans and reviews
  -> SPLITBRIEF turns that thinking into small executable Task Briefs
  -> a weaker model executes those briefs one task at a time, in an isolated checkout
  -> SPLITBRIEF holds the contract: context size, user edits, checkpoints, validation, drift, escalation, evidence
```

The value is the split itself. The stronger tool is used where quality changes the result: research, planning, ambiguity reduction, task decomposition, review, and escalation. Mechanical implementation goes to the weaker model whenever the task is small enough and sufficiently specified.

### Product identity

SPLITBRIEF orchestrates two coding tools: one plans and reviews, the other executes. SPLITBRIEF holds everything in between.

The pairing is strongest cross-lab — planner and implementer from different model labs — because a model reviewing its own output repeats its own blind spots. Spend is a reported fact of a run, not the headline: a run should be able to say what it spent, and the claim the product makes is a reviewable change with evidence behind it.

It owns:

- planning workflow,
- durable workflow sessions,
- Task Brief quality,
- task sizing and routing,
- isolation and Apply,
- checkpoint boundaries,
- conflict detection,
- validation,
- retry and escalation,
- session artifacts,
- evidence and drift reporting,
- TUI visibility.

It does not own a long-lived project-management database or generalized MCP tool execution, and it does not replace the capabilities of Claude Code, Codex, OpenCode, Kilo, or Copilot. The full non-goals list lives in [VISION.md](./VISION.md).

The core sentence is:

> SPLITBRIEF has the stronger tool decide what should happen, feeds the weaker one small safe chunks in an isolated checkout, proves the result itself, and stops before overwriting the user.

### Planner role

The planner is the stronger of the two tools, and usually the expensive one. It should be used when quality materially changes the result:

- understanding a rough user request,
- asking clarification questions,
- reading enough codebase context to produce a reliable plan,
- splitting work into atomic Task Briefs,
- identifying risks and stop conditions,
- estimating whether the weaker implementer is likely to succeed,
- reviewing drift after implementation,
- giving hints or taking over when the implementer fails.

The planner should not be used for routine mechanical edits when the weaker implementer can do the work safely.

### Implementer role

The implementer is a weaker **model**, not a weaker kind of tool. What makes something an implementer is the model behind it, not how the bytes travel.

Two transports are first-class and supported equally:

| Transport | Write mode | Example |
|---|---|---|
| Tool CLI driving a smaller model | `direct` — the agent writes files itself | Codex, Claude Code, OpenCode, Kilo, or Copilot pinned to a smaller model |
| Model behind an OpenAI-compatible API | `extracted-code` — the model returns file contents, SPLITBRIEF writes them | Ollama, LM Studio, or a custom endpoint |

SPLITBRIEF does not favour a transport. The user picks; both paths get the same prompt quality, the same isolation, and the same validation. Shell and agent subprocesses remain supported as the escape hatch for custom executors.

The write mode is not a free choice — it follows the runner kind, enforced in `src/core/schemas/implementer-config.ts`: `api` and `shell` return code, `cli` and `agent` write files.

The important point is that this is still one role: implementer. A pool means SPLITBRIEF can choose the capable executor whose context window best fits each Task Brief — it is profile selection, not the swarm/multi-agent behavior ruled out in [VISION.md](./VISION.md).

The implementer should receive a fresh, bounded prompt per task. It should not receive the whole plan, whole transcript, or every previous task unless the current brief explicitly depends on that context. Both write modes get a full system prompt — file scope, stop conditions, validation expectations, reporting format. Neither mode is the side path.

### Who owns validation

The implementer is by definition the weaker side. If its own assessment decided whether a task was done, the weakest link would set the quality bar. It does not.

Correctness is owned by two things:

- SPLITBRIEF's deterministic validation pipeline — the plan's checks, then the reviewer checks: SPLITBRIEF runs the project gate that the plan names in the run workspace under the reviewer command policy, before each final review (`src/engine/orchestrator/review-checks.ts`),
- the planner's review of the finished change.

An implementer implements; it does not run the project gates. The direct-writer preamble (`src/engine/spec/prompts/system.ts`) tells it: "SPLITBRIEF runs the checks after you hand back, and its verdict is the authority. Run no test, typecheck, lint, format, screenshot, render or other check command, not even the tests you write or a command the brief names." The brief's Tests section names the tests SPLITBRIEF runs, and the implementer writes or changes the ones in the files the brief lists. The P01 run showed why: one brief spent 13% of its tool calls on edits and 87% on reads, gates and renders. Whatever an implementer reports about its own validation lands in the evidence trail as a claim by the agent, never as a verdict.

The brief's files are suggestions. The implementer starts from them, edits another ordinary project file the change needs, and names it in its report as `Also changed (not suggested): <file> — <reason>`. Only a protected path (dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`) is off limits unless the brief asks for that operation.

This is where the cross-lab advantage lands in practice: the review that decides is done by a model that did not write the code.

### Fresh context per task

Local models often have limited context windows. A 32k context model cannot safely execute a 20-task plan if every task is appended to one long chat.

The required execution model is:

```text
Task Brief T001 -> worker call with fresh context
Task Brief T002 -> worker call with fresh context
Task Brief T003 -> worker call with fresh context
```

Each call includes only:

- the selected Task Brief,
- the relevant file contents or extracted code context,
- dependency outputs that are truly needed,
- validation expectations,
- constraints,
- escalation rules,
- retry or hint context when applicable.

If a task does not fit the selected worker's context window, SPLITBRIEF should not stuff more context into the prompt. It should either:

1. ask the planner to split the task,
2. route the task to a larger implementer,
3. escalate to the planner.

Large prompts are a planning failure, not a reason to make every worker remember the whole session.

### Brief grouping

A brief is one coherent, reviewable outcome, not a file: every path it writes is listed under `files`, with `file` as the anchor. A brief that creates `src/health.ts` and its `src/health.test.ts` is one outcome, because splitting it would hand the implementer a test with nothing to test.

The grouping rule is `sliceRuleText()` (`src/core/pipeline-spec/brief.ts`). The planner prompts and the portable skills render it; they do not restate it. The rule keeps tests, callers, wiring, fixtures and necessary documentation with their behavior, and it combines related corrections that share a contract, mechanism or code context. It splits independent outcomes, or a complex mechanism, when separate validation, context or recovery makes the work easier to execute correctly.

No brief count, file count or changed-line count decides a boundary, and no mode caps the number of briefs in a run. What bounds one brief is the real limit of its runner: the model context and the prompt transport, with the system text, skills and retry feedback included. A brief that does not fit follows the refusal path above; the brief is never truncated.

### Implementer pool

The implemented optional profile shape is:

```yaml
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b

implementerProfiles:
  default: local-qwen
  profiles:
    local-qwen:
      kind: api
      provider: ollama
      service: ollama
      offering: local
      apiBase: http://localhost:11434/v1
      model: qwen3-coder:30b
      contextLength: 32768
      capabilities:
        writesFiles: extracted-code
    small-cloud:
      kind: api
      provider: custom-endpoint
      service: custom-endpoint
      offering: payg
      apiBase: https://api.example-endpoint.com/v1
      apiKey: your-key
      model: qwen3-coder
      contextLength: 131072
      capabilities:
        writesFiles: extracted-code
    agent-cli:
      kind: cli
      tool: codex
      model: gpt-5-mini
      contextLength: 200000
      capabilities:
        writesFiles: direct
```

The implemented behavior is:

- default to the capable implementer with the smallest sufficient context window,
- consider context length before dispatch,
- consider runner kind and write mode (`extracted-code` profiles can only return one file's contents; `direct` profiles can edit in-scope files directly),
- keep a record of the routing decision,
- fall back predictably when validation fails, including recovery-time rerouting to a named larger profile for the current task,
- never parallel-write the same checkout in v1.

### Isolation and Apply

An implementer with `writesFiles: direct` needs somewhere to write that is not the user's working tree. That somewhere is a **git worktree, created once per run** — not a copy of the project per task.

- One worktree per run, at `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` (default `~/.local/state/...`) on a `splitbrief/<slug>` branch (`src/engine/orchestrator/isolation/create-worktree.ts`). Tasks share it. Outside `.git/` (direct-writing CLIs refuse paths there) and outside the project tree: it is a second copy of the source that survives every per-task validation, and a project-rooted test glob that reaches it counts every test twice.
- Project dependencies are reachable inside the worktree. A checkout without `node_modules` is a checkout where nothing runs: no typecheck, no tests, no useful self-check by the implementer.
- The worktree carries `.splitbrief/config.yaml` and `.splitbrief/hooks/` over from the real project, so hook and config behaviour matches.
- Worktree is the default, not the only option. A user may configure a different isolation strategy.
- `staged-copy` stays, as an explicit value and as the fallback when the worktree is unavailable (no git, no commit, a failed worktree creation). Its snapshots need no git.
- The per-task recursive copy into the system temp directory (`createStagedProject`) is no longer the default path.

**The user chooses where the implementer writes.** `workflow.isolation` takes `worktree`, `staged-copy` or `none`. `worktree` stays the default. `none` lets the implementer of every transport edit the user's checkout directly; validation and review run there, and a passing review closes the run with no Apply. Some stacks only work in the checkout (linked workspace packages, editable installs, a shared build cache). For those, readiness recommends `none` once, and writing the key confirms the choice. SPLITBRIEF never switches the worktree to the checkout automatically. In `none`, SPLITBRIEF still audits git writes during a call, halts a write outside the checkout, and saves every byte it reverts.

For a worktree or staged-copy run, Apply is the non-negotiable half. Work that stays inside the run workspace is not a delivered change: the reviewed result is written into the user's real project directory once, when the user applies it. Apply never overwrites a file that moved under SPLITBRIEF's feet; [WORKFLOW.md §Apply](./WORKFLOW.md#apply) owns the algorithm.

**A worktree is not a security boundary.** It isolates files, not the runtime — same ports, same database, same credentials on disk — and it shares hooks and config with the real repository by design. An implementer running in a worktree is code running with the user's privileges. Runner kinds `shell` and `agent` execute arbitrary commands with no shell or network sandbox, and the worktree does not change that. Documentation and UI must say so plainly rather than implying containment. The checkout mode removes even the file boundary, so it must say so too.

### Parallelism

Parallelism is not the first goal. The first goal is reliable execution on the weaker model. One worktree per run isolates the implementer from the user's checkout; it is not a licence for concurrent workers inside it.

Allowed in this direction:

- sequential task execution with fresh context,
- optional fallback to stronger implementer profiles,
- future parallel execution only when each worker owns a separate worktree or equivalent sandbox.

Not allowed in the first implementation:

- multiple workers writing the same working tree at once,
- multiple workers writing the same checkout at once,
- hidden background task fan-out,
- best-of-N workers racing on the same files,
- automatic merge of overlapping changes.

If parallel execution is later considered, it should be a separate design using one worktree per worker, and only for tasks with non-overlapping file ownership. Do not frame parallel writes as near-term work.

### User edits

The user can edit files manually while SPLITBRIEF is planning or implementing. Those edits are not noise. They are source-of-truth changes made by the owner of the repository.

SPLITBRIEF must distinguish:

- files already dirty before a task starts,
- files changed by SPLITBRIEF during a task,
- files changed by the user while SPLITBRIEF was waiting, prompting, validating, or applying,
- files changed by another process after a snapshot/checkpoint.

The default behavior is never to overwrite. Briefs build in the run workspace, so a checkout edit never halts a brief; Apply merges the checkout into the run's result and stops on a conflict instead of overwriting.

Examples:

```text
User edits unrelated file:
  continue; the call logs checkout_changed_during_call, and Apply carries the edit through.

User edits a file a pending brief will change:
  continue; Apply merges the edit with the brief's result.

User edits a file the run also changed, and the two cannot merge:
  Apply halts as apply-conflict and names the file and the workspace.
```

The right UX is not "SPLITBRIEF detected external changes, continue yes/no" only. The TUI should show which files changed, which tasks are affected, and what the safe choices mean.

### Checkpoints

Checkpointing is core to trust, but it should be framed as run safety, not git history management.

Useful checkpoints:

- before implementation begins,
- before each task,
- after each successful task,
- before final review,
- before rejecting a run.

Checkpoint restore must be hash-guarded so later user edits are not overwritten.

In this repository, agents must never run `git add`, `git stage`, or `git commit`. Product support for commits may exist, but this codebase's working rule is manual commits only. Docs should keep this distinction explicit.

### Tool calls

Tools belong to the underlying runner. Truth belongs to SPLITBRIEF.

That means:

- Claude Code, Codex, OpenCode, Kilo, or Copilot may use their own tools and MCP clients when they are the planner or implementer.
- SPLITBRIEF should not become another tool-calling agent that independently reads, writes, browses, and shells around the worker.
- SPLITBRIEF should run deterministic orchestration operations: file snapshots, git status/diff, validation commands, budget checks, drift checks, evidence writes, approval gates.
- SPLITBRIEF exposes no server of its own. It ships no MCP server, and an external agent reaches a run's artifacts by reading the session directory, not by calling into SPLITBRIEF.

### TUI direction

The TUI should make the invisible orchestration understandable.

The important screens are:

1. Intake/planning status.
2. Plan review and Task Brief editing.
3. Execution status by task.
4. Conflict/checkpoint decisions.
5. Context posture.
6. Final review and drift/evidence summary.

The TUI stays within the product boundary in [VISION.md](./VISION.md). It should answer practical questions:

- What is the planner doing?
- What will the implementer receive?
- Will this task fit the selected worker?
- Which files are in scope?
- What did the user change manually?
- What changed after the worker ran?
- What test or validation proves this task is done?
- What will happen if I approve, retry, skip, or rebase?

### Cleanup direction

Existing implementation has valuable pieces, but docs and product surface should be tightened around the core loop.

High-confidence cleanup:

- Update product docs that frame SPLITBRIEF as broad external-agent interop, kanban, archive, or plan-management product.
- Preserve session history/resume/browse/filter/search as core workflow surfaces, but distinguish them from a plan archive.
- Make the no-commit rule explicit for this repository, and separate it from optional product-level commit strategies.
- Update stale config examples that use old snake_case or old config keys.
- Reword Task Contract docs so external Kanban/Jira usage is not presented as the main purpose.
- Audit tests for behavior value, especially hook/wrapper tests and large UI tests that assert "no crash" rather than user-observable behavior.

Lower-confidence cleanup that should not happen blindly:

- Do not delete snapshots before deciding how checkpoint UX should work.
- Do not delete worktree support: it is the default isolation path, not a hypothetical future need.
- Do not reintroduce inline Task Brief editing just because an external editor round-trip feels less integrated; preserve the simple plan card plus the persisted `plan.json` editor contract unless product direction changes.

### Success criteria

This direction is successful when:

- a user can understand which tool is planning, which is executing, and why splitting them earns its keep,
- both transports — tool CLI on a smaller model and API model — reach the same bar, and neither reads as the fallback path,
- each implementer task is small enough to fit its selected context window,
- the implementer works in an isolated checkout where dependencies resolve and validation can actually run,
- every accepted change lands in the user's real project directory, and never on top of a file the user changed underneath it,
- correctness is decided by SPLITBRIEF's validation pipeline and the planner's review, never by the implementer's own claim,
- a finished run can report what it actually spent, as a measurement rather than a headline,
- the user can edit the plan before implementation,
- manual user edits are never silently overwritten,
- TUI explains current state without acting like a project-management tool,
- final review can compare planned work against actual changes,
- future agents can implement features from Task Briefs without reading this entire conversation.

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

## What we will NOT build

These are conscious anti-goals, not TODO items:

- **Custom TUI framework** — Ink 6.x is sufficient; the whole-frame rewrite at the 30fps cap is fast enough, and `incrementalRendering` stays off until ink >= 7.0.0. Custom differential rendering is a multi-month effort with no user-visible gain.
- **Extension/plugin system** — Our hook system (allow/deny/warn/crash) is the right abstraction for an orchestrator. Extensions are for tools that own the agent loop; we don't.
- **Model registry** — We delegate model management to the providers (ollama, LM Studio). No model catalog, no download management.
- **OAuth/login flows** — Authentication belongs to the child agents (claude-code, codex). We pass API keys in config.
- **Parallel same-checkout writes** — Git doesn't support this safely. Worktrees or sequential execution only.
- **Confinement for checks and seats, and per-action approval** — no OS sandbox or network proxy around checks or seats, no `workflow.approve: each` or `yolo`, and no per-action approval inside a seat (the Agent Client Protocol, a bridge to Claude Code's permission prompts, the Codex app-server). A check sandbox must keep every language's toolchain, cache and registry working, so it needs its own design; it would wrap the spawn in `runCommand` (`src/lib/process/spawn/run-command.ts`). What a check can reach today: [CONFIGURATION.md](./CONFIGURATION.md#what-a-check-can-reach).
