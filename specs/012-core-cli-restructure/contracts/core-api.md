# Core API Contract

**Feature**: 012-core-cli-restructure
**Date**: 2026-03-30
**Purpose**: Defines the public API exported from `@tiny-spec/core` (internal path: `src/core/index.ts`)

## Public API

### Orchestration

```typescript
// Main workflow execution
export function runWorkflow(
  feature: string,
  projectDir: string,
  config: Config,
  callbacks: OrchestratorCallbacks,
  savedState?: WorkflowState
): Promise<void>;

// State machine
export const transitions: Record<Phase, Phase[]>;
export function isValidTransition(from: Phase, to: Phase): boolean;

// Types
export interface WorkflowState {
  stateVersion: number;
  feature: string;
  projectDir: string;
  phase: Phase;
  tasks: Task[];
  currentTaskIndex: number;
  completedTasks: string[];
  failedTasks: string[];
  escalatedTasks: string[];
  startedAt: string;
  config: Config;
}

export interface OrchestratorCallbacks {
  onEvent(event: TuiEvent): void;
  onApprovalNeeded(type: 'spec' | 'plan', filePath: string): Promise<{ approved: boolean; comment?: string }>;
  onExternalChanges(): Promise<boolean>;
  onComplete(summary: Summary): void;
  onQuestionAsked(question: ClarificationQuestion, num: number, total: number): Promise<string>;
}
```

### Planning

```typescript
// Factory
export function createPlanner(config: Config): PlannerBackend;

// Detection
export async function detectAvailablePlanners(): Promise<PlannerInfo[]>;

// Types
export interface PlannerBackend {
  plan(feature: string, projectDir: string, config: Config, callbacks: PlannerCallbacks): Promise<PlanResult>;
  escalateHint?(context: EscalationContext, hint: string): Promise<string>;
  escalateFull?(context: EscalationContext): Promise<string>;
  isAvailable(): Promise<boolean>;
  getPricing?(): { inputPer1k: number; outputPer1k: number };
}

export interface PlannerInfo {
  tool: PlannerTool;
  available: boolean;
  version?: string;
  models?: string[];
}
```

### Implementation

```typescript
// Factory
export function createImplementer(config: ImplementerConfig): Implementer;

// Code extraction
export function extractCode(response: string, format?: 'fenced' | 'raw'): string;

// Types
export interface Implementer {
  implement(task: Task, context: CodeContext, callbacks: ImplementerCallbacks): Promise<ImplementResult>;
}

export interface CodeContext {
  file: string;
  action: 'create' | 'modify';
  currentContent?: string;
  signature?: string;
  typeDefs?: string;
  constraints?: string[];
}
```

### Validation

```typescript
// Pipeline
export async function runValidation(
  projectDir: string,
  file: string,
  stages: ValidationStage[]
): Promise<ValidationResult>;

// Types
export type ValidationStage = 'tsc' | 'lint' | 'test';

export interface ValidationResult {
  passed: boolean;
  stages: Record<ValidationStage, boolean>;
  error?: string;
  output?: string;
}
```

### Config

```typescript
// Loading
export function loadConfig(projectDir: string): Config;
export function initConfig(projectDir: string): void;
export function createDefaultConfig(): Config;

// Types
export interface Config {
  planner: PlannerConfig;
  implementer: ImplementerConfig;
  approval?: ApprovalConfig;
}

export interface PlannerConfig {
  tool: PlannerTool;
  model?: string;
  session?: string;
  command?: string;
  args?: string[];
  outputFormat?: 'stream-json' | 'jsonl' | 'text';
}

export interface ImplementerConfig {
  provider: Provider;
  model: string;
  apiBase?: string;
  apiKey?: string;
  contextLength?: number;
  temperature?: number;
}
```

### Spec Parsing

```typescript
// Parsing
export function parseTasks(markdown: string): Task[];

// Formatting
export function formatPrompt(task: Task, context: CodeContext, config: PromptConfig): string;
export function formatTask(task: Task, format: 'compact' | 'full'): string;

// Templates
export const templates: Record<string, PromptTemplate>;
```

### Types

```typescript
// Phases
export type Phase = 
  | 'idle' 
  | 'researching' 
  | 'specifying' 
  | 'reviewing-spec' 
  | 'planning' 
  | 'reviewing-plan' 
  | 'implementing' 
  | 'validating-task' 
  | 'escalating' 
  | 'final-review' 
  | 'complete';

// Tasks
export interface Task {
  id: string;
  title: string;
  description: string;
  file: string;
  action: 'create' | 'modify';
  signature?: string;
  typeDefs?: string;
  constraints?: string[];
  tests?: string[];
  dependencies?: string[];
}

// Events
export type TuiEvent =
  | { type: 'planner-status'; ts: number; phase: Phase; status: string; summary?: string }
  | { type: 'planner-text'; ts: number; text: string }
  | { type: 'task-start'; ts: number; taskId: string; title: string; index: number; total: number; file: string; action: string }
  | { type: 'implementer-generate'; ts: number; status: 'running' | 'done'; model: string; file: string; duration?: number; diff?: string }
  | { type: 'validate'; ts: number; passed: boolean; stages: Record<string, boolean>; error?: string }
  | { type: 'retry'; ts: number; taskId: string; attempt: number; maxRetries: number }
  | { type: 'escalate'; ts: number; tier: number; hint?: string }
  | { type: 'git-commit'; ts: number; message: string }
  | { type: 'error'; ts: number; message: string }
  | { type: 'task-complete'; ts: number; taskId: string; title: string; method: 'local' | 'escalated'; retries: number; duration: number }
  | { type: 'task-skipped'; ts: number; taskId: string; title: string; reason: string };

// Permissions
export type PermissionMode = 'auto' | 'normal' | 'comment';

// Providers
export type Provider = 'ollama' | 'lm-studio' | 'deepseek' | 'openrouter' | 'custom';
export type PlannerTool = 'claude-code' | 'codex' | 'opencode' | 'aider' | 'agent-sdk' | 'shell';
```

## Internal API (NOT exported)

The following are implementation details and should NOT be exported from `src/core/index.ts`:

### Orchestration Internal
- `orchestrator.ts` internals (workflow loop implementation)
- `callbacks.ts` internal types
- `cost.ts` calculation functions (exported separately if needed)

### Planning Internal
- `backends/*.ts` individual implementations
- `question-parser.ts` parsing logic

### Implementation Internal
- `context-extractor.ts` extraction logic

### Validation Internal
- `validator.ts` stage execution

### Escalation Internal
- `escalator.ts` escalation logic

## Versioning

**Semantic Versioning**: The public API follows semver:
- **PATCH**: Bug fixes, internal refactoring
- **MINOR**: New features, backward-compatible additions
- **MAJOR**: Breaking changes to exported types or functions

**Current Version**: 0.1.0 (pre-release, API may change)

## Stability Guarantees

### Stable API (0.x.x)
- `runWorkflow()` signature and behavior
- `Config` type structure
- `TuiEvent` union type structure
- `Phase` type values

### Unstable API (may change)
- Internal structure of orchestrator loop
- Planner backend implementations
- Validation pipeline stages

## Deprecation Policy

When deprecating API surface:
1. Add `@deprecated` JSDoc tag
2. Provide migration path in documentation
3. Maintain for at least one major version
4. Remove in next major version with changelog entry