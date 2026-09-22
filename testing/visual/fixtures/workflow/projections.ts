import { projectRunnerCallActivity } from '../../../../src/engine/calls/activity.js';
import type { RecoveryIssue } from '../../../../src/core/schemas/recovery/schemas.js';
import type { RunRecord } from '../../../../src/core/sessions/run-record.js';
import type { Summary } from '../../../../src/core/schemas/summary.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { makeUsage } from '../../../helpers/factories/summary.js';
import { makeImplState, makeWorkflowState } from '../../../helpers/factories/workflow-state.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import type { TaskReviewRequest } from '../../../../src/engine/events/workflow-events.js';
import type { ClarificationQuestion } from '../../../../src/core/schemas/question.js';
import type { ReviewArtifact } from '../../../../src/features/workflow/prompt-rows/approval.js';
import { getWorkflowPromptRows } from '../../../../src/features/workflow/prompt-rows/workflow.js';
import { formatRecoveryPrompt } from '../../../../src/features/workflow/recovery-prompt.js';
import { formatTaskReviewPrompt } from '../../../../src/features/workflow/task-review-prompt.js';
import type { ApprovalPromptState } from '../../../../src/stores/approval-prompt/prompt.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../../src/stores/workflow/stop.js';
import type { ScenarioId } from '../../contracts/identifiers.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { atRestProjections } from './at-rest-projections.js';

export const WORKFLOW_FIXTURE_VERSION = 1;

