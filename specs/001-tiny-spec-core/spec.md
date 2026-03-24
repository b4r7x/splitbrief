# Feature Specification: tiny-spec v0.1 — Cost-Optimized AI Coding Orchestrator

**Feature Branch**: `001-tiny-spec-core`
**Created**: 2026-03-24
**Status**: Draft

## Vision

tiny-spec is an open-source CLI tool that orchestrates two AI coding sessions side by side — one running an expensive model (Claude Code with Opus) for planning/validation, and one running a cheap/local model (OpenCode with Ollama/LM Studio) for implementation. The expensive model writes detailed specs; the cheap model implements them. The result: $100/mo feels like $300+.

## User Scenarios & Testing

### US1 — Spec-Driven Feature Development (P1)

A developer has a feature to build. Instead of spending all their Opus tokens on implementation, they run `tiny-spec` which opens a split-pane terminal. The left pane runs Claude Code (Opus) which researches the codebase, writes a detailed specification, breaks it into atomic tasks with tests, and generates implementation prompts. The right pane runs OpenCode with a local model, receiving tasks one-by-one and implementing them. After each task, automated validation runs. If it passes, the next task starts. If it fails, the local model retries (max 3). If still failing, the task escalates to Opus.

**Acceptance Scenarios**:

1. **Given** a project directory and a feature description, **When** the user runs `tiny-spec start "add user authentication"`, **Then** the tool opens a split-pane TUI with Claude Code on the left and OpenCode on the right.

2. **Given** a running session, **When** Opus finishes writing the spec, **Then** the spec is saved as `.tiny-spec/current/spec.md` and the user can review it before proceeding.

3. **Given** an approved spec, **When** the plan phase runs, **Then** Opus generates `.tiny-spec/current/plan.md` and `.tiny-spec/current/tasks.md` with atomic, self-contained tasks.

4. **Given** tasks ready for implementation, **When** implementation starts, **Then** each task is fed to OpenCode one-by-one with full context (current code, spec, test expectations) inlined in the prompt.

5. **Given** a task implementation, **When** automated validation (tsc, lint, tests) passes, **Then** the task is marked complete, changes are committed, and the next task begins.

6. **Given** a task that fails validation 3 times, **When** escalation triggers, **Then** the task is sent to Claude Code (Opus) for implementation or fix guidance.

7. **Given** all tasks complete, **When** the final validation runs, **Then** Opus reviews the full diff against the original spec and reports any gaps.

### US2 — Standalone Spec Generation (P2)

A developer wants to generate a detailed spec without running the full pipeline. They run `tiny-spec spec "feature description"` and get a complete spec file they can use manually with any AI tool.

**Acceptance Scenarios**:

1. **Given** a feature description, **When** the user runs `tiny-spec spec "add rate limiting"`, **Then** Opus generates a spec.md with requirements, acceptance scenarios, and test expectations.

2. **Given** a generated spec, **When** the user runs `tiny-spec plan`, **Then** Opus generates plan.md with architecture decisions and tasks.md with atomic implementation tasks.

### US3 — Configuration & Model Selection (P2)

A developer configures which models to use for implementation and where they run.

**Acceptance Scenarios**:

1. **Given** first run, **When** no config exists, **Then** the tool runs `tiny-spec init` which detects available local models (Ollama/LM Studio) and creates `.tiny-spec/config.yaml`.

2. **Given** a config file, **When** the user specifies `implementer.provider: ollama` and `implementer.model: qwen2.5-coder:7b`, **Then** OpenCode uses that model for implementation.

3. **Given** a config file, **When** the user specifies `implementer.provider: lm-studio`, **Then** OpenCode connects to LM Studio's API at `localhost:1234`.

## Functional Requirements

### FR1: Split-Pane TUI
- Two-pane terminal interface using Ink (React for CLI)
- Left pane: Claude Code session output (read-only view of its activity)
- Right pane: OpenCode session output (read-only view of its activity)
- Bottom bar: status (current phase, task progress, model info)
- Top bar: project name, feature name, elapsed time
- Keyboard: `q` quit, `Tab` switch focus, `Enter` approve spec/plan, `s` skip task, `e` escalate task

### FR2: Workflow State Machine
States: `idle` → `researching` → `specifying` → `planning` → `tasking` → `implementing` → `validating` → `complete`

