import type { Summary } from '../../../src/core/schemas/summary.js';
import { taskId } from '../../../src/core/schemas/task.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/use-workflow-screen.js';
import type { RunWorkflowFn } from '../../../src/features/workflow/hooks/use-runner.js';
import {
  closeApprovalPrompt,
  openApprovalPrompt,
} from '../../../src/stores/approval-prompt/prompt.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { questionPromptStore } from '../../../src/stores/question-prompt/prompt.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';
import { addEvent } from '../../../src/stores/workflow/actions.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { streamingOutputStore } from '../../../src/stores/workflow/streaming-output.js';
import type { CheckpointId, ScenarioId } from '../contracts/identifiers.js';
import { checkpointId, scenarioId } from '../contracts/identifiers.js';
import type {
  CheckpointPredicate,
  FixtureContext,
  FixtureFactory,
  FixtureRegistry,
} from './common.js';
import { createWorkflowBaseFixture, teardownVisualFixture } from './screen-fixtures.js';

export const WORKFLOW_FIXTURE_VERSION = 1;

export const WORKFLOW_FIXTURE_BOUNDS = Object.freeze({
  version: WORKFLOW_FIXTURE_VERSION,
  maxEventsPerFixture: 8,
  maxStringLength: 160,
});

const FIXED_TS = 1_783_958_400_000;
const FIXED_TASK_ID = taskId('T901');
const FIXED_CALL_ID = 'visual-call-001';
const FIXED_RUNNER_NAME = 'Synthetic local runner';
const FIXED_RUNNER_MODEL = 'fixture-model-v1';
const WORKFLOW_FEATURE = 'Visual fixture workflow';
const REVIEW_FILE = 'testing/visual/fixtures/workflow-fixtures.ts';

export const WORKFLOW_FIXTURE_TEXT = Object.freeze({
  idle: 'no events yet',
  planning: 'Planning deterministic visual fixtures',
  implementation: 'Inspecting deterministic fixture contract',
  implementationTask: 'Project deterministic workflow activity',
  review: 'Apply bounded visual fixture patch',
  reviewAnswer: 'Approve once',
  question: 'Which fixture answer should be used?',
  questionAnswer: 'Use the bounded synthetic answer.',
  success: 'Visual fixture workflow complete',
  failure: 'Synthetic runner failure: bounded fixture',
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
  plannerModel: 'fixture-planner-v1',
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
};

const planningProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PLANNING_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
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
      model: 'fixture-planner-v1',
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

const implementationProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IMPLEMENTATION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
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
      taskId: FIXED_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 1,
      file: REVIEW_FILE,
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 150,
      phase: 'implementing',
      role: 'implementer',
      content: 'plain',
      text: WORKFLOW_FIXTURE_TEXT.implementation,
    },
    {
      type: 'runner_call_started',
      ts: FIXED_TS + 200,
      phase: 'implementing',
      taskId: FIXED_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 0,
    },
    {
      type: 'runner_call_activity',
      ts: FIXED_TS + 300,
      phase: 'implementing',
      taskId: FIXED_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 1,
      activityId: 'visual-call-001:read:1',
      stage: 'completed',
      kind: 'read',
      label: WORKFLOW_FIXTURE_TEXT.implementation,
      target: REVIEW_FILE,
      redacted: false,
      rawAvailable: false,
    },
  ],
  streaming: {
    lines: ['Reading fixture contract', 'Projecting bounded activity'],
  },
};

const reviewProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_REVIEW_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'review',
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
      text: 'Review the bounded synthetic projection.',
    },
  ],
  approval: {
    actionDescription: WORKFLOW_FIXTURE_TEXT.review,
    answer: WORKFLOW_FIXTURE_TEXT.reviewAnswer,
  },
  review: {
    filePath: REVIEW_FILE,
    source: '# Deterministic visual review\n\nApprove the bounded fixture projection.',
  },
};

const questionProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_QUESTION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
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
      taskId: FIXED_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 1,
      file: REVIEW_FILE,
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'runner_call_started',
      ts: FIXED_TS + 200,
      phase: 'implementing',
      taskId: FIXED_TASK_ID,
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
      taskId: FIXED_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 1,
      status: 'failed',
      error: { code: 'synthetic-failure', message: WORKFLOW_FIXTURE_TEXT.failure },
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

function teardownWorkflowFixture(): void {
  closeApprovalPrompt();
  teardownVisualFixture();
}

