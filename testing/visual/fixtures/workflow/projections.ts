import type { Summary } from '../../../../src/core/schemas/summary.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import { getWorkflowPromptRows } from '../../../../src/features/workflow/prompt-rows/workflow.js';
import type { ApprovalPromptState } from '../../../../src/stores/approval-prompt/prompt.js';
import type { ScenarioId } from '../../contracts/identifiers.js';
import { scenarioId } from '../../contracts/identifiers.js';

export const WORKFLOW_FIXTURE_VERSION = 1;

export const WORKFLOW_FIXTURE_BOUNDS = Object.freeze({
  version: WORKFLOW_FIXTURE_VERSION,
  maxEventsPerFixture: 16,
  maxStringLength: 160,
});

const FIXED_TS = 1_783_958_400_000;
export const WORKFLOW_FIXTURE_TASK_ID = taskId('T901');
const FIXED_CALL_ID = 'visual-call-001';
const FIXED_RUNNER_NAME = 'Ollama API';
const FIXED_RUNNER_MODEL = 'qwen2.5-coder:7b';
const WORKFLOW_FEATURE = 'Add Ollama model discovery';
export const WORKFLOW_FIXTURE_REVIEW_FILE = 'src/engine/detection/service.ts';
export const WORKFLOW_FIXTURE_REVIEW_PANEL_FILE =
  '.splitbrief/sessions/2026-07-13-add-ollama-model-discovery/plan.md';

export const WORKFLOW_FIXTURE_TEXT = Object.freeze({
  idle: 'no events yet',
  planning: 'Mapping provider discovery and cache updates',
  implementation: 'Inspecting provider discovery flow',
  implementationTask: 'Detect available Ollama models',
  review: 'Approve the Ollama discovery plan',
  reviewAnswer: 'approve',
  question: 'Continue if Ollama is unavailable?',
  questionAnswer: 'Warn and continue with manual model entry.',
  success: 'Ollama model discovery complete',
  failure: 'Ollama request failed: connection refused',
});

export const WORKFLOW_SUCCESS_SUMMARY: Readonly<Summary> = Object.freeze({
  feature: WORKFLOW_FIXTURE_TEXT.success,
  totalTasks: 1,
  completedByLocal: 1,
  escalatedToPlanner: 0,
  skipped: 0,
  failed: 0,
  totalTime: 4_200,
  tokenUsage: {
    plannerInput: 120,
    plannerOutput: 40,
    implementerInput: 240,
    implementerOutput: 80,
    escalationInput: 0,
    escalationOutput: 0,
  },
  estimatedCostSavings: '$0.01',
  escalationRate: 0,
  plannerTool: 'claude-code',
  plannerModel: 'claude-sonnet-4-6',
  implementerTool: 'ollama',
  implementerModel: FIXED_RUNNER_MODEL,
  mode: 'standard',
  phaseTimings: {
    planning: 1_200,
    implementing: 2_400,
    'final-review': 600,
  },
});

interface FixtureQuestion {
  readonly prompt: string;
  readonly answer: string;
}

interface FixtureApproval {
  readonly actionDescription: string;
  readonly answer: string;
}

interface FixtureReview {
  readonly filePath: string;
  readonly source: string;
}

interface FixtureStreaming {
  readonly lines: readonly string[];
}

export interface WorkflowFixtureProjection {
  readonly scenarioId: ScenarioId;
  readonly feature: string;
  readonly events: readonly EngineEvent[];
  readonly inputMode: 'normal' | 'review' | 'question';
  readonly sidebarVisible: boolean;
  readonly question?: FixtureQuestion;
  readonly approval?: FixtureApproval;
  readonly review?: FixtureReview;
  readonly streaming?: FixtureStreaming;
  readonly summary?: Readonly<Summary>;
}

const WORKFLOW_IDLE_ID = scenarioId('workflow-idle');
const WORKFLOW_PLANNING_ID = scenarioId('workflow-planning');
const WORKFLOW_IMPLEMENTATION_ID = scenarioId('workflow-implementation');
const WORKFLOW_REVIEW_ID = scenarioId('workflow-review');
const WORKFLOW_QUESTION_ID = scenarioId('workflow-question');
const SUMMARY_SUCCESS_ID = scenarioId('summary-success');
const WORKFLOW_FAILURE_ID = scenarioId('workflow-failure');

const idleProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IDLE_ID,
  feature: WORKFLOW_FEATURE,
  events: [],
  inputMode: 'normal',
  sidebarVisible: false,
};

const planningProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PLANNING_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'planning',
      feature: WORKFLOW_FEATURE,
    },
    {
      type: 'planner_status',
      ts: FIXED_TS + 100,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'claude-sonnet-4-6',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 200,
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      text: WORKFLOW_FIXTURE_TEXT.planning,
    },
  ],
};

// The gallery clock is frozen at 2026-01-01T00:00:00.000Z (gallery/environment.ts). The build
// stage started 4m05s before it so the footer elapsed reads a working duration, not 0:00.
const IMPLEMENTATION_STARTED_TS = 1_767_225_600_000 - 245_000;

interface ImplementationActivity {
  readonly kind: 'read' | 'edit' | 'write' | 'command';
  readonly label: string;
  readonly target: string;
}

const IMPLEMENTATION_ACTIVITIES: readonly ImplementationActivity[] = [
  { kind: 'read', label: 'Read', target: 'src/core/schemas/detection.ts' },
  { kind: 'read', label: 'Read', target: WORKFLOW_FIXTURE_REVIEW_FILE },
  { kind: 'edit', label: 'Edit', target: WORKFLOW_FIXTURE_REVIEW_FILE },
  { kind: 'write', label: 'Write', target: 'src/engine/detection/service.test.ts' },
  { kind: 'command', label: 'Run', target: 'npm test -- src/engine/detection/service.test.ts' },
];

const implementationProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IMPLEMENTATION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    {
      type: 'workflow_started',
      ts: IMPLEMENTATION_STARTED_TS,
      phase: 'implementing',
      feature: WORKFLOW_FEATURE,
    },
    {
      type: 'task_started',
      ts: IMPLEMENTATION_STARTED_TS + 5_000,
      phase: 'implementing',
      taskId: taskId('T899'),
      title: 'Add the detection result schema',
      index: 0,
      total: 5,
      file: 'src/core/schemas/detection.ts',
      action: 'create',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'task_completed',
      ts: IMPLEMENTATION_STARTED_TS + 57_000,
      phase: 'implementing',
      taskId: taskId('T899'),
      title: 'Add the detection result schema',
      method: 'local',
      retries: 0,
      duration: 52_000,
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'task_started',
      ts: IMPLEMENTATION_STARTED_TS + 60_000,
      phase: 'implementing',
      taskId: taskId('T900'),
      title: 'Query the local Ollama model endpoint',
      index: 1,
      total: 5,
      file: 'src/engine/detection/models.ts',
      action: 'create',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'task_completed',
      ts: IMPLEMENTATION_STARTED_TS + 121_000,
      phase: 'implementing',
      taskId: taskId('T900'),
      title: 'Query the local Ollama model endpoint',
      method: 'local',
      retries: 0,
      duration: 61_000,
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'planner_text',
      ts: IMPLEMENTATION_STARTED_TS + 125_000,
      phase: 'implementing',
      role: 'implementer',
      content: 'plain',
      text: WORKFLOW_FIXTURE_TEXT.implementation,
    },
    {
      type: 'task_started',
      ts: IMPLEMENTATION_STARTED_TS + 128_000,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 2,
      total: 5,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'runner_call_started',
      ts: IMPLEMENTATION_STARTED_TS + 130_000,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 0,
    },
    ...IMPLEMENTATION_ACTIVITIES.map((activity, index) => ({
      type: 'runner_call_activity' as const,
      ts: IMPLEMENTATION_STARTED_TS + 140_000 + index * 20_000,
      phase: 'implementing' as const,
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer' as const,
      backendKind: 'api' as const,
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: index + 1,
      activityId: `${FIXED_CALL_ID}:${activity.kind}:${index + 1}`,
      stage: 'completed' as const,
      kind: activity.kind,
      label: activity.label,
      target: activity.target,
      redacted: false,
      rawAvailable: false,
    })),
  ],
  streaming: {
    lines: ['Adding cache-aware model discovery', 'Writing detection service tests'],
  },
};

const reviewProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_REVIEW_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'review',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'reviewing-plan',
      feature: WORKFLOW_FEATURE,
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'reviewing-plan',
      role: 'planner',
      content: 'plain',
      text: 'Review the Ollama discovery plan before implementation.',
    },
  ],
  approval: {
    actionDescription: WORKFLOW_FIXTURE_TEXT.review,
    answer: WORKFLOW_FIXTURE_TEXT.reviewAnswer,
  },
  review: {
    filePath: WORKFLOW_FIXTURE_REVIEW_PANEL_FILE,
    source:
      '# Ollama model discovery\n\n1. Query the local Ollama model endpoint.\n2. Cache discovered model metadata.\n3. Continue setup when Ollama is offline.',
  },
};

const questionProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_QUESTION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'clarifying',
      feature: WORKFLOW_FEATURE,
    },
  ],
  question: {
    prompt: WORKFLOW_FIXTURE_TEXT.question,
    answer: WORKFLOW_FIXTURE_TEXT.questionAnswer,
  },
};

const successProjection: WorkflowFixtureProjection = {
  scenarioId: SUMMARY_SUCCESS_ID,
  feature: WORKFLOW_FIXTURE_TEXT.success,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'implementing',
      feature: WORKFLOW_FIXTURE_TEXT.success,
    },
    {
      type: 'workflow_complete',
      ts: FIXED_TS + 4_200,
      phase: 'complete',
    },
  ],
  summary: WORKFLOW_SUCCESS_SUMMARY,
};

const failureProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_FAILURE_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'implementing',
      feature: WORKFLOW_FEATURE,
    },
    {
      type: 'task_started',
      ts: FIXED_TS + 100,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 1,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'runner_call_started',
      ts: FIXED_TS + 200,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 0,
    },
    {
      type: 'runner_call_error',
      ts: FIXED_TS + 700,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 1,
      status: 'failed',
      error: { code: 'ECONNREFUSED', message: WORKFLOW_FIXTURE_TEXT.failure },
      partial: false,
      startedAt: FIXED_TS + 200,
      endedAt: FIXED_TS + 700,
      durationMs: 500,
      usage: null,
      nativeSessionId: null,
    },
    {
      type: 'error',
      ts: FIXED_TS + 800,
      phase: 'implementing',
      message: WORKFLOW_FIXTURE_TEXT.failure,
    },
    {
      type: 'workflow_cancelled',
      ts: FIXED_TS + 900,
      phase: 'implementing',
      reason: 'user_cancelled',
    },
  ],
};

const projections = [
  idleProjection,
  planningProjection,
  implementationProjection,
  reviewProjection,
  questionProjection,
  successProjection,
  failureProjection,
] as const;

export const workflowFixtureProjections: ReadonlyMap<ScenarioId, WorkflowFixtureProjection> =
  new Map(projections.map((projection) => [projection.scenarioId, projection]));

export function getWorkflowFixturePromptRows(
  projection: WorkflowFixtureProjection,
  cols: number,
): number {
  const approvalState: ApprovalPromptState =
    projection.approval === undefined
      ? { status: 'idle' }
      : {
          status: 'pending',
          request: {
            tier: 'sticky',
            actionClass: 'write_out_of_scope',
            actionDescription: projection.approval.actionDescription,
            taskId: WORKFLOW_FIXTURE_TASK_ID,
            phase: 'reviewing-plan',
          },
          resolve: () => {},
        };
  const questionHint =
    projection.inputMode === 'question' && projection.question !== undefined
      ? projection.question.prompt
      : null;
  return getWorkflowPromptRows({
    approvalState,
    costApprovalState: { status: 'idle' },
    questionHint,
    cols,
  });
}

function projectionStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(projectionStrings);
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(projectionStrings);
}

function assertProjectionBounds(projection: WorkflowFixtureProjection): void {
  if (projection.events.length > WORKFLOW_FIXTURE_BOUNDS.maxEventsPerFixture) {
    throw new Error(`Workflow fixture ${projection.scenarioId} exceeds the event bound`);
  }
  const oversized = projectionStrings(projection).find(
    (value) => value.length > WORKFLOW_FIXTURE_BOUNDS.maxStringLength,
  );
  if (oversized !== undefined) {
    throw new Error(`Workflow fixture ${projection.scenarioId} exceeds the string bound`);
  }
}

for (const projection of projections) assertProjectionBounds(projection);
