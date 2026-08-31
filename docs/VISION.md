# SPLITBRIEF — Vision & Strategic Direction

## What SPLITBRIEF IS

An orchestrator for two coding tools. One plans, the other executes, the review seat reads the result, and SPLITBRIEF owns everything in between:

- **Planner** — the stronger of the two. Researches the repo, compiles Task Briefs, decides when a spec is worth the cost, answers escalations, and reviews the finished diff against the spec and the briefs unless the review seat is assigned elsewhere.
- **Implementer** — the weaker model, reached either as a tool CLI driving a cheaper model or as an API endpoint. Executes one Task Brief at a time in a fresh context. The transport is the user's choice; SPLITBRIEF does not privilege one.
- **SPLITBRIEF** — owns the contract (the Task Brief), the isolation the implementer works in, the validation pipeline, retry, escalation, and the evidence trail.

The argument for the split is quality, not price. A model reviewing its own output repeats its own blind spots — the assumptions that produced the bug are the same ones reading the diff — so an implementer and a reviewer from **different labs** catch issues a same-lab pair misses, and the gap is widest on logic errors and edge cases ([MindStudio](https://www.mindstudio.ai/blog/cross-vendor-ai-agent-review-claude-codex), [Augment Code](https://www.augmentcode.com/guides/adversarial-code-review) report the effect; SPLITBRIEF has not measured it — see [DIRECTION.md](./DIRECTION.md#what-we-measure)). SPLITBRIEF is built around that pairing: the review seat reads what the implementer wrote, and a deterministic pipeline (typecheck → lint → test) — not the implementer's own opinion — decides whether the change is correct.

Lower cost follows from putting the mechanical half of the work on the cheaper tool. It is reported after the run; it is not the reason to switch.

## What SPLITBRIEF is NOT

- **NOT a universal AI connector** — we don't "connect any AI to any AI"
- **NOT Claude Squad / Overstory** — we don't manage multiple parallel agent sessions
- **NOT a multi-agent coordinator** — two roles (planner + implementer) filling three seats (plan, build, review), clear hierarchy
- **NOT a swarm manager** — no dynamic agent count, agent racing, or same-checkout parallel writing
- **NOT a generic orchestration framework** — opinionated workflow centered on Task Briefs, with specs only when the work needs more structure
- **NOT a kanban board or project-management system** — no boards, tickets, or cross-team task tracking
- **NOT a plan archive** — sessions are execution records scoped to one workflow each, not a long-lived store of past plans
- **NOT a cross-plan dependency tracker** — SPLITBRIEF reasons about one workflow at a time, not dependencies across plans

An implementer pool, when enabled, is profile selection inside the single implementer role. It chooses the cheapest capable worker for a Task Brief; it is not dynamic agent count, agent racing, or same-checkout parallel writing.

Two roles, three seats. The third seat is the final review that the planner has always performed, made assignable to a different tool. It runs the same planner/implementer contract: one stateless, read-only call over the run diff. It cannot plan, cannot write files, and holds no session.

So the anti-goals above stay in force exactly as written: assigning an existing seat to a different tool does not add a dynamic agent count (the seat count is fixed at three), does not wrap an agent in an agent (the reviewer is called by SPLITBRIEF, not by the planner), and does not introduce coordination between agents (the reviewer talks to nobody — it reads a diff and returns a verdict). It is the cross-lab argument of the split itself, applied to the review of the diff.

## USP — Why This Exists

| Tool | What it does | Why SPLITBRIEF is different |
|------|-------------|--------------------------|
| Two-tool orchestrators (Merlin, claw-orchestrator, Codex-Orchestration, OmniAgent Polly) | Drive two coding CLIs from one control loop | Same niche, occupied. What differs is what sits between the two tools: a Task Brief contract, an owned validation pipeline, retry, escalation, and evidence — not message passing. |
| Claude Squad | Manages multiple Claude Code/Codex/Aider instances in parallel | Parallel sessions of one role. No planning/implementation split, so nothing reviews anything else. |
| Agent Orchestrator (Composio) | Parallel coding agents with git worktrees | Multi-agent coordination. Work is not compiled into briefs and not reviewed by a second tool. |
| Overstory | Multi-agent with 11 runtimes, SQLite mail | Coordination complexity. No Task Brief handoff, no owned validation. |
| Claude Code native teams | Multiple Claude Code sessions coordinating | One lab on both sides — the reviewer inherits the implementer's blind spots. |

**Differentiator**: two tools from different labs, with SPLITBRIEF holding the contract between them — brief compilation, isolation, validation, retry, escalation, evidence. The spec → plan → tasks pipeline is not the differentiator; by 2026 it is table stakes.

## Strategic Decisions

### 1. Stay a two-tool orchestrator

Don't pivot to "universal connector", and don't pivot to N agents. Two roles, one contract between them, three fixed seats — plan, build, review — and SPLITBRIEF owning the enforcement. The review seat may point at a third tool, which buys the cross-lab read on the diff without buying a third role: it is still the planner's review call, with the same prompt and the same output. Cost is an outcome of that shape, not the thing being optimized for.

### 2. Interactive TUI picker — YES

Interactive model/provider selection in `start` command. Auto-detect available planners and running implementer endpoints. No more editing YAML to get started.

### 3. Subprocess implementer — YES, on equal footing

`implementer.kind: cli` / `agent` / `shell` runs a subprocess instead of an OpenAI-compatible chat call, which is how a tool CLI running a cheaper model becomes the implementer. `kind: api` covers the endpoint path. Neither is the privileged default: the implementer is defined by being the weaker model, not by the transport that reaches it, and both paths get the same prompt, isolation, and validation treatment.

### 4. Tool calls in implementer — the anti-goal is retired, nothing replaces it yet

The old rationale was that 7B–27B models cannot produce strict tool-call payloads. That premise expired: 2026 local coder models (Qwen3-Coder 30B, Devstral Small 2 24B) are credible tool-callers ([RunLocalModel](https://runlocalmodel.com/best-local-coding-llm-2026.html)). Half the pipeline already runs on tools anyway — a `direct` implementer (`kind: cli`, `agent`, `agent-sdk`) edits files with its own tooling and SPLITBRIEF never sees the call protocol, only the resulting diff.

What replaces the anti-goal is open. A SPLITBRIEF-owned tool-call protocol on the `extracted-code` path (`kind: api`, `shell`) would add a second control and approval surface, and nothing yet shows it earns that. The blanket "never" is gone; the case for "yes" has not been made.

### 5. The implementer runs one brief, never the workflow

An implementer may be a full coding agent that writes files itself — a first-class path, not a workaround. What it never gets is the workflow: SPLITBRIEF owns the task boundary, isolation, validation, retry, escalation, evidence, and checkpoint policy. The implementer is by construction the weaker model, so it must not be the thing deciding whether its own work is correct.

### 6. OpenCode-inspired TUI (v0.5 — 2026-03-31)

The TUI visual language uses opencode as a reference point. Key principles:

**Why opencode as reference**: opencode shows that a terminal UI can feel refined through simple, replicable patterns — not GPU acceleration or custom renderers.

**Design language** (achievable in Ink 6):
- **Background color stepping** (3 levels: `#0a0a0a` → `#141414` → `#1e1e1e`) instead of box-drawing borders
- **Left-colored accent lines** (`┃`) for message ownership — accent for planner, primary for user, warning for escalation, error for failures
- **Compact tool calls** — one-line format (`. description  result`) in muted color, expandable
- **Color-coded diffs** — teal additions on dark teal bg, red removals on dark red bg
- **Braille spinners** (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80ms) instead of text spinners
- **Markdown rendering** in planner text — headings in accent, code blocks highlighted, bold in warning

**What we CAN'T replicate** (and don't need to):
- opencode uses OpenTUI (Zig native core, 60fps, GPU). We use Ink 6 with full-screen redraw via react-reconciler + Yoga layout (30fps cap). Ink erases and rewrites the entire output on each state change — it does NOT render line-by-line. `incrementalRendering` (Ink 6.5+) would diff the output and rewrite only the changed lines, but Ink 6.8's incremental writer mis-positions the cursor for a frame shorter than the terminal, so the inline render path stays on Ink's standard writer; the DEC 2026 synchronized-output brackets Ink writes around every frame on a TTY outside CI (Ink 6.7+) are what prevent flicker in multiplexers.
- opencode has smooth animations. Ink's full-redraw architecture means animations are limited to spinners and progress bars.

**What we GAINED over previous approach**:
- Ink 6.7+ brackets every frame in DEC 2026 synchronized output on a TTY outside CI — no flicker in tmux/Zellij
- `<Static>` for completed events — zero re-render cost
- `backgroundColor` on `<Box>` (Ink 6.1+) — the depth effect that makes opencode look good
- Mouse zones Ink has no notion of — click, hover and scroll, on by default in fullscreen, off entirely under `--no-fullscreen` or `--no-mouse`, with hover opt-in via `--hover`

### 7. Clean architecture: engine + feature slices

Previous: tangled `orchestrator/` with 25+ files and a flat TUI component layer.

Current: `src/engine/` owns orchestration with zero React dependencies; `src/features/` owns TUI feature slices; `src/components/` and `src/hooks/` hold cross-feature UI primitives and hooks. Runtime commands live in `src/core/runtime/commands/`, and the command palette lives in `src/features/palette/`.

### 8. Stay on Ink 6.x

Evaluated alternatives:
- **@opentui/react** (OpenCode's framework, Zig core) — usable but requires Bun, v0.1.x, migration risk
- **Bubbletea** (Go) — not applicable (wrong language)
- **neo-blessed** — semi-maintained, not React

Ink works, we know React, and the whole-frame rewrite at the 30fps cap is fast enough — `incrementalRendering` stays off until ink >= 7.0.0 (see the render note above). Migrate to OpenTUI later if needed.

## Competitive Landscape (August 2026)

The niche has direct competitors now. "Orchestrate two coding CLIs" is occupied by **Merlin**, **claw-orchestrator**, **Codex-Orchestration** and **OmniAgent Polly**, among others. Spec-driven development became table stakes over the same period — spec-kit, Kiro, OpenSpec, BMAD, Antigravity and Claude Code all ship a version of it. The spec → plan → tasks pipeline is therefore no longer a differentiator on its own. What still differentiates is the pairing — planner and implementer from different labs, one reviewing the other — and what SPLITBRIEF enforces between them.

Demand moved the same way: third-party market research from August 2026 reports that the large majority of professional developers do not fully trust the correctness of AI-written code, and the tools that win produce reviewable, testable changes rather than more code.

Adjacent, multi-agent rather than two-role:

- **Claude Code native teams** — first-party multi-agent, but every session is the same expensive model from one lab
- **Claude Squad** (github.com/smtg-ai/claude-squad) — TUI manager for multiple agents in separate workspaces
- **Agent Orchestrator** (github.com/ComposioHQ/agent-orchestrator) — parallel agents, git worktrees, swappable backends
- **Overstory** (github.com/jayminwest/overstory) — 11 runtime adapters, tmux, SQLite mail
- **Ruflo** — multi-agent swarms for Claude Code
- **OpenCode** (opencode.ai) — polished TUI, OpenTUI framework, single-tool rather than a planner/implementer split

These tools primarily optimize parallel coordination or interface quality rather than the two-role split and the review that comes with it.

Sources: [Augment Code — open-source agent orchestrators](https://www.augmentcode.com/tools/open-source-agent-orchestrators) · [amux — AI agent orchestration 2026](https://amux.io/guides/ai-agent-orchestration-2026/) · [Microsoft — spec-driven development](https://developer.microsoft.com/blog/spec-driven-development-ai-native-engineering/) · [Faros — best AI coding agents 2026](https://www.faros.ai/blog/best-ai-coding-agents-2026) · [Augment Code — why multi-agent systems fail](https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them)

## Architecture Principles

See `.specify/memory/constitution.md` for the 6 constitutional principles:

1. **Two-Tool Orchestration** — two roles fill three seats: the stronger tool researches, plans, absorbs escalations and holds the review seat unless a reviewer is assigned; the weaker one executes briefs. Cost follows from the split
2. **Spec-Driven Development** — Task Briefs first; specs only for larger or riskier work
3. **Weaker-Model Implementation** — the implementer is a weaker model, not a weaker transport; a tool CLI and an API endpoint are equally supported and the user picks
4. **Functional Purity** — zero runtime classes, pure functions, ESM, no unnecessary comments
5. **Validate Before Checkpoint** — SPLITBRIEF owns the per-task validation pipeline; optional product commits only when configured; final review of the run diff (the planner's seat unless a reviewer is assigned)
6. **Identity & Anti-Goals** — two roles across three fixed seats, not N agents; visible orchestration is product identity, not scope creep

## Version History

> `v0.x` labels are feature milestones and do not match the semver in `package.json`. Current `package.json` version: `0.1.0`.

| Version | Date | Key Changes |
|---------|------|-------------|
| v0.1 | 2026-03 | Core orchestrator, 45 tasks, end-to-end workflow |
| v0.2 | 2026-03 | Pluggable backends (6 planners + shell), token dashboard, integration tests |
| v0.3 | 2026-03 | Conversational planning, TUI picker, agent-mode implementer, version detection |
| v0.4 | 2026-03 | TUI conversation flow redesign — event model, collapsible diffs, pipeline bar |
| v0.5 | 2026-03 | OpenCode visual restructure — Ink 6/React 19, Shiki highlighting, theme system, engine/ui architecture |
| v0.6 | 2026-04 | Core extraction (core/, cli/, types/), colocated tests, slash commands, skills, global keys |
| v0.7 | 2026-04 | Symmetric provider/implementer architecture; cleanup pass — useRef anti-patterns removed, TwoColumnPicker Context eliminated, layer inversions fixed, tsconfig tier-2 strict flags, Biome linter, doc accuracy pass |
