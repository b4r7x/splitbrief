# Tasks: tiny-spec v0.1

**Input**: Design documents from `/specs/001-tiny-spec-core/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (reference)

---

## Phase 1: Project Setup

**Purpose**: Initialize project structure and dependencies

- [ ] T001 Create project directory structure per plan.md (`src/`, `src/tui/`, `src/orchestrator/`, `src/spec/`, `src/utils/`, `tests/`)
- [ ] T002 Initialize package.json with `"type": "module"`, `"engines": {"node": ">=22"}`, bin entry `tiny-spec`, scripts (dev, build, test)
- [ ] T003 [P] Configure tsconfig.json with strict mode, ESM target, JSX react-jsx (for Ink), `dist/` outDir
- [ ] T004 [P] Add runtime dependencies: ink, @inkjs/ui, react, @anthropic-ai/sdk, openai, yaml, simple-git, commander
- [ ] T005 [P] Add dev dependencies: @types/node, @types/react, typescript
- [ ] T006 Create `.gitignore` with node_modules, dist, .tiny-spec/current/state.json

**Checkpoint**: Project scaffolding ready, `npm install` succeeds

---

## Phase 2: Types & Configuration

**Purpose**: Define all types and configuration loading

- [ ] T007 Define all shared types in `src/types.ts`:
  ```typescript
  // Workflow states
  type Phase = 'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'planning' | 'reviewing-plan' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete';

  interface WorkflowState {
    phase: Phase;
    feature: string;
    currentTaskIndex: number;
    attempt: number;
    tasks: Task[];
    completedTasks: string[];  // task IDs
    escalatedTasks: string[];  // task IDs
    startedAt: string;         // ISO timestamp
  }

  // Task definition (parsed from tasks.md)
  interface Task {
    id: string;
    title: string;
    action: 'create' | 'modify' | 'delete';
    file: string;
    dependsOn: string[];
    description: string;
    signature?: string;
    currentCode?: string;
    tests: string[];
    constraints: string[];
    pattern?: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed' | 'escalated';
  }

  // Configuration
  interface Config {
    planner: {
      tool: 'claude-api' | 'claude-code';
      model: string;
    };
    implementer: {
      tool: 'openai-compat' | 'opencode';
      provider: 'ollama' | 'lm-studio' | 'openrouter' | 'deepseek';
      model: string;
      apiBase: string;
      contextLength: number;
      temperature: number;
    };
    validation: {
      typecheck: boolean;
      lint: boolean;
      test: boolean;
      testCommand: string;
    };
    workflow: {
      autoApproveSpec: boolean;
      autoApprovePlan: boolean;
      maxRetries: number;
      commitPerTask: boolean;
    };
  }

  // Validation result
  interface ValidationResult {
    passed: boolean;
    stage: 'typecheck' | 'lint' | 'test';
    error?: string;
    output?: string;
  }

  // Summary after completion
  interface Summary {
    feature: string;
    totalTasks: number;
    completedByLocal: number;
    escalatedToOpus: number;
    totalTime: number;        // ms
    validationFailures: number;
  }
  ```

- [ ] T008 Implement config loader in `src/config.ts`:
  - `loadConfig(projectDir: string): Config`  -  reads `.tiny-spec/config.yaml`, merges with defaults
  - `createDefaultConfig(): Config`  -  returns sensible defaults (ollama, qwen2.5-coder:7b)
  - `initConfig(projectDir: string): void`  -  creates `.tiny-spec/config.yaml` with defaults if not exists
  - `detectLocalModels(): Promise<{provider: string, models: string[]}[]>`  -  checks Ollama (`http://localhost:11434/api/tags`) and LM Studio (`http://localhost:1234/v1/models`) for available models

- [ ] T009 Implement state manager in `src/state.ts`:
  - `createInitialState(feature: string): WorkflowState`
  - `saveState(projectDir: string, state: WorkflowState): void`  -  writes `.tiny-spec/current/state.json`
  - `loadState(projectDir: string): WorkflowState | null`  -  reads state, returns null if not exists
  - `transition(state: WorkflowState, action: StateAction): WorkflowState`  -  pure state transitions
  - StateAction union type for all valid transitions

**Checkpoint**: Types defined, config loads from YAML, state machine transitions work

---

## Phase 3: Utility Modules

**Purpose**: Git operations, file system helpers, process management

- [ ] T010 Implement git utilities in `src/utils/git.ts`:
  - `isGitRepo(dir: string): Promise<boolean>`
  - `commitChanges(dir: string, message: string): Promise<string>`  -  stages all, commits, returns hash
  - `getCurrentDiff(dir: string): Promise<string>`  -  unstaged + staged diff
  - `getFileContent(dir: string, filePath: string): Promise<string | null>`  -  read file, null if not exists

- [ ] T011 Implement file system helpers in `src/utils/fs.ts`:
  - `ensureTinySpecDir(projectDir: string): void`  -  creates `.tiny-spec/current/` if needed
  - `writeSpecFile(projectDir: string, filename: string, content: string): void`
  - `readSpecFile(projectDir: string, filename: string): string | null`
  - `archiveCurrentFeature(projectDir: string, featureName: string): void`  -  moves current/ to history/

- [ ] T012 Implement process utilities in `src/utils/process.ts`:
  - `spawnWithOutput(command: string, args: string[], options: SpawnOptions): Promise<{stdout: string, stderr: string, code: number}>`
  - `runValidation(projectDir: string, config: Config): Promise<ValidationResult[]>`  -  runs typecheck, lint, test in sequence, stops on first failure
  - This module wraps child_process.spawn with promise-based API and output capture

**Checkpoint**: Can commit, read files, run validation commands

---

## Phase 4: Spec Generation (Planner Module)

**Purpose**: Drive Claude API to generate spec, plan, and tasks

- [ ] T013 Implement spec prompt templates in `src/spec/templates.ts`:
  - `buildResearchPrompt(feature: string, projectContext: string): string`  -  prompt for Opus to research the codebase and understand what's needed
  - `buildSpecPrompt(feature: string, researchOutput: string): string`  -  prompt for Opus to write spec.md
  - `buildPlanPrompt(spec: string, projectContext: string): string`  -  prompt for Opus to write plan.md
  - `buildTasksPrompt(spec: string, plan: string): string`  -  prompt for Opus to write tasks.md with the self-contained task format from plan.md
  - `buildValidationPrompt(spec: string, diff: string): string`  -  prompt for Opus final review
  - `buildEscalationPrompt(task: Task, lastAttempt: string, error: string): string`  -  prompt for Opus to fix a failed task
  - Each prompt should be detailed, structured, and include the exact output format expected

- [ ] T014 Implement task parser in `src/spec/parser.ts`:
  - `parseTasks(tasksMarkdown: string): Task[]`  -  parse tasks.md into Task objects
  - Handle YAML frontmatter per task (id, title, action, file, depends_on)
  - Extract sections: Context, Task, Signature, Tests, Constraints, Pattern
  - Return ordered array respecting dependencies

