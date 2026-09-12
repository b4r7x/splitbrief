import type { RecoveryIssue } from '../../../../src/core/schemas/recovery/schemas.js';
import type { Summary } from '../../../../src/core/schemas/summary.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { makeUsage } from '../../../helpers/factories/summary.js';
import { makeImplState } from '../../../helpers/factories/workflow-state.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import { getWorkflowPromptRows } from '../../../../src/features/workflow/prompt-rows/workflow.js';
import { formatRecoveryPrompt } from '../../../../src/features/workflow/recovery-prompt.js';
import type { ApprovalPromptState } from '../../../../src/stores/approval-prompt/prompt.js';
import type { ScenarioId } from '../../contracts/identifiers.js';
import { scenarioId } from '../../contracts/identifiers.js';

export const WORKFLOW_FIXTURE_VERSION = 1;

export const WORKFLOW_FIXTURE_BOUNDS = Object.freeze({
  version: WORKFLOW_FIXTURE_VERSION,
  maxEventsPerFixture: 8,
  maxStringLength: 160,
});

const FIXED_TS = 1_783_958_400_000;
export const WORKFLOW_FIXTURE_TASK_ID = taskId('T901');
const FIXED_CALL_ID = 'visual-call-001';
const FIXED_RUNNER_NAME = 'Synthetic local runner';
const FIXED_RUNNER_MODEL = 'fixture-model-v1';
const WORKFLOW_FEATURE = 'Visual fixture workflow';
export const WORKFLOW_FIXTURE_REVIEW_FILE = 'testing/visual/fixtures/workflow/projections.ts';
export const WORKFLOW_FIXTURE_REVIEW_PANEL_FILE =
  'testing/visual/fixtures/workflow/review-fixture.md';

/**
 * The quota halt the recovery scenario projects: 17:00 on the capture clock's own day
 * (`FIXED_CLOCK`, `testing/visual/gallery/environment.ts`), so the rendered note is the
 * same-day form — a bare clock — in every capture.
 */
export const WORKFLOW_FIXTURE_RESET_AT = Date.parse('2026-01-01T17:00:00.000Z');

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
  recovery: 'switch BUILD to OpenCode CLI',
});