function assertFixtureContext(
  projection: WorkflowFixtureProjection,
  context: FixtureContext,
): void {
  if (context.scenario.id !== projection.scenarioId) {
    throw new Error(
      `Workflow fixture ${projection.scenarioId} cannot set up scenario ${context.scenario.id}`,
    );
  }
}

async function setupProjection(
  projection: WorkflowFixtureProjection,
  context: FixtureContext,
): Promise<void> {
  assertFixtureContext(projection, context);
  closeApprovalPrompt();
  await createWorkflowBaseFixture().setup(context);

  if (projection.summary !== undefined) {
    routerStore.init({ screen: 'summary', summary: projection.summary, status: 'complete' });
  } else {
    const route = routerStore.get();
    if (route.screen !== 'workflow') {
      throw new Error(`Workflow fixture ${projection.scenarioId} failed to initialize its route`);
    }
    routerStore.init({
      screen: 'workflow',
      feature: projection.feature,
      readiness: route.readiness,
    });
  }

  applyProjection(projection);
}

function applyProjection(projection: WorkflowFixtureProjection): void {
  for (const event of projection.events) addEvent(event);

  if (projection.streaming !== undefined) {
    streamingOutputStore.startStreaming(FIXED_TASK_ID);
    streamingOutputStore.replaceLines([...projection.streaming.lines]);
  }

  if (projection.review !== undefined) {
    reviewStore.setReviewFile(projection.review.filePath);
    reviewStore.setBriefSources([projection.review.source]);
    reviewStore.setBriefPaths([projection.review.filePath]);
  }

  if (projection.question !== undefined) {
    questionPromptStore.setHint(projection.question.prompt);
  }

  controlsStore.setInputMode(projection.inputMode);

  if (projection.approval !== undefined) {
    void openApprovalPrompt({
      tier: 'sticky',
      actionClass: 'write_out_of_scope',
      actionDescription: projection.approval.actionDescription,
      taskId: FIXED_TASK_ID,
      phase: 'reviewing-plan',
    });
  }
}

export function createWorkflowFixtureAppDeps(
  projection?: WorkflowFixtureProjection,
): WorkflowScreenDeps {
  const runWorkflow: RunWorkflowFn = (options) => {
    if (projection !== undefined) {
      applyProjection(projection);
      activateFixtureInputMode(projection, options);
    }
    return waitForFixtureAbort(options.signal);
  };
  return { runWorkflow };
}

function activateFixtureInputMode(
  projection: WorkflowFixtureProjection,
  options: Parameters<RunWorkflowFn>[0],
): void {
  if (projection.review !== undefined) {
    void options.callbacks.onApprovalNeeded('briefs', projection.review.filePath);
  }
  if (projection.question !== undefined) {
    void options.callbacks.onQuestionAsked?.(
      { id: 'visual-question', type: 'input', text: projection.question.prompt },
      1,
      1,
    );
  }
}

function waitForFixtureAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function fixtureFactory(projection: WorkflowFixtureProjection): FixtureFactory {
  return () => ({
    setup: (context) => setupProjection(projection, context),
    teardown: teardownWorkflowFixture,
  });
}

export const workflowFixtureRegistry: FixtureRegistry = new Map(
  projections.map((projection) => [projection.scenarioId, fixtureFactory(projection)]),
);

function includesAll(...markers: readonly string[]): CheckpointPredicate {
  return ({ output, checkpoint }) =>
    output.includes(checkpoint.marker) && markers.every((marker) => output.includes(marker));
}

const checkpointPredicates = [
  [checkpointId('idle'), includesAll(WORKFLOW_FIXTURE_TEXT.idle)],
  [checkpointId('planning'), includesAll(WORKFLOW_FIXTURE_TEXT.planning)],
  [
    checkpointId('implementation'),
    includesAll(WORKFLOW_FIXTURE_TEXT.implementation, WORKFLOW_FIXTURE_TEXT.implementationTask),
  ],
  [checkpointId('review'), includesAll('Approval', WORKFLOW_FIXTURE_TEXT.review)],
  [checkpointId('question'), includesAll(WORKFLOW_FIXTURE_TEXT.question)],
  [checkpointId('success'), includesAll('complete', WORKFLOW_FIXTURE_TEXT.success)],
  [checkpointId('failure'), includesAll(WORKFLOW_FIXTURE_TEXT.failure, 'Workflow cancelled')],
] as const satisfies readonly (readonly [CheckpointId, CheckpointPredicate])[];

export const workflowCheckpointPredicates: ReadonlyMap<CheckpointId, CheckpointPredicate> = new Map(
  checkpointPredicates,
);
