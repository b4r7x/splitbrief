# tiny-spec — Vision & Strategic Direction

## What tiny-spec IS

Cost-optimized AI coding orchestrator. Splits coding work between:

- **Planner** (expensive/smart AI) — research, spec, plan, task breakdown, escalation, review
- **Implementer** (cheap/local AI) — code generation task by task

Core value: **same planning quality, 50%+ cost savings** by offloading mechanical coding to cheap models.

## What tiny-spec is NOT

- **NOT a universal AI connector** — we don't "connect any AI to any AI"
- **NOT Claude Squad / Overstory** — we don't manage multiple parallel agent sessions
- **NOT a multi-agent coordinator** — exactly 2 roles (planner + implementer), clear hierarchy
- **NOT a generic orchestration framework** — opinionated workflow (spec → plan → tasks → implement → validate → commit)

## USP — Why This Exists

| Tool | What it does | Why tiny-spec is different |
|------|-------------|--------------------------|
| Claude Squad | Manages multiple Claude Code/Codex/Aider instances in parallel | Doesn't split planning from implementation. Same expensive model for everything. |
| Agent Orchestrator (Composio) | Parallel coding agents with git worktrees | Multi-agent coordination, not cost optimization. |
| Overstory | Multi-agent with 11 runtimes, SQLite mail | Coordination complexity. No planner/implementer split. |
| Claude Code native teams | Multiple Claude Code sessions coordinating | All sessions use Opus. No cost savings. |

**Our moat**: Intelligent planner/implementer split with validation, retry, and escalation pipeline. Nobody else does this.

## Strategic Decisions

### 1. Keep the cost-optimization focus

Don't pivot to "universal connector". The market for multi-agent orchestrators is crowded (Claude Squad, Overstory, Composio, etc.). The market for cost-optimized split orchestration is ours.

### 2. Interactive TUI picker — YES

Interactive model/provider selection in `start` command. Auto-detect available planners and running implementer endpoints. No more editing YAML to get started.

### 3. Subprocess implementer — YES (as option)

`implementer.type: agent` runs a subprocess command instead of OpenAI chat API. Lets users plug in custom bash wrappers, alternative CLIs, etc. Default stays OpenAI-compatible API.

### 4. Tool calls in implementer — NO

Small models (7B-27B) can't reliably produce tool call format. Current pipeline works: prompt → text → extract code → write file. Adding tool calls = massive complexity for marginal gain.

### 5. Don't wrap agents in agents

If the implementer IS a full coding agent, there's a conflict of control. tiny-spec owns file writing, validation, and git. The implementer returns code, nothing more.

### 6. OpenCode-inspired TUI (v0.5 — 2026-03-31)

The TUI visual language is modeled after opencode — the best-looking terminal coding assistant. Key principles:

**Why opencode as reference**: opencode has the most polished terminal UI in the AI coding space. It achieves visual quality through simple, replicable patterns — not GPU acceleration or custom renderers.

**Design language** (achievable in Ink 6):
- **Background color stepping** (3 levels: `#0a0a0a` → `#141414` → `#1e1e1e`) instead of box-drawing borders
- **Left-colored accent lines** (`┃`) for message ownership — accent for planner, primary for user, warning for escalation, error for failures
- **Compact tool calls** — one-line format (`. description  result`) in muted color, expandable
- **Syntax-highlighted diffs** via Shiki 4.x — teal additions on dark teal bg, red removals on dark red bg
- **Braille spinners** (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80ms) instead of text spinners
- **Markdown rendering** in planner text — headings in accent, code blocks highlighted, bold in warning

**What we CAN'T replicate** (and don't need to):
- opencode uses OpenTUI (Zig native core, 60fps, GPU). We use Ink 6 with full-screen redraw via react-reconciler + Yoga layout (30fps cap). Ink erases and rewrites the entire output on each state change — it does NOT render line-by-line. Mitigated by `incrementalRendering` (Ink 6.5+) which diffs output and only rewrites changed lines, and `synchronizedOutput` (Ink 6.7+) which prevents flicker in multiplexers.
- opencode has mouse support. Ink doesn't.
- opencode has smooth animations. Ink's full-redraw architecture means animations are limited to spinners and progress bars.

**What we GAINED over previous approach**:
- Ink 6.5+ has native `incrementalRendering` — only changed lines redraw
- Ink 6.7+ has `synchronizedOutput` — no flicker in tmux/Zellij
- `<Static>` for completed events — zero re-render cost
- `backgroundColor` on `<Box>` (Ink 6.1+) — the depth effect that makes opencode look good

### 7. Clean architecture: engine/ + ui/

Previous: tangled `orchestrator/` with 25+ files and `tui/` with components. Bulletproof React features pattern was attempted and rejected — artificial feature boundaries don't fit a single-view CLI app.

Current: `engine/` (zero React deps, all business logic) + `ui/` (flat, ~14 Ink components) + `hooks/` (bridge). Theme is project-level (`src/theme.ts`), importable by both engine and UI.

### 8. Stay on Ink 6.x

Evaluated alternatives:
- **@opentui/react** (OpenCode's framework, Zig core) — production-ready but requires Bun, v0.1.x, migration risk
- **Bubbletea** (Go) — not applicable (wrong language)
- **neo-blessed** — semi-maintained, not React

Ink works, we know React, incremental rendering is good enough. Migrate to OpenTUI later if needed.

## Competitive Landscape (March 2026)

Multi-agent coding space is exploding:

- **Claude Code native teams** — first-party multi-agent, but all sessions use expensive Opus
- **Claude Squad** (github.com/smtg-ai/claude-squad) — TUI manager for multiple agents in separate workspaces
- **Agent Orchestrator** (github.com/ComposioHQ/agent-orchestrator) — parallel agents, git worktrees, swappable backends
- **Overstory** (github.com/jayminwest/overstory) — 11 runtime adapters, tmux, SQLite mail
- **Ruflo** — multi-agent swarms for Claude Code
- **OpenCode** (opencode.ai) — beautiful TUI, OpenTUI framework, but no cost optimization

None of these optimize for cost. They assume the same tier of model for all work.

## Architecture Principles

See `.specify/memory/constitution.md` for the 6 constitutional principles (v1.3.1):

1. **Cost-Optimal Orchestration** — Opus only for tasks where quality matters; implementation on cheap models
2. **Spec-Driven Development** — No code without spec; self-contained task prompts
3. **Local-First Implementation** — Default to Ollama/LM Studio ($0); cloud is opt-in
4. **Functional Purity** — Zero classes, pure functions, ESM, no unnecessary comments
5. **Validate Before Commit** — tsc → lint → test per task; final Opus review
6. **Identity & Anti-Goals** — Not a multi-agent coordinator; beautiful orchestration UX is product identity, not scope creep

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