export const WORKFLOW_FIXTURE_BOUNDS = Object.freeze({
  version: WORKFLOW_FIXTURE_VERSION,
  maxEventsPerFixture: 8,
  maxStringLength: 160,
  maxQuestionOptionLength: 640,
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

export const WORKFLOW_FIXTURE_SECOND_FILE = 'testing/visual/fixtures/workflow/registry.ts';
export const WORKFLOW_FIXTURE_TASK_ID_2 = taskId('T902');
export const WORKFLOW_FIXTURE_TASK_ID_3 = taskId('T903');

export const WORKFLOW_FIXTURE_TEXT = Object.freeze({
  idle: 'no events yet',
  planning: 'Planning deterministic visual fixtures',
  implementation: 'Inspecting deterministic fixture contract',
  implementationTask: 'Project deterministic workflow activity',
  validationSkipReason: 'no affected test file found',
  review: 'Apply bounded visual fixture patch',
  reviewAnswer: 'Approve once',
  question: 'Which seat performs the per-slice review?',
  questionAnswer: 'Reviewer/planner seat',
  success: 'Visual fixture workflow complete',
  failure: 'Synthetic runner failure: bounded fixture',
  recovery: 'Change BUILD tool',
  recoveryPlan: 'Change PLAN tool',
  retryExhausted: 'exhausted recovery retries',
  apiContext: 'Nothing was sent to PLAN',
});

interface FixtureQuestion {
  readonly prompt: string;
  readonly answer: string;
  readonly questions?: readonly ClarificationQuestion[];
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

/** What the user asked of the stop ladder; the registry stamps it after the events land. */
export interface FixtureStopState {
  readonly intent: StopIntent;
  readonly phase: StopPhase;
  readonly parked?: { readonly kind: StopParkKind; readonly taskId: string };
}

/**
 * A run the screen opens at rest: its record, and the session log its transcript replays when the
 * scenario is about the replay itself rather than about the block at the tail.
 */
export interface FixtureAtRestRoute {
  readonly record: RunRecord;
  readonly log?: string;
}

export interface WorkflowFixtureProjection {
  readonly scenarioId: ScenarioId;
  readonly feature: string;
  readonly events: readonly EngineEvent[];
  readonly inputMode: 'normal' | 'review' | 'question';
  readonly sidebarVisible: boolean;
  readonly question?: FixtureQuestion;
  readonly questionPreview?: 'overflow-back';
  readonly taskReview?: TaskReviewRequest;
  readonly approval?: FixtureApproval;
  readonly review?: FixtureReview;
  /** The artifact the document review panel names, when the projection opens that gate. */
  readonly reviewArtifact?: ReviewArtifact;
  readonly streaming?: FixtureStreaming;
  /**
   * The saved run the screen resumes; the production resume path hydrates it from disk, so a halt it
   * carries is prompted by the real recovery driver instead of staged by the fixture.
   */
  readonly resumeState?: WorkflowState;
  readonly summary?: Readonly<Summary>;
  readonly stop?: FixtureStopState;
  /** Set when the scenario shows a run that is not moving; the screen mounts no runner. */
  readonly atRest?: FixtureAtRestRoute;
}

const WORKFLOW_IDLE_ID = scenarioId('workflow-idle');
const WORKFLOW_PLANNING_ID = scenarioId('workflow-planning');
const WORKFLOW_IMPLEMENTATION_ID = scenarioId('workflow-implementation');
const WORKFLOW_IMPLEMENTATION_RETRY_ID = scenarioId('workflow-implementation-retry');
const WORKFLOW_VALIDATION_ID = scenarioId('workflow-validation');
const WORKFLOW_IMPLEMENTATION_ESCALATED_ID = scenarioId('workflow-implementation-escalated');
const WORKFLOW_REVIEW_ID = scenarioId('workflow-review');
const WORKFLOW_APPROVAL_DOCUMENT_ID = scenarioId('workflow-approval-document');
const WORKFLOW_APPROVAL_PERMISSION_ID = scenarioId('workflow-approval-permission');
const WORKFLOW_REVIEWING_BRIEFS_ID = scenarioId('workflow-reviewing-briefs');
const WORKFLOW_QUESTION_ID = scenarioId('workflow-question');
const WORKFLOW_PAUSED_MID_BRIEF_ID = scenarioId('workflow-paused-mid-brief');
const WORKFLOW_PAUSED_BOUNDARY_ID = scenarioId('workflow-paused-boundary');
const WORKFLOW_STOPPING_ID = scenarioId('workflow-stopping');
const WORKFLOW_STOPPED_ID = scenarioId('workflow-stopped');
const WORKFLOW_FAILURE_ID = scenarioId('workflow-failure');
const WORKFLOW_RECOVERY_USAGE_LIMIT_ID = scenarioId('workflow-recovery-usage-limit');
const WORKFLOW_RECOVERY_RETRY_EXHAUSTED_ID = scenarioId('workflow-recovery-retry-exhausted');
const WORKFLOW_API_CONTEXT_ID = scenarioId('workflow-api-context-insufficient');
const WORKFLOW_RECOVERY_PLAN_SEAT_ID = scenarioId('workflow-recovery-plan-seat');
const WORKFLOW_RECOVERY_PLAN_SWAPPED_ID = scenarioId('workflow-recovery-plan-swapped');

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
      type: 'artifact_written',
      ts: FIXED_TS + 50,
      phase: 'researching',
      filename: 'research.md',
      path: '.splitbrief/sessions/2026-09-17-workflow-conversation-recovery/research.md',
      lineCount: 24,
      excerpt: ['Project Overview', 'Existing workflow and recovery behavior'],
      omittedCount: 5,
      omittedUnit: 'section',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 60,
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      text: 'Which module should the plan cover?',
    },
    {
      type: 'user_message',
      ts: FIXED_TS + 70,
      phase: 'planning',
      text: 'Refactor src/auth.ts; preserve the public API.',
    },
    {
      type: 'planner_status',
      ts: FIXED_TS + 100,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'tasks',
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

// One slice per brief, three briefs, so the build-progress block has a fraction to report and the
// task header has a second file to count.
const FIXTURE_TASKS_PLANNED: EngineEvent = {
  type: 'tasks_planned',
  ts: FIXED_TS + 50,
  phase: 'implementing',
  total: 3,
  tasks: [
    {
      id: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      action: 'modify',
    },
    {
      id: WORKFLOW_FIXTURE_TASK_ID_2,
      title: 'Register the bounded fixture projection',
      index: 1,
      file: WORKFLOW_FIXTURE_SECOND_FILE,
      action: 'modify',
    },
    {
      id: WORKFLOW_FIXTURE_TASK_ID_3,
      title: 'Capture the bounded fixture frame',
      index: 2,
      file: WORKFLOW_FIXTURE_REVIEW_PANEL_FILE,
      action: 'create',
    },
  ],
};

const wideCommandActivity = projectRunnerCallActivity(
  {
    ts: FIXED_TS + 350,
    callId: FIXED_CALL_ID,
    role: 'implementer',
    backendKind: 'api',
    runnerName: FIXED_RUNNER_NAME,
    model: FIXED_RUNNER_MODEL,
    attempt: 1,
    type: 'call_tool_use_delta',
    channel: 'tool',
    toolUseId: 'wide-command',
    name: 'Bash',
    inputDelta: JSON.stringify({
      command:
        'npm exec vitest run src/engine/calls/activity.test.ts src/features/workflow/display/activity-display-text.test.ts --reporter=verbose',
    }),
  },
  4,
);
if (wideCommandActivity === null) throw new Error('Missing wide command fixture activity');

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
    FIXTURE_TASKS_PLANNED,
    {
      type: 'task_started',
      ts: FIXED_TS + 100,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 3,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      files: [WORKFLOW_FIXTURE_REVIEW_FILE, WORKFLOW_FIXTURE_SECOND_FILE],
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
      type: 'runner_call_activity',
      ts: FIXED_TS + 290,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 1,
      activityId: 'visual-call-001:warn:1',
      stage: 'warning',
      kind: 'warning',
      label: 'warning fixture drift detected',
      redacted: false,
      rawAvailable: false,
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
      sequence: 2,
      activityId: 'visual-call-001:read:1',
      stage: 'completed',
      kind: 'read',
      label: WORKFLOW_FIXTURE_TEXT.implementation,
      target: WORKFLOW_FIXTURE_REVIEW_FILE,
      redacted: false,
      rawAvailable: false,
    },
    {
      type: 'runner_call_activity',
      ts: FIXED_TS + 320,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 3,
      activityId: 'visual-call-001:read:2',
      stage: 'completed',
      kind: 'read',
      label: WORKFLOW_FIXTURE_TEXT.implementation,
      redacted: false,
      rawAvailable: false,
    },
    {
      type: 'runner_call_activity',
      ts: FIXED_TS + 350,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: FIXED_CALL_ID,
      role: 'implementer',
      backendKind: 'api',
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      attempt: 1,
      sequence: 4,
      ...wideCommandActivity,
    },
  ],
  streaming: {
    lines: ['Reading fixture contract', 'Projecting bounded activity'],
  },
};

// The three verdicts a gate row can carry, on one frame: a stage that passed, a stage that never
// ran and says why, and a stage the baseline was already failing when the run started.
const validationProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_VALIDATION_ID,
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
    FIXTURE_TASKS_PLANNED,
    {
      type: 'validation_baseline',
      ts: FIXED_TS + 60,
      phase: 'implementing',
      status: 'done',
      stages: { typecheck: true, lint: false, test: false },
      commands: { typecheck: 'npm run typecheck', lint: 'npm run lint' },
      failing: { lint: true },
      duration: 2_100,
    },
    {
      type: 'task_started',
      ts: FIXED_TS + 100,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 3,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      files: [WORKFLOW_FIXTURE_REVIEW_FILE, WORKFLOW_FIXTURE_SECOND_FILE],
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'validate',
      ts: FIXED_TS + 400,
      phase: 'validating-task',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      status: 'done',
      passed: true,
      exempt: true,
      stages: { typecheck: true, lint: false, test: false },
      attempted: { typecheck: true, lint: true, test: true },
      commands: { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' },
      skipped: { test: true },
      skippedReason: { test: WORKFLOW_FIXTURE_TEXT.validationSkipReason },
      duration: 1_800,
    },
  ],
};

const implementationRetryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IMPLEMENTATION_RETRY_ID,
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
    FIXTURE_TASKS_PLANNED,
    {
      type: 'task_started',
      ts: FIXED_TS + 100,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 3,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      files: [WORKFLOW_FIXTURE_REVIEW_FILE, WORKFLOW_FIXTURE_SECOND_FILE],
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'task_retry',
      ts: FIXED_TS + 400,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      attempt: 1,
      maxRetries: 2,
      error: WORKFLOW_FIXTURE_TEXT.failure,
    },
  ],
};

const implementationEscalatedProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IMPLEMENTATION_ESCALATED_ID,
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
    FIXTURE_TASKS_PLANNED,
    {
      type: 'task_started',
      ts: FIXED_TS + 100,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 3,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'task_completed',
      ts: FIXED_TS + 600,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      method: 'escalated-full',
      retries: 2,
      duration: 500,
    },
  ],
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
    source: 'Approve the bounded fixture projection.\n\nIt writes one file and runs one gate.',
  },
};

const approvalDocumentProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_APPROVAL_DOCUMENT_ID,
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
      text: 'The plan slices the fixture feature into three briefs.',
    },
  ],
  reviewArtifact: 'plan',
  review: {
    filePath: WORKFLOW_FIXTURE_REVIEW_PANEL_FILE,
    source: '# Fixture plan\n\n1. Read the contract\n2. Slice the change\n3. Run the gates',
  },
};

const approvalPermissionProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_APPROVAL_PERMISSION_ID,
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
  ],
  approval: {
    actionDescription: 'src/features/workflow/panel.ts',
    answer: WORKFLOW_FIXTURE_TEXT.reviewAnswer,
  },
};

const reviewingBriefsProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_REVIEWING_BRIEFS_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'review',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'reviewing-briefs',
      feature: WORKFLOW_FEATURE,
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'reviewing-briefs',
      role: 'planner',
      content: 'plain',
      text: 'Three briefs compiled from the approved plan.',
    },
  ],
  reviewArtifact: 'briefs',
  review: {
    filePath: WORKFLOW_FIXTURE_REVIEW_PANEL_FILE,
    source: '# T001 modify\n\nProject deterministic workflow activity.',
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
    questions: [
      {
        id: 'review-seat',
        type: 'choice',
        text: WORKFLOW_FIXTURE_TEXT.question,
        options: [
          'Reviewer/planner seat (review-only tool, per existing split-review design)',
          'Implementer seat reviewing its own diff slices',
        ],
        default: 'Reviewer/planner seat (review-only tool, per existing split-review design)',
      },
      {
        id: 'review-slice',
        type: 'choice',
        text: 'What should a ‘slice’ be when one Task Brief changes several files, including shared types and their callers?',
        options: [
          'One slice per changed file',
          'One slice per Task Brief/task',
          'Size-bounded chunks of the diff, keeping each function with its callers where possible. Include the original Task Brief, the surrounding unchanged lines, and validation results with every chunk so the reviewer can judge the change independently. If a function exceeds the limit, split it at a statement boundary and carry its signature into the next chunk. Keep Unicode paths such as src/レビュー.ts intact. Report findings against original file and line numbers, then merge duplicates before the final review.',
        ],
        default: 'One slice per changed file',
      },
      {
        id: 'review-location',
        type: 'choice',
        text: "Where should sliced review live so users can inspect a local diff and reuse the same review behavior in a workflow's final review step?",
        options: [
          'New option on the existing review CLI command',
          'New standalone CLI command',
          "Change to the workflow's final-review step",
          'All of the above, sharing one core',
        ],
        default: 'New option on the existing review CLI command',
      },
    ],
  },
};

const questionOverflowProjection: WorkflowFixtureProjection = {
  ...questionProjection,
  scenarioId: scenarioId('workflow-question-overflow'),
  questionPreview: 'overflow-back',
};

const questionInputProjection: WorkflowFixtureProjection = {
  ...questionProjection,
  scenarioId: scenarioId('workflow-question-input'),
  question: {
    prompt: 'Type your answer…',
    answer: 'Review the current diff',
    questions: [
      {
        id: 'target',
        type: 'input',
        text: 'Which file or module do you want refactored?',
        default: 'src/features/workflow',
      },
      {
        id: 'goal',
        type: 'choice',
        text: 'What is the refactor goal?',
        options: ['Simplify/reduce complexity', 'Fix a specific bug', 'Just general cleanup'],
        default: 'Just general cleanup',
      },
    ],
  },
};

const plannerReplyProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-planner-reply'),
  feature: 'Refactor my code',
  inputMode: 'question',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'researching', feature: 'Refactor my code' },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'researching',
      role: 'planner',
      content: 'plain',
      text: 'Which module should change? Tell me what is wrong or what behavior you want to improve.',
    },
  ],
  question: { prompt: 'Reply to the planner…', answer: 'Refactor src/auth.ts.', questions: [] },
};