export const WORKFLOW_SUCCESS_SUMMARY: Readonly<Summary> = Object.freeze({
  feature: WORKFLOW_FIXTURE_TEXT.success,
  totalTasks: 1,
  completedByLocal: 1,
  escalatedToPlanner: 0,
  skipped: 0,
  failed: 0,
  totalTime: 4_200,
  tokenUsage: makeUsage({
    plannerInput: 120,
    plannerOutput: 40,
    implementerInput: 240,
    implementerOutput: 80,
  }),
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
  readonly sidebarVisible: boolean;
  readonly question?: FixtureQuestion;
  readonly approval?: FixtureApproval;
  readonly review?: FixtureReview;
  readonly streaming?: FixtureStreaming;
  /**
   * The saved run the screen resumes; the production resume path hydrates it from disk, so a halt it
   * carries is prompted by the real recovery driver instead of staged by the fixture.
   */
  readonly resumeState?: WorkflowState;
  readonly summary?: Readonly<Summary>;
}

const WORKFLOW_IDLE_ID = scenarioId('workflow-idle');
const WORKFLOW_PLANNING_ID = scenarioId('workflow-planning');
const WORKFLOW_IMPLEMENTATION_ID = scenarioId('workflow-implementation');
const WORKFLOW_REVIEW_ID = scenarioId('workflow-review');
const WORKFLOW_QUESTION_ID = scenarioId('workflow-question');
const SUMMARY_SUCCESS_ID = scenarioId('summary-success');
const WORKFLOW_FAILURE_ID = scenarioId('workflow-failure');
const WORKFLOW_RECOVERY_USAGE_LIMIT_ID = scenarioId('workflow-recovery-usage-limit');

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
  sidebarVisible: true,
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
      type: 'runner_call_activity',
      ts: FIXED_TS + 300,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
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
      target: WORKFLOW_FIXTURE_REVIEW_FILE,
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
      text: 'Review the bounded synthetic projection.',
    },
  ],
  approval: {
    actionDescription: WORKFLOW_FIXTURE_TEXT.review,
    answer: WORKFLOW_FIXTURE_TEXT.reviewAnswer,
  },
  review: {
    filePath: WORKFLOW_FIXTURE_REVIEW_PANEL_FILE,
    source: '# Deterministic visual review\n\nApprove the bounded fixture projection.',
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

const usageLimitRecoveryIssue: RecoveryIssue = {
  id: 'rec_visual_usage_limit',
  reason: 'runner-usage-limit',
  phase: 'implementing',
  status: 'awaiting-user',
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  taskTitle: WORKFLOW_FIXTURE_TEXT.implementationTask,
  files: [WORKFLOW_FIXTURE_REVIEW_FILE],
  affectedTaskIds: [WORKFLOW_FIXTURE_TASK_ID],
  message:
    'Ollama hit its usage limit. The limit resets at Jan 1, 2026, 5:00 PM; wait for it, switch the seat to another tool, or abort.',
  details: [
    'Ollama reported: quota exhausted · resets 5pm',
    'The run stopped instead of escalating.',
  ],
  attempts: 1,
  maxAttempts: 3,
  selectedImplementerProfile: 'local-fixture',
  resetAt: new Date(WORKFLOW_FIXTURE_RESET_AT).toISOString(),
  switchSeat: {
    seat: 'build',
    // Tool-only, because that is all a candidate can be today: the offer is built
    // from the readiness snapshot (`loadSeatSwapContext`), and a `CliToolDetection`
    // carries no model. A candidate that does name one is covered by the component
    // test, not staged here as a state the engine cannot produce.
    candidates: [{ tool: 'opencode' }, { tool: 'codex' }],
  },
  facts: { tool: 'Ollama' },
  availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'abort-workflow'],
  recommendedAction: 'switch-seat',
  createdAt: new Date(FIXED_TS).toISOString(),
};

function haltedResumeState(issue: RecoveryIssue): WorkflowState {
  return makeImplState(
    [
      makeTask({
        id: WORKFLOW_FIXTURE_TASK_ID,
        title: WORKFLOW_FIXTURE_TEXT.implementationTask,
        file: WORKFLOW_FIXTURE_REVIEW_FILE,
      }),
    ],
    { feature: WORKFLOW_FEATURE, pendingRecovery: issue },
  );
}

const usageLimitRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_USAGE_LIMIT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  // A resumed run starts on an empty transcript — `resetWorkflow` rehydrates lifecycle, tasks and
  // tokens from the saved state and nothing else — and this halt never reaches the run, so staged
  // events could not survive to the frame. The phase and the task come from the resumed state.
  events: [],
  resumeState: haltedResumeState(usageLimitRecoveryIssue),
};

const projections = [
  idleProjection,
  planningProjection,
  implementationProjection,
  reviewProjection,
  questionProjection,
  successProjection,
  failureProjection,
  usageLimitRecoveryProjection,
] as const;

export const workflowFixtureProjections: ReadonlyMap<ScenarioId, WorkflowFixtureProjection> =
  new Map(projections.map((projection) => [projection.scenarioId, projection]));

/** The text the question panel prints: a clarification prompt, or the halt the resumed state carries. */
export function fixtureQuestionHint(projection: WorkflowFixtureProjection): string | null {
  if (projection.question !== undefined) return projection.question.prompt;
  const halt = projection.resumeState?.pendingRecovery;
  return halt === undefined ? null : formatRecoveryPrompt(halt);
}

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
  const questionHint = projection.inputMode === 'question' ? fixtureQuestionHint(projection) : null;
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