Transitions:
- `idle` → `researching`: User provides feature description
- `researching` → `specifying`: Opus has explored the codebase
- `specifying` → `planning`: User approves spec (or auto-approve with `--auto`)
- `planning` → `tasking`: Opus has written plan, generates tasks
- `tasking` → `implementing`: Tasks generated, user approves (or `--auto`)
- `implementing` → `validating`: All tasks complete (or max escalations reached)
- `validating` → `complete`: Opus approves final diff
- Any state → `idle`: User cancels (`q` or Ctrl+C)

### FR3: Spec Generation (Opus Phase)
- Opus reads the codebase (via Claude Code's built-in tools)
- Generates spec.md following the tiny-spec template
- Includes: user scenarios, acceptance criteria, functional requirements
- Generates plan.md with architecture decisions, file structure, dependencies
- Generates tasks.md with atomic tasks, each containing:
  - YAML frontmatter: id, title, action (create/modify/delete), file, depends_on
  - Context: relevant current code inlined
  - Task description: what to implement
  - Function signature: exact types
  - Test cases: concrete input/output pairs
  - Constraints: what not to do
  - Pattern: example from codebase if applicable

### FR4: Task Execution (Local Model Phase)
- Parse tasks.md into ordered task list
- For each task:
  1. Build a self-contained prompt from the task spec
  2. Send to OpenCode via headless mode (`opencode run "prompt"`)
  3. Wait for OpenCode to complete
  4. Run validation pipeline
  5. On success: commit changes, mark task complete, continue
  6. On failure: feed error back to OpenCode, retry (max 3)
  7. On max retries: escalate to Claude Code

### FR5: Validation Pipeline
For each completed task, run in order:
1. TypeScript compiler (`tsc --noEmit`) or equivalent
2. Linter (ESLint/Biome if configured)
3. Test runner (if tests exist for the changed files)
4. If all pass: task is done
5. If any fail: capture error output, format as structured feedback, retry

### FR6: Escalation to Opus
When a task fails 3 times with the local model:
- Send to Claude Code: the task spec + the local model's last attempt + the error
- Claude Code fixes it using Opus
- Result is committed and pipeline continues

### FR7: Configuration
`.tiny-spec/config.yaml`:
```yaml
planner:
  tool: claude-code          # or: claude-api
  model: opus                # uses Claude Code's model config

implementer:
  tool: opencode             # or: aider, custom
  provider: ollama           # or: lm-studio, openrouter, deepseek
  model: qwen2.5-coder:7b   # model identifier
  api_base: http://localhost:11434  # optional override
  context_length: 32768      # context window to use
  temperature: 0.1

validation:
  typecheck: true
  lint: true
  test: true
  test_command: npm test     # custom test command

workflow:
  auto_approve_spec: false   # require user approval of spec
  auto_approve_plan: false   # require user approval of plan
  max_retries: 3             # retries before escalation
  commit_per_task: true      # git commit after each task
```

### FR8: File Structure
```
.tiny-spec/
├── config.yaml              # Project configuration
├── current/                 # Current active feature
│   ├── spec.md              # Generated specification
│   ├── plan.md              # Generated implementation plan
│   ├── tasks.md             # Generated task list
│   └── state.json           # Workflow state (current task, retries, etc.)
└── history/                 # Completed features (archived)
    └── 2026-03-24-user-auth/
        ├── spec.md
        ├── plan.md
        ├── tasks.md
        └── summary.md       # What was done, what escalated, stats
```

## Non-Functional Requirements

- **Startup time**: < 2 seconds to show TUI
- **Task handoff**: < 1 second between task completion and next task start
- **Memory**: < 200MB RSS for the orchestrator itself
- **Compatibility**: macOS (primary), Linux (secondary), Windows (future)
- **Node.js**: 22+ (native TypeScript stripping)

## Assumptions

- User has Claude Code installed and authenticated ($100+ plan)
- User has OpenCode installed (`npm install -g @opencode/cli` or similar)
- User has Ollama or LM Studio running with at least one coding model pulled
- Project has a `package.json` or equivalent (for validation commands)
- Git is initialized in the project directory

## Out of Scope (v0.1)

- Prain integration (future)
- MCP server mode (future)
- Parallel task execution via git worktrees (future)
- Custom spec templates (future)
- Web dashboard / GUI (future)
- Windows support (future)
- Aider as implementer backend (future, but architecture supports it)