- [ ] T015 Implement task formatter in `src/spec/formatter.ts`:
  - `formatTaskPrompt(task: Task, projectContext: ProjectContext): string`  -  build self-contained prompt for the local model
  - `ProjectContext` includes: project name, runtime info, test command
  - Prompt uses whole-file format for files <200 lines, search/replace for larger files
  - Inline all relevant code context (don't reference external files)
  - Include concrete test expectations

- [ ] T016 Implement planner in `src/orchestrator/planner.ts`:
  - `planFeature(feature: string, projectDir: string, config: Config, onProgress: (msg: string) => void): Promise<{spec: string, plan: string, tasks: Task[]}>`
  - Uses `@anthropic-ai/sdk` to call Claude API
  - Calls research prompt → spec prompt → plan prompt → tasks prompt sequentially
  - Saves each artifact to `.tiny-spec/current/`
  - Reports progress via callback (for TUI updates)
  - Handles API errors with retries (exponential backoff, max 3)

**Checkpoint**: Given a feature description, generates spec.md, plan.md, tasks.md via Claude API

---

## Phase 5: Implementation (Implementer Module)

**Purpose**: Drive local model to implement tasks one by one

- [ ] T017 Implement the implementer in `src/orchestrator/implementer.ts`:
  - `implementTask(task: Task, projectDir: string, config: Config, onProgress: (msg: string) => void): Promise<{success: boolean, output: string, error?: string}>`
  - Uses `openai` SDK configured for local model (Ollama/LM Studio)
  - Builds prompt via `formatTaskPrompt()`
  - Sends to local model, receives generated code
  - Writes generated code to the target file
  - Returns success/failure with output

  Configuration for different providers:
  ```typescript
  // Ollama
  new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' })
  // LM Studio
  new OpenAI({ baseURL: 'http://localhost:1234/v1', apiKey: 'lm-studio' })
  // OpenRouter
  new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY })
  // DeepSeek
  new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY })
  ```

- [ ] T018 Implement the validator in `src/orchestrator/validator.ts`:
  - `validateTask(task: Task, projectDir: string, config: Config): Promise<ValidationResult[]>`
  - Runs validation pipeline in order: typecheck → lint → test
  - Each step only runs if enabled in config
  - Returns array of results (stops on first failure for efficiency)
  - `formatValidationError(results: ValidationResult[]): string`  -  human-readable error for retry prompt

- [ ] T019 Implement the escalator in `src/orchestrator/escalator.ts`:
  - `escalateTask(task: Task, lastAttempt: string, error: string, projectDir: string, config: Config, onProgress: (msg: string) => void): Promise<{success: boolean, output: string}>`
  - Uses Claude API (Opus) to fix what the local model couldn't
  - Sends: task spec + last attempt code + validation error
  - Writes the fix to the target file
  - Returns success/failure

**Checkpoint**: Can send a task to local model, validate result, escalate if needed

---

## Phase 6: Orchestrator

**Purpose**: Main workflow loop that coordinates planner, implementer, validator, escalator

- [ ] T020 Implement the main orchestrator in `src/orchestrator/orchestrator.ts`:
  - `runWorkflow(feature: string, projectDir: string, config: Config, callbacks: OrchestratorCallbacks): Promise<Summary>`
  - `OrchestratorCallbacks`:
    ```typescript
    interface OrchestratorCallbacks {
      onPhaseChange: (phase: Phase) => void;
      onPlannerOutput: (text: string) => void;
      onImplementerOutput: (text: string) => void;
      onTaskStart: (task: Task, index: number, total: number) => void;
      onTaskComplete: (task: Task, method: 'local' | 'escalated') => void;
      onTaskRetry: (task: Task, attempt: number, error: string) => void;
      onValidationResult: (task: Task, results: ValidationResult[]) => void;
      onApprovalNeeded: (type: 'spec' | 'plan', content: string) => Promise<boolean>;
      onComplete: (summary: Summary) => void;
    }
    ```
  - Workflow loop:
    1. Call planner to generate spec/plan/tasks
    2. If not auto-approve: wait for user approval of spec, then plan
    3. For each task in order:
       a. Call implementer
       b. Call validator
       c. If pass: commit, mark done, continue
       d. If fail and attempts < maxRetries: format error, retry implementer
       e. If fail and max retries: call escalator
       f. If escalator fails: mark task as failed, continue
    4. After all tasks: call planner for final review (diff vs spec)
    5. Return summary

**Checkpoint**: Full workflow runs end-to-end via function calls (no TUI yet)

---

## Phase 7: Terminal UI (Ink)

**Purpose**: Build the split-pane terminal interface

- [ ] T021 Implement header component in `src/tui/header.tsx`:
  - Shows: `tiny-spec | {feature_name} | {elapsed_time}`
  - Fixed at top, full width
  - Uses Ink `<Box>` and `<Text>` with colors

- [ ] T022 Implement pane component in `src/tui/pane.tsx`:
  - Props: `title: string`, `lines: string[]`, `focused: boolean`
  - Scrollable text output (last N lines visible)
  - Border with title
  - Highlight border when focused
  - Auto-scroll to bottom on new lines

- [ ] T023 Implement status bar in `src/tui/status-bar.tsx`:
  - Shows: `Phase: {phase} | Task: {current}/{total} | Model: {model_name} | Retries: {n}`
  - Fixed at bottom, full width
  - Color-coded by phase (green=implementing, yellow=validating, red=escalating)

- [ ] T024 Implement prompt component in `src/tui/prompt.tsx`:
  - Shows approval prompts: "Spec generated. Review at .tiny-spec/current/spec.md [Enter to approve, e to edit, q to quit]"
  - Handles keyboard input for approval/rejection
  - Blocks workflow until user responds (unless --auto)

- [ ] T025 Implement main layout in `src/tui/layout.tsx`:
  - Two-column layout: left pane (Planner) + right pane (Implementer)
  - Header at top, status bar at bottom
  - Tab to switch focus between panes
  - q to quit (with confirmation)
  - Passes orchestrator callbacks to update pane content

- [ ] T026 Implement root app component in `src/app.tsx`:
  - Creates config, initializes state
  - Starts orchestrator with TUI callbacks
  - Renders the Ink app with layout

**Checkpoint**: TUI renders with two panes, shows real-time output from orchestrator

---

## Phase 8: CLI Entry Point

**Purpose**: Wire everything together as a CLI tool

- [ ] T027 Implement CLI in `src/cli.ts`:
  - Commands:
    - `tiny-spec start <feature>`  -  full workflow (TUI + orchestrator)
    - `tiny-spec spec <feature>`  -  spec-only mode (generate spec/plan/tasks, no implementation)
    - `tiny-spec init`  -  create .tiny-spec/config.yaml with detected models
    - `tiny-spec status`  -  show current workflow state
    - `tiny-spec resume`  -  resume interrupted workflow from saved state
  - Global options:
    - `--auto`  -  auto-approve spec and plan
    - `--model <model>`  -  override implementer model
    - `--provider <provider>`  -  override implementer provider
    - `--project <dir>`  -  project directory (default: cwd)
  - Entry: `#!/usr/bin/env node` with `--experimental-strip-types` for dev mode
  - Uses commander for argument parsing
  - Renders Ink app for `start` command, plain console for others

**Checkpoint**: `tiny-spec init` creates config, `tiny-spec start "feature"` launches full workflow

---

## Phase 9: Polish & Testing

**Purpose**: Tests, error handling, documentation

- [ ] T028 Write unit tests for task parser (`tests/parser.test.ts`):
  - Test parsing a sample tasks.md into Task[]
  - Test handling malformed markdown
  - Test YAML frontmatter extraction
  - Test dependency ordering

- [ ] T029 Write unit tests for task formatter (`tests/formatter.test.ts`):
  - Test prompt generation for create action
  - Test prompt generation for modify action (includes current code)
  - Test context length calculation
  - Test that prompt is self-contained (no external references)

- [ ] T030 Write unit tests for state machine (`tests/state.test.ts`):
  - Test all valid transitions
  - Test invalid transition handling
  - Test state serialization/deserialization

- [ ] T031 Write integration test for validation pipeline (`tests/validator.test.ts`):
  - Test typecheck detection (mock tsc output)
  - Test lint detection (mock eslint output)
  - Test test runner detection (mock npm test output)
  - Test error formatting for retry prompt

- [ ] T032 Add error handling at module boundaries:
  - API errors (Claude, OpenAI-compat): retry with backoff, then fail gracefully
  - Process errors (tsc, lint, test): capture stderr, format for user
  - File errors: clear messages about missing files/permissions
  - Config errors: validate config on load, report specific issues

- [ ] T033 Write README.md:
  - Project description and motivation
  - Installation instructions
  - Quick start guide
  - Configuration reference
  - Supported models and providers
  - Architecture overview
  - Contributing guide

**Checkpoint**: Tests pass, errors handled gracefully, README complete

---

## Summary

| Phase | Tasks | Purpose |
|-------|-------|---------|
| 1. Setup | T001-T006 | Project scaffolding |
| 2. Types & Config | T007-T009 | Type definitions, config, state |
| 3. Utilities | T010-T012 | Git, FS, process helpers |
| 4. Planner | T013-T016 | Spec generation via Claude API |
| 5. Implementer | T017-T019 | Task execution via local model |
| 6. Orchestrator | T020 | Main workflow loop |
| 7. TUI | T021-T026 | Ink split-pane interface |
| 8. CLI | T027 | Entry point and commands |
| 9. Polish | T028-T033 | Tests, errors, docs |

**Total**: 33 tasks across 9 phases
**Estimated complexity**: Medium  -  no novel algorithms, mostly orchestration + TUI
**Critical path**: T007 → T013-T016 → T017-T019 → T020 → T025-T027