// The flat numbered blob the planner prompt consumes. It is the qa pairs below joined, so only
// the pairs are content; the join is exempted from the string bound like the task-review prompt.
const ANSWERED_QUESTIONS_TEXT =
  '1. What should be refactored? Give a file/module/feature name or area of the codebase.\nI want you to first review the changes and then after review make tasks of fixes for implementer\n\n2. What kind of refactor?\nSimplify/clean up existing code';

const answeredQuestionsProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-question-answered'),
  feature: 'Refactor my code',
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'clarifying', feature: 'Refactor my code' },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'clarifying',
      role: 'planner',
      content: 'plain',
      text: 'A few questions before I write the plan.',
    },
    {
      type: 'user_message',
      ts: FIXED_TS + 200,
      phase: 'clarifying',
      text: ANSWERED_QUESTIONS_TEXT,
      qa: [
        {
          question:
            'What should be refactored? Give a file/module/feature name or area of the codebase.',
          answer:
            'I want you to first review the changes and then after review make tasks of fixes for implementer',
        },
        { question: 'What kind of refactor?', answer: 'Simplify/clean up existing code' },
      ],
    },
  ],
};

const taskReviewRequest: TaskReviewRequest = {
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  taskTitle: 'Update fixture',
  status: 'done',
  filesTouched: ['src/fixture.ts'],
  validation: { passed: true, summary: 'tests passed', stages: [{ stage: 'test', passed: true }] },
  evidence: {
    summary: 'behavior verified',
    expected: ['fixture works'],
    observed: ['fixture works'],
  },
  cost: {
    tokenUsage: makeUsage({ implementerInput: 12345, implementerOutput: 23456 }),
    tool: 'ollama',
    model: 'qwen',
  },
  routing: {
    fit: 'tight',
    estimatedTokens: 12345,
    untruncatedEstimatedTokens: 23456,
    contextLength: 32768,
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    reason: 'Selected worker (tight, estimated 12345/32768 tokens)',
  },
  availableCommands: ['continue', 'redo-task', 'abort'],
};

const taskReviewProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-task-review'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  taskReview: taskReviewRequest,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
  ],
  question: {
    get prompt() {
      return formatTaskReviewPrompt(taskReviewRequest);
    },
    answer: 'c',
  },
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
    // Six detected tools: more than the three the text prompt names, so the panel's own height is
    // proved to follow its action rows and not the offer. Tool-only candidates match the readiness
    // snapshot shape — the model is chosen in the seat's picker, which taking the swap opens.
    candidates: [
      { tool: 'opencode' },
      { tool: 'codex' },
      { tool: 'claude-code', model: 'sonnet' },
      { tool: 'cursor' },
      { tool: 'copilot' },
      { tool: 'kilo-code' },
    ],
  },
  facts: { tool: 'Ollama' },
  availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
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

/**
 * A brief the ladder could not land: the last error the brief died on, the attempts spelled out
 * as local retries plus the hinted one, both voices — what the implementer said before it stopped
 * and what the planner answered — and the verdict the planner reached on the brief itself.
 */
const retryExhaustedRecoveryIssue: RecoveryIssue = {
  id: 'rec_visual_retry_exhausted',
  reason: 'retry-exhausted',
  phase: 'escalating',
  status: 'awaiting-user',
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  taskTitle: WORKFLOW_FIXTURE_TEXT.implementationTask,
  files: [WORKFLOW_FIXTURE_REVIEW_FILE],
  affectedTaskIds: [WORKFLOW_FIXTURE_TASK_ID],
  message: `${WORKFLOW_FIXTURE_TASK_ID} exhausted recovery retries`,
  details: [
    "Validation: error TS2339: Property 'stop' is missing on Projection.",
    'Attempts: 4 (3 local, then 1 with planner hints)',
    'Implementer said: no stop field on Projection, so I wrote nothing.',
    'Planner said: The field is optional; read it via the registry.',
    'Planner verdict: the brief itself is wrong — Projection never declared stop',
  ],
  attempts: 4,
  maxAttempts: 3,
  selectedImplementerProfile: 'local-fixture',
  facts: {
    validationSummary: "error TS2339: Property 'stop' is missing on Projection.",
    allowRetryOverride: true,
    hintRungRan: true,
    plannerVerdict: 'brief',
  },
  availableActions: ['retry-same-worker', 'skip-current-task', 'pause-run', 'end-run'],
  recommendedAction: 'retry-same-worker',
  createdAt: new Date(FIXED_TS).toISOString(),
};

const retryExhaustedRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_RETRY_EXHAUSTED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  resumeState: haltedResumeState(retryExhaustedRecoveryIssue),
};

/**
 * A plan packet the seat was never given: the halt the engine persists carries the cause, the
 * sections and the figures, and the panel shows only the first two. The run is still in planning,
 * so there is no brief to replay and the retry re-issues the seat's own step.
 */
const apiContextRecoveryIssue: RecoveryIssue = {
  id: 'rec_visual_api_context',
  reason: 'planner-call-failed',
  seat: 'plan',
  phase: 'planning',
  status: 'awaiting-user',
  files: [],
  affectedTaskIds: [],
  message: 'The planning seat was not given the context this call needs.',
  details: [
    'Missing: evidence.json, drift-report.json',
    'Adjust the plan seat with /crew plan or Settings, then /resume and choose retry.',
  ],
  facts: {
    apiContextCode: 'insufficient-context',
    apiContextSeat: 'plan',
    apiContextCause: 'missing-required',
    apiContextModel: 'qwen3-coder-30b',
    apiContextMissingSectionsJson: '["evidence.json","drift-report.json"]',
  },
  availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
  recommendedAction: 'pause-run',
  createdAt: new Date(FIXED_TS).toISOString(),
};

const apiContextRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_API_CONTEXT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  resumeState: makeWorkflowState({
    feature: WORKFLOW_FEATURE,
    phase: 'planning',
    pendingRecovery: apiContextRecoveryIssue,
  }),
};

/**
 * The plan seat out of quota mid-plan: the halt is about the seat, not a brief, and offers the
 * seat's other ready tools. Every surface that names the move names PLAN, never the build seat.
 */
const planUsageLimitRecoveryIssue: RecoveryIssue = {
  id: 'rec_visual_plan_usage_limit',
  reason: 'runner-usage-limit',
  seat: 'plan',
  phase: 'planning',
  status: 'awaiting-user',
  files: [],
  affectedTaskIds: [],
  message:
    'Planning failed. Claude Code hit its usage limit — logging in again will not fix this. The limit resets at 5:00 PM; wait for it or switch the planner.',
  details: ['Claude Code reported: usage limit reached · resets 5pm'],
  resetAt: new Date(WORKFLOW_FIXTURE_RESET_AT).toISOString(),
  switchSeat: { seat: 'plan', candidates: [{ tool: 'codex' }, { tool: 'opencode' }] },
  facts: { tool: 'Claude Code' },
  availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
  recommendedAction: 'switch-seat',
  createdAt: new Date(FIXED_TS).toISOString(),
};

const planSeatRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_PLAN_SEAT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  resumeState: makeWorkflowState({
    feature: WORKFLOW_FEATURE,
    phase: 'planning',
    pendingRecovery: planUsageLimitRecoveryIssue,
  }),
};

const planSeatHalt = {
  phase: 'planning',
  issueId: 'rec_visual_plan_swapped',
  reason: 'runner-usage-limit',
} as const;
const planSeatSwap = { ...planSeatHalt, action: 'switch-seat', seat: 'plan' } as const;

/**
 * A plan seat that ran out on Codex and was moved onto Claude Code, the planner this fixture's
 * config names — so the header, which reads the seat of record, shows the seat after the swap.
 */
const planSeatSwappedProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_PLAN_SWAPPED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    {
      type: 'error',
      ts: FIXED_TS + 100,
      phase: 'planning',
      message:
        'Planning failed. Codex hit its usage limit — logging in again will not fix this. Wait for the limit to reset or switch the planner, then start again.',
    },
    {
      type: 'recovery_prompted',
      ts: FIXED_TS + 200,
      ...planSeatHalt,
      files: [],
      affectedTaskIds: [],
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      headline: 'Usage limit on Codex',
      resumeCommand: 'splitbrief continue visual-workflow --action switch-seat:claude-code',
    },
    { type: 'recovery_action_selected', ts: FIXED_TS + 300, ...planSeatSwap },
    { type: 'recovery_resolved', ts: FIXED_TS + 400, ...planSeatSwap, outcome: 'continued' },
    {
      type: 'planner_status',
      ts: FIXED_TS + 500,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'claude-sonnet-4',
    },
  ],
};

