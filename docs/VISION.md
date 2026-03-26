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

## Strategic Decisions (2026-03-26)

### 1. Keep the cost-optimization focus

Don't pivot to "universal connector". The market for multi-agent orchestrators is crowded (Claude Squad, Overstory, Composio, etc.). The market for cost-optimized split orchestration is ours.

### 2. Interactive TUI picker — YES

Add interactive model/provider selection to `start` command. Auto-detect available planners and running implementer endpoints. No more editing YAML to get started.

### 3. Subprocess implementer — YES (as option)

Add `implementer.type: agent` that runs a subprocess command instead of OpenAI chat API. Lets users plug in custom bash wrappers, alternative CLIs, etc. But the default stays OpenAI-compatible API — it works and is simple.

### 4. Tool calls in implementer — NO

Small models (7B-27B) can't reliably produce tool call format. Current pipeline works: prompt → text → extract code → write file. Adding tool calls = massive complexity for marginal gain.

### 5. Don't wrap agents in agents

If the implementer IS a full coding agent (manages its own files/git/context), there's a conflict of control. tiny-spec owns file writing, validation, and git. The implementer returns code, nothing more.

### 6. Name change — open question

"tiny-spec" implies spec-driven development, which is accurate. If we rename, it should reflect cost-optimization, not "universal connector". No decision yet.

## Competitive Landscape (March 2026)

Multi-agent coding space is exploding:

- **Claude Code native teams** — first-party multi-agent, but all sessions use expensive Opus
- **Claude Squad** (github.com/smtg-ai/claude-squad) — TUI manager for multiple agents in separate workspaces
- **Agent Orchestrator** (github.com/ComposioHQ/agent-orchestrator) — parallel agents, git worktrees, swappable backends
- **Overstory** (github.com/jayminwest/overstory) — 11 runtime adapters, tmux, SQLite mail
- **Ruflo** — multi-agent swarms for Claude Code

None of these optimize for cost. They assume the same tier of model for all work.

## Architecture Principles

See `.specify/memory/constitution.md` for the 5 constitutional principles:

1. **Cost-Optimal Orchestration** — Opus only for tasks where quality matters; implementation on cheap models
2. **Spec-Driven Development** — No code without spec; self-contained task prompts
3. **Local-First Implementation** — Default to Ollama/LM Studio ($0); cloud is opt-in
4. **Functional Purity** — Zero classes, pure functions, ESM, no unnecessary comments
5. **Validate Before Commit** — tsc → lint → test per task; final Opus review

## Current State (March 2026)

- **v0.1**: Complete. 45 tasks. Core orchestrator works end-to-end.
- **v0.2**: In progress on branch `004-token-dashboard-integration-tests`
  - Pluggable planner backends (6 built-in + shell)
  - Token dashboard / cost tracking
  - Integration tests
  - Bug fixes and hardening
- **v0.3 features** (branch `006-conversational-planning`):
  - Conversational planning: planner can ask clarifying questions via `<!-- Q:{JSON} -->` markers
  - Interactive TUI picker for planner/implementer selection with auto-detection
  - Shell subprocess implementer (`implementer.type: shell`)
  - Constitution updated to v1.1.0 (added Principle VI: Identity & Anti-Goals)
  - Removed backward-compat planner wrapper; `spec` command uses factory
  - Codebase cleanup

## Known Problems & Open Questions (2026-03-26)

### Shell implementer doesn't work well for agent-style tools

The `implementer.type: shell` was designed with a simple stdin/stdout model: send prompt to stdin, read code from stdout. This works for simple scripts but **doesn't work for full coding agents** like claude-zai (Claude Code wrapper) because:

1. **Bash functions can't be spawned** — `spawn()` doesn't see shell functions, only executables on PATH. Workaround (`bash -c "source ~/.zshrc && claude-zai ..."`) is ugly and fragile.
2. **Agent-style tools manage their own files** — If the implementer IS a coding agent (like Claude Code via Z.AI), it writes files directly. But tiny-spec assumes it controls file writes via `extractCode()` → `applyCode()`. Two things writing to the same files = conflict.
3. **The stdin/stdout contract is too simple** — Agents like Claude Code use stream-json format with session IDs, tool use, etc. The simple "prompt in, code out" model doesn't capture this.

**Decision needed**: Should the shell implementer be redesigned to support agent-mode (where the implementer manages its own files and tiny-spec only validates/commits)? Or should we keep it simple and only support "dumb" implementers that return code text?

This is fundamentally about Decision #5 ("Don't wrap agents in agents"). If we allow agent-style implementers, we need to rethink who owns file writes, git, and validation.

### Interactive TUI needs work

The current interactive implementation has rough edges:

1. **Picker works** — auto-detection and selection for planner/implementer is functional
2. **Question protocol works** — `<!-- Q:{JSON} -->` markers are parsed from planner stream
3. **But the conversational flow hasn't been battle-tested** — it was implemented by agents without manual end-to-end testing with real Claude Code
4. **Comment-on-approval flow** — the regenerate loop (comment → planner regenerates → re-approve) depends on planner session continuity which only works with claude-code and agent-sdk backends
5. **The TUI input components exist** but need real-world UX testing — focus management, keyboard handling, and layout may have issues

### Claude Code CLI compatibility

Claude Code v2.1.84 requires `--verbose` flag when using `--output-format stream-json` with `-p`. This wasn't documented in earlier versions. Fixed in `claude-code.ts` but indicates the CLI API is a moving target — we need to handle version differences gracefully.

## Near-term Priorities

1. **Rethink shell implementer for agent-style tools** — The current stdin/stdout model is too simple. Need to decide: support agent-mode implementers, or only "dumb" code generators?
2. **End-to-end test the conversational flow** — Run the full pipeline with real Claude Code and real Ollama to validate question asking, approval commenting, and file persistence
3. Cost reporting (token dashboard with per-task breakdown) — partially done
4. Integration test coverage — in progress
5. Multi-language support (beyond TypeScript/JavaScript)
6. Prompt size limit enforcement (8K/16K) in formatter

## Spec History

| Directory | Status | Content |
|-----------|--------|---------|
| `specs/001-tiny-spec-core/` | Historical | Original bootstrap spec. v0.1 prototype. |
| `specs/002-cost-optimized-orchestrator/` | Reference | Main v0.1 spec. 4 user stories, 24 FRs, 45 tasks. All complete. |
| `specs/003-v02-fixes-robustness/` | Active | v0.2 fixes: retry/escalation bugs, config validation, test coverage. |
| `specs/004-token-dashboard-integration-tests/` | Active | Current branch. Pluggable backends, token dashboard, integration tests. |