const STOPPED_RUN_EVENTS: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: FIXED_TS,
    phase: 'implementing',
    feature: WORKFLOW_FEATURE,
  },
  FIXTURE_TASKS_PLANNED,
  {
    type: 'task_started',
    ts: FIXED_TS + 100,
    phase: 'implementing',
    taskId: WORKFLOW_FIXTURE_TASK_ID,
    title: WORKFLOW_FIXTURE_TEXT.implementationTask,
    index: 0,
    total: 3,
    file: WORKFLOW_FIXTURE_REVIEW_FILE,
    files: [WORKFLOW_FIXTURE_REVIEW_FILE, WORKFLOW_FIXTURE_SECOND_FILE],
    action: 'modify',
    tool: 'ollama',
    model: FIXED_RUNNER_MODEL,
  },
];

const pausedMidBriefProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PAUSED_MID_BRIEF_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: STOPPED_RUN_EVENTS,
  stop: {
    intent: 'stop-now',
    phase: 'parked',
    parked: { kind: 'mid-brief', taskId: WORKFLOW_FIXTURE_TASK_ID },
  },
};

const pausedBoundaryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PAUSED_BOUNDARY_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    ...STOPPED_RUN_EVENTS,
    {
      type: 'task_completed',
      ts: FIXED_TS + 600,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      method: 'local',
      retries: 0,
      duration: 500,
    },
  ],
  stop: {
    intent: 'pause-after-brief',
    phase: 'parked',
    parked: { kind: 'boundary', taskId: WORKFLOW_FIXTURE_TASK_ID },
  },
};

const stoppingProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_STOPPING_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: STOPPED_RUN_EVENTS,
  stop: { intent: 'stop-now', phase: 'settling' },
};

const stoppedProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_STOPPED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    ...STOPPED_RUN_EVENTS,
    {
      type: 'workflow_cancelled',
      ts: FIXED_TS + 700,
      phase: 'implementing',
      reason: 'user_cancelled',
    },
  ],
  stop: { intent: 'end-run', phase: 'ended' },
};

const projections = [
  idleProjection,
  planningProjection,
  implementationProjection,
  implementationRetryProjection,
  implementationEscalatedProjection,
  validationProjection,
  reviewProjection,
  approvalDocumentProjection,
  approvalPermissionProjection,
  reviewingBriefsProjection,
  questionProjection,
  questionOverflowProjection,
  questionInputProjection,
  plannerReplyProjection,
  answeredQuestionsProjection,
  taskReviewProjection,
  pausedMidBriefProjection,
  pausedBoundaryProjection,
  stoppingProjection,
  stoppedProjection,
  failureProjection,
  usageLimitRecoveryProjection,
  retryExhaustedRecoveryProjection,
  apiContextRecoveryProjection,
  planSeatRecoveryProjection,
  planSeatSwappedProjection,
] as const;

export const workflowFixtureProjections: ReadonlyMap<ScenarioId, WorkflowFixtureProjection> =
  new Map(
    [...projections, ...atRestProjections].map((projection) => [projection.scenarioId, projection]),
  );

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
    questionHint,
    questions: projection.question?.questions,
    reviewArtifact: projection.reviewArtifact ?? null,
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
    // The production formatter joins bounded facts and commands into one multiline prompt, and
    // the answered card's flat text joins its bounded qa pairs; neither is independent content.
    (value) =>
      value !== formatTaskReviewPrompt(taskReviewRequest) &&
      value !== ANSWERED_QUESTIONS_TEXT &&
      value.length > WORKFLOW_FIXTURE_BOUNDS.maxStringLength &&
      !projection.question?.questions?.some(
        (question) =>
          question.type === 'choice' &&
          question.options.includes(value) &&
          value.length <= WORKFLOW_FIXTURE_BOUNDS.maxQuestionOptionLength,
      ),
  );
  if (oversized !== undefined) {
    throw new Error(`Workflow fixture ${projection.scenarioId} exceeds the string bound`);
  }
}

for (const projection of projections) assertProjectionBounds(projection);
