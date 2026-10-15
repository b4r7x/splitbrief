import { projectRunnerCallActivity } from '../../../../src/engine/calls/activity.js';
import { reviewResumeProjection, reviewCheckCrashProjection } from './review-resume-projection.js';
import { buildArtifactExcerpt } from '../../../../src/engine/orchestrator/artifact-card.js';
import { checkFailureText } from '../../../../src/engine/orchestrator/validation/failure-text.js';
import { formatTasks } from '../../../../src/engine/spec/formatter.js';
import type { RecoveryIssue } from '../../../../src/core/schemas/recovery/schemas.js';
import type { DriftFinding } from '../../../../src/core/schemas/drift.js';
import type { RunRecord } from '../../../../src/core/sessions/run-record.js';
import type { Summary } from '../../../../src/core/schemas/summary.js';
import { retainedWorkspaceNotices, retainedWorkspaceProjection } from './retained-workspace.js';
import { closedQueueProjection } from './closed-queue-projection.js';
import { cliStopContinuedProjection } from './cli-stop-continued.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import type { SeatSwitchRecord, WorkflowState } from '../../../../src/core/schemas/workflow.js';
import type { ConsultSeat } from '../../../../src/core/schemas/consult.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { makeRunRecord } from '../../../helpers/factories/run-record.js';
import { SessionLogEventEntrySchema } from '../../../../src/core/schemas/session-log.js';
import { engineEventFromLogEntry } from '../../../../src/engine/events/replay.js';
import { makeReviewFixInsertedEvents } from '../../../helpers/events/task.js';
import { makePlanProposal, makeTaskSpec } from '../../../helpers/factories/plan.js';
import { formatPlanMarkdown } from '../../../../src/engine/spec/plan-markdown.js';
import { renderCheckNotes, planRepairWarning } from '../../../../src/engine/spec/plan-checks.js';
import { MAX_QUESTION_ROUNDS } from '../../../../src/engine/spec/prompts/plan-session.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../../src/core/pipeline-spec/retries.js';
import { BOUNDS } from '../../../../src/core/pipeline-spec/bounds.js';
import { buildConsultBoundRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/consult.js';
import { taskFromSpec } from '../../../../src/engine/spec/plan-tasks.js';
import { planConfirmations } from '../../../../src/engine/orchestrator/approval/confirm.js';
import { makeImplState, makeWorkflowState } from '../../../helpers/factories/workflow-state.js';
import type { EngineEvent, EngineEventOf, EventBus } from '../../../../src/engine/events/types.js';
import type { ClarificationQuestion } from '../../../../src/core/schemas/question.js';
import type { ReviewArtifact } from '../../../../src/features/workflow/prompt-rows/approval.js';
import { getWorkflowPromptRows } from '../../../../src/features/workflow/prompt-rows/workflow.js';
import { formatRecoveryPrompt } from '../../../../src/features/workflow/recovery-prompt.js';
import { projectRunnerCallEvents } from '../../../../src/engine/calls/event-projection.js';
import { createRunnerCallRecorder } from '../../../../src/engine/calls/recorder.js';
import { createImplementerCallContext } from '../../../../src/engine/implementers/pipeline/call-result.js';
import type { RunnerCallEvent } from '../../../../src/engine/calls/types.js';
import { claudeCodePlannerAdapter } from '../../../../src/engine/runners/cli-tools/claude-code.js';
import { recordCliProtocolEvent } from '../../../../src/engine/runners/cli-tools/process-invoke.js';
import { createCliTextForwarder } from '../../../../src/engine/runners/invoke-cli-adapter.js';
import type { ApprovalPromptState } from '../../../../src/stores/approval-prompt/prompt.js';
import type {
  ReviewChecksApprovalRequest,
  TieredApprovalRequest,
} from '../../../../src/core/approval/types.js';
import { reviewChecksCardLayout } from '../../../../src/features/workflow/review-checks/options.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../../src/stores/workflow/stop.js';
import { type ScenarioId, scenarioId } from '../../contracts/identifiers.js';
import { tasksCardProjection } from './artifact-card-projections.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildReviewFailedRecoveryIssue,
  buildSeatDownIssue,
  buildLeftIsolationRecoveryIssue,
  buildCheckoutChangedRecoveryIssue,
  runnerHaltRow,
  type SeatDownRecoveryOptions,
  type SeatSwapContext,
} from '../../../../src/engine/orchestrator/recovery/builders/task.js';
import { parseUsageLimitReset } from '../../../../src/engine/runners/usage-limit.js';
import type { SeatFailureClassification } from '../../../../src/engine/runners/seat-failure.js';
import {
  consultHaltDetails,
  reviewSeatDetails,
} from '../../../../src/engine/orchestrator/recovery/builders/details.js';
import {
  buildPlanSessionHaltRecoveryIssue,
  buildPlannerCallFailedRecoveryIssue,
} from '../../../../src/engine/orchestrator/recovery/builders/planner.js';
import { diagnosePlannerCallFailure } from '../../../../src/engine/orchestrator/recovery/planner-call-failure.js';
import { consultFailureLabel } from '../../../../src/engine/orchestrator/task/retry.js';
import {
  publishError,
  publishRecoveryActionSelected,
  publishRecoveryPrompted,
  publishRecoveryResolved,
  publishWarning,
  publishSeatSwitched,
  publishTaskStart,
} from '../../../../src/engine/orchestrator/events.js';
import type { Config } from '../../../../src/core/schemas/config.js';
import { error } from '../../../../src/utils/error.js';
import { createEventBus } from '../../../../src/engine/events/bus.js';
import {
  checkCommandRefusal,
  sanitizeDiscoveredValidation,
} from '../../../../src/engine/orchestrator/planning/sanitize-discovered-validation.js';
import {
  BASE_IMPLEMENTER,
  BASE_PLANNER,
  VISUAL_FIXTURE_PROJECT_DIR,
  visualConfig,
  VISUAL_WORKFLOW_SESSION_ID,
  VISUAL_WIDE_CREW,
} from '../screen-fixtures.js';
import { VISUAL_FIXTURE_EPOCH } from '../common.js';
import { RUNNER_IDLE_WARN_MS } from '../../../../src/core/schemas/runner-fields.js';
import { seatAxisWords } from '../../../../src/core/runners/effort-channel.js';
import { formatSeatChangeIdentities } from '../../../../src/core/crew/identity.js';
import { formatRecoveryHeadline } from '../../../../src/core/recovery/headline.js';
import { fallbackBlockedReason } from '../../../../src/core/crew/fallback.js';
import { configWithSwitchedSeat } from '../../../../src/engine/orchestrator/recovery/switch-seat.js';
import type { ScopedCliCatalogAttempt } from '../../../../src/engine/detection/cli-catalog-outcomes.js';
import {
  atRestProjections,
  reviewTaskCadenceProjection,
  reviewTaskOutOfScopeProjection,
} from './at-rest-projections.js';

type VisualConfigOverrides = Parameters<typeof visualConfig>[0];

export const WORKFLOW_FIXTURE_VERSION = 1;

export const WORKFLOW_FIXTURE_BOUNDS = Object.freeze({
  version: WORKFLOW_FIXTURE_VERSION,
  maxEventsPerFixture: 32,
  maxStringLength: 160,
  maxQuestionOptionLength: 640,
});

const FIXED_TS = VISUAL_FIXTURE_EPOCH;
export const WORKFLOW_FIXTURE_TASK_ID = taskId('T901');
const FIXED_CALL_ID = 'visual-call-001';
// The gallery's BUILD seat, as its API runner names its calls, so every surface names one seat.
const FIXED_RUNNER_NAME = 'ollama';
const FIXED_RUNNER_MODEL = 'qwen2.5-coder:7b';
const WORKFLOW_FEATURE = 'Visual fixture workflow';
export const WORKFLOW_FIXTURE_REVIEW_FILE = 'testing/visual/fixtures/workflow/projections.ts';
export const WORKFLOW_FIXTURE_REVIEW_PANEL_FILE =
  'testing/visual/fixtures/workflow/review-fixture.md';

export const WORKFLOW_FIXTURE_SECOND_FILE = 'testing/visual/fixtures/workflow/registry.ts';
export const WORKFLOW_FIXTURE_TASK_ID_2 = taskId('T902');
export const WORKFLOW_FIXTURE_TASK_ID_3 = taskId('T903');
export const WORKFLOW_FIXTURE_FIX_TASK_ID = taskId('T904');

export const WORKFLOW_FIXTURE_TEXT = Object.freeze({
  idle: 'no events yet',
  planningNarration: 'Reading the parser before the fixture it pins.',
  planningRead: 'src/engine/streaming/parse-stream-json.ts',
  planningReply: 'The parser keeps the frames out of the reply.',
  implementation: 'Inspecting deterministic fixture contract',
  implementationTask: 'Project deterministic workflow activity',
  validationSkipReason: 'no affected test file found',
  review: 'package.json',
  reviewAnswer: 'Approve once',
  question: 'Which seat performs the per-slice review?',
  questionAnswer: 'Reviewer/planner seat',
  success: 'Visual fixture workflow complete',
  failure: 'Synthetic runner failure: bounded fixture',
  implementerFailure:
    'Edit bundle did not apply: testing/visual/fixtures/workflow/projections.ts hunk 2 no longer matches\nHint: the next attempt reads the current file',
  recovery: 'Change BUILD tool',
  recoveryPlan: 'Change PLAN tool',
  retryExhausted: 'failed',
  consultBound: 'used its consult allowance',
  reviewFailed: 'Fix again',
  reviewFixTask: 'Fix the finding the review raised',
  leftIsolation: 'Seat down · T901 left the isolation directory',
  checkoutChanged: 'Needs you · Repository changed under T901',
  apiContext: 'Nothing was sent to PLAN',
});

interface FixtureQuestion {
  readonly seat?: ConsultSeat;
  readonly prompt: string;
  readonly answer: string;
  readonly questions?: readonly ClarificationQuestion[];
}

interface FixtureApproval {
  readonly actionDescription: string;
  readonly answer: string;
  readonly actionClass?: TieredApprovalRequest['actionClass'];
}

interface FixtureReview {
  readonly filePath: string;
  readonly source: string;
  /** The plan.json beside a plan card's plan.md, the file its Edit row opens. */
  readonly planJson?: string;
  /** What approving the plan card confirms, as the engine hands it to the card. */
  readonly confirms?: readonly string[];
}

interface FixtureStreaming {
  readonly lines: readonly string[];
}

/** What the user asked of the stop ladder; the registry stamps it after the events land. */
export interface FixtureStopState {
  readonly intent: StopIntent;
  readonly phase: StopPhase;
  readonly parked?: {
    readonly kind: StopParkKind;
    readonly taskId: string;
    readonly kept?: readonly string[];
  };
}

/**
 * A run the screen opens at rest: its record, and the session log its transcript replays when the
 * scenario is about the replay itself rather than about the block at the tail.
 */
export interface FixtureAtRestRoute {
  readonly record: RunRecord;
  readonly log?: string | readonly EngineEvent[];
}

export interface WorkflowFixtureProjection {
  readonly scenarioId: ScenarioId;
  readonly feature: string;
  readonly events: readonly EngineEvent[];
  readonly inputMode: 'normal' | 'review' | 'question';
  readonly sidebarVisible: boolean;
  readonly question?: FixtureQuestion;
  readonly questionPreview?: 'overflow-back';
  readonly approval?: FixtureApproval;
  /** The reviewer checks card, open on the commands the reviewer chose. */
  readonly reviewChecksPrompt?: ReviewChecksApprovalRequest;
  readonly review?: FixtureReview;
  /** The artifact the document review panel names, when the projection opens that gate. */
  readonly reviewArtifact?: ReviewArtifact;
  readonly streaming?: FixtureStreaming;
  /** The crew and workflow settings the saved run ran under, when they are not the gallery default. */
  readonly config?: VisualConfigOverrides;
  readonly cliModels?: readonly ScopedCliCatalogAttempt[];
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
const WORKFLOW_PLANNING_PATH_NOTICE_ID = scenarioId('workflow-planning-path-notice');
const WORKFLOW_IMPLEMENTATION_ID = scenarioId('workflow-implementation');
const WORKFLOW_IMPLEMENTATION_RETRY_ID = scenarioId('workflow-implementation-retry');
const WORKFLOW_VALIDATION_ID = scenarioId('workflow-validation');
const WORKFLOW_IMPLEMENTATION_ESCALATED_ID = scenarioId('workflow-implementation-escalated');
const WORKFLOW_IMPLEMENTATION_NARRATION_ID = scenarioId('workflow-implementation-narration');
const WORKFLOW_IMPLEMENTATION_ADJACENT_NARRATION_ID = scenarioId(
  'workflow-implementation-adjacent-narration',
);
const WORKFLOW_IMPLEMENTATION_FENCED_HANDBACK_ID = scenarioId(
  'workflow-implementation-fenced-handback',
);
const WORKFLOW_REVIEW_ID = scenarioId('workflow-review');
const WORKFLOW_REVIEW_FIX_ID = scenarioId('workflow-review-fix');
const WORKFLOW_REVIEW_FIX_NO_CHANGE_ID = scenarioId('workflow-review-fix-no-change');
const WORKFLOW_FINAL_REVIEW_ID = scenarioId('workflow-final-review');
const WORKFLOW_APPROVAL_CONFIRM_ID = scenarioId('workflow-approval-confirm');
const WORKFLOW_QUESTION_ID = scenarioId('workflow-question');
const WORKFLOW_PAUSED_MID_BRIEF_ID = scenarioId('workflow-paused-mid-brief');
const WORKFLOW_RESUMED_KEPT_WORK_ID = scenarioId('workflow-resumed-kept-work');
const WORKFLOW_PAUSED_BOUNDARY_ID = scenarioId('workflow-paused-boundary');
const WORKFLOW_STOPPING_ID = scenarioId('workflow-stopping');
const WORKFLOW_FAILURE_ID = scenarioId('workflow-failure');
const WORKFLOW_RECOVERY_USAGE_LIMIT_ID = scenarioId('workflow-recovery-usage-limit');
const WORKFLOW_RECOVERY_RETRY_EXHAUSTED_ID = scenarioId('workflow-recovery-retry-exhausted');
const WORKFLOW_RECOVERY_CONSULT_BOUND_ID = scenarioId('workflow-recovery-consult-bound');
const WORKFLOW_RECOVERY_REVIEW_FAILED_ID = scenarioId('workflow-recovery-review-failed');
const WORKFLOW_RECOVERY_LEFT_ISOLATION_ID = scenarioId('workflow-recovery-left-isolation');
const WORKFLOW_RECOVERY_CHECKOUT_CHANGED_ID = scenarioId('workflow-recovery-checkout-changed');
const WORKFLOW_API_CONTEXT_ID = scenarioId('workflow-api-context-insufficient');
const WORKFLOW_RECOVERY_PLAN_SEAT_ID = scenarioId('workflow-recovery-plan-seat');
const WORKFLOW_RECOVERY_PLAN_CHECKS_ID = scenarioId('workflow-recovery-plan-checks');
const WORKFLOW_RECOVERY_PLAN_QUESTIONS_ID = scenarioId('workflow-recovery-plan-questions');
const WORKFLOW_RECOVERY_PLAN_SWAPPED_ID = scenarioId('workflow-recovery-plan-swapped');
const WORKFLOW_RECOVERY_REVIEW_SEAT_ID = scenarioId('workflow-recovery-review-seat');
const WORKFLOW_RECOVERY_HINT_SEAT_ID = scenarioId('workflow-recovery-hint-seat');
const WORKFLOW_PLAN_ACTIVITY_ID = scenarioId('workflow-plan-activity');
const WORKFLOW_PLANNING_CLAUDE_FRAMES_ID = scenarioId('workflow-planning-claude-frames');
const WORKFLOW_PLANNER_SESSION_EXPIRED_ID = scenarioId('workflow-planner-session-expired');

const idleProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IDLE_ID,
  feature: WORKFLOW_FEATURE,
  events: [],
  inputMode: 'normal',
  sidebarVisible: false,
};

// One planning session: it asked a round of questions, took the answers and plans on. Nothing
// streams while the planner works; the byline carries the session.
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
      ts: FIXED_TS + 10,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'plan',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 60,
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      messageStart: true,
      text: 'Questions before the plan · round 1 of 2',
    },
    {
      type: 'user_message',
      ts: FIXED_TS + 70,
      phase: 'planning',
      text: '1. Which module should the plan cover?\nsrc/auth.ts\n\n2. Keep the public API?\nYes',
      qa: [
        { question: 'Which module should the plan cover?', answer: 'src/auth.ts' },
        { question: 'Keep the public API?', answer: 'Yes' },
      ],
    },
  ],
};

const OUTSIDE_COMPOSER_FILE =
  '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md';

const startAttachedFilesProjection: WorkflowFixtureProjection = {
  ...planningProjection,
  scenarioId: scenarioId('workflow-start-attached-files'),
  events: [
    ...planningProjection.events.filter(
      (event) => event.type === 'workflow_started' || event.type === 'planner_status',
    ),
    {
      type: 'user_message',
      ts: FIXED_TS + 20,
      phase: 'planning',
      text: WORKFLOW_FEATURE,
      attachedInputs: [
        {
          path: OUTSIDE_COMPOSER_FILE,
          kind: 'text',
        },
        { path: '/Volumes/design/receiving-flow.png', kind: 'image' },
      ],
    },
  ],
};

const composerOutsideFileProjection: WorkflowFixtureProjection = {
  ...planningProjection,
  scenarioId: scenarioId('workflow-composer-outside-file'),
  events: [
    ...planningProjection.events,
    {
      type: 'user_message',
      ts: FIXED_TS + 80,
      phase: 'planning',
      text: `Use @${OUTSIDE_COMPOSER_FILE} for the receiving flow.`,
      attachedInputs: [{ path: OUTSIDE_COMPOSER_FILE, kind: 'text' }],
    },
  ],
};

const questionOutsideFileProjection: WorkflowFixtureProjection = {
  ...planningProjection,
  scenarioId: scenarioId('workflow-question-outside-file'),
  events: [
    ...planningProjection.events.filter((event) => event.type !== 'user_message'),
    {
      type: 'user_message',
      ts: FIXED_TS + 70,
      phase: 'planning',
      text: `1. Which brief describes the receiving flow?\nPlease use @${OUTSIDE_COMPOSER_FILE}`,
      qa: [
        {
          question: 'Which brief describes the receiving flow?',
          answer: `Please use @${OUTSIDE_COMPOSER_FILE}`,
        },
      ],
      attachedInputs: [{ path: OUTSIDE_COMPOSER_FILE, kind: 'text' }],
    },
  ],
};

const planningPathNoticeProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PLANNING_PATH_NOTICE_ID,
  feature: '/Users/dev/notes/brief.md plan from this brief',
  inputMode: 'normal',
  sidebarVisible: false,
  config: { planner: BASE_IMPLEMENTER },
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'planning',
      feature: '/Users/dev/notes/brief.md plan from this brief',
    },
    {
      type: 'warning',
      ts: FIXED_TS + 10,
      phase: 'planning',
      message:
        'The plan seat reads no files, so it cannot open /Users/dev/notes/brief.md. Put @ before a file path to attach its text.',
    },
    {
      type: 'planner_status',
      ts: FIXED_TS + 20,
      phase: 'planning',
      status: 'running',
      tool: BASE_IMPLEMENTER.provider,
      model: BASE_IMPLEMENTER.model,
      call: 'plan',
    },
  ],
};

// One slice per brief, three briefs, so the build-progress block has a fraction to report and the
// task header has a second file to count.
type TasksPlannedEvent = Extract<EngineEvent, { type: 'tasks_planned' }>;
const FIXTURE_TASKS_PLANNED: TasksPlannedEvent = {
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
    axes: seatAxisWords(BASE_IMPLEMENTER),
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
  VISUAL_FIXTURE_PROJECT_DIR,
);
if (wideCommandActivity === null) throw new Error('Missing wide command fixture activity');

const firstBriefAfterPlanProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-first-brief-after-plan'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  // A plan of real length, so the settled Plan row carries a duration past a minute.
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS - 720_000,
      phase: 'planning',
      feature: WORKFLOW_FEATURE,
    },
    { type: 'user_message', ts: FIXED_TS - 719_990, phase: 'planning', text: WORKFLOW_FEATURE },
    {
      type: 'artifact_written',
      ts: FIXED_TS + 15_000,
      phase: 'planning',
      filename: 'plan.md',
      path: '.splitbrief/sessions/visual-first-brief-after-plan/plan.md',
      lineCount: 3,
      excerpt: ['Project the workflow events, register the projection, and capture the frame.'],
      omittedCount: 0,
      omittedUnit: 'line',
    },
    { type: 'plan_approved', ts: FIXED_TS + 30_000, phase: 'reviewing-plan' },
    {
      ...FIXTURE_TASKS_PLANNED,
      ts: FIXED_TS + 30_050,
      tasks: FIXTURE_TASKS_PLANNED.tasks.map((task, index) => ({
        ...task,
        id: taskId(`T00${index + 1}`),
      })),
    },
    {
      type: 'task_started',
      ts: FIXED_TS + 30_100,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 3,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
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
      axes: seatAxisWords(BASE_IMPLEMENTER),
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
      axes: seatAxisWords(BASE_IMPLEMENTER),
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
      axes: seatAxisWords(BASE_IMPLEMENTER),
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
      axes: seatAxisWords(BASE_IMPLEMENTER),
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
      axes: seatAxisWords(BASE_IMPLEMENTER),
      attempt: 1,
      sequence: 4,
      ...wideCommandActivity,
    },
  ],
  streaming: {
    lines: ['Reading fixture contract', 'Projecting bounded activity'],
  },
};

const implementationQueuedProjection: WorkflowFixtureProjection = {
  ...implementationProjection,
  scenarioId: scenarioId('workflow-implementation-queued'),
  config: { implementer: BASE_PLANNER },
  events: [
    ...implementationProjection.events.map((event): EngineEvent => {
      if (event.type === 'task_started') {
        return { ...event, taskId: taskId('T003'), tool: 'claude-code', model: BASE_PLANNER.model };
      }
      if (event.type === 'runner_call_started' || event.type === 'runner_call_activity') {
        return {
          ...event,
          taskId: taskId('T003'),
          backendKind: 'cli',
          runnerName: 'claude',
          model: BASE_PLANNER.model,
          axes: seatAxisWords(BASE_PLANNER),
        };
      }
      if (event.type === 'tasks_planned') {
        return {
          ...event,
          tasks: event.tasks.map((task) => ({
            ...task,
            id: task.id === WORKFLOW_FIXTURE_TASK_ID ? taskId('T003') : task.id,
          })),
        };
      }
      if ('taskId' in event && event.taskId === WORKFLOW_FIXTURE_TASK_ID) {
        return { ...event, taskId: taskId('T003') };
      }
      return event;
    }),
    {
      type: 'message_queued',
      ts: FIXED_TS + 400,
      phase: 'implementing',
      id: 'visual-build-message',
      seat: 'build',
      taskId: 'T003',
      preview: 'Keep the parser changes small.',
    },
  ],
};

const implementationDeliveredProjection: WorkflowFixtureProjection = {
  ...implementationQueuedProjection,
  scenarioId: scenarioId('workflow-implementation-delivered'),
  events: [
    ...implementationQueuedProjection.events,
    {
      type: 'queue_drained',
      ts: FIXED_TS + 500,
      phase: 'implementing',
      count: 1,
      ids: ['visual-build-message'],
      seat: 'build',
      taskId: 'T003',
    },
  ],
};

const implementationSteerableProjection: WorkflowFixtureProjection = {
  ...implementationDeliveredProjection,
  scenarioId: scenarioId('workflow-implementation-steerable'),
  events: implementationDeliveredProjection.events.flatMap((event): EngineEvent[] => {
    if (event.type === 'message_queued') {
      return [
        {
          type: 'steerable_call',
          ts: FIXED_TS + 350,
          phase: 'implementing',
          seat: 'build',
          taskId: 'T003',
        },
        { ...event, steerable: true },
      ];
    }
    return [event.type === 'queue_drained' ? { ...event, via: 'mid-call' } : event];
  }),
};

const buildConsultProjection: WorkflowFixtureProjection = {
  ...implementationProjection,
  scenarioId: scenarioId('workflow-build-consult'),
  events: [
    ...implementationProjection.events.slice(0, 3),
    {
      type: 'runner_call_started',
      ts: FIXED_TS + 400,
      phase: 'escalating',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: 'visual-build-consult',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'claude',
      model: BASE_PLANNER.model,
      axes: seatAxisWords(BASE_PLANNER),
      sequence: 0,
    },
  ],
};

// A session from before reviewer checks: a brief gate whose red stages are also red at the run base
// accepts them as pre-existing failures. The rows stay for replaying such a session.
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
      phase: 'implementing',
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

// A run where a brief also changed files its brief did not suggest: its checks pass, the
// brief completes, and one dim row names the extra files for the reviewer.
const touchedNotSuggestedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-touched-not-suggested'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
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
      type: 'checks_run',
      ts: FIXED_TS + 400,
      phase: 'validating-task',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      results: [
        { id: 'C1', status: 'pass' },
        { id: 'C2', status: 'pass' },
      ],
    },
    {
      type: 'task_completed',
      ts: FIXED_TS + 500,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      method: 'local',
      retries: 0,
      duration: 1_900,
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'task_touched_not_suggested',
      ts: FIXED_TS + 501,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      files: ['src/shared/format.ts', 'src/shared/format.test.ts'],
    },
  ],
};

// An approved plan names `npm run lint`, but package.json defines no lint script. The plan command
// policy refuses the check, so the brief's checks show it as a refused row with the rule it broke,
// and the brief completes on the check that ran.
const planCheckRefusedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-plan-check-refused'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    ...touchedNotSuggestedProjection.events.filter(
      (event) => event.type === 'workflow_started' || event.type === 'tasks_planned',
    ),
    ...touchedNotSuggestedProjection.events.filter((event) => event.type === 'task_started'),
    {
      type: 'full_suite',
      ts: FIXED_TS + 390,
      phase: 'validating-task',
      moment: 'plan',
      id: 'K2',
      command: 'npm run lint',
      status: 'refused',
      detail:
        checkCommandRefusal('npm run lint', {
          npmScriptsApproved: true,
          packageScripts: { packageJsonExists: true, scripts: { test: 'node --test' } },
        }) ?? '',
    },
    {
      type: 'checks_run',
      ts: FIXED_TS + 400,
      phase: 'validating-task',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      results: [
        { id: 'K1', status: 'pass' },
        { id: 'K2', status: 'refused' },
      ],
    },
    ...touchedNotSuggestedProjection.events.filter((event) => event.type === 'task_completed'),
  ],
};

/** What production code publishes on a bus of its own, stamped in order from `ts`. */
function publishedEvents(ts: number, publish: (bus: EventBus) => void): EngineEvent[] {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  publish(bus);
  return events.map((event, index) => ({ ...event, ts: ts + index }));
}

// Research suggested a package script as the test command. The production sanitizer refuses it on a
// bus of its own, so the transcript carries the words a real run records.
function plannerCommandRefusals(ts: number): EngineEvent[] {
  return publishedEvents(ts, (bus) =>
    sanitizeDiscoveredValidation(
      { language: 'typescript', testCommand: 'npm run test:unit' },
      { bus, phase: 'planning' },
    ),
  );
}

// The plan's validation block named a package script as the test command: compiling the plan writes
// its two cards, and the sanitizer then refuses the script.
const plannerCommandsRefusedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-planner-commands-refused'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  get events(): EngineEvent[] {
    return [...planCompiledProjection.events, ...plannerCommandRefusals(FIXED_TS + 300)];
  },
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
      type: 'task_full_fail',
      ts: FIXED_TS + 50,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID_2,
      reason: WORKFLOW_FIXTURE_TEXT.failure,
    },
    {
      type: 'task_started',
      lineageAttempt: 6,
      attemptAllowance: 12,
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
      type: 'implementer_generate_failed',
      ts: FIXED_TS + 300,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      model: FIXED_RUNNER_MODEL,
      error: WORKFLOW_FIXTURE_TEXT.implementerFailure,
    },
    {
      type: 'task_retry',
      lineageAttempt: 7,
      attemptAllowance: 12,
      ts: FIXED_TS + 400,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      attempt: 1,
      maxRetries: 2,
      error: WORKFLOW_FIXTURE_TEXT.failure,
    },
  ],
};

const FIXTURE_PLANNED_BRIEFS = [
  { id: WORKFLOW_FIXTURE_TASK_ID, title: WORKFLOW_FIXTURE_TEXT.implementationTask, index: 0 },
  { id: WORKFLOW_FIXTURE_TASK_ID_2, title: 'Register the bounded fixture projection', index: 1 },
  { id: WORKFLOW_FIXTURE_TASK_ID_3, title: 'Capture the bounded fixture frame', index: 2 },
] as const;

// The plan announced each brief, so a completion alone marks it passed and times it.
function fixtureBriefPassed(
  brief: Pick<TasksPlannedEvent['tasks'][number], 'id' | 'title' | 'index'>,
  ts: number,
): EngineEventOf<'task_completed'> {
  return {
    type: 'task_completed',
    ts,
    phase: 'implementing',
    taskId: brief.id,
    title: brief.title,
    method: 'local',
    retries: 0,
    duration: 120_000,
    tool: 'ollama',
    model: FIXED_RUNNER_MODEL,
  };
}

function everyBriefPassed(briefs = FIXTURE_TASKS_PLANNED.tasks): EngineEvent[] {
  return [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
    { ...FIXTURE_TASKS_PLANNED, tasks: briefs },
    ...briefs.flatMap((brief, index) => [
      orphanBriefStarted(brief, FIXED_TS + 100 * (index + 1)),
      fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1) + 10),
    ]),
  ];
}

function orphanBriefStarted(
  brief: Pick<TasksPlannedEvent['tasks'][number], 'id' | 'title' | 'index'> & { file?: string },
  ts: number,
): EngineEventOf<'task_started'> {
  return {
    type: 'task_started',
    ts,
    phase: 'implementing',
    taskId: brief.id,
    title: brief.title,
    index: brief.index,
    total: 3,
    file: brief.file ?? WORKFLOW_FIXTURE_REVIEW_FILE,
    action: 'modify',
    tool: 'ollama',
    model: FIXED_RUNNER_MODEL,
  };
}

const completedOrphanRowsProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-completed-orphan-rows'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
    FIXTURE_TASKS_PLANNED,
    {
      type: 'warning',
      ts: FIXED_TS + 80,
      phase: 'implementing',
      message: 'Ignoring changed files that could not be read: src/tmp.lock.',
    },
    orphanBriefStarted(FIXTURE_PLANNED_BRIEFS[0], FIXED_TS + 100),
    fixtureBriefPassed(FIXTURE_PLANNED_BRIEFS[0], FIXED_TS + 200),
    {
      type: 'task_touched_not_suggested',
      ts: FIXED_TS + 201,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      files: ['src/shared/format.ts', 'src/shared/format.test.ts'],
    },
    orphanBriefStarted(FIXTURE_PLANNED_BRIEFS[1], FIXED_TS + 300),
  ],
};

/** Every brief passed once; the review appended a fix task, and its build is starting. */
const reviewFixProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_REVIEW_FIX_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  get events(): EngineEvent[] {
    return [
      ...everyBriefPassed(),
      finalReviewStarted(FIXED_TS + 390, BASE_PLANNER),
      finalReviewCompleted({
        ts: FIXED_TS + 400,
        duration: 10,
        verdict: 'fail',
        seat: BASE_PLANNER,
      }),
      {
        type: 'review_fix_started',
        ts: FIXED_TS + 400,
        phase: 'implementing',
        cycle: 1,
        taskIds: [WORKFLOW_FIXTURE_FIX_TASK_ID],
      },
      {
        type: 'tasks_planned',
        ts: FIXED_TS + 405,
        phase: 'implementing',
        total: 4,
        tasks: [
          ...FIXTURE_TASKS_PLANNED.tasks,
          {
            id: WORKFLOW_FIXTURE_FIX_TASK_ID,
            title: WORKFLOW_FIXTURE_TEXT.reviewFixTask,
            index: 3,
            file: WORKFLOW_FIXTURE_SECOND_FILE,
            action: 'modify',
          },
        ],
      },
      {
        type: 'task_started',
        ts: FIXED_TS + 410,
        phase: 'implementing',
        taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
        title: WORKFLOW_FIXTURE_TEXT.reviewFixTask,
        index: 3,
        total: 4,
        file: WORKFLOW_FIXTURE_SECOND_FILE,
        action: 'modify',
        tool: 'ollama',
        model: FIXED_RUNNER_MODEL,
      },
    ];
  },
};

/**
 * The review's fix task reported `blocked`: the reviewer that wrote it answered with guidance,
 * the next attempt stopped on the same decision, and the reviewer answers again while the run is
 * still implementing. The fixture crew has no reviewer block, so the review seat runs on the
 * PLAN tool.
 */
const buildReviewConsultProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-build-review-consult'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  get events(): EngineEvent[] {
    return [
      ...reviewFixProjection.events,
      {
        type: 'consult_answered',
        ts: FIXED_TS + 500,
        phase: 'implementing',
        taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
        reason: 'blocked',
        seat: 'review',
        action: 'guidance',
        diagnosis: 'The finding asks for the cache key, not the whole entry.',
        newTaskIds: null,
      },
      {
        type: 'task_retry',
        lineageAttempt: 2,
        attemptAllowance: 8,
        ts: FIXED_TS + 550,
        phase: 'implementing',
        taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
        attempt: 1,
        maxRetries: 2,
        error: 'Blocked: which cache key does the finding name?',
      },
      {
        type: 'runner_call_started',
        ts: FIXED_TS + 600,
        phase: 'implementing',
        taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
        callId: 'visual-build-review-consult',
        role: 'review',
        backendKind: 'cli',
        runnerName: 'claude',
        model: BASE_PLANNER.model,
        axes: seatAxisWords(BASE_PLANNER),
        sequence: 0,
      },
    ];
  },
};

const REVIEW_CHECK_TYPECHECK = {
  id: 'V1',
  command: 'npm run typecheck',
  reason: 'The change edits exported types in src/shared.',
} as const;
const REVIEW_CHECK_TEST = {
  id: 'V2',
  command: 'npm test',
  reason: 'The unit tests cover the formatter the change edits.',
} as const;
const REVIEW_CHECK_DECLINED = {
  target: 'npm run test:e2e',
  reason: 'It needs a browser, and the change touches no screen.',
} as const;

const DRIFT_REVIEW_CHECKS = [
  {
    id: 'V1',
    command: 'node --test test/loan.test.js',
    reason: 'The loan tests cover the changed service.',
  },
  {
    id: 'V2',
    command: 'node --test test/renewals.test.js',
    reason: 'The renewal tests cover the changed service.',
  },
  {
    id: 'V3',
    command: 'node --test test/member.test.js',
    reason: 'The member tests cover the changed model.',
  },
  {
    id: 'V4',
    command: 'node --test test/services.test.js',
    reason: 'The service tests cover the integration.',
  },
];

const DRIFT_REVIEW_TASKS_PLANNED: TasksPlannedEvent = {
  ...FIXTURE_TASKS_PLANNED,
  total: 5,
  tasks: [
    {
      id: taskId('T001'),
      title: 'Update the loan service',
      index: 0,
      file: 'src/loan.js',
      action: 'modify',
    },
    {
      id: taskId('T002'),
      title: 'Update the renewal service',
      index: 1,
      file: 'src/renew.js',
      action: 'modify',
    },
    {
      id: taskId('T003'),
      title: 'Verify the loan service',
      index: 2,
      file: 'test/loan.test.js',
      action: 'modify',
    },
    {
      id: taskId('T004'),
      title: 'Verify the renewal service',
      index: 3,
      file: 'test/renewals.test.js',
      action: 'modify',
    },
    {
      id: taskId('T005'),
      title: 'Verify the member model',
      index: 4,
      file: 'test/member.test.js',
      action: 'modify',
    },
  ],
};

const DRIFT_REVIEW_FINDINGS: DriftFinding[] = [
  {
    severity: 'warning',
    code: 'missing_expected_file',
    taskId: taskId('T004'),
    file: 'test/renewals.test.js',
    message: 'Task T004 reached done but test/renewals.test.js was not changed.',
  },
  {
    severity: 'error',
    code: 'failed_task_with_diff',
    taskId: taskId('T002'),
    file: 'src/renew.js',
    message: 'Failed task T002 left changes in src/renew.js.',
  },
  {
    severity: 'info',
    code: 'out_of_scope_file',
    file: 'README.md',
    message: 'README.md touched, not suggested by any task.',
  },
  {
    severity: 'warning',
    code: 'missing_expected_file',
    taskId: taskId('T003'),
    file: 'test/loan.test.js',
    message: 'Task T003 reached done but test/loan.test.js was not changed.',
  },
  {
    severity: 'error',
    code: 'failed_task_with_diff',
    taskId: taskId('T001'),
    file: 'src/loan.js',
    message: 'Failed task T001 left changes in src/loan.js.',
  },
  {
    severity: 'warning',
    code: 'missing_expected_file',
    taskId: taskId('T005'),
    file: 'test/member.test.js',
    message: 'Task T005 reached done but test/member.test.js was not changed.',
  },
];

const CODEX_REVIEW_SEAT = { kind: 'cli', tool: 'codex', model: 'gpt-6-astra' } as const;

function finalReviewStarted(
  ts: number,
  seat: Pick<EngineEventOf<'review_started'>, 'tool' | 'model'>,
): EngineEventOf<'review_started'> {
  return {
    type: 'review_started',
    ts,
    phase: 'final-review',
    scope: 'final',
    tool: seat.tool,
    model: seat.model,
  };
}

function finalReviewCompleted({
  ts,
  duration,
  verdict,
  seat,
}: {
  ts: number;
  duration: number;
  verdict: 'pass' | 'fail';
  seat: Pick<EngineEventOf<'review_started'>, 'tool' | 'model'>;
}): EngineEventOf<'review_completed'> {
  return {
    ...finalReviewStarted(ts, seat),
    type: 'review_completed',
    verdict,
    findings: { blocking: verdict === 'fail' ? 1 : 0, minor: 0, outOfScope: 0 },
    duration,
  };
}

/** The reviewer chose two commands and declined one test before the final review. */
function reviewChecksPlanned(ts: number): EngineEvent {
  return {
    type: 'review_checks',
    ts,
    phase: 'final-review',
    scope: 'final',
    status: 'planned',
    commands: [{ ...REVIEW_CHECK_TYPECHECK }, { ...REVIEW_CHECK_TEST }],
    declined: [{ ...REVIEW_CHECK_DECLINED }],
    reason: null,
  };
}

/**
 * One reviewer check before the final review, its re-run at the run base, or a fix brief running it
 * again; `newFailures`, `preExisting` and `notVerified` split a red base re-run.
 */
function reviewCheck(
  ts: number,
  check: { readonly id: string; readonly command: string },
  result:
    | { status: 'running' | 'not-run' | 'refused'; moment?: 'base' | 'brief'; detail?: string }
    | {
        status: 'done';
        moment?: 'base' | 'brief';
        passed: boolean;
        duration?: number;
        newFailures?: number;
        preExisting?: number;
        notVerified?: number;
        newKeys?: string[];
        preExistingKeys?: string[];
        own?: number;
        ownLeft?: number;
        others?: number;
        proven?: boolean;
        detail?: string;
      },
  phase: 'final-review' | 'implementing' = 'final-review',
): EngineEvent {
  const { moment = 'pre-review', ...rest } = result;
  return {
    type: 'full_suite',
    ts,
    phase,
    id: check.id,
    command: check.command,
    moment,
    ...(rest.status === 'done' && { duration: 1_000 }),
    ...rest,
  };
}

const reviewFixCyclesProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-fix-cycles'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { reviewer: CODEX_REVIEW_SEAT },
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    {
      type: 'artifact_written',
      ts: FIXED_TS + 20,
      phase: 'planning',
      filename: 'tasks.md',
      path: '.splitbrief/sessions/visual-review-fix-cycles/tasks.md',
      lineCount: 18,
      excerpt: FIXTURE_PLANNED_BRIEFS.map((brief) => `${brief.id}  ${brief.title}`),
      omittedCount: 0,
      omittedUnit: 'task',
    },
    { type: 'plan_approved', ts: FIXED_TS + 30, phase: 'reviewing-plan' },
    FIXTURE_TASKS_PLANNED,
    ...FIXTURE_PLANNED_BRIEFS.flatMap((brief, index) => [
      orphanBriefStarted(brief, FIXED_TS + 100 * (index + 1)),
      fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1) + 10),
    ]),
    finalReviewStarted(FIXED_TS + 900, CODEX_REVIEW_SEAT),
    reviewChecksPlanned(FIXED_TS + 900),
    reviewCheck(FIXED_TS + 1_000, REVIEW_CHECK_TYPECHECK, { status: 'done', passed: true }),
    reviewCheck(FIXED_TS + 2_000, REVIEW_CHECK_TEST, { status: 'done', passed: false }),
    reviewCheck(FIXED_TS + 3_000, REVIEW_CHECK_TEST, {
      status: 'done',
      moment: 'base',
      passed: true,
      duration: 9_000,
    }),
    {
      type: 'runner_call_activity',
      ts: FIXED_TS + 3_500,
      phase: 'final-review',
      callId: 'visual-review-call-001',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: CODEX_REVIEW_SEAT.model,
      axes: seatAxisWords(CODEX_REVIEW_SEAT),
      sequence: 1,
      activityId: 'visual-review-call-001:read',
      stage: 'completed',
      kind: 'read',
      label: 'reading the failing test',
      target: WORKFLOW_FIXTURE_SECOND_FILE,
      redacted: false,
    },
    finalReviewCompleted({
      ts: FIXED_TS + 4_000,
      duration: 3_100,
      verdict: 'fail',
      seat: CODEX_REVIEW_SEAT,
    }),
    {
      type: 'review_fix_started',
      ts: FIXED_TS + 4_000,
      phase: 'implementing',
      cycle: 1,
      taskIds: [WORKFLOW_FIXTURE_FIX_TASK_ID],
    },
    {
      type: 'task_started',
      ts: FIXED_TS + 4_100,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.reviewFixTask,
      index: 3,
      total: 4,
      file: WORKFLOW_FIXTURE_SECOND_FILE,
      action: 'modify',
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    {
      type: 'task_completed',
      ts: FIXED_TS + 4_200,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.reviewFixTask,
      method: 'local',
      retries: 0,
      duration: 100,
      tool: 'ollama',
      model: FIXED_RUNNER_MODEL,
    },
    finalReviewStarted(FIXED_TS + 4_900, CODEX_REVIEW_SEAT),
    reviewChecksPlanned(FIXED_TS + 4_900),
    reviewCheck(FIXED_TS + 5_000, REVIEW_CHECK_TYPECHECK, { status: 'done', passed: true }),
    reviewCheck(FIXED_TS + 7_000, REVIEW_CHECK_TEST, { status: 'running' }),
  ],
};

/** The fix task the review appended passed, and so did the review: every brief counted once. */
const completeAfterFixTasksProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-complete-after-fix-tasks'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  get events(): EngineEvent[] {
    return [
      { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
      {
        ...FIXTURE_TASKS_PLANNED,
        total: 4,
        tasks: [
          ...FIXTURE_TASKS_PLANNED.tasks,
          {
            id: WORKFLOW_FIXTURE_FIX_TASK_ID,
            title: WORKFLOW_FIXTURE_TEXT.reviewFixTask,
            index: 3,
            file: WORKFLOW_FIXTURE_SECOND_FILE,
            action: 'modify',
          },
        ],
      },
      ...FIXTURE_PLANNED_BRIEFS.map((brief, index) =>
        fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1)),
      ),
      {
        type: 'task_completed',
        ts: FIXED_TS + 500,
        phase: 'implementing',
        taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
        title: WORKFLOW_FIXTURE_TEXT.reviewFixTask,
        method: 'local',
        retries: 0,
        duration: 60_000,
        tool: 'ollama',
        model: FIXED_RUNNER_MODEL,
      },
      finalReviewStarted(FIXED_TS + 500, BASE_PLANNER),
      finalReviewCompleted({
        ts: FIXED_TS + 600,
        duration: 600,
        verdict: 'pass',
        seat: BASE_PLANNER,
      }),
      {
        type: 'workflow_complete',
        ts: FIXED_TS + 600,
        phase: 'complete',
        review: 'passed',
        completedTasks: 4,
      },
    ];
  },
};

/** The appended fix task's attempt verified the finding and edited nothing, then passed its gates. */
const reviewFixNoChangeProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_REVIEW_FIX_NO_CHANGE_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  get events(): EngineEvent[] {
    const second = FIXTURE_PLANNED_BRIEFS[1];
    return [
      ...everyBriefPassed(),
      finalReviewStarted(FIXED_TS + 390, BASE_PLANNER),
      finalReviewCompleted({
        ts: FIXED_TS + 400,
        duration: 10,
        verdict: 'fail',
        seat: BASE_PLANNER,
      }),
      {
        type: 'review_fix_started',
        ts: FIXED_TS + 400,
        phase: 'implementing',
        cycle: 1,
        taskIds: [second.id],
      },
      {
        type: 'implementer_generate_done',
        ts: FIXED_TS + 420,
        phase: 'implementing',
        taskId: second.id,
        file: WORKFLOW_FIXTURE_SECOND_FILE,
        files: [],
        linesAdded: 0,
        linesRemoved: 0,
        duration: 48_000,
        noChange: true,
      },
      fixtureBriefPassed(second, FIXED_TS + 430),
    ];
  },
};

/** Every brief passed; the review seat, on another tool than the build, judges the run. */
const finalReviewProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_FINAL_REVIEW_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { reviewer: CODEX_REVIEW_SEAT },
  get events(): EngineEvent[] {
    return [
      ...everyBriefPassed(),
      finalReviewStarted(FIXED_TS + 450, CODEX_REVIEW_SEAT),
      {
        type: 'review_checks',
        ts: FIXED_TS + 450,
        phase: 'final-review',
        scope: 'final',
        status: 'planned',
        commands: [],
        declined: [],
        reason: 'The project has no test, build or lint command, and no CI config names one.',
      },
      {
        type: 'runner_call_started',
        ts: FIXED_TS + 520,
        phase: 'final-review',
        callId: 'visual-review-call-001',
        role: 'review',
        backendKind: 'cli',
        runnerName: 'codex',
        model: CODEX_REVIEW_SEAT.model,
        axes: seatAxisWords(CODEX_REVIEW_SEAT),
        attempt: 1,
        sequence: 0,
      },
    ];
  },
};

// With End-of-run checks off nothing runs before the review, and one row says so.
const reviewChecksOffProjection: WorkflowFixtureProjection = {
  ...finalReviewProjection,
  scenarioId: scenarioId('workflow-review-checks-off'),
  get events(): EngineEvent[] {
    return finalReviewProjection.events.map(
      (event): EngineEvent =>
        event.type === 'review_checks'
          ? {
              type: 'review_checks',
              ts: event.ts,
              phase: event.phase,
              scope: 'final',
              status: 'off',
            }
          : event,
    );
  },
};

const reviewFixNarrowRailProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-fix-narrow-rail'),
  feature: 'Add overdue book reporting',
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'implementing',
      feature: 'Add overdue book reporting',
    },
    ...makeReviewFixInsertedEvents(),
  ],
};

const taskStatusesProjection: WorkflowFixtureProjection = {
  ...reviewFixNarrowRailProjection,
  scenarioId: scenarioId('workflow-task-statuses'),
  events: reviewFixNarrowRailProjection.events.map((event): EngineEvent => {
    if (event.type !== 'task_completed') return event;
    if (event.taskId === 'T002') return { ...event, method: 'escalated-full' };
    if (event.taskId === 'T003')
      return {
        type: 'task_full_fail',
        ts: event.ts,
        phase: event.phase,
        taskId: event.taskId,
      };
    if (event.taskId === 'T004')
      return {
        type: 'task_skipped',
        ts: event.ts,
        phase: event.phase,
        taskId: event.taskId,
        title: event.title,
        reason: 'No changes needed',
      };
    return event;
  }),
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

const approvalConfirmProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_APPROVAL_CONFIRM_ID,
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
    actionClass: 'destructive',
    actionDescription: '.splitbrief/state.json',
    answer: WORKFLOW_FIXTURE_TEXT.reviewAnswer,
  },
};

const approvalConfirmSecretProjection: WorkflowFixtureProjection = {
  ...approvalConfirmProjection,
  scenarioId: scenarioId('workflow-approval-confirm-secret'),
  approval: {
    actionClass: 'sensitive_change',
    actionDescription: '.env.local',
    answer: WORKFLOW_FIXTURE_TEXT.reviewAnswer,
  },
};

// The plan card: two batches and one protected operation, rendered by the same formatter the
// planning session writes plan.md with.
const PLAN_CARD_PLAN = makePlanProposal({
  summary: 'Add a greeting module and expose it from the CLI.',
  decisions: ['Keep the greeting in one module', 'Add the CLI flag in a second batch'],
  criteria: [
    { id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] },
    { id: 'C2', text: 'The CLI prints the greeting', checkIds: ['K2'] },
  ],
  tasks: [
    makeTaskSpec(),
    makeTaskSpec({
      id: 'T002',
      title: 'Expose the greeting from the CLI',
      intent: 'Print the greeting for --name',
      criteria: ['C2'],
      checks: [{ id: 'K2', kind: 'test', value: 'src/cli.test.ts', required: true }],
      suggestedFiles: ['src/cli.ts'],
      contextFiles: ['src/hello.ts'],
      protectedOperations: [
        { path: 'package.json', operation: 'write' },
        { path: 'package-lock.json', operation: 'write' },
      ],
      dependsOn: ['T001'],
      batch: 2,
    }),
  ],
});

const planCardProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-plan-card'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'review',
  sidebarVisible: true,
  events: [
    {
      type: 'tasks_planned',
      ts: FIXED_TS,
      phase: 'reviewing-plan',
      tasks: PLAN_CARD_PLAN.tasks.map((spec, index) => {
        const task = taskFromSpec(spec, VISUAL_FIXTURE_PROJECT_DIR);
        return {
          id: task.id,
          title: task.title,
          index,
          file: task.suggestedFiles[0],
          action: task.action,
        };
      }),
      total: PLAN_CARD_PLAN.tasks.length,
    },
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'reviewing-plan',
      feature: WORKFLOW_FEATURE,
    },
  ],
  reviewArtifact: 'plan',
  review: {
    filePath: 'testing/visual/fixtures/workflow/plan-card/plan.md',
    source: formatPlanMarkdown(PLAN_CARD_PLAN, []),
    planJson: `${JSON.stringify(PLAN_CARD_PLAN, null, 2)}\n`,
    confirms: planConfirmations(
      PLAN_CARD_PLAN.tasks.map((spec) => taskFromSpec(spec, VISUAL_FIXTURE_PROJECT_DIR)),
      VISUAL_FIXTURE_PROJECT_DIR,
    ).map((confirmation) => confirmation.actionDescription),
  },
};

// The plan card of a plan whose render checks have no validation.render to run them: the planner
// kept them after its one repair, so the card opens with the note before anything it confirms.
const RENDER_NOTE_PLAN = makePlanProposal({
  ...PLAN_CARD_PLAN,
  checks: [{ id: 'K-render', kind: 'render', value: 'overlay-settings', required: true }],
  criteria: [
    { id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] },
    { id: 'C2', text: 'The CLI prints the greeting', checkIds: ['K2', 'K-render'] },
  ],
});

const planCardRenderNoteProjection: WorkflowFixtureProjection = {
  ...planCardProjection,
  scenarioId: scenarioId('workflow-plan-card-render-note'),
  review: {
    filePath: 'testing/visual/fixtures/workflow/plan-card/plan.md',
    source: formatPlanMarkdown(RENDER_NOTE_PLAN, renderCheckNotes(RENDER_NOTE_PLAN, undefined)),
    planJson: `${JSON.stringify(RENDER_NOTE_PLAN, null, 2)}\n`,
    confirms: planCardProjection.review?.confirms ?? [],
  },
};

// Two run checks under different ids run one command, as `c-invariants` and `c-deleted-symbols`
// did in a real run: the confirms line names the command once.
const SHARED_COMMAND_PLAN = makePlanProposal({
  ...PLAN_CARD_PLAN,
  checks: [
    { id: 'c-typecheck', kind: 'cmd', value: 'npm run typecheck', required: true },
    { id: 'c-invariants', kind: 'cmd', value: 'npm run check:invariants', required: true },
    { id: 'c-deleted-symbols', kind: 'cmd', value: 'npm run check:invariants', required: true },
  ],
});

const planCardSharedCommandProjection: WorkflowFixtureProjection = {
  ...planCardProjection,
  scenarioId: scenarioId('workflow-plan-card-shared-command'),
  review: {
    filePath: 'testing/visual/fixtures/workflow/plan-card/plan.md',
    source: formatPlanMarkdown(SHARED_COMMAND_PLAN, []),
    planJson: `${JSON.stringify(SHARED_COMMAND_PLAN, null, 2)}\n`,
    confirms: planConfirmations(
      SHARED_COMMAND_PLAN.tasks.map((spec) => taskFromSpec(spec, VISUAL_FIXTURE_PROJECT_DIR)),
      VISUAL_FIXTURE_PROJECT_DIR,
      {
        summary: SHARED_COMMAND_PLAN.summary,
        decisions: [],
        criteria: SHARED_COMMAND_PLAN.criteria,
        checks: SHARED_COMMAND_PLAN.checks,
        validation: SHARED_COMMAND_PLAN.validation,
      },
    ).map((confirmation) => confirmation.actionDescription),
  },
};

const PLAN_CARD_TASKS = PLAN_CARD_PLAN.tasks.map((spec) => taskFromSpec(spec, '/nonexistent'));

// The planning session right after its plan passed the checks: the two cards it announces, plan.md
// and tasks.md, both rendered from plan.json.
const planCompiledProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-plan-compiled'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    {
      type: 'planner_status',
      ts: FIXED_TS + 100,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'plan',
    },
    {
      type: 'artifact_written',
      ts: FIXED_TS + 200,
      phase: 'planning',
      filename: 'plan.md',
      path: '.splitbrief/sessions/2026-09-17-workflow-conversation-recovery/plan.md',
      ...buildArtifactExcerpt(formatPlanMarkdown(PLAN_CARD_PLAN, []), 'plan.md'),
    },
    {
      type: 'artifact_written',
      ts: FIXED_TS + 210,
      phase: 'planning',
      filename: 'tasks.md',
      path: '.splitbrief/sessions/2026-09-17-workflow-conversation-recovery/tasks.md',
      ...buildArtifactExcerpt(formatTasks(PLAN_CARD_TASKS), 'tasks.md', PLAN_CARD_TASKS),
    },
  ],
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
      phase: 'planning',
      feature: WORKFLOW_FEATURE,
    },
    {
      type: 'planner_status',
      ts: FIXED_TS + 10,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'plan',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      messageStart: true,
      text: 'Questions before the plan · round 1 of 2',
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
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: 'Refactor my code' },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      text: 'Which module should change? Tell me what is wrong or what behavior you want to improve.',
    },
  ],
  question: { prompt: 'Reply to the planner…', answer: 'Refactor src/auth.ts.', questions: [] },
};

// The flat numbered blob the planner prompt consumes. It is the qa pairs below joined, so only
// the pairs are content; the join is exempted from the string bound.
const ANSWERED_QUESTIONS_TEXT =
  '1. What should be refactored? Give a file/module/feature name or area of the codebase.\nI want you to first review the changes and then after review make tasks of fixes for implementer\n\n2. What kind of refactor?\nSimplify/clean up existing code';

const answeredQuestionsProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-question-answered'),
  feature: 'Refactor my code',
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: 'Refactor my code' },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      text: 'Questions before the plan · round 1 of 2',
    },
    {
      type: 'user_message',
      ts: FIXED_TS + 200,
      phase: 'planning',
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

const consultQuestionProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-consult-answer-default'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
    {
      type: 'task_started',
      ts: FIXED_TS + 100,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: 'Choose the store',
      action: 'modify',
      index: 0,
      total: 1,
      file: 'src/store.ts',
    },
    {
      type: 'runner_call_started',
      ts: FIXED_TS + 35_000,
      phase: 'escalating',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: 'visual-consult-call-001',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'claude-code',
      model: BASE_PLANNER.model,
      axes: seatAxisWords(BASE_PLANNER),
      attempt: 1,
      sequence: 0,
    },
    {
      type: 'runner_call_completed',
      ts: FIXED_TS + 38_000,
      phase: 'escalating',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      callId: 'visual-consult-call-001',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'claude-code',
      model: BASE_PLANNER.model,
      axes: seatAxisWords(BASE_PLANNER),
      attempt: 1,
      sequence: 1,
      durationMs: 3_000,
      startedAt: FIXED_TS + 35_000,
      endedAt: FIXED_TS + 38_000,
      status: 'completed',
      error: null,
      partial: false,
      usage: null,
      nativeSessionId: null,
    },
    {
      type: 'consult_answered',
      ts: FIXED_TS + 38_100,
      phase: 'escalating',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      reason: 'failed',
      action: 'ask-user',
      diagnosis: 'Only the operator knows the deployment.',
      newTaskIds: null,
    },
  ],
  question: {
    prompt: 'Reply to the planner…',
    answer: '',
    questions: [{ id: 'consult-store', type: 'input', text: 'Which store?', default: 'memory' }],
  },
};

const DECISION_QUESTION = 'Did you ask for greet to also be a default export of src/greet.ts?';
const DECISION_KEEP = 'Yes, keep the default export';

/** A decision confirm that asks about a decision the user's own correction caused. */
const decisionConfirmEvents: WorkflowFixtureProjection['events'] = [
  { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
  {
    type: 'task_started',
    ts: FIXED_TS + 100,
    phase: 'implementing',
    taskId: WORKFLOW_FIXTURE_TASK_ID,
    title: 'Add the greeting',
    action: 'modify',
    index: 0,
    total: 1,
    file: 'src/greet.ts',
  },
  {
    type: 'consult_answered',
    ts: FIXED_TS + 38_100,
    phase: 'implementing',
    taskId: WORKFLOW_FIXTURE_TASK_ID,
    reason: 'deviation',
    action: 'ask-user',
    diagnosis: 'The default export changes what is built.',
    newTaskIds: null,
  },
];

const decisionQuestionProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-decision-question'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: decisionConfirmEvents,
  question: {
    prompt: 'Type your answer…',
    answer: '',
    questions: [
      {
        id: 'ask-user',
        type: 'choice',
        text: [
          `Your instructions for ${WORKFLOW_FIXTURE_TASK_ID}:`,
          '- also export a default from src/greet.ts',
          '',
          DECISION_QUESTION,
        ].join('\n'),
        options: [DECISION_KEEP, 'No, remove the default export'],
        default: DECISION_KEEP,
      },
    ],
  },
};

const decisionGuidanceProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-decision-guidance'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    ...decisionConfirmEvents,
    {
      type: 'user_message',
      ts: FIXED_TS + 40_000,
      phase: 'implementing',
      text: DECISION_KEEP,
      qa: [{ question: DECISION_QUESTION, answer: DECISION_KEEP }],
    },
    {
      type: 'consult_answered',
      ts: FIXED_TS + 44_000,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      reason: 'deviation',
      action: 'guidance',
      diagnosis: 'The user keeps the default export.',
      newTaskIds: null,
    },
  ],
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
      axes: seatAxisWords(BASE_IMPLEMENTER),
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
      axes: seatAxisWords(BASE_IMPLEMENTER),
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

/** The fallback a seat declares in config: a seat that cannot work moves to it. */
const SEAT_FALLBACK = {
  tool: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  variant: 'max',
} as const;

/** Ollama's words at its limit, in the shape that names its reset as a clock. */
const OLLAMA_LIMIT_WORDS = 'quota exhausted · resets 5pm';

/**
 * The BUILD seat out of quota on the brief's first attempt, as the engine halts it. Six tools were
 * detected: more than the three the text prompt names, so the panel's own height is proved to
 * follow its action rows and not the offer. Built when the capture reads it, because the tool's
 * clock resolves against the capture's own clock and zone.
 */
function usageLimitRecoveryIssue(
  overrides: Readonly<
    Partial<Pick<SeatDownRecoveryOptions, 'runner' | 'seatSwap' | 'seatSwitches'>>
  > = {},
): RecoveryIssue {
  const config = visualConfig();
  const resetAt = parseUsageLimitReset(OLLAMA_LIMIT_WORDS);
  const classification: SeatFailureClassification =
    resetAt === null ? { class: 'account', cause: 'quota' } : { class: 'rate-limited', resetAt };
  return buildSeatDownIssue({
    id: 'rec_visual_usage_limit',
    seat: 'build',
    runner: { ...config.implementer, fallback: SEAT_FALLBACK },
    classification,
    words: OLLAMA_LIMIT_WORDS,
    task: HALTED_TASK,
    phase: 'implementing',
    attempts: 1,
    maxAttempts: DEFAULT_LOCAL_RETRIES,
    selectedImplementerProfile: 'local-fixture',
    seatSwap: {
      seat: 'build',
      currentTool: '',
      fallback: SEAT_FALLBACK,
      detectedTools: ['opencode', 'codex', 'claude-code', 'cursor', 'copilot', 'kilo-code'].map(
        (tool) => ({ tool, ready: true }),
      ),
    },
    createdAt: new Date(FIXED_TS).toISOString(),
    ...overrides,
  });
}

const AGY_BUILD_SEAT = {
  kind: 'cli',
  tool: 'antigravity',
  model: 'gemini-3.8-flash-high',
} as const;
/** The isolation halts are raised only on a CLI implementer's tool calls. */
const AGY_CREW: VisualConfigOverrides = { implementer: AGY_BUILD_SEAT };

const HALTED_TASK = makeTask({
  id: WORKFLOW_FIXTURE_TASK_ID,
  title: WORKFLOW_FIXTURE_TEXT.implementationTask,
  suggestedFiles: [WORKFLOW_FIXTURE_REVIEW_FILE],
  status: 'in_progress',
});

/**
 * When a resumed run's saved state says it started. Left to the state factory, it is the wall clock
 * the module loaded at: later than the capture clock, so the header clamps to 0:00, and different
 * on every capture.
 */
const RESUMED_RUN_STARTED_AT = new Date(FIXED_TS).toISOString();

/** The run the engine saves at a halt: the brief still in flight, at the phase the halt was raised in. */
function haltedResumeState(issue: RecoveryIssue): WorkflowState {
  return makeImplState([HALTED_TASK], {
    feature: WORKFLOW_FEATURE,
    startedAt: RESUMED_RUN_STARTED_AT,
    phase: issue.phase,
    pendingRecovery: issue,
  });
}

const usageLimitRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_USAGE_LIMIT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  config: { implementer: { ...BASE_IMPLEMENTER, fallback: SEAT_FALLBACK } },
  get events() {
    const issue = usageLimitRecoveryIssue();
    return publishedEvents(FIXED_TS + 100, (bus) =>
      publishError({
        bus,
        phase: issue.phase,
        message: runnerHaltRow(issue, OLLAMA_LIMIT_WORDS),
        resetAt: issue.resetAt,
      }),
    );
  },
  get resumeState() {
    return haltedResumeState(usageLimitRecoveryIssue());
  },
};

const OPENCODE_BALANCE_SEAT = {
  kind: 'cli',
  tool: 'opencode',
  model: 'deepseek/deepseek-flash',
} as const;
const BALANCE_WORDS = 'provider.quota: Insufficient Balance';

function balanceSpentRecoveryIssue(): RecoveryIssue {
  return buildSeatDownIssue({
    id: 'rec_visual_balance_spent',
    seat: 'build',
    runner: OPENCODE_BALANCE_SEAT,
    classification: { class: 'account', cause: 'balance' },
    words: BALANCE_WORDS,
    task: HALTED_TASK,
    phase: 'implementing',
    attempts: 1,
    maxAttempts: DEFAULT_LOCAL_RETRIES,
    selectedImplementerProfile: 'default',
    seatSwap: {
      seat: 'build',
      currentTool: 'opencode',
      detectedTools: [{ tool: 'claude-code', ready: true }],
    },
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

const balanceSpentRecoveryProjection: WorkflowFixtureProjection = {
  ...usageLimitRecoveryProjection,
  scenarioId: scenarioId('workflow-recovery-balance-spent'),
  config: { implementer: OPENCODE_BALANCE_SEAT },
  get events() {
    const issue = balanceSpentRecoveryIssue();
    return publishedEvents(FIXED_TS + 100, (bus) =>
      publishError({ bus, phase: issue.phase, message: runnerHaltRow(issue, BALANCE_WORDS) }),
    );
  },
  get resumeState() {
    return haltedResumeState(balanceSpentRecoveryIssue());
  },
};

const stopSheetRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-stop-sheet-recovery'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  get events() {
    return usageLimitRecoveryProjection.events;
  },
  get resumeState() {
    return haltedResumeState(usageLimitRecoveryIssue());
  },
};

const FIXTURE_TYPECHECK_ERROR =
  "src/features/workflow/display/activity.ts(42,18): error TS2339: Property 'stop' does not exist on type 'Projection'.";

/**
 * Two local retries fail on one typecheck error; the third changes nothing and says why, which
 * ends the local rung on the same error. The planner answers, and the guided retry fails on it.
 */
const retryExhaustedRecoveryIssue = buildRetryExhaustedRecoveryIssue({
  id: 'rec_visual_retry_exhausted',
  task: HALTED_TASK,
  phase: 'escalating',
  validationSummary: FIXTURE_TYPECHECK_ERROR,
  attempts: 4,
  maxAttempts: 3,
  allowRetryOverride: true,
  selectedImplementerProfile: 'default',
  handBack:
    'activity.ts reads projection.stop, but Projection has no stop field. I did not know its type, so I changed nothing.',
  createdAt: new Date(FIXED_TS).toISOString(),
});

/** Two consults on one brief did not land it; the halt carries the planner's last diagnosis. */
const consultBoundRecoveryIssue = buildConsultBoundRecoveryIssue({
  id: 'rec_visual_consult_bound',
  reason: 'consult-bound-spent',
  task: HALTED_TASK,
  phase: 'escalating',
  lastDiagnosis:
    'Projection is declared in src/core/projection.ts, which this brief does not list. Add stop there in its own brief.',
  consults: BOUNDS.consultsPerLineage,
  consultAllowance: BOUNDS.consultsPerLineage,
  attempts: 5,
  attemptAllowance: BOUNDS.attemptsPerLineage,
  plannerCalls: 2,
  plannerCallAllowance: BOUNDS.plannerCallsPerRun,
  createdAt: new Date(FIXED_TS).toISOString(),
});

const retryExhaustedRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_RETRY_EXHAUSTED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_CREW,
  resumeState: haltedResumeState(retryExhaustedRecoveryIssue),
};

const consultBoundRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_CONSULT_BOUND_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_CREW,
  resumeState: haltedResumeState(consultBoundRecoveryIssue),
};

/** The final review still failed once its repair cycles ran out; every brief had landed. */
const reviewFailedRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_REVIEW_FAILED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_CREW,
  resumeState: makeImplState([{ ...HALTED_TASK, status: 'done' }], {
    feature: WORKFLOW_FEATURE,
    startedAt: RESUMED_RUN_STARTED_AT,
    phase: 'complete',
    reviewStatus: 'failed',
    workspace: {
      kind: 'checkout',
      path: VISUAL_FIXTURE_PROJECT_DIR,
      base: { snapshotId: 'visual-base', head: null },
    },
    pendingRecovery: buildReviewFailedRecoveryIssue({
      id: 'rec_visual_review_failed',
      blocking: 4,
      phase: 'complete',
      acceptAsIs: true,
      createdAt: new Date(FIXED_TS).toISOString(),
    }),
  }),
};

/** The final review left six criteria unverified, as in a real run: nothing for the planner to fix. */
const reviewUnverifiedRecoveryProjection: WorkflowFixtureProjection = {
  ...reviewFailedRecoveryProjection,
  scenarioId: scenarioId('workflow-recovery-review-unverified'),
  resumeState: makeImplState([{ ...HALTED_TASK, status: 'done' }], {
    feature: WORKFLOW_FEATURE,
    startedAt: RESUMED_RUN_STARTED_AT,
    phase: 'complete',
    reviewStatus: 'failed',
    workspace: {
      kind: 'checkout',
      path: VISUAL_FIXTURE_PROJECT_DIR,
      base: { snapshotId: 'visual-base', head: null },
    },
    pendingRecovery: buildReviewFailedRecoveryIssue({
      id: 'rec_visual_review_unverified',
      unverified: 6,
      phase: 'complete',
      acceptAsIs: true,
      createdAt: new Date(FIXED_TS).toISOString(),
    }),
  }),
};

const reviewContextRecoveryProjection: WorkflowFixtureProjection = {
  ...reviewFailedRecoveryProjection,
  scenarioId: scenarioId('workflow-review-context-insufficient'),
  resumeState: makeImplState([{ ...HALTED_TASK, status: 'done' }], {
    feature: WORKFLOW_FEATURE,
    phase: 'final-review',
    pendingRecovery: buildReviewFailedRecoveryIssue({
      id: 'rec_visual_review_context',
      failure: {
        kind: 'insufficient-context',
        diagnostic: {
          code: 'insufficient-context',
          seat: 'review',
          cause: 'input-budget',
          missingSections: [],
        },
      },
      createdAt: new Date(FIXED_TS).toISOString(),
    }),
  }),
};

const reviewCallFailedRecoveryProjection: WorkflowFixtureProjection = {
  ...reviewFailedRecoveryProjection,
  scenarioId: scenarioId('workflow-review-call-failed'),
  resumeState: makeImplState([{ ...HALTED_TASK, status: 'done' }], {
    feature: WORKFLOW_FEATURE,
    phase: 'final-review',
    pendingRecovery: buildReviewFailedRecoveryIssue({
      id: 'rec_visual_review_call_failed',
      failure: { kind: 'call-failed', code: 'timeout', message: 'Review call timed out.' },
      createdAt: new Date(FIXED_TS).toISOString(),
    }),
  }),
};

/**
 * The halt `buildLeftIsolationRecoveryIssue` writes when agy searched the whole home directory
 * from its scratch directory: the evidence rides in the message, and another ready tool is on
 * offer for the seat.
 */
const leftIsolationRecoveryIssue: RecoveryIssue = {
  id: 'rec_visual_left_isolation',
  reason: 'implementer-left-isolation',
  phase: 'implementing',
  status: 'awaiting-user',
  seat: 'build',
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  taskTitle: WORKFLOW_FIXTURE_TEXT.implementationTask,
  files: [WORKFLOW_FIXTURE_REVIEW_FILE],
  affectedTaskIds: [WORKFLOW_FIXTURE_TASK_ID],
  message: `${WORKFLOW_FIXTURE_TASK_ID} left the isolation directory · Google Antigravity CLI searched ~ (outside the workspace) with run_command: find ~ -name "projections.ts" 2>/dev/null`,
  details: [
    'Google Antigravity CLI searched ~ (outside the workspace) with run_command: find ~ -name "projections.ts" 2>/dev/null',
    "Your checkout gets the run's changes only through Apply.",
  ],
  selectedImplementerProfile: 'default',
  switchSeat: { seat: 'build', candidates: [{ tool: 'codex' }] },
  facts: { tool: 'Google Antigravity CLI' },
  availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
  recommendedAction: 'retry-same-worker',
  createdAt: new Date(FIXED_TS).toISOString(),
};

const leftIsolationInPlaceRecoveryIssue = buildLeftIsolationRecoveryIssue({
  id: 'rec_visual_left_isolation_in_place',
  task: HALTED_TASK,
  runner: AGY_BUILD_SEAT,
  toolMessage: 'wrote outside the checkout with run_command: touch ../outside.txt',
  attempts: 0,
  maxAttempts: DEFAULT_LOCAL_RETRIES,
  inPlace: { revertedDir: `.splitbrief/sessions/${VISUAL_WORKFLOW_SESSION_ID}/reverted` },
  seatSwap: {
    seat: 'build',
    currentTool: 'antigravity',
    detectedTools: [{ tool: 'codex', ready: true }],
  },
  createdAt: new Date(FIXED_TS).toISOString(),
});

const leftIsolationRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_LEFT_ISOLATION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_CREW,
  resumeState: haltedResumeState(leftIsolationRecoveryIssue),
};

const leftIsolationInPlaceRecoveryProjection: WorkflowFixtureProjection = {
  ...leftIsolationRecoveryProjection,
  scenarioId: scenarioId('workflow-recovery-left-isolation-in-place'),
  config: { ...AGY_CREW, workflow: { isolation: 'none' } },
  resumeState: haltedResumeState(leftIsolationInPlaceRecoveryIssue),
};

/**
 * The halt `buildCheckoutChangedRecoveryIssue` writes when another session created a branch while
 * agy ran: the words name the repository, never the tool, because the audit cannot tell who made
 * the change.
 */
const checkoutChangedRecoveryIssue = buildCheckoutChangedRecoveryIssue({
  id: 'rec_visual_checkout_changed',
  task: HALTED_TASK,
  runner: AGY_BUILD_SEAT,
  toolMessage: 'branch fix/implementer-never-runs-gates',
  attempts: 0,
  maxAttempts: DEFAULT_LOCAL_RETRIES,
  createdAt: new Date(FIXED_TS).toISOString(),
});

const checkoutChangedRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_CHECKOUT_CHANGED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_CREW,
  // A halt that names only a branch is stale on a run with no workspace, so the run keeps its
  // worktree, as the real run that raised it did.
  resumeState: {
    ...haltedResumeState(checkoutChangedRecoveryIssue),
    workspace: {
      kind: 'worktree',
      path: `.splitbrief/worktrees/${VISUAL_WORKFLOW_SESSION_ID}`,
      base: { snapshotId: 'visual-base', head: null },
    },
  },
};

const retriedBriefStart: EngineEventOf<'task_started'> = {
  type: 'task_started',
  ts: FIXED_TS,
  phase: 'implementing',
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  title: WORKFLOW_FIXTURE_TEXT.implementationTask,
  index: 0,
  total: 3,
  file: WORKFLOW_FIXTURE_REVIEW_FILE,
  action: 'modify',
  tool: 'ollama',
  model: FIXED_RUNNER_MODEL,
};

/** The checkout halt, the Try again the person chose, and the reset and retry it made. */
function checkoutHaltRetried(bus: EventBus, prompted: boolean): void {
  const issue = checkoutChangedRecoveryIssue;
  const phase = 'implementing';
  const recovery = { bus, phase, issue, action: 'retry-same-worker' } as const;
  bus.publish(retriedBriefStart);
  publishError({ bus, phase, message: issue.message });
  if (prompted) publishRecoveryPrompted({ bus, phase }, VISUAL_WORKFLOW_SESSION_ID, issue);
  publishRecoveryActionSelected(recovery);
  bus.publish({ type: 'task_reset', ts: FIXED_TS, phase, taskId: WORKFLOW_FIXTURE_TASK_ID });
  publishRecoveryResolved({
    ...recovery,
    outcome: 'retry-current-task',
    implementerProfile: 'default',
  });
  bus.publish(retriedBriefStart);
}

// The brief is on its second attempt: the halt, the Try again and the reset read as one error and
// one Recovery row above the retry.
const resolvedRetryRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-recovery-resolved-retry'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  get events(): EngineEvent[] {
    return [
      FIXTURE_TASKS_PLANNED,
      ...publishedEvents(FIXED_TS + 100, (bus) => checkoutHaltRetried(bus, true)),
    ];
  },
};

// The retried brief passed and the next one runs: the halt belongs to the brief it stopped, so it
// stays in that brief's retained body beneath its completed heading.
const implementationAfterRetryProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-implementation-after-retry'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  get events(): EngineEvent[] {
    return publishedEvents(FIXED_TS + 100, (bus) => {
      checkoutHaltRetried(bus, false);
      bus.publish(fixtureBriefPassed(FIXTURE_PLANNED_BRIEFS[0], FIXED_TS));
      bus.publish({
        ...retriedBriefStart,
        taskId: WORKFLOW_FIXTURE_TASK_ID_2,
        title: FIXTURE_PLANNED_BRIEFS[1].title,
        index: 1,
        file: WORKFLOW_FIXTURE_SECOND_FILE,
      });
    });
  },
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
    'Pick a plan seat with a larger context in /crew plan, then choose Try again.',
  ],
  facts: {
    apiContextCode: 'insufficient-context',
    apiContextSeat: 'plan',
    apiContextCause: 'missing-required',
    apiContextModel: 'qwen3-coder-30b',
    apiContextMissingSectionsJson: '["evidence.json","drift-report.json"]',
  },
  availableActions: ['retry-same-worker', 'end-run'],
  recommendedAction: 'retry-same-worker',
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
    startedAt: RESUMED_RUN_STARTED_AT,
    phase: 'planning',
    pendingRecovery: apiContextRecoveryIssue,
  }),
};

/** Claude Code's words at its session limit, and codex's, each naming the fixture's reset. */
const CLAUDE_LIMIT_WORDS = "You've hit your session limit · resets 5pm";
const CODEX_LIMIT_WORDS =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 13th, 2026 5:00 PM.";

/** The seat the owner plans on; with no reviewer of its own, REVIEW follows it. */
const CODEX_PLAN_SEAT = { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } as const;
const CODEX_PLAN_CREW: VisualConfigOverrides = { planner: CODEX_PLAN_SEAT };

/** A planner-tier call that failed with the tool's words, as `requireCompletedCall` throws it. */
function plannerCallFailed(role: 'planner' | 'review' | 'escalation', words: string): unknown {
  return error('runner-call-failed', `Planner ${role} call failed`, {
    role,
    status: 'failed',
    error: { code: 'turn-failed', message: words },
  });
}

/** What the last readiness pass remembered for the halted seat: every tool here ready. */
function plannerSeatSwap(
  seat: 'plan' | 'review',
  currentTool: string,
  tools: readonly string[],
): SeatSwapContext {
  return { seat, currentTool, detectedTools: tools.map((tool) => ({ tool, ready: true })) };
}

/**
 * The plan seat out of quota mid-plan: the halt is about the seat, not a brief, and offers the
 * seat's other ready tools. Every surface that names the move names PLAN, never the build seat.
 */
function planSeatRecoveryIssue(): RecoveryIssue {
  const planner = visualConfig().planner;
  return buildPlannerCallFailedRecoveryIssue({
    id: 'rec_visual_plan_usage_limit',
    diagnosis: diagnosePlannerCallFailure({
      seat: 'plan',
      err: plannerCallFailed('planner', CLAUDE_LIMIT_WORDS),
      label: 'Planning failed',
      runner: planner,
    }),
    phase: 'planning',
    runner: { ...planner, fallback: SEAT_FALLBACK },
    seatSwap: plannerSeatSwap('plan', 'claude-code', ['claude-code', 'codex', 'opencode']),
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/**
 * The inherited review out of quota on PLAN's tool: its switch gives REVIEW a separate seat.
 */
function reviewSeatRecoveryIssue(): RecoveryIssue {
  return buildPlannerCallFailedRecoveryIssue({
    id: 'rec_visual_review_usage_limit',
    diagnosis: diagnosePlannerCallFailure({
      seat: 'review',
      err: plannerCallFailed('review', CODEX_LIMIT_WORDS),
      label: 'Final review failed',
      runner: CODEX_PLAN_SEAT,
    }),
    seat: 'review',
    phase: 'final-review',
    runner: { ...CODEX_PLAN_SEAT, fallback: SEAT_FALLBACK },
    details: reviewSeatDetails(true),
    seatSwap: plannerSeatSwap('review', 'codex', ['codex', 'claude-code', 'opencode']),
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/**
 * The planner out of quota on a brief's consult: the halt is the plan seat's, and it names the
 * brief, so taking the swap replays that brief from its first attempt.
 */
function consultSeatRecoveryIssue(): RecoveryIssue {
  const err = plannerCallFailed('escalation', CODEX_LIMIT_WORDS);
  return buildPlannerCallFailedRecoveryIssue({
    id: 'rec_visual_hint_usage_limit',
    diagnosis: diagnosePlannerCallFailure({
      seat: 'plan',
      err,
      label: consultFailureLabel('plan', WORKFLOW_FIXTURE_TASK_ID),
      runner: CODEX_PLAN_SEAT,
    }),
    task: HALTED_TASK,
    phase: 'escalating',
    runner: CODEX_PLAN_SEAT,
    details: consultHaltDetails(WORKFLOW_FIXTURE_TASK_ID, 'plan'),
    seatSwap: plannerSeatSwap('plan', 'codex', ['codex', 'claude-code', 'opencode']),
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/** A PLAN seat that ran out on Codex, and the only other tool it could move to. */
function planSwappedRecoveryIssue(): RecoveryIssue {
  return buildPlannerCallFailedRecoveryIssue({
    id: 'rec_visual_plan_swapped',
    diagnosis: diagnosePlannerCallFailure({
      seat: 'plan',
      err: plannerCallFailed('planner', CODEX_LIMIT_WORDS),
      label: 'Planning failed',
      runner: CODEX_PLAN_SEAT,
    }),
    phase: 'planning',
    runner: CODEX_PLAN_SEAT,
    seatSwap: plannerSeatSwap('plan', 'codex', ['codex', 'claude-code']),
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/** The error row the engine publishes before it raises the halt. */
function haltErrorEvents(issue: RecoveryIssue): EngineEvent[] {
  return publishedEvents(FIXED_TS + 100, (bus) =>
    publishError({ bus, phase: issue.phase, message: issue.message, resetAt: issue.resetAt }),
  );
}

const planSeatRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_PLAN_SEAT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  get events() {
    return haltErrorEvents(planSeatRecoveryIssue());
  },
  get resumeState() {
    return makeWorkflowState({
      feature: WORKFLOW_FEATURE,
      startedAt: RESUMED_RUN_STARTED_AT,
      phase: 'planning',
      pendingRecovery: planSeatRecoveryIssue(),
    });
  },
};

/** A plan that failed its checks, went back once with the errors, and failed them again. */
function planChecksRecoveryIssue(): RecoveryIssue {
  return buildPlanSessionHaltRecoveryIssue({
    id: 'rec_visual_plan_checks',
    reason: 'plan-checks-failed',
    phase: 'planning',
    message: 'The plan failed its checks again after one repair.',
    details: ['Criterion C2 is served by no task.', 'Tasks T002 and T003 depend on each other.'],
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/** A planner that still asked questions after its two rounds: the third round is the halt's details. */
function planQuestionsRecoveryIssue(): RecoveryIssue {
  return buildPlanSessionHaltRecoveryIssue({
    id: 'rec_visual_plan_questions',
    reason: 'plan-questions-exhausted',
    phase: 'planning',
    message: `The planner asked a third round of questions; a session takes ${MAX_QUESTION_ROUNDS}.`,
    details: ['Which store keeps the greeting?', 'Should the CLI print a trailing newline?'],
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

const planQuestionsRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_PLAN_QUESTIONS_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    {
      type: 'planner_text',
      ts: FIXED_TS + 100,
      phase: 'planning',
      role: 'planner',
      content: 'plain',
      messageStart: true,
      text: 'Questions before the plan · round 2 of 2',
    },
  ],
  get resumeState() {
    return makeWorkflowState({
      feature: WORKFLOW_FEATURE,
      startedAt: RESUMED_RUN_STARTED_AT,
      phase: 'planning',
      pendingRecovery: planQuestionsRecoveryIssue(),
    });
  },
};

const planChecksRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_PLAN_CHECKS_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  get events(): EngineEvent[] {
    return [
      { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
      ...publishedEvents(FIXED_TS + 100, (bus) =>
        publishWarning({
          bus,
          phase: 'planning',
          ...planRepairWarning([
            { code: 'uncovered-criterion', message: 'Criterion C2 is served by no task.' },
            { code: 'dependency-cycle', message: 'Tasks T002 and T003 depend on each other.' },
          ]),
        }),
      ),
    ];
  },
  get resumeState() {
    return makeWorkflowState({
      feature: WORKFLOW_FEATURE,
      startedAt: RESUMED_RUN_STARTED_AT,
      phase: 'planning',
      pendingRecovery: planChecksRecoveryIssue(),
    });
  },
};

const reviewSeatRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_REVIEW_SEAT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  get events() {
    return haltErrorEvents(reviewSeatRecoveryIssue());
  },
  config: CODEX_PLAN_CREW,
  get resumeState() {
    return makeImplState([{ ...HALTED_TASK, status: 'done' }], {
      feature: WORKFLOW_FEATURE,
      startedAt: RESUMED_RUN_STARTED_AT,
      phase: 'final-review',
      pendingRecovery: reviewSeatRecoveryIssue(),
    });
  },
};

const hintSeatRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_HINT_SEAT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  get events() {
    return haltErrorEvents(consultSeatRecoveryIssue());
  },
  config: CODEX_PLAN_CREW,
  get resumeState() {
    return haltedResumeState(consultSeatRecoveryIssue());
  },
};

const BALANCE_SWITCH_FALLBACK = { ...SEAT_FALLBACK, variant: 'high' } as const;
const BALANCE_SWITCH_CONFIG = configWithSwitchedSeat(
  visualConfig({ implementer: { ...OPENCODE_BALANCE_SEAT, fallback: BALANCE_SWITCH_FALLBACK } }),
  'build',
  BALANCE_SWITCH_FALLBACK,
  undefined,
  true,
);
if (BALANCE_SWITCH_CONFIG === null) throw new Error('Invalid automatic balance-switch fixture');
const BALANCE_SWITCH_RUNNER = BALANCE_SWITCH_CONFIG.implementer;
const BALANCE_SWITCH_MODEL_NAME = 'DeepSeek V4.1 Flash';
const balanceSwitchIdentities = formatSeatChangeIdentities(
  { seat: OPENCODE_BALANCE_SEAT, displayName: BALANCE_SWITCH_MODEL_NAME },
  { seat: BALANCE_SWITCH_RUNNER, displayName: BALANCE_SWITCH_MODEL_NAME },
);

function fallbackRecoveryProjection(
  input: Readonly<{
    scenarioId: ScenarioId;
    config: Config;
    seatSwap: SeatSwapContext;
    seatSwitches?: SeatSwitchRecord[] | undefined;
  }>,
): WorkflowFixtureProjection {
  const issue = () =>
    usageLimitRecoveryIssue({
      runner: input.config.implementer,
      seatSwap: input.seatSwap,
      seatSwitches: input.seatSwitches,
    });
  return {
    ...usageLimitRecoveryProjection,
    scenarioId: input.scenarioId,
    config: { implementer: input.config.implementer },
    get events() {
      return haltErrorEvents(issue());
    },
    get resumeState() {
      return { ...haltedResumeState(issue()), seatSwitches: input.seatSwitches };
    },
  };
}

const noFallbackRecoveryProjection = fallbackRecoveryProjection({
  scenarioId: scenarioId('workflow-recovery-no-fallback'),
  config: visualConfig(),
  seatSwap: {
    seat: 'build',
    currentTool: '',
    detectedTools: [{ tool: 'codex', ready: true }],
  },
});

const fallbackUsedRecoveryProjection = fallbackRecoveryProjection({
  scenarioId: scenarioId('workflow-recovery-fallback-used'),
  config: BALANCE_SWITCH_CONFIG,
  seatSwap: {
    seat: 'build',
    currentTool: BALANCE_SWITCH_FALLBACK.tool,
    currentModel: BALANCE_SWITCH_FALLBACK.model,
    fallback: BALANCE_SWITCH_RUNNER.fallback,
    detectedTools: [{ ...OPENCODE_BALANCE_SEAT, ready: true }],
  },
  seatSwitches: [
    {
      seat: 'build',
      from: balanceSwitchIdentities.from,
      to: balanceSwitchIdentities.to,
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'visual-config-revision',
      ts: RESUMED_RUN_STARTED_AT,
    },
  ],
});

const fallbackNotInstalledRecoveryProjection = fallbackRecoveryProjection({
  scenarioId: scenarioId('workflow-recovery-fallback-not-installed'),
  config: visualConfig({ implementer: { ...BASE_IMPLEMENTER, fallback: SEAT_FALLBACK } }),
  seatSwap: {
    seat: 'build',
    currentTool: '',
    fallback: SEAT_FALLBACK,
    fallbackBlockedReason: fallbackBlockedReason(undefined),
    detectedTools: [{ tool: 'codex', ready: true }],
  },
});

const balanceSeatSwitchProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-seat-switched-balance'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { implementer: BALANCE_SWITCH_RUNNER },
  cliModels: [
    {
      connection: { tool: 'opencode', contextKey: 'build-opencode-visual' },
      outcome: {
        kind: 'success',
        value: [OPENCODE_BALANCE_SEAT, BALANCE_SWITCH_FALLBACK].map((seat) => ({
          id: seat.model,
          displayName: BALANCE_SWITCH_MODEL_NAME,
        })),
      },
    },
  ],
  get events(): EngineEvent[] {
    const issue = balanceSpentRecoveryIssue();
    const start = {
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: 'Add wordCount to src/text.js',
      index: 0,
      total: 1,
      lineageAttempt: 1,
      attemptAllowance: BOUNDS.attemptsPerLineage,
      file: 'src/text.js',
      files: ['src/text.js', 'test/text.test.js'],
      action: 'modify',
      tool: OPENCODE_BALANCE_SEAT.tool,
      backendKind: 'cli',
      implementerProfile: 'default',
    } as const;
    return publishedEvents(FIXED_TS, (bus) => {
      const ctx = { bus, phase: 'implementing' } as const;
      let sequence = 0;
      const onCallEvent = (event: RunnerCallEvent): void => {
        for (const projected of projectRunnerCallEvents(event, {
          rootDir: VISUAL_FIXTURE_PROJECT_DIR,
          phase: ctx.phase,
          sequence: sequence++,
        }))
          bus.publish(projected);
      };
      bus.publish({
        type: 'workflow_started',
        ts: FIXED_TS,
        phase: ctx.phase,
        feature: WORKFLOW_FEATURE,
      });
      publishTaskStart(ctx, {
        ...start,
        files: [...start.files],
        model: OPENCODE_BALANCE_SEAT.model,
        axes: seatAxisWords(OPENCODE_BALANCE_SEAT),
      });
      const failedCall = createRunnerCallRecorder({
        context: {
          ...createImplementerCallContext({
            config: visualConfig({ implementer: OPENCODE_BALANCE_SEAT }),
            attempt: 0,
            taskId: start.taskId,
          }),
          callId: 'visual-opencode-balance-failed',
        },
        startedAt: FIXED_TS + 2,
        onEvent: onCallEvent,
      });
      const words = `${BALANCE_WORDS} (request_id: c69db249-284a-4420-af40-a355af445569)`;
      failedCall.warning({
        warning: {
          code: 'opencode-error',
          severity: 'warning',
          source: 'provider',
          surface: 'activity',
          message: words,
        },
        ts: FIXED_TS + 3,
      });
      failedCall.finishFailed({
        status: 'failed',
        error: {
          code: 'opencode-error',
          message: words,
          status: 402,
          providerType: 'provider.quota',
        },
        endedAt: FIXED_TS + 4,
      });
      bus.publish({
        type: 'implementer_generate_failed',
        ts: FIXED_TS + 5,
        phase: ctx.phase,
        taskId: start.taskId,
        model: OPENCODE_BALANCE_SEAT.model,
        error: words,
      });
      publishError({ ...ctx, message: formatRecoveryHeadline(issue) });
      publishRecoveryPrompted(ctx, VISUAL_WORKFLOW_SESSION_ID, issue);
      publishRecoveryActionSelected({ ...ctx, issue, action: 'switch-seat' });
      publishSeatSwitched(ctx, {
        seat: 'build',
        from: { tool: OPENCODE_BALANCE_SEAT.tool, model: OPENCODE_BALANCE_SEAT.model },
        to: BALANCE_SWITCH_FALLBACK,
        cause: issue.reason,
        accountCause: 'balance',
        headline: formatRecoveryHeadline(issue),
        auto: true,
        configRevision: 'visual-config-revision',
      });
      publishRecoveryResolved({
        ...ctx,
        issue,
        action: 'switch-seat',
        outcome: 'retry-current-task',
        implementerProfile: 'default',
      });
      publishTaskStart(ctx, {
        ...start,
        files: [...start.files],
        model: BALANCE_SWITCH_FALLBACK.model,
        axes: seatAxisWords(BALANCE_SWITCH_RUNNER),
      });
      const restartedCall = createRunnerCallRecorder({
        context: {
          ...createImplementerCallContext({
            config: visualConfig({ implementer: BALANCE_SWITCH_RUNNER }),
            attempt: 0,
            taskId: start.taskId,
          }),
          callId: 'visual-opencode-balance-restarted',
        },
        startedAt: FIXED_TS + 12,
        onEvent: onCallEvent,
      });
      restartedCall.toolUseDelta({
        toolUseId: 'visual-endpoint-read',
        name: 'read',
        inputDelta: JSON.stringify({ path: start.file }),
        stage: 'started',
        ts: FIXED_TS + 13,
      });
      bus.publish({
        type: 'planner_text',
        ts: FIXED_TS + 14,
        phase: ctx.phase,
        role: 'implementer',
        content: 'markdown',
        text: 'Added wordCount and its tests.\n\n{"status":"done","filesChanged":["src/text.js","test/text.test.js"],"touchedNotSuggested":[],"notes":null,"decisions":[]}',
      });
      restartedCall.finishCompleted({ endedAt: FIXED_TS + 15 });
      bus.publish({
        type: 'implementer_generate_done',
        ts: FIXED_TS + 16,
        phase: ctx.phase,
        taskId: start.taskId,
        file: start.file,
        files: [...start.files],
        duration: 15409,
      });
      bus.publish({
        type: 'task_completed',
        ts: FIXED_TS + 17,
        phase: ctx.phase,
        taskId: start.taskId,
        title: start.title,
        method: 'local',
        retries: 0,
        duration: 15822,
        tool: 'opencode',
        model: BALANCE_SWITCH_FALLBACK.model,
        implementerProfile: 'default',
      });
    });
  },
};

const seatSwitchedProjection: WorkflowFixtureProjection = {
  ...balanceSeatSwitchProjection,
  scenarioId: scenarioId('workflow-seat-switched'),
};

const manualSeatSwitchedProjection: WorkflowFixtureProjection = {
  ...seatSwitchedProjection,
  scenarioId: scenarioId('workflow-seat-switched-manual'),
  events: seatSwitchedProjection.events.map((event) =>
    event.type === 'seat_switched' ? { ...event, auto: false } : event,
  ),
};

const SPENT_B2_REPLAY_LOG = `
{"ts":"2026-10-11T13:56:40.377Z","kind":"event","type":"tasks_planned","phase":"implementing","data":{"tasks":[{"id":"T001","title":"Add wordCount to src/text.js","index":0,"file":"src/text.js","action":"modify"},{"id":"T002","title":"Add optional suffix to truncate in src/preview.js","index":1,"file":"src/preview.js","action":"modify"}],"total":2}}
{"ts":"2026-10-11T13:56:40.429Z","kind":"event","type":"task_started","taskId":"T001","phase":"implementing","data":{"title":"Add wordCount to src/text.js","index":0,"total":2,"lineageAttempt":1,"attemptAllowance":8,"file":"src/text.js","files":["src/text.js","test/text.test.js"],"action":"modify","tool":"opencode","model":"deepseek/deepseek-flash","axes":[],"backendKind":"cli","implementerProfile":"default","contextFit":"fits","estimatedTokens":1573,"untruncatedEstimatedTokens":1573,"contextLength":1000000,"currentCodeTruncated":false,"currentCodeContextMode":"none","routingReason":"Selected profile default (fits, estimated 1573/1000000 tokens)"}}
{"ts":"2026-10-11T13:56:40.662Z","kind":"event","type":"implementer_generate_running","taskId":"T001","phase":"implementing","data":{"file":"src/text.js","lineageAttempt":1,"attemptAllowance":8}}
{"ts":"2026-10-11T13:56:40.961Z","kind":"event","type":"runner_call_started","taskId":"T001","phase":"implementing","data":{"callId":"implementer-1","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"deepseek/deepseek-flash","axes":[],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727000961,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":415}}
{"ts":"2026-10-11T13:56:43.321Z","kind":"event","type":"steerable_call","taskId":"T001","phase":"implementing","data":{"seat":"build"}}
{"ts":"2026-10-11T13:56:43.323Z","kind":"event","type":"runner_call_session_id","taskId":"T001","phase":"implementing","data":{"callId":"implementer-1","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"deepseek/deepseek-flash","axes":[],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727000961,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":416,"nativeSessionId":"ses_ed4bf9e1dffehEzin1mygGWRGs"}}
{"ts":"2026-10-11T13:56:43.353Z","kind":"event","type":"runner_call_warning","taskId":"T001","phase":"implementing","data":{"callId":"implementer-1","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"deepseek/deepseek-flash","axes":[],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727000961,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":417,"warning":{"code":"opencode-error","severity":"warning","source":"provider","surface":"activity","fingerprint":"rw:763c296f02a6f316bfc6ef84","message":"provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)"}}}
{"ts":"2026-10-11T13:56:43.353Z","kind":"event","type":"runner_call_activity","taskId":"T001","phase":"implementing","data":{"callId":"implementer-1","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"deepseek/deepseek-flash","axes":[],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727000961,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":417,"activityId":"implementer-1:warning:rw:763c296f02a6f316bfc6ef84","stage":"warning","kind":"warning","label":"warning opencode-error","redacted":false,"rawAvailable":false,"expandId":"implementer-1:warning:rw:763c296f02a6f316bfc6ef84","diagnosticPartial":"provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)"}}
{"ts":"2026-10-11T13:56:43.363Z","kind":"event","type":"steerable_call","phase":"implementing","data":{}}
{"ts":"2026-10-11T13:56:43.410Z","kind":"event","type":"runner_call_error","taskId":"T001","phase":"implementing","data":{"callId":"implementer-1","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"deepseek/deepseek-flash","axes":[],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727000961,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":418,"status":"failed","error":{"code":"opencode-error","message":"provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)","status":402,"providerType":"provider.quota"},"partial":true,"rawTail":"provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)","startedAt":1791727000961,"endedAt":1791727003410,"durationMs":2449,"usage":null,"nativeSessionId":"ses_ed4bf9e1dffehEzin1mygGWRGs"}}
{"ts":"2026-10-11T13:56:43.410Z","kind":"event","type":"runner_call_activity","taskId":"T001","phase":"implementing","data":{"callId":"implementer-1","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"deepseek/deepseek-flash","axes":[],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727000961,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":418,"activityId":"implementer-1:terminal","stage":"failed","kind":"error","label":"failed opencode-error","redacted":false,"rawAvailable":true,"expandId":"implementer-1:terminal","diagnosticPartial":"provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)"}}
{"ts":"2026-10-11T13:56:43.462Z","kind":"event","type":"implementer_generate_failed","taskId":"T001","phase":"implementing","data":{"model":"deepseek/deepseek-flash","error":"provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569)"}}
{"ts":"2026-10-11T13:56:43.480Z","kind":"event","type":"error","phase":"implementing","data":{"message":"Balance spent on OpenCode CLI. Add credit or change the BUILD tool, then continue. (runner reported: provider.quota: Insufficient Balance (request_id: c69db249-284a-4420-af40-a355af445569))"}}
{"ts":"2026-10-11T13:56:43.524Z","kind":"event","type":"recovery_prompted","taskId":"T001","phase":"implementing","data":{"issueId":"rec_20261011135643_runner_usage_limit_implementing_T001","reason":"runner-usage-limit","files":["src/text.js"],"affectedTaskIds":["T001"],"availableActions":["retry-same-worker","switch-seat","skip-current-task","end-run"],"recommendedAction":"switch-seat","headline":"Balance spent on OpenCode CLI","headlineSpans":[{"text":"Balance spent on OpenCode CLI"}],"resumeCommand":"splitbrief continue 2026-10-11-word-counts-and-marked-previews --action switch-seat:opencode:opencode-go/deepseek-v4.1-flash@high"}}
{"ts":"2026-10-11T13:56:47.504Z","kind":"event","type":"recovery_action_selected","phase":"implementing","data":{"issueId":"rec_20261011135643_runner_usage_limit_implementing_T001","reason":"runner-usage-limit","action":"switch-seat","seat":"build"}}
{"ts":"2026-10-11T13:56:47.552Z","kind":"event","type":"seat_switched","phase":"implementing","data":{"seat":"build","from":{"tool":"opencode","model":"deepseek/deepseek-flash"},"to":{"tool":"opencode","model":"opencode-go/deepseek-v4.1-flash","variant":"high"},"cause":"runner-usage-limit","accountCause":"balance","headline":"Balance spent on OpenCode CLI","auto":true,"configRevision":"643fca0d8c759fc0e3b5b4957fe3e290aaa87a3e309ec98100fa7cfca9db4aa7"}}
{"ts":"2026-10-11T13:56:47.552Z","kind":"event","type":"recovery_resolved","phase":"implementing","data":{"issueId":"rec_20261011135643_runner_usage_limit_implementing_T001","reason":"runner-usage-limit","action":"switch-seat","seat":"build","outcome":"retry-current-task","implementerProfile":"default"}}
{"ts":"2026-10-11T13:56:47.579Z","kind":"event","type":"warning","phase":"implementing","data":{"message":"BUILD seat changed OpenCode CLI · deepseek/deepseek-flash → OpenCode CLI · opencode-go/deepseek-v4.1-flash · high; the rest of the run uses the new seat"}}
{"ts":"2026-10-11T13:56:47.599Z","kind":"event","type":"workflow_resumed","phase":"implementing","data":{}}
{"ts":"2026-10-11T13:56:47.600Z","kind":"event","type":"workflow_config","phase":"implementing","data":{"plannerTool":"claude-code","plannerModel":"claude-opus-5-5","implementerTool":"opencode","implementerModel":"opencode-go/deepseek-v4.1-flash","reviewerTool":"codex","reviewerModel":"gpt-6.1-sol"}}
{"ts":"2026-10-11T13:56:47.806Z","kind":"event","type":"tasks_planned","phase":"implementing","data":{"tasks":[{"id":"T001","title":"Add wordCount to src/text.js","index":0,"file":"src/text.js","action":"modify"},{"id":"T002","title":"Add optional suffix to truncate in src/preview.js","index":1,"file":"src/preview.js","action":"modify"}],"total":2}}
{"ts":"2026-10-11T13:56:47.835Z","kind":"event","type":"task_started","taskId":"T001","phase":"implementing","data":{"title":"Add wordCount to src/text.js","index":0,"total":2,"lineageAttempt":1,"attemptAllowance":8,"file":"src/text.js","files":["src/text.js","test/text.test.js"],"action":"modify","tool":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"backendKind":"cli","implementerProfile":"default","contextFit":"fits","estimatedTokens":1573,"untruncatedEstimatedTokens":1573,"contextLength":1000000,"currentCodeTruncated":false,"currentCodeContextMode":"none","routingReason":"Selected profile default (fits, estimated 1573/1000000 tokens)"}}
{"ts":"2026-10-11T13:56:48.022Z","kind":"event","type":"implementer_generate_running","taskId":"T001","phase":"implementing","data":{"file":"src/text.js","lineageAttempt":1,"attemptAllowance":8}}
{"ts":"2026-10-11T13:56:48.291Z","kind":"event","type":"runner_call_started","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":419}}
{"ts":"2026-10-11T13:56:53.386Z","kind":"event","type":"steerable_call","taskId":"T001","phase":"implementing","data":{"seat":"build"}}
{"ts":"2026-10-11T13:56:53.387Z","kind":"event","type":"runner_call_session_id","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":420,"nativeSessionId":"ses_ed4bf81f5ffeJnkbVh4fsKPGKi"}}
{"ts":"2026-10-11T13:56:54.095Z","kind":"event","type":"runner_call_tool_use","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":421,"stage":"done","toolUse":{"id":"call_00_ite0q1t16woz95buk0ph9o02","name":"read","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/src/text.js"},"output":"Read file /Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/src/text.js, lines 1-6\\n1: export function compactWhitespace(value) {\\n2:   if (typeof value !== 'string') {\\n3:     throw new TypeError('value must be a string');\\n4:   }\\n5:   return value.trim().replace(/\\\\s+/g, ' ');\\n6: }"}}}
{"ts":"2026-10-11T13:56:54.095Z","kind":"event","type":"runner_call_activity","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":421,"activityId":"implementer-2:tool:call_00_ite0q1t16woz95buk0ph9o02","stage":"completed","kind":"read","label":"reading src/text.js","target":"src/text.js","redacted":false,"rawAvailable":false,"expandId":"implementer-2:tool:call_00_ite0q1t16woz95buk0ph9o02"}}
{"ts":"2026-10-11T13:56:54.128Z","kind":"event","type":"runner_call_tool_use","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":422,"stage":"done","toolUse":{"id":"call_01_hivt3g7zu711ale5u0b4uk9d","name":"read","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/test/text.test.js"},"output":"Read file /Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/test/text.test.js, lines 1-22\\n1: import test from 'node:test';\\n2: import assert from 'node:assert/strict';\\n3: import { compactWhitespace } from '../src/text.js';\\n4: \\n5: test('compacts spaces, tabs, and newlines', () => {\\n6:   assert.equal(compactWhitespace('  Hello\\\\t world\\\\n again  '), 'Hello world again');\\n7: });\\n8: \\n9: test('keeps letter case and punctuation', () => {\\n10:   assert.equal(compactWhitespace('Hello, World!'), 'Hello, World!');\\n11: });\\n12: \\n13: test('empty and whitespace-only strings become empty', () => {\\n14:   assert.equal(compactWhitespace(''), '');\\n15:   assert.equal(compactWhitespace(' \\\\t\\\\n '), '');\\n16: });\\n17: \\n18: test('rejects non-string text', () => {\\n19:   for (const value of [null, undefined, 7, {}, []]) {\\n20:     assert.throws(() => compactWhitespace(value), TypeError);\\n21:   }\\n22: });"}}}
{"ts":"2026-10-11T13:56:54.128Z","kind":"event","type":"runner_call_activity","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":422,"activityId":"implementer-2:tool:call_01_hivt3g7zu711ale5u0b4uk9d","stage":"completed","kind":"read","label":"reading test/text.test.js","target":"test/text.test.js","redacted":false,"rawAvailable":false,"expandId":"implementer-2:tool:call_01_hivt3g7zu711ale5u0b4uk9d"}}
{"ts":"2026-10-11T13:56:54.142Z","kind":"event","type":"runner_call_usage","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":423,"usage":{"inputTokens":39503,"outputTokens":143,"cacheReadTokens":1408,"cacheCreateTokens":0,"reasoningTokens":7},"semantics":"delta"}}
{"ts":"2026-10-11T13:57:00.288Z","kind":"event","type":"runner_call_tool_use","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":424,"stage":"done","toolUse":{"id":"call_00_dwh9e2pefls02duk3ut249vx","name":"edit","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/src/text.js","oldString":"export function compactWhitespace(value) {\\n  if (typeof value !== 'string') {\\n    throw new TypeError('value must be a string');\\n  }\\n  return value.trim().replace(/\\\\s+/g, ' ');\\n}","newString":"export function compactWhitespace(value) {\\n  if (typeof value !== 'string') {\\n    throw new TypeError('value must be a string');\\n  }\\n  return value.trim().replace(/\\\\s+/g, ' ');\\n}\\n\\nexport function wordCount(value) {\\n  if (typeof value !== 'string') {\\n    throw new TypeError('value must be a string');\\n  }\\n  return (value.match(/\\\\S+/g) ?? []).length;\\n}"},"output":"Edited src/text.js (1 replacement)"}}}
{"ts":"2026-10-11T13:57:00.288Z","kind":"event","type":"runner_call_activity","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":424,"activityId":"implementer-2:tool:call_00_dwh9e2pefls02duk3ut249vx","stage":"completed","kind":"write","label":"editing src/text.js","target":"src/text.js","redacted":false,"rawAvailable":false,"expandId":"implementer-2:tool:call_00_dwh9e2pefls02duk3ut249vx"}}
{"ts":"2026-10-11T13:57:00.316Z","kind":"event","type":"runner_call_tool_use","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":425,"stage":"done","toolUse":{"id":"call_01_lp0z70gkmvxw222l1zqfskl4","name":"edit","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/test/text.test.js","oldString":"import { compactWhitespace } from '../src/text.js';","newString":"import { compactWhitespace, wordCount } from '../src/text.js';"},"output":"Edited test/text.test.js (1 replacement)"}}}
{"ts":"2026-10-11T13:57:00.316Z","kind":"event","type":"runner_call_activity","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":425,"activityId":"implementer-2:tool:call_01_lp0z70gkmvxw222l1zqfskl4","stage":"completed","kind":"write","label":"editing test/text.test.js","target":"test/text.test.js","redacted":false,"rawAvailable":false,"expandId":"implementer-2:tool:call_01_lp0z70gkmvxw222l1zqfskl4"}}
{"ts":"2026-10-11T13:57:00.318Z","kind":"event","type":"runner_call_tool_use","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":426,"stage":"done","toolUse":{"id":"call_02_t16s4ijhtveiv4kz5okdgyfq","name":"edit","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/test/text.test.js","oldString":"test('rejects non-string text', () => {\\n  for (const value of [null, undefined, 7, {}, []]) {\\n    assert.throws(() => compactWhitespace(value), TypeError);\\n  }\\n});","newString":"test('rejects non-string text', () => {\\n  for (const value of [null, undefined, 7, {}, []]) {\\n    assert.throws(() => compactWhitespace(value), TypeError);\\n  }\\n});\\n\\ntest('counts nonempty whitespace-separated words', () => {\\n  assert.equal(wordCount('  one\\\\ttwo\\\\nthree  '), 3);\\n});\\n\\ntest('keeps punctuation inside a word', () => {\\n  assert.equal(wordCount('hello,world'), 1);\\n});\\n\\ntest('empty and whitespace-only strings count zero words', () => {\\n  assert.equal(wordCount(''), 0);\\n  assert.equal(wordCount(' \\\\t\\\\n '), 0);\\n});\\n\\ntest('wordCount rejects non-string input', () => {\\n  assert.throws(() => wordCount(null), TypeError);\\n  assert.throws(() => wordCount(42), TypeError);\\n  assert.throws(() => wordCount(undefined), TypeError);\\n});"},"output":"Edited test/text.test.js (1 replacement)"}}}
{"ts":"2026-10-11T13:57:00.318Z","kind":"event","type":"runner_call_activity","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":426,"activityId":"implementer-2:tool:call_02_t16s4ijhtveiv4kz5okdgyfq","stage":"completed","kind":"write","label":"editing test/text.test.js","target":"test/text.test.js","redacted":false,"rawAvailable":false,"expandId":"implementer-2:tool:call_02_t16s4ijhtveiv4kz5okdgyfq"}}
{"ts":"2026-10-11T13:57:00.373Z","kind":"event","type":"runner_call_usage","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":427,"usage":{"inputTokens":648,"outputTokens":719,"cacheReadTokens":40832,"cacheCreateTokens":0,"reasoningTokens":38},"semantics":"delta"}}
{"ts":"2026-10-11T13:57:03.287Z","kind":"event","type":"planner_text","phase":"implementing","data":{"text":"Added \`wordCount(value)\` as a named export in \`src/text.js\`, matching \`compactWhitespace\`'s validation style, and extended \`test/text.test.js\` with the required cases.\\n\\n{\\"status\\":\\"done\\",\\"filesChanged\\":[\\"src/text.js\\",\\"test/text.test.js\\"],\\"touchedNotSuggested\\":[],\\"notes\\":null,\\"decisions\\":[]}","role":"implementer","content":"markdown"}}
{"ts":"2026-10-11T13:57:03.312Z","kind":"event","type":"steerable_call","phase":"implementing","data":{}}
{"ts":"2026-10-11T13:57:03.355Z","kind":"event","type":"runner_call_completed","taskId":"T001","phase":"implementing","data":{"callId":"implementer-2","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727008291,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":430,"status":"completed","error":null,"partial":false,"startedAt":1791727008291,"endedAt":1791727023355,"durationMs":15064,"usage":{"inputTokens":40151,"outputTokens":862,"cacheReadTokens":42240,"cacheCreateTokens":0,"reasoningTokens":45},"nativeSessionId":"ses_ed4bf81f5ffeJnkbVh4fsKPGKi"}}
{"ts":"2026-10-11T13:57:03.432Z","kind":"event","type":"implementer_generate_done","taskId":"T001","phase":"implementing","data":{"file":"src/text.js","duration":15409}}
{"ts":"2026-10-11T13:57:03.490Z","kind":"event","type":"cost_update","phase":"implementing","data":{"tokenUsage":{"plannerInput":4,"plannerOutput":3222,"implementerInput":40151,"implementerOutput":862,"escalationInput":0,"escalationOutput":0,"reviewerInput":0,"reviewerOutput":0,"plannerCacheRead":39876,"plannerCacheCreate":43816,"implementerCacheRead":42240,"implementerCacheCreate":0,"implementerReasoning":45,"plannerCoverage":{"input":"reported","output":"partial","cacheRead":"reported","cacheCreate":"reported","reasoning":"missing"}}}}
{"ts":"2026-10-11T13:57:03.672Z","kind":"event","type":"task_completed","taskId":"T001","phase":"implementing","data":{"title":"Add wordCount to src/text.js","method":"local","retries":0,"duration":15822,"tool":"opencode","model":"opencode-go/deepseek-v4.1-flash","implementerProfile":"default"}}
{"ts":"2026-10-11T13:57:03.781Z","kind":"event","type":"task_tokens","taskId":"T001","phase":"implementing","data":{"method":"local","implementerTokens":41013,"escalationTokens":0,"implementerCacheReadTokens":42240,"implementerCacheCreateTokens":0,"implementerInputTokens":40151,"implementerOutputTokens":862,"implementerReasoningTokens":45,"retryCount":0,"tool":"opencode","model":"opencode-go/deepseek-v4.1-flash","implementerProfile":"default","contextFit":"fits","estimatedTokens":1573,"untruncatedEstimatedTokens":1573,"contextLength":1000000,"currentCodeTruncated":false,"currentCodeContextMode":"none","routingReason":"Selected profile default (fits, estimated 1573/1000000 tokens)"}}
{"ts":"2026-10-11T13:57:03.917Z","kind":"event","type":"task_started","taskId":"T002","phase":"implementing","data":{"title":"Add optional suffix to truncate in src/preview.js","index":1,"total":2,"lineageAttempt":1,"attemptAllowance":8,"file":"src/preview.js","files":["src/preview.js","test/preview.test.js"],"action":"modify","tool":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"backendKind":"cli","implementerProfile":"default","contextFit":"fits","estimatedTokens":1872,"untruncatedEstimatedTokens":1872,"contextLength":1000000,"currentCodeTruncated":false,"currentCodeContextMode":"none","routingReason":"Selected profile default (fits, estimated 1872/1000000 tokens)"}}
{"ts":"2026-10-11T13:57:04.088Z","kind":"event","type":"implementer_generate_running","taskId":"T002","phase":"implementing","data":{"file":"src/preview.js","lineageAttempt":1,"attemptAllowance":8}}
{"ts":"2026-10-11T13:57:04.337Z","kind":"event","type":"runner_call_started","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":431}}
{"ts":"2026-10-11T13:57:08.836Z","kind":"event","type":"steerable_call","taskId":"T002","phase":"implementing","data":{"seat":"build"}}
{"ts":"2026-10-11T13:57:08.837Z","kind":"event","type":"runner_call_session_id","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":432,"nativeSessionId":"ses_ed4bf433bffe6j7ebzmv48B3vx"}}
{"ts":"2026-10-11T13:57:09.403Z","kind":"event","type":"runner_call_tool_use","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":433,"stage":"done","toolUse":{"id":"call_01_kt2eae9el2zmaorf0yhv806o","name":"read","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/test/preview.test.js"},"output":"Read file /Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/test/preview.test.js, lines 1-24\\n1: import test from 'node:test';\\n2: import assert from 'node:assert/strict';\\n3: import { truncate } from '../src/preview.js';\\n4: \\n5: test('cuts a long preview at the requested length', () => {\\n6:   assert.equal(truncate('abcdef', 3), 'abc');\\n7:   assert.equal(truncate('abcdef', 1), 'a');\\n8: });\\n9: \\n10: test('keeps short, exact-length, and empty previews', () => {\\n11:   assert.equal(truncate('ab', 3), 'ab');\\n12:   assert.equal(truncate('abc', 3), 'abc');\\n13:   assert.equal(truncate('', 3), '');\\n14: });\\n15: \\n16: test('rejects non-string previews', () => {\\n17:   assert.throws(() => truncate(null, 3), TypeError);\\n18: });\\n19: \\n20: test('rejects invalid maximum lengths', () => {\\n21:   for (const length of [0, -1, 1.5, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {\\n22:     assert.throws(() => truncate('abc', length), RangeError);\\n23:   }\\n24: });"}}}
{"ts":"2026-10-11T13:57:09.403Z","kind":"event","type":"runner_call_activity","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":433,"activityId":"implementer-3:tool:call_01_kt2eae9el2zmaorf0yhv806o","stage":"completed","kind":"read","label":"reading test/preview.test.js","target":"test/preview.test.js","redacted":false,"rawAvailable":false,"expandId":"implementer-3:tool:call_01_kt2eae9el2zmaorf0yhv806o"}}
{"ts":"2026-10-11T13:57:09.431Z","kind":"event","type":"runner_call_tool_use","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":434,"stage":"done","toolUse":{"id":"call_00_9rcxaynqzhmwd3bwvry296vy","name":"read","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/src/preview.js"},"output":"Read file /Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/src/preview.js, lines 1-9\\n1: export function truncate(value, maxLength) {\\n2:   if (typeof value !== 'string') {\\n3:     throw new TypeError('value must be a string');\\n4:   }\\n5:   if (!Number.isSafeInteger(maxLength) || maxLength < 1) {\\n6:     throw new RangeError('maxLength must be a positive safe integer');\\n7:   }\\n8:   return value.slice(0, maxLength);\\n9: }"}}}
{"ts":"2026-10-11T13:57:09.431Z","kind":"event","type":"runner_call_activity","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":434,"activityId":"implementer-3:tool:call_00_9rcxaynqzhmwd3bwvry296vy","stage":"completed","kind":"read","label":"reading src/preview.js","target":"src/preview.js","redacted":false,"rawAvailable":false,"expandId":"implementer-3:tool:call_00_9rcxaynqzhmwd3bwvry296vy"}}
{"ts":"2026-10-11T13:57:09.443Z","kind":"event","type":"runner_call_usage","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":435,"usage":{"inputTokens":5079,"outputTokens":145,"cacheReadTokens":36096,"cacheCreateTokens":0,"reasoningTokens":6},"semantics":"delta"}}
{"ts":"2026-10-11T13:57:15.811Z","kind":"event","type":"runner_call_tool_use","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":436,"stage":"done","toolUse":{"id":"call_00_2wge1tf6goxk0aq1jks95wlj","name":"edit","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/src/preview.js","oldString":"export function truncate(value, maxLength) {\\n  if (typeof value !== 'string') {\\n    throw new TypeError('value must be a string');\\n  }\\n  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {\\n    throw new RangeError('maxLength must be a positive safe integer');\\n  }\\n  return value.slice(0, maxLength);\\n}","newString":"export function truncate(value, maxLength, suffix = '') {\\n  if (typeof value !== 'string') {\\n    throw new TypeError('value must be a string');\\n  }\\n  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {\\n    throw new RangeError('maxLength must be a positive safe integer');\\n  }\\n  if (typeof suffix !== 'string') {\\n    throw new TypeError('suffix must be a string');\\n  }\\n  if (suffix.length > maxLength) {\\n    throw new RangeError('suffix must not be longer than maxLength');\\n  }\\n  if (value.length <= maxLength) {\\n    return value;\\n  }\\n  return value.slice(0, maxLength - suffix.length) + suffix;\\n}"},"output":"Edited src/preview.js (1 replacement)"}}}
{"ts":"2026-10-11T13:57:15.811Z","kind":"event","type":"runner_call_activity","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":436,"activityId":"implementer-3:tool:call_00_2wge1tf6goxk0aq1jks95wlj","stage":"completed","kind":"write","label":"editing src/preview.js","target":"src/preview.js","redacted":false,"rawAvailable":false,"expandId":"implementer-3:tool:call_00_2wge1tf6goxk0aq1jks95wlj"}}
{"ts":"2026-10-11T13:57:15.841Z","kind":"event","type":"runner_call_tool_use","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":437,"stage":"done","toolUse":{"id":"call_01_czqqhx6led5sg96jyox9o1zy","name":"edit","input":{"path":"/Users/alice/.local/state/splitbrief/trees/8ffd6ae95841/2026-10-11-word-counts-and-marked-previews/test/preview.test.js","oldString":"test('rejects non-string previews', () => {\\n  assert.throws(() => truncate(null, 3), TypeError);\\n});\\n\\ntest('rejects invalid maximum lengths', () => {\\n  for (const length of [0, -1, 1.5, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {\\n    assert.throws(() => truncate('abc', length), RangeError);\\n  }\\n});","newString":"test('marks cut previews with a suffix', () => {\\n  assert.equal(truncate('abcdef', 4, '..'), 'ab..');\\n  assert.equal(truncate('abcdef', 3, '...'), '...');\\n  assert.equal(truncate('abcdef', 3), 'abc');\\n});\\n\\ntest('keeps short, exact-length, and empty previews with a suffix', () => {\\n  assert.equal(truncate('ab', 4, '..'), 'ab');\\n  assert.equal(truncate('abcd', 4, '..'), 'abcd');\\n  assert.equal(truncate('', 4, '..'), '');\\n});\\n\\ntest('rejects non-string previews', () => {\\n  assert.throws(() => truncate(null, 3), TypeError);\\n  assert.throws(() => truncate(null, 3, '..'), TypeError);\\n});\\n\\ntest('rejects invalid maximum lengths', () => {\\n  for (const length of [0, -1, 1.5, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {\\n    assert.throws(() => truncate('abc', length), RangeError);\\n    assert.throws(() => truncate('abc', length, '..'), RangeError);\\n  }\\n});\\n\\ntest('rejects non-string suffixes', () => {\\n  assert.throws(() => truncate('a', 4, null), TypeError);\\n  assert.throws(() => truncate('a', 4, 42), TypeError);\\n});\\n\\ntest('rejects suffixes longer than the maximum length', () => {\\n  assert.throws(() => truncate('a', 2, '...'), RangeError);\\n});"},"output":"Edited test/preview.test.js (1 replacement)"}}}
{"ts":"2026-10-11T13:57:15.841Z","kind":"event","type":"runner_call_activity","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":437,"activityId":"implementer-3:tool:call_01_czqqhx6led5sg96jyox9o1zy","stage":"completed","kind":"write","label":"editing test/preview.test.js","target":"test/preview.test.js","redacted":false,"rawAvailable":false,"expandId":"implementer-3:tool:call_01_czqqhx6led5sg96jyox9o1zy"}}
{"ts":"2026-10-11T13:57:15.914Z","kind":"event","type":"runner_call_usage","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":438,"usage":{"inputTokens":744,"outputTokens":898,"cacheReadTokens":41088,"cacheCreateTokens":0,"reasoningTokens":7},"semantics":"delta"}}
{"ts":"2026-10-11T13:57:18.858Z","kind":"event","type":"planner_text","phase":"implementing","data":{"text":"I updated \`truncate\` with the optional \`suffix\` parameter and added the requested node:test cases.\\n\\n{\\"status\\":\\"done\\",\\"filesChanged\\":[\\"src/preview.js\\",\\"test/preview.test.js\\"],\\"touchedNotSuggested\\":[],\\"notes\\":null,\\"decisions\\":[]}","role":"implementer","content":"markdown"}}
{"ts":"2026-10-11T13:57:18.927Z","kind":"event","type":"runner_call_usage","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":440,"usage":{"inputTokens":1046,"outputTokens":62,"cacheReadTokens":41728,"cacheCreateTokens":0,"reasoningTokens":0},"semantics":"delta"}}
{"ts":"2026-10-11T13:57:18.936Z","kind":"event","type":"steerable_call","phase":"implementing","data":{}}
{"ts":"2026-10-11T13:57:19.008Z","kind":"event","type":"runner_call_completed","taskId":"T002","phase":"implementing","data":{"callId":"implementer-3","role":"implementer","backendKind":"cli","runnerName":"opencode","model":"opencode-go/deepseek-v4.1-flash","axes":["high"],"attempt":0,"invocationIdentity":{"version":1,"capturedAt":1791727024337,"runner":{"kind":"cli","id":"opencode"},"billing":{"posture":"unknown","basis":"unknown"}},"usageBoundary":"aggregate","sequence":442,"status":"completed","error":null,"partial":false,"startedAt":1791727024337,"endedAt":1791727039008,"durationMs":14671,"usage":{"inputTokens":6869,"outputTokens":1105,"cacheReadTokens":118912,"cacheCreateTokens":0,"reasoningTokens":13},"nativeSessionId":"ses_ed4bf433bffe6j7ebzmv48B3vx"}}
{"ts":"2026-10-11T13:57:19.106Z","kind":"event","type":"implementer_generate_done","taskId":"T002","phase":"implementing","data":{"file":"src/preview.js","duration":15018}}
{"ts":"2026-10-11T13:57:19.136Z","kind":"event","type":"cost_update","phase":"implementing","data":{"tokenUsage":{"plannerInput":4,"plannerOutput":3222,"implementerInput":47020,"implementerOutput":1967,"escalationInput":0,"escalationOutput":0,"reviewerInput":0,"reviewerOutput":0,"plannerCacheRead":39876,"plannerCacheCreate":43816,"implementerCacheRead":161152,"implementerCacheCreate":0,"implementerReasoning":58,"plannerCoverage":{"input":"reported","output":"partial","cacheRead":"reported","cacheCreate":"reported","reasoning":"missing"}}}}
{"ts":"2026-10-11T13:57:19.316Z","kind":"event","type":"task_completed","taskId":"T002","phase":"implementing","data":{"title":"Add optional suffix to truncate in src/preview.js","method":"local","retries":0,"duration":15385,"tool":"opencode","model":"opencode-go/deepseek-v4.1-flash","implementerProfile":"default"}}
`;

const spentB2ReplayEvents = SPENT_B2_REPLAY_LOG.trim()
  .split('\n')
  .map((line) => {
    const event = engineEventFromLogEntry(SessionLogEventEntrySchema.parse(JSON.parse(line)));
    if (event === null) throw new Error('Invalid recorded spent-b2 event');
    return event;
  });

const spentB2ReplayProjection: WorkflowFixtureProjection = {
  ...balanceSeatSwitchProjection,
  scenarioId: scenarioId('workflow-spent-b2-replay'),
  feature: 'Word counts and marked previews',
  events: spentB2ReplayEvents,
  config: {
    planner: { kind: 'cli', tool: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
    implementer: BALANCE_SWITCH_RUNNER,
    reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  },
  atRest: {
    record: makeRunRecord({
      ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: 'visual-spent-b2-replay' },
      feature: 'Word counts and marked previews',
      startedAt: '2026-10-11T13:56:40.377Z',
      hydration: {
        kind: 'loaded',
        state: makeImplState(
          [
            makeTask({
              id: 'T001',
              title: 'Add wordCount to src/text.js',
              action: 'modify',
              suggestedFiles: ['src/text.js', 'test/text.test.js'],
              status: 'done',
            }),
            makeTask({
              id: 'T002',
              title: 'Add optional suffix to truncate in src/preview.js',
              action: 'modify',
              suggestedFiles: ['src/preview.js', 'test/preview.test.js'],
              status: 'done',
            }),
          ],
          {
            feature: 'Word counts and marked previews',
            startedAt: '2026-10-11T13:56:40.377Z',
            currentTaskIndex: 2,
            interruptedStep: {
              step: { kind: 'review', cycle: 0 },
              source: 'user',
              cut: 'boundary',
              at: '2026-10-11T13:57:19.316Z',
            },
            plannerTool: 'claude-code',
            plannerModel: 'claude-opus-5-5',
            implementerTool: 'opencode',
            implementerModel: 'opencode-go/deepseek-v4.1-flash',
            reviewerTool: 'codex',
            reviewerModel: 'gpt-6.1-sol',
          },
        ),
      },
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
        resumeAt: { kind: 'review', cycle: 0 },
      },
    }),
    log: spentB2ReplayEvents,
  },
};

/**
 * A plan seat that ran out on Codex and was moved onto Claude Code, the planner this fixture's
 * config names — so the header, which reads the seat of record, shows the seat after the swap.
 */
const planSeatSwappedProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_PLAN_SWAPPED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  get events(): EngineEvent[] {
    const issue = planSwappedRecoveryIssue();
    const halt = { phase: issue.phase, issue, action: 'switch-seat' } as const;
    return [
      { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
      ...publishedEvents(FIXED_TS + 100, (bus) => {
        publishError({ bus, phase: issue.phase, message: issue.message, resetAt: issue.resetAt });
        publishRecoveryPrompted({ bus, phase: issue.phase }, VISUAL_WORKFLOW_SESSION_ID, issue);
        publishRecoveryActionSelected({ bus, ...halt });
        publishRecoveryResolved({ bus, ...halt, outcome: 'continued' });
      }),
      {
        type: 'planner_status',
        ts: FIXED_TS + 500,
        phase: 'planning',
        status: 'running',
        tool: 'claude-code',
        model: 'claude-sonnet-4',
      },
    ];
  },
};

/** The seat the defect was seen on: Claude Code's Opus alias at max effort, planning. */
const CLAUDE_PLAN_SEAT = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'opus',
  effort: 'max',
} as const;

/** One call of the Claude runner, named as it names itself: by its command, with the alias it ran. */
function claudePlanActivity(
  sequence: number,
  activity: Pick<EngineEventOf<'runner_call_activity'>, 'stage' | 'kind' | 'label'> & {
    readonly target?: string;
  },
): EngineEvent {
  return {
    type: 'runner_call_activity',
    ts: FIXED_TS + 100 + sequence * 10,
    phase: 'planning',
    callId: 'visual-claude-call',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'claude',
    model: CLAUDE_PLAN_SEAT.model,
    axes: seatAxisWords(CLAUDE_PLAN_SEAT),
    sequence,
    activityId: `visual-claude-call:${sequence}`,
    redacted: false,
    ...activity,
  };
}

/**
 * The planner's activity batch beside the rail and the sidebar that name the same seat, so the
 * three are read on one frame. The warning is there because a batch that carries one is the
 * widest header the transcript paints.
 */
const planActivityProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PLAN_ACTIVITY_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { planner: CLAUDE_PLAN_SEAT },
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    {
      type: 'planner_status',
      ts: FIXED_TS + 50,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'opus',
      call: 'plan',
    },
    claudePlanActivity(1, {
      stage: 'completed',
      kind: 'read',
      label: 'reading CLAUDE.md',
      target: 'CLAUDE.md',
    }),
    claudePlanActivity(2, {
      stage: 'completed',
      kind: 'search',
      label: 'searching formatSeatIdentity',
      target: 'formatSeatIdentity',
    }),
    claudePlanActivity(3, {
      stage: 'warning',
      kind: 'warning',
      label: 'warning stderr: hook output truncated',
    }),
    claudePlanActivity(4, {
      stage: 'completed',
      kind: 'read',
      label: 'reading src/core/crew/identity.ts',
      target: 'src/core/crew/identity.ts',
    }),
  ],
};

/** One call of a Claude Code build seat: a direct writer that narrates between its tool calls. */
const CLAUDE_BUILD_CALL = {
  phase: 'implementing',
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  callId: 'visual-claude-build',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'claude-code',
  model: CLAUDE_PLAN_SEAT.model,
  axes: seatAxisWords(CLAUDE_PLAN_SEAT),
  attempt: 0,
} as const;

const implementationExtractedCodeProjection: WorkflowFixtureProjection = {
  ...implementationProjection,
  scenarioId: scenarioId('workflow-implementation-extracted-code'),
  sidebarVisible: false,
  events: [
    ...implementationProjection.events.slice(0, 3),
    ...JSON.stringify(
      {
        version: 'file-bundle-v1',
        files: [
          {
            path: WORKFLOW_FIXTURE_REVIEW_FILE,
            content: '# Load config\n__init__(*args)\n<!-- keep -->\n`code`\n- x\n1. value',
          },
        ],
      },
      null,
      2,
    )
      .split('\n')
      .map(
        (line, index): EngineEvent => ({
          type: 'planner_text',
          ts: FIXED_TS + 200 + index,
          phase: 'implementing',
          role: 'implementer',
          content: 'plain',
          text: `${line}\n`,
        }),
      ),
  ],
};

/** Build narration as a real Claude Code call streamed it: each message on its own rows, once. */
const implementationNarrationProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IMPLEMENTATION_NARRATION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { implementer: CLAUDE_PLAN_SEAT },
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
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
      tool: 'claude-code',
      model: CLAUDE_PLAN_SEAT.model,
      axes: seatAxisWords(CLAUDE_PLAN_SEAT),
    },
    {
      type: 'implementer_generate_running',
      ts: FIXED_TS + 150,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
    },
    { type: 'runner_call_started', ts: FIXED_TS + 160, ...CLAUDE_BUILD_CALL, sequence: 0 },
    {
      type: 'planner_text',
      ts: FIXED_TS + 200,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: "Using the brief's steps directly. I start with orientation: the fixture size, the two comment sites, and the git state.",
    },
    {
      type: 'runner_call_activity',
      ts: FIXED_TS + 300,
      ...CLAUDE_BUILD_CALL,
      sequence: 1,
      activityId: 'visual-claude-build:1',
      stage: 'completed',
      kind: 'read',
      label: `reading ${WORKFLOW_FIXTURE_SECOND_FILE}`,
      target: WORKFLOW_FIXTURE_SECOND_FILE,
      redacted: false,
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 400,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: 'I check the `fixture` in [src/registry.ts](file:///tmp/src/registry.ts) before I edit it.',
    },
  ],
};

const implementationAdjacentNarrationProjection: WorkflowFixtureProjection = {
  ...implementationNarrationProjection,
  scenarioId: WORKFLOW_IMPLEMENTATION_ADJACENT_NARRATION_ID,
  events: [
    ...implementationNarrationProjection.events.filter(
      (event) => event.type !== 'runner_call_activity' && event.type !== 'planner_text',
    ),
    {
      type: 'planner_text',
      ts: FIXED_TS + 200,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: 'I checked the `fixture` in [src/fixture.ts](file:///Users/x',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 220,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: '/.local/state/splitbrief/trees/42',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 240,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: '/run/src/fixture.ts).',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 400,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      messageStart: true,
      text: 'The gallery has an uncommitted change.',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 500,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      messageStart: true,
      text: 'I run the two brief checks now.',
    },
  ],
};

/** In a real run, the build seat fenced its hand-back report in a json code block. */
const implementationFencedHandBackProjection: WorkflowFixtureProjection = {
  ...implementationNarrationProjection,
  scenarioId: WORKFLOW_IMPLEMENTATION_FENCED_HANDBACK_ID,
  events: [
    ...implementationNarrationProjection.events.slice(0, -1),
    {
      type: 'planner_text',
      ts: FIXED_TS + 400,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: 'Both sites read the `fixture` in [src/row.ts](file:///tmp/src/row.ts).',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 410,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: [
        '\n',
        '```json',
        '{"status":"done","filesChanged":["src/row.ts"],"touchedNotSuggested":[],"notes":null}',
        '```',
      ].join('\n'),
    },
  ],
};

const CONTINUOUS_BRIEFS = [
  { id: taskId('T001'), title: 'Report replenishment needs', index: 0, file: 'src/report.js' },
  { id: taskId('T002'), title: 'Receive stock deliveries', index: 1, file: 'src/orders.js' },
  {
    id: taskId('T003'),
    title: 'Test the receiving flow',
    index: 2,
    file: 'test/receiving.test.js',
  },
] as const;

const continuousTranscriptProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-continuous-transcript'),
  feature: 'Restock planning and receiving',
  inputMode: 'normal',
  sidebarVisible: true,
  config: { implementer: CLAUDE_PLAN_SEAT },
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'planning',
      feature: 'Restock planning and receiving',
    },
    {
      type: 'user_message',
      ts: FIXED_TS + 10,
      phase: 'planning',
      text: 'Add restock planning and receiving.',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 20,
      phase: 'planning',
      content: 'markdown',
      text: 'Keep stock changes atomic and test missing catalog entries.',
    },
    { type: 'plan_approved', ts: FIXED_TS + 50, phase: 'reviewing-plan' },
    {
      type: 'tasks_planned',
      ts: FIXED_TS + 60,
      phase: 'implementing',
      total: 3,
      tasks: CONTINUOUS_BRIEFS.map((brief) => ({ ...brief, action: 'modify' })),
    },
    {
      ...orphanBriefStarted(CONTINUOUS_BRIEFS[0], FIXED_TS + 100),
      tool: 'claude-code',
      model: CLAUDE_PLAN_SEAT.model,
      axes: ['max'],
    },
    {
      type: 'implementer_generate_running',
      ts: FIXED_TS + 110,
      phase: 'implementing',
      taskId: taskId('T001'),
      file: 'src/report.js',
    },
    ...['README.md', 'src/items.js', 'src/report.js', 'test/report.test.js', 'src/stock.js'].map(
      (target, index): EngineEvent => ({
        type: 'runner_call_activity',
        ts: FIXED_TS + 120 + index,
        ...CLAUDE_BUILD_CALL,
        taskId: taskId('T001'),
        callId: 'visual-continuous-build-1',
        sequence: index + 1,
        activityId: `visual-continuous-build-1:${index + 1}`,
        stage: 'completed',
        kind: 'read',
        label: `reading ${target}`,
        target,
        redacted: false,
      }),
    ),
    ...[
      'Implemented `lowStockItems` and `restockPlan` in',
      ' [src/report.js](file:///Users/x',
      '/.local/state/splitbrief/trees/42',
      '/run/src/report.js)',
      ' and added tests.\n',
      '\n{"status":"done","filesChanged":["src/report.js","test/report.test.js"],"touchedNotSuggested":[],"notes":null,"decisions":[]}\n',
    ].map(
      (text, index): EngineEvent => ({
        type: 'planner_text',
        ts: FIXED_TS + 200 + index,
        phase: 'implementing',
        role: 'implementer',
        content: 'markdown',
        text,
      }),
    ),
    {
      type: 'validate',
      ts: FIXED_TS + 300,
      phase: 'validating-task',
      taskId: taskId('T001'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
      duration: 1_800,
    },
    {
      type: 'checks_run',
      ts: FIXED_TS + 310,
      phase: 'validating-task',
      taskId: taskId('T001'),
      results: [{ id: 'C1', status: 'pass' }],
    },
    {
      type: 'full_suite',
      ts: FIXED_TS + 315,
      phase: 'implementing',
      moment: 'brief',
      id: 'V1',
      command: 'npm test',
      status: 'done',
      passed: true,
      duration: 1_000,
    },
    {
      type: 'warning',
      ts: FIXED_TS + 320,
      phase: 'implementing',
      message: 'Keep the stock warning in the completed brief.',
    },
    {
      type: 'implementer_generate_done',
      ts: FIXED_TS + 330,
      phase: 'implementing',
      taskId: taskId('T001'),
      file: 'src/report.js',
      files: ['src/report.js', 'test/report.test.js'],
      duration: 3_000,
      diff: '@@ -1 +1 @@\n-export const report = [];\n+export const lowStockItems = [];',
      linesAdded: 1,
      linesRemoved: 1,
    },
    {
      ...fixtureBriefPassed(CONTINUOUS_BRIEFS[0], FIXED_TS + 400),
      tool: 'claude-code',
      model: CLAUDE_PLAN_SEAT.model,
    },
    {
      ...orphanBriefStarted(CONTINUOUS_BRIEFS[1], FIXED_TS + 500),
      tool: 'claude-code',
      model: CLAUDE_PLAN_SEAT.model,
      axes: ['max'],
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 520,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: 'Added atomic delivery receipts.',
    },
    {
      ...fixtureBriefPassed(CONTINUOUS_BRIEFS[1], FIXED_TS + 600),
      tool: 'claude-code',
      model: CLAUDE_PLAN_SEAT.model,
    },
    {
      ...orphanBriefStarted(CONTINUOUS_BRIEFS[2], FIXED_TS + 700),
      tool: 'claude-code',
      model: CLAUDE_PLAN_SEAT.model,
      axes: ['max'],
    },
    {
      type: 'implementer_generate_running',
      ts: FIXED_TS + 710,
      phase: 'implementing',
      taskId: taskId('T003'),
      file: 'test/receiving.test.js',
    },
    {
      type: 'runner_call_started',
      ts: FIXED_TS + 715,
      ...CLAUDE_BUILD_CALL,
      taskId: taskId('T003'),
      callId: 'visual-continuous-build-3',
      sequence: 0,
    },
    {
      type: 'runner_call_activity',
      ts: FIXED_TS + 720,
      ...CLAUDE_BUILD_CALL,
      taskId: taskId('T003'),
      callId: 'visual-continuous-build-3',
      sequence: 1,
      activityId: 'visual-continuous-build-3:1',
      stage: 'started',
      kind: 'command',
      label: 'running npm test',
      target: 'npm test',
      redacted: false,
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 730,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: 'Checking `receiveDelivery` before the receiving flow tests.',
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
  events: [
    ...STOPPED_RUN_EVENTS,
    {
      type: 'turn_interrupted',
      ts: FIXED_TS + 101,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: WORKFLOW_FIXTURE_TASK_ID, attempt: 0 },
    },
  ],
  stop: {
    intent: 'stop-now',
    phase: 'parked',
    parked: {
      kind: 'mid-brief',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      kept: [WORKFLOW_FIXTURE_REVIEW_FILE],
    },
  },
};

const RESUMED_REPORT_TEXT = JSON.stringify({
  status: 'done',
  filesChanged: [WORKFLOW_FIXTURE_REVIEW_FILE, WORKFLOW_FIXTURE_SECOND_FILE],
  touchedNotSuggested: [],
  notes: null,
  decisions: [],
});

/**
 * A stop cut the brief after it wrote both its files; the continued call found that work complete
 * and changed nothing more, after the implementer's own report counted the two files.
 */
const resumedKeptWorkProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RESUMED_KEPT_WORK_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    ...STOPPED_RUN_EVENTS,
    {
      type: 'turn_interrupted',
      ts: FIXED_TS + 101,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: WORKFLOW_FIXTURE_TASK_ID, attempt: 0 },
    },
    { type: 'workflow_resumed', ts: FIXED_TS + 30_000, phase: 'implementing' },
    {
      type: 'planner_text',
      ts: FIXED_TS + 30_400,
      phase: 'implementing',
      role: 'implementer',
      text: RESUMED_REPORT_TEXT,
    },
    {
      type: 'implementer_generate_done',
      ts: FIXED_TS + 30_500,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      files: [],
      duration: 1_200,
      noChange: true,
      kept: [WORKFLOW_FIXTURE_REVIEW_FILE, WORKFLOW_FIXTURE_SECOND_FILE],
    },
  ],
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
    {
      type: 'turn_interrupted',
      ts: FIXED_TS + 601,
      phase: 'implementing',
      source: 'user',
      at: 'boundary',
      step: { kind: 'brief', taskId: WORKFLOW_FIXTURE_TASK_ID_2, attempt: 0 },
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

function claudeSystemFrame(subtype: string, fields: Record<string, unknown> = {}) {
  return { type: 'system', subtype, ...fields };
}

function claudeRetryFrame(attempt: number, delayMs: number) {
  return claudeSystemFrame('api_retry', {
    attempt,
    max_retries: 10,
    retry_delay_ms: delayMs,
    error_status: 529,
    error: 'overloaded',
  });
}

function claudeMessageFrames(text: string, toolUse?: Record<string, unknown>) {
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { content: [] } } },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text }, ...(toolUse === undefined ? [] : [toolUse])] },
    },
  ];
}

// A whole Claude Code plan call as the CLI prints it: session hooks, init, status and
// thinking-token estimates around a read, a retry of the next request and the fallback model that
// answered it, the closing message and the terminal result.
const CLAUDE_PLAN_FRAMES = [
  claudeSystemFrame('hook_started', { hook_id: 'hook-1', hook_name: 'SessionStart:startup' }),
  claudeSystemFrame('hook_response', { hook_id: 'hook-1', outcome: 'success', exit_code: 0 }),
  claudeSystemFrame('init', { model: 'claude-sonnet-4' }),
  claudeSystemFrame('status', { status: 'requesting' }),
  claudeSystemFrame('thinking_tokens', { estimated_tokens: 40, estimated_tokens_delta: 40 }),
  ...claudeMessageFrames(WORKFLOW_FIXTURE_TEXT.planningNarration, {
    type: 'tool_use',
    id: 'read-parser',
    name: 'Read',
    input: { file_path: WORKFLOW_FIXTURE_TEXT.planningRead },
  }),
  claudeSystemFrame('status', { status: 'requesting' }),
  claudeRetryFrame(2, 4000),
  claudeSystemFrame('model_fallback', {
    trigger: 'overloaded',
    original_model: 'claude-sonnet-4',
    fallback_model: 'claude-haiku-4-5',
    content: 'Sonnet 4 is overloaded · using Haiku 4.5 for this turn',
  }),
  claudeSystemFrame('thinking_tokens', { estimated_tokens: 80, estimated_tokens_delta: 40 }),
  ...claudeMessageFrames(WORKFLOW_FIXTURE_TEXT.planningReply),
  claudeSystemFrame('task_notification', { task_id: 'task-1', status: 'completed', summary: '' }),
  { type: 'result', result: WORKFLOW_FIXTURE_TEXT.planningReply },
];

// The frames run through the production stream handler and event projection, so the transcript
// shows what the engine makes of them. Only narration and activity paint rows; the rest are dropped.
function claudePlanFrameEvents(): EngineEvent[] {
  const events: EngineEvent[] = [];
  const stamp = (): number => FIXED_TS + 300 + events.length;
  const adapter = claudeCodePlannerAdapter;
  const parse = adapter.createParser?.() ?? adapter.parse;
  const forwardText = createCliTextForwarder((text, opts) => {
    events.push({
      type: 'planner_text',
      ts: stamp(),
      phase: 'planning',
      text,
      content: 'markdown',
      ...(opts?.messageStart === true && { messageStart: true }),
    });
  });
  const recorder = createRunnerCallRecorder({
    context: {
      callId: 'visual-claude-plan-001',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'claude',
      model: BASE_PLANNER.model,
      axes: seatAxisWords(BASE_PLANNER),
      attempt: 1,
    },
    onEvent: (event) => {
      events.push(
        ...projectRunnerCallEvents(
          { ...event, ts: stamp() },
          { rootDir: VISUAL_FIXTURE_PROJECT_DIR, phase: 'planning', sequence: events.length },
        ),
      );
      if (event.type === 'call_text_delta') forwardText(event);
    },
  });
  for (const frame of CLAUDE_PLAN_FRAMES) {
    for (const event of parse(JSON.stringify({ session_id: 'visual-claude-session', ...frame }))) {
      recordCliProtocolEvent(recorder, event);
    }
  }
  return events.filter(
    (event) => event.type === 'planner_text' || event.type === 'runner_call_activity',
  );
}

const planningClaudeFramesProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PLANNING_CLAUDE_FRAMES_ID,
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
      model: 'claude-sonnet-4',
      call: 'plan',
    },
    ...claudePlanFrameEvents(),
  ],
};

/** A codex planning call's context, as the CLI planner stamps it on every call event. */
function codexPlanCall(callId: string, attempt: number) {
  return {
    callId,
    role: 'planner',
    backendKind: 'cli',
    runnerName: CODEX_PLAN_SEAT.tool,
    model: CODEX_PLAN_SEAT.model,
    axes: seatAxisWords(CODEX_PLAN_SEAT),
    attempt,
  } as const;
}

/** Call events as the workflow bus receives them: the typed event dropped, its activity kept. */
function planningCallActivity(ts: number, events: readonly RunnerCallEvent[]): EngineEvent[] {
  return events
    .flatMap((event, index) =>
      projectRunnerCallEvents(
        { ...event, ts: ts + index },
        { rootDir: VISUAL_FIXTURE_PROJECT_DIR, phase: 'planning', sequence: index },
      ),
    )
    .filter((event) => event.type === 'runner_call_activity');
}

/**
 * A resumed run whose codex thread is gone, in the events a real run records: the resume fails in
 * the tool's own words, the run says once that it asks again, and a fresh thread answers. No
 * recovery menu opens.
 */
const plannerSessionExpiredProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_PLANNER_SESSION_EXPIRED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  config: CODEX_PLAN_CREW,
  get events(): EngineEvent[] {
    const expired = codexPlanCall('visual-codex-expired', 1);
    return [
      { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
      {
        type: 'planner_status',
        ts: FIXED_TS + 50,
        phase: 'planning',
        status: 'running',
        tool: CODEX_PLAN_SEAT.tool,
        model: CODEX_PLAN_SEAT.model,
        call: 'plan',
      },
      ...planningCallActivity(FIXED_TS + 100, [
        {
          type: 'call_warning',
          ts: FIXED_TS + 100,
          ...expired,
          warning: {
            code: 'stderr_diagnostic',
            severity: 'warning',
            source: 'stderr',
            surface: 'status',
            channel: 'stderr',
            fingerprint: 'rw:visual-codex-expired',
            message:
              'Error: thread/resume: thread/resume failed: no rollout found for thread id 019a8c3e (code -32600)',
          },
        },
        {
          type: 'call_error',
          ts: FIXED_TS + 101,
          ...expired,
          status: 'failed',
          error: { code: 'non-zero-exit', message: 'CLI exited with code 1' },
          partial: true,
          startedAt: FIXED_TS + 90,
          endedAt: FIXED_TS + 101,
          durationMs: 11,
          usage: null,
          nativeSessionId: null,
        },
      ]),
      ...publishedEvents(FIXED_TS + 200, (bus) =>
        publishWarning({
          bus,
          phase: 'planning',
          message:
            'Planner session expired; the call runs again on a fresh session with the conversation so far.',
          safety: { category: 'planner', code: 'planner_session_expired' },
        }),
      ),
      ...planningCallActivity(FIXED_TS + 300, [
        {
          type: 'call_session_id',
          ts: FIXED_TS + 300,
          ...codexPlanCall('visual-codex-fresh', 2),
          nativeSessionId: '019a8c41',
        },
      ]),
      {
        type: 'planner_text',
        ts: FIXED_TS + 400,
        phase: 'planning',
        text: 'Reading the export module before the plan names its files.',
        content: 'markdown',
      },
    ];
  },
};

// A CLI seat gone quiet mid-brief. OpenCode reports a tool only once the tool lands, so the idle
// watchdog warns at its default and the call runs on. The build block's freshness line is the one
// place that silence is counted; beside it the byline says only that the seat is still working.
const OPENCODE_BUILD_SEAT = {
  kind: 'cli',
  tool: 'opencode',
  model: 'openai/gpt-5.6-luna',
} as const;
const SILENT_CALL = {
  phase: 'implementing',
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  callId: FIXED_CALL_ID,
  role: 'implementer',
  backendKind: 'cli',
  runnerName: OPENCODE_BUILD_SEAT.tool,
  model: OPENCODE_BUILD_SEAT.model,
  axes: seatAxisWords(OPENCODE_BUILD_SEAT),
  attempt: 1,
} as const;
const SILENT_CALL_WARNED_TS = FIXED_TS - 10_000;

const implementationSilentProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-implementation-silent'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { implementer: OPENCODE_BUILD_SEAT },
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS - 420_000,
      phase: 'implementing',
      feature: WORKFLOW_FEATURE,
    },
    { ...FIXTURE_TASKS_PLANNED, ts: FIXED_TS - 410_000 },
    {
      type: 'task_started',
      ts: FIXED_TS - 400_000,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID,
      title: WORKFLOW_FIXTURE_TEXT.implementationTask,
      index: 0,
      total: 3,
      file: WORKFLOW_FIXTURE_REVIEW_FILE,
      action: 'modify',
      tool: OPENCODE_BUILD_SEAT.tool,
      model: OPENCODE_BUILD_SEAT.model,
    },
    {
      type: 'runner_call_started',
      ts: SILENT_CALL_WARNED_TS - RUNNER_IDLE_WARN_MS,
      ...SILENT_CALL,
      sequence: 0,
    },
    {
      type: 'runner_call_stalled',
      ts: SILENT_CALL_WARNED_TS,
      ...SILENT_CALL,
      sequence: 1,
      silentMs: RUNNER_IDLE_WARN_MS,
    },
  ],
};

// The same quiet seat, but the stream opened a tool and has not closed it: the test run inside the
// worktree is what the seat is doing, and the build block names it with how long it has run.
const implementationToolRunningProjection: WorkflowFixtureProjection = {
  ...implementationSilentProjection,
  scenarioId: scenarioId('workflow-implementation-tool-running'),
  events: implementationSilentProjection.events.flatMap((event): EngineEvent[] =>
    event.type === 'runner_call_started'
      ? [
          event,
          {
            type: 'runner_call_activity',
            ts: event.ts + 1_000,
            ...SILENT_CALL,
            sequence: 1,
            activityId: `${FIXED_CALL_ID}:tool:bash-1`,
            stage: 'updated',
            kind: 'command',
            label: 'bash',
            target: 'npx vitest run src/features/workflow',
            redacted: false,
          },
        ]
      : [event],
  ),
};

// The same silence on a seat whose stream reports each tool as it starts: nothing is open and no
// hint applies, so the build block states the silence alone.
const CODEX_BUILD_SEAT = { kind: 'cli', tool: 'codex', model: 'gpt-6-astra' } as const;
const implementationSilentBareProjection: WorkflowFixtureProjection = {
  ...implementationSilentProjection,
  scenarioId: scenarioId('workflow-implementation-silent-bare'),
  config: { implementer: CODEX_BUILD_SEAT },
  events: implementationSilentProjection.events.map((event): EngineEvent => {
    if (event.type === 'task_started') {
      return { ...event, tool: CODEX_BUILD_SEAT.tool, model: CODEX_BUILD_SEAT.model };
    }
    if (event.type === 'runner_call_started' || event.type === 'runner_call_stalled') {
      return {
        ...event,
        runnerName: CODEX_BUILD_SEAT.tool,
        model: CODEX_BUILD_SEAT.model,
        axes: seatAxisWords(CODEX_BUILD_SEAT),
      };
    }
    return event;
  }),
};

const implementationShellWrapperProjection: WorkflowFixtureProjection = {
  ...implementationSilentBareProjection,
  scenarioId: scenarioId('workflow-implementation-shell-wrapper'),
  events: implementationSilentBareProjection.events.flatMap((event): EngineEvent[] => {
    if (event.type === 'tasks_planned') {
      return [{ ...event, tasks: event.tasks.slice(0, 1), total: 1 }];
    }
    if (event.type === 'task_started') return [{ ...event, total: 1 }];
    return event.type === 'runner_call_started'
      ? [
          event,
          ...[
            `/bin/zsh -lc "sed -n '1,120p' src/loans/renewals.ts"`,
            `/bin/zsh -lc "rg --files --hidden -g '"'!node_modules'"' -g '"'!.git'"' -g '"'!package-lock.json'"' -g '"'!yarn.lock'"' -g '"'!pnpm-lock.yaml'"'"`,
            `/bin/bash -lc 'echo '"'"'renewal window'"'"''`,
            `bash -lc 'echo unfinished`,
            String.raw`bash -lc $'echo hi\nls'`,
            String.raw`/bin/zsh -lc "rg -n \"overdue\" src/loans"`,
          ].map(
            (target, index): EngineEvent => ({
              ...event,
              type: 'runner_call_activity',
              ts: event.ts + (index + 1) * 1_000,
              sequence: index + 1,
              activityId: `${event.callId}:command:${index + 1}`,
              stage: index === 5 ? 'updated' : 'completed',
              kind: 'command',
              label: 'running ' + target,
              target,
              redacted: false,
            }),
          ),
        ]
      : [event];
  }),
};

// Every brief passed, and the pre-review full suite is ten minutes into `npm test`. No seat is on a
// call: the suite is the whole of what the run is doing.
const PRE_REVIEW_TEST_STARTED_TS = FIXED_TS + 42_000 - 602_000;
const LAST_BRIEF_PASSED_TS = PRE_REVIEW_TEST_STARTED_TS - 240_000;
const LAST_BRIEF_CALL = {
  phase: 'implementing',
  taskId: WORKFLOW_FIXTURE_TASK_ID_3,
  callId: 'visual-full-suite-last-build',
  role: 'implementer',
  backendKind: 'api',
  runnerName: FIXED_RUNNER_NAME,
  model: FIXED_RUNNER_MODEL,
  axes: seatAxisWords(BASE_IMPLEMENTER),
  attempt: 1,
} as const;

const reviewCheckRunningProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-check-running'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    {
      type: 'workflow_started',
      ts: PRE_REVIEW_TEST_STARTED_TS - 900_000,
      phase: 'implementing',
      feature: WORKFLOW_FEATURE,
    },
    { ...FIXTURE_TASKS_PLANNED, ts: PRE_REVIEW_TEST_STARTED_TS - 890_000 },
    ...FIXTURE_TASKS_PLANNED.tasks
      .slice(0, 2)
      .flatMap((brief, index) => [
        orphanBriefStarted(brief, PRE_REVIEW_TEST_STARTED_TS - 720_000 + 180_000 * index),
        fixtureBriefPassed(brief, PRE_REVIEW_TEST_STARTED_TS - 600_000 + 180_000 * index),
      ]),
    ...FIXTURE_TASKS_PLANNED.tasks
      .slice(2)
      .map((brief) => orphanBriefStarted(brief, LAST_BRIEF_PASSED_TS - 120_000)),
    {
      type: 'runner_call_started',
      ts: LAST_BRIEF_PASSED_TS - 115_000,
      ...LAST_BRIEF_CALL,
      sequence: 0,
    },
    {
      type: 'runner_call_completed',
      ts: LAST_BRIEF_PASSED_TS - 5_000,
      ...LAST_BRIEF_CALL,
      sequence: 1,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: LAST_BRIEF_PASSED_TS - 115_000,
      endedAt: LAST_BRIEF_PASSED_TS - 5_000,
      durationMs: 110_000,
      usage: null,
      nativeSessionId: null,
    },
    fixtureBriefPassed(FIXTURE_PLANNED_BRIEFS[2], LAST_BRIEF_PASSED_TS),
    finalReviewStarted(PRE_REVIEW_TEST_STARTED_TS - 30_000, BASE_PLANNER),
    reviewChecksPlanned(PRE_REVIEW_TEST_STARTED_TS - 30_000),
    reviewCheck(PRE_REVIEW_TEST_STARTED_TS - 20_000, REVIEW_CHECK_TYPECHECK, {
      status: 'done',
      passed: true,
      duration: 18_000,
    }),
    reviewCheck(PRE_REVIEW_TEST_STARTED_TS, REVIEW_CHECK_TEST, { status: 'running' }),
  ],
};

const reviewRenderRunningProjection: WorkflowFixtureProjection = {
  ...reviewCheckRunningProjection,
  scenarioId: scenarioId('workflow-review-render-running'),
  events: [
    ...reviewCheckRunningProjection.events.filter(
      (event) => event.type !== 'review_checks' && event.type !== 'full_suite',
    ),
    {
      type: 'full_suite',
      ts: FIXED_TS + 14_300,
      phase: 'final-review',
      moment: 'plan',
      id: 'R1',
      scenario: 'workflow-plan-compiled',
      command: 'npm run tui-shots -- --scenario workflow-plan-compiled --output /tmp/render-r1',
      status: 'done',
      passed: true,
      duration: 14_200,
    },
    {
      type: 'full_suite',
      ts: FIXED_TS + 25_500,
      phase: 'final-review',
      moment: 'plan',
      id: 'R2',
      scenario: 'workflow-implementation',
      command: 'npm run tui-shots -- --scenario workflow-implementation --output /tmp/render-r2',
      status: 'done',
      passed: false,
      duration: 11_000,
    },
    {
      type: 'full_suite',
      ts: FIXED_TS + 30_000,
      phase: 'final-review',
      moment: 'plan',
      id: 'R3',
      scenario: 'workflow-review',
      command: 'npm run tui-shots -- --scenario workflow-review --output /tmp/render-r3',
      status: 'running',
    },
  ],
};

// `validation.approve_checks: ask`: the reviewer chose two commands and the card waits for Run all
// or Skip all before either runs.
const reviewChecksApproveProjection: WorkflowFixtureProjection = {
  ...reviewCheckRunningProjection,
  scenarioId: scenarioId('workflow-review-checks-approve'),
  events: reviewCheckRunningProjection.events.filter((event) => event.type !== 'full_suite'),
  reviewChecksPrompt: {
    scope: 'final',
    commands: [{ ...REVIEW_CHECK_TYPECHECK }, { ...REVIEW_CHECK_TEST }],
  },
};

const reviewPauseRequestedProjection: WorkflowFixtureProjection = {
  ...reviewCheckRunningProjection,
  scenarioId: scenarioId('workflow-review-pause-requested'),
  stop: { intent: 'pause-after-brief', phase: 'requested' },
};

const reviewCorrectedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-corrected'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    { type: 'plan_approved', ts: FIXED_TS + 50, phase: 'reviewing-plan' },
    { ...FIXTURE_TASKS_PLANNED, ts: FIXED_TS + 60 },
    orphanBriefStarted(FIXTURE_PLANNED_BRIEFS[0], FIXED_TS + 100),
    fixtureBriefPassed(FIXTURE_PLANNED_BRIEFS[0], FIXED_TS + 200),
    {
      type: 'warning',
      ts: FIXED_TS + 300,
      phase: 'implementing',
      message: 'pre_task blocked: already covered',
    },
    {
      type: 'task_skipped',
      ts: FIXED_TS + 300,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_TASK_ID_2,
      title: FIXTURE_PLANNED_BRIEFS[1].title,
      reason: 'already covered',
    },
    orphanBriefStarted(FIXTURE_PLANNED_BRIEFS[2], FIXED_TS + 400),
    fixtureBriefPassed(FIXTURE_PLANNED_BRIEFS[2], FIXED_TS + 500),
    finalReviewStarted(FIXED_TS + 1_000, BASE_PLANNER),
    finalReviewCompleted({
      ts: FIXED_TS + 8_000,
      duration: 7_000,
      verdict: 'fail',
      seat: BASE_PLANNER,
    }),
    { type: 'workflow_complete', ts: FIXED_TS + 8_000, phase: 'final-review', review: 'failed' },
    {
      type: 'user_message',
      ts: FIXED_TS + 9_000,
      phase: 'final-review',
      text: 'The fixture is updated.',
    },
    finalReviewStarted(FIXED_TS + 9_000, BASE_PLANNER),
    finalReviewCompleted({
      ts: FIXED_TS + 14_000,
      duration: 5_000,
      verdict: 'pass',
      seat: BASE_PLANNER,
    }),
    { type: 'workflow_complete', ts: FIXED_TS + 14_000, phase: 'complete', review: 'passed' },
  ],
};

// The user chose Skip all: one row names every command that did not run and why.
const reviewChecksSkippedProjection: WorkflowFixtureProjection = {
  ...reviewCheckRunningProjection,
  scenarioId: scenarioId('workflow-review-checks-skipped'),
  events: [
    ...reviewCheckRunningProjection.events.filter((event) => event.type !== 'full_suite'),
    {
      type: 'review_checks',
      ts: PRE_REVIEW_TEST_STARTED_TS - 25_000,
      phase: 'final-review',
      scope: 'final',
      status: 'skipped',
      commands: [{ ...REVIEW_CHECK_TYPECHECK }, { ...REVIEW_CHECK_TEST }],
      reason: 'Skip all was chosen on the card',
    },
  ],
};

const LONG_REVIEW_CHECK_TEST = {
  id: 'V2',
  command: 'npx vitest run src/features/workflow/display/build-progress.test.ts',
  reason: 'This test file covers the build block the change edits.',
} as const;

// The same check ten minutes in, with a command longer than the byline at 80 columns: the label and
// the clock stay whole and the command alone gives way.
const reviewCheckLongCommandProjection: WorkflowFixtureProjection = {
  ...reviewCheckRunningProjection,
  scenarioId: scenarioId('workflow-review-check-long-command'),
  events: reviewCheckRunningProjection.events.map(
    (event): EngineEvent =>
      event.type === 'full_suite' && event.id === LONG_REVIEW_CHECK_TEST.id
        ? { ...event, command: LONG_REVIEW_CHECK_TEST.command }
        : event.type === 'review_checks' && event.status === 'planned'
          ? {
              ...event,
              commands: (event.commands ?? []).map((command) =>
                command.id === LONG_REVIEW_CHECK_TEST.id ? { ...LONG_REVIEW_CHECK_TEST } : command,
              ),
            }
          : event,
  ),
};

/** One full-suite stage as a session from before reviewer checks wrote it: a stage, no check id. */
function legacySuiteStage(
  ts: number,
  stage: 'typecheck' | 'test',
  command: string,
  result:
    | { status: 'running'; moment?: 'base' }
    | { status: 'done'; moment?: 'base'; passed: boolean; duration: number },
): EngineEvent {
  const { moment = 'pre-review', ...rest } = result;
  return { type: 'full_suite', ts, phase: 'final-review', stage, command, moment, ...rest };
}

// An older session replays its full-suite stages in the words they had: no check id, no plan row.
const reviewLegacySuiteProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-legacy-suite'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    ...everyBriefPassed(),
    legacySuiteStage(FIXED_TS + 1_000, 'typecheck', 'npx tsc --noEmit', {
      status: 'done',
      passed: true,
      duration: 14_000,
    }),
    legacySuiteStage(FIXED_TS + 1_500, 'test', 'npm test', {
      status: 'done',
      passed: false,
      duration: 21_000,
    }),
    legacySuiteStage(FIXED_TS + 2_000, 'test', 'npm test', { status: 'running', moment: 'base' }),
  ],
};

const RED_GATE_LINT = {
  id: 'V1',
  command: 'npm run lint',
  reason: 'The project lints every source file.',
};
const RED_GATE_TYPECHECK = {
  id: 'V2',
  command: 'npx tsc --noEmit',
  reason: 'The change edits exported types.',
};
const RED_GATE_TEST = {
  id: 'V3',
  command: 'npm test',
  reason: 'The unit tests cover the changed module.',
};

const reviewRedGateProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-red-gate'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { reviewer: CODEX_REVIEW_SEAT },
  get events(): EngineEvent[] {
    return [
      { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
      { ...FIXTURE_TASKS_PLANNED, total: 1, tasks: FIXTURE_TASKS_PLANNED.tasks.slice(0, 1) },
      fixtureBriefPassed(FIXTURE_PLANNED_BRIEFS[0], FIXED_TS + 300),
      finalReviewStarted(FIXED_TS + 390, CODEX_REVIEW_SEAT),
      {
        type: 'review_checks',
        ts: FIXED_TS + 390,
        phase: 'final-review',
        scope: 'final',
        status: 'planned',
        commands: [RED_GATE_LINT, RED_GATE_TYPECHECK, RED_GATE_TEST],
        declined: [],
        reason: null,
      },
      reviewCheck(FIXED_TS + 395, RED_GATE_LINT, {
        status: 'refused',
        detail: 'runs the package script lint, and this run changed package.json',
      }),
      reviewCheck(FIXED_TS + 400, RED_GATE_TYPECHECK, {
        status: 'done',
        passed: false,
        duration: 16_000,
      }),
      reviewCheck(FIXED_TS + 401, RED_GATE_TYPECHECK, {
        status: 'done',
        moment: 'base',
        passed: true,
        duration: 15_000,
      }),
      reviewCheck(FIXED_TS + 402, RED_GATE_TEST, { status: 'not-run', detail: 'V2 failed' }),
      ...finalReviewProjection.events.filter((event) => event.type === 'runner_call_started'),
      ...['Reading the typecheck failure and the pending input'].map(
        (label, index): EngineEvent => ({
          type: 'runner_call_activity',
          ts: FIXED_TS + 560 + index * 10,
          phase: 'final-review',
          callId: 'visual-review-call-001',
          role: 'review',
          backendKind: 'cli',
          runnerName: 'codex',
          model: CODEX_REVIEW_SEAT.model,
          axes: seatAxisWords(CODEX_REVIEW_SEAT),
          attempt: 1,
          sequence: index + 1,
          activityId: `visual-review-call-001:read:${index}`,
          stage: 'completed',
          kind: 'read',
          label,
          redacted: false,
          rawAvailable: false,
        }),
      ),
    ];
  },
};

const BASE_RERUN_TYPECHECK = {
  id: 'V1',
  command: 'npx tsc --noEmit',
  reason: 'The change edits exported types.',
};
const BASE_RERUN_TEST = {
  id: 'V2',
  command: 'npm test -- src/legacy.test.ts',
  reason: 'This test file covers the changed module.',
};

const reviewBaseRerunProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-base-rerun'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    ...everyBriefPassed(),
    finalReviewStarted(FIXED_TS + 900, BASE_PLANNER),
    {
      type: 'review_checks',
      ts: FIXED_TS + 900,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [BASE_RERUN_TYPECHECK, BASE_RERUN_TEST],
      declined: [],
      reason: null,
    },
    reviewCheck(FIXED_TS + 1_000, BASE_RERUN_TYPECHECK, {
      status: 'done',
      passed: false,
      duration: 14_000,
    }),
    reviewCheck(FIXED_TS + 1_200, BASE_RERUN_TYPECHECK, {
      status: 'done',
      moment: 'base',
      passed: false,
      duration: 13_000,
      newFailures: 0,
      preExisting: 3,
      preExistingKeys: [
        'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.',
        'src/legacy.ts(9,3): error TS2554: Expected 2 arguments, but got 1.',
        'src/report.ts(14,5): error TS2339: Property total does not exist on type Ledger.',
      ],
    }),
    reviewCheck(FIXED_TS + 1_500, BASE_RERUN_TEST, {
      status: 'done',
      passed: false,
      duration: 12_000,
    }),
    reviewCheck(FIXED_TS + 2_000, BASE_RERUN_TEST, { status: 'running', moment: 'base' }),
  ],
};

// Q2 review B3: a red with new and pre-existing failures stops the list; its base row says why.
const reviewBaseMixedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-base-mixed'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    ...everyBriefPassed(
      FIXTURE_TASKS_PLANNED.tasks.map((brief, index) => ({
        ...brief,
        id: taskId(`T00${index + 1}`),
      })),
    ),
    finalReviewStarted(FIXED_TS + 900, BASE_PLANNER),
    {
      type: 'review_checks',
      ts: FIXED_TS + 900,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [BASE_RERUN_TYPECHECK, BASE_RERUN_TEST],
      declined: [],
      reason: null,
    },
    reviewCheck(FIXED_TS + 1_000, BASE_RERUN_TYPECHECK, {
      status: 'done',
      passed: false,
      duration: 14_000,
    }),
    reviewCheck(FIXED_TS + 1_200, BASE_RERUN_TYPECHECK, {
      status: 'done',
      moment: 'base',
      passed: false,
      duration: 13_000,
      newFailures: 2,
      preExisting: 1,
      newKeys: [
        'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.',
        'src/b.ts(4,2): error TS2304: Cannot find name total.',
      ],
      preExistingKeys: [
        'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.',
      ],
    }),
    reviewCheck(FIXED_TS + 1_300, BASE_RERUN_TEST, { status: 'not-run', detail: 'V1 failed' }),
  ],
};

// Q2 review B2: the fix brief runs the red V2 again under its own row and clock.
const fixCheckRunningProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-fix-check-running'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  get events(): EngineEvent[] {
    const fixBuild = reviewFixProjection.events
      .slice(everyBriefPassed().length)
      .filter((event) => event.type !== 'review_started' && event.type !== 'review_completed');
    return [
      ...everyBriefPassed(),
      finalReviewStarted(FIXED_TS + 350, BASE_PLANNER),
      reviewChecksPlanned(FIXED_TS + 350),
      reviewCheck(FIXED_TS + 360, REVIEW_CHECK_TYPECHECK, {
        status: 'done',
        passed: true,
        duration: 18_000,
      }),
      reviewCheck(FIXED_TS + 370, REVIEW_CHECK_TEST, {
        status: 'done',
        passed: false,
        duration: 21_000,
      }),
      reviewCheck(FIXED_TS + 380, REVIEW_CHECK_TEST, {
        status: 'done',
        moment: 'base',
        passed: true,
        duration: 20_000,
        newFailures: 1,
        preExisting: 0,
      }),
      finalReviewCompleted({
        ts: FIXED_TS + 400,
        duration: 50,
        verdict: 'fail',
        seat: BASE_PLANNER,
      }),
      ...fixBuild,
      reviewCheck(
        FIXED_TS + 2_000,
        REVIEW_CHECK_TEST,
        { status: 'running', moment: 'brief' },
        'implementing',
      ),
    ];
  },
};

const fixCheckStoppedContinuedProjection: WorkflowFixtureProjection = {
  ...fixCheckRunningProjection,
  scenarioId: scenarioId('workflow-fix-check-stopped-continued'),
  events: [
    ...fixCheckRunningProjection.events,
    {
      type: 'turn_interrupted',
      ts: FIXED_TS + 3_000,
      phase: 'implementing',
      source: 'user',
      step: { kind: 'brief', taskId: WORKFLOW_FIXTURE_FIX_TASK_ID, attempt: 0 },
    },
    { type: 'workflow_resumed', ts: FIXED_TS + 30_000, phase: 'implementing' },
    {
      type: 'task_retry',
      ts: FIXED_TS + 30_000,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
      lineageAttempt: 2,
      attemptAllowance: 8,
      attempt: 1,
      maxRetries: 1,
      error: 'Continue after Stop',
    },
    {
      type: 'runner_call_started',
      ts: FIXED_TS + 30_000,
      phase: 'implementing',
      taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
      callId: 'visual-fix-continued',
      role: 'implementer',
      backendKind: 'api',
      sequence: 0,
      runnerName: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      axes: seatAxisWords(BASE_IMPLEMENTER),
      attempt: 2,
    },
  ],
};

// Live run 2026-10-09: a fix brief's check says which of the failures it carries remain; the
// other failures of the same red command belong to other fix briefs.
const fixCheckDoneProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-fix-check-done'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  get events(): EngineEvent[] {
    const testCi = { ...REVIEW_CHECK_TEST, command: 'npm run test-ci' };
    const remaining = 'a.ts:1: error';
    const gone = 'src/checkout/total.test.ts::returns the total';
    const keys = [remaining, 'b.ts:1', 'c.ts:1', 'd.ts:1'];
    return [
      ...fixCheckRunningProjection.events.slice(0, -1),
      reviewCheck(
        FIXED_TS + 2_000,
        testCi,
        {
          status: 'done',
          moment: 'brief',
          passed: false,
          own: 2,
          ownLeft: 1,
          others: 3,
          proven: true,
          duration: 181_000,
        },
        'implementing',
      ),
      {
        type: 'task_retry',
        lineageAttempt: 2,
        attemptAllowance: 8,
        ts: FIXED_TS + 2_100,
        phase: 'implementing',
        taskId: WORKFLOW_FIXTURE_FIX_TASK_ID,
        attempt: 1,
        maxRetries: 1,
        error: checkFailureText(
          {
            checkId: 'V2',
            status: 'fail',
            failure: { keys },
            output: '',
          },
          { carried: { failureKeys: [remaining, gone], redKeys: [...keys, gone] } },
        ),
      },
      reviewCheck(
        FIXED_TS + 2_200,
        testCi,
        {
          status: 'done',
          moment: 'brief',
          passed: false,
          own: 2,
          ownLeft: 0,
          others: 1,
          proven: false,
          duration: 180_000,
        },
        'implementing',
      ),
      reviewCheck(
        FIXED_TS + 2_300,
        testCi,
        {
          status: 'done',
          moment: 'brief',
          passed: true,
          own: 2,
          ownLeft: 0,
          others: 3,
          proven: true,
          duration: 180_000,
        },
        'implementing',
      ),
    ];
  },
};

const BASE_NOT_VERIFIED_E2E = {
  id: 'V1',
  command: 'npm run e2e',
  reason: 'The end-to-end suite drives the changed checkout flow.',
};
const BASE_NOT_VERIFIED_TEST = {
  id: 'V2',
  command: 'npm test',
  reason: 'The unit tests cover the changed module.',
};

const reviewBaseNotVerifiedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-base-not-verified'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    ...everyBriefPassed(),
    finalReviewStarted(FIXED_TS + 900, BASE_PLANNER),
    {
      type: 'review_checks',
      ts: FIXED_TS + 900,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [BASE_NOT_VERIFIED_E2E, BASE_NOT_VERIFIED_TEST],
      declined: [],
      reason: null,
    },
    reviewCheck(FIXED_TS + 1_000, BASE_NOT_VERIFIED_E2E, {
      status: 'done',
      passed: false,
      duration: 600_000,
    }),
    reviewCheck(FIXED_TS + 1_200, BASE_NOT_VERIFIED_E2E, {
      status: 'done',
      moment: 'base',
      passed: false,
      duration: 600_000,
      newFailures: 0,
      preExisting: 0,
      notVerified: 1,
      detail: 'both runs timed out',
    }),
    reviewCheck(FIXED_TS + 1_500, BASE_NOT_VERIFIED_TEST, {
      status: 'not-run',
      detail: 'V1 failed',
    }),
  ],
};

/** The reviewer rejected a red check that was red at the run base too, and the review passed. */
const reviewBaseRejectedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-base-rejected'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  events: [
    ...everyBriefPassed(),
    finalReviewStarted(FIXED_TS + 900, BASE_PLANNER),
    {
      type: 'review_checks',
      ts: FIXED_TS + 900,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [BASE_NOT_VERIFIED_E2E, BASE_NOT_VERIFIED_TEST],
      declined: [],
      reason: null,
    },
    reviewCheck(FIXED_TS + 1_000, BASE_NOT_VERIFIED_E2E, {
      status: 'done',
      passed: false,
      duration: 1_300,
    }),
    reviewCheck(FIXED_TS + 1_200, BASE_NOT_VERIFIED_E2E, {
      status: 'done',
      moment: 'base',
      passed: false,
      duration: 1_100,
      newFailures: 0,
      preExisting: 0,
      notVerified: 1,
      detail: "both runs exited with code 1: Error: Cannot find module 'e2e'",
    }),
    reviewCheck(FIXED_TS + 1_500, BASE_NOT_VERIFIED_TEST, {
      status: 'not-run',
      detail: 'V1 failed',
    }),
    {
      ...finalReviewCompleted({
        ts: FIXED_TS + 2_000,
        duration: 22_600,
        verdict: 'pass',
        seat: BASE_PLANNER,
      }),
      verdict: 'pass-with-notes',
      findings: { blocking: 0, minor: 1, outOfScope: 0 },
    },
    {
      type: 'workflow_complete',
      ts: FIXED_TS + 2_100,
      phase: 'complete',
      review: 'passed',
      completedTasks: 3,
    },
  ],
};

const projections = [
  reviewResumeProjection,
  reviewCheckCrashProjection,
  idleProjection,
  planningProjection,
  startAttachedFilesProjection,
  composerOutsideFileProjection,
  questionOutsideFileProjection,
  planningPathNoticeProjection,
  planCompiledProjection,
  firstBriefAfterPlanProjection,
  implementationProjection,
  // The same run a moment after it was continued: the screen holds it and its engine has not
  // started its first call yet (`markWorkflowPaused`, applied by the registry).
  {
    scenarioId: scenarioId('workflow-resuming'),
    feature: implementationProjection.feature,
    inputMode: implementationProjection.inputMode,
    sidebarVisible: implementationProjection.sidebarVisible,
    events: implementationProjection.events.filter(
      (event) => event.type !== 'runner_call_started' && event.type !== 'runner_call_activity',
    ),
  },
  implementationQueuedProjection,
  implementationDeliveredProjection,
  implementationSteerableProjection,
  {
    ...implementationProjection,
    scenarioId: scenarioId('workflow-crew-wide'),
    config: VISUAL_WIDE_CREW,
    events: implementationProjection.events.map((event): EngineEvent => {
      switch (event.type) {
        case 'task_started':
          return {
            ...event,
            tool: 'antigravity',
            model: AGY_BUILD_SEAT.model,
            axes: seatAxisWords(AGY_BUILD_SEAT),
          };
        case 'runner_call_started':
        case 'runner_call_activity':
          return {
            ...event,
            backendKind: 'cli',
            runnerName: 'antigravity',
            model: AGY_BUILD_SEAT.model,
            axes: seatAxisWords(AGY_BUILD_SEAT),
          };
        default:
          return event;
      }
    }),
  },
  balanceSpentRecoveryProjection,
  balanceSeatSwitchProjection,
  stopSheetRecoveryProjection,
  buildConsultProjection,
  buildReviewConsultProjection,
  implementationRetryProjection,
  reviewFixProjection,
  reviewFixCyclesProjection,
  completeAfterFixTasksProjection,
  reviewFixNoChangeProjection,
  finalReviewProjection,
  {
    ...finalReviewProjection,
    scenarioId: scenarioId('workflow-review-verdict-only'),
    events: finalReviewProjection.events
      .filter((event) => event.type !== 'review_checks')
      .flatMap((event): EngineEvent[] =>
        event.type === 'review_started'
          ? [
              event,
              {
                type: 'review_checks',
                ts: event.ts + 10,
                phase: event.phase,
                scope: 'final',
                status: 'planned',
                commands: [],
                reason: 'The recorded plan checks verify the change.',
              },
              {
                type: 'review_completed',
                ts: event.ts + 20,
                phase: event.phase,
                scope: 'final',
                tool: event.tool,
                verdict: 'pass',
                duration: 20,
              },
              {
                type: 'user_message',
                ts: event.ts + 30,
                phase: event.phase,
                text: 'Keep the cache key.',
                qa: [{ question: 'Keep the cache key?', answer: 'Keep the cache key.' }],
              },
              { ...event, ts: event.ts + 40 },
              { type: 'review_step', ts: event.ts + 40, phase: event.phase, step: 'verdict' },
            ]
          : [event],
      ),
  },
  {
    ...finalReviewProjection,
    scenarioId: scenarioId('workflow-review-choosing-checks'),
    events: finalReviewProjection.events
      .filter((event) => event.type !== 'review_checks')
      .flatMap((event): EngineEvent[] =>
        event.type === 'review_started'
          ? [
              event,
              { type: 'review_step', ts: event.ts, phase: event.phase, step: 'choosing-checks' },
            ]
          : [event],
      ),
  },
  reviewCorrectedProjection,
  reviewTaskCadenceProjection,
  reviewTaskOutOfScopeProjection,
  ...['clean', 'found'].map(
    (drift): WorkflowFixtureProjection => ({
      scenarioId: scenarioId(`workflow-review-drift-${drift}`),
      feature: WORKFLOW_FEATURE,
      inputMode: 'normal',
      sidebarVisible: false,
      events: [
        ...(drift === 'clean'
          ? everyBriefPassed()
          : ([
              {
                type: 'workflow_started',
                ts: FIXED_TS,
                phase: 'implementing',
                feature: WORKFLOW_FEATURE,
              },
              DRIFT_REVIEW_TASKS_PLANNED,
              ...DRIFT_REVIEW_TASKS_PLANNED.tasks.flatMap((brief, index): EngineEvent[] => [
                {
                  ...orphanBriefStarted(brief, FIXED_TS + 100 * (index + 1)),
                  total: DRIFT_REVIEW_TASKS_PLANNED.total,
                },
                index < 2
                  ? {
                      type: 'task_full_fail',
                      ts: FIXED_TS + 100 * (index + 1) + 10,
                      phase: 'implementing',
                      taskId: brief.id,
                    }
                  : fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1) + 10),
              ]),
            ] satisfies EngineEvent[])),
        {
          type: 'review_checks',
          ts: FIXED_TS + 1_000,
          phase: 'final-review',
          scope: 'final',
          status: 'planned',
          commands: DRIFT_REVIEW_CHECKS,
          declined: [{ ...REVIEW_CHECK_DECLINED }],
          reason: null,
        },
        ...DRIFT_REVIEW_CHECKS.map((check, index) =>
          reviewCheck(FIXED_TS + 1_100 + 100 * index, check, {
            status: 'done',
            passed: drift === 'clean' || check.id !== 'V2',
            duration: index % 2 === 0 ? 100 : 200,
          }),
        ),
        {
          type: 'drift_report',
          ts: FIXED_TS + 1_500,
          phase: 'final-review',
          passed: drift === 'clean',
          errorCount: drift === 'clean' ? 0 : 2,
          warningCount: drift === 'clean' ? 0 : 3,
          findings: drift === 'clean' ? [] : DRIFT_REVIEW_FINDINGS,
        },
      ],
    }),
  ),
  ...(['passed', 'failed'] as const).map(
    (review): WorkflowFixtureProjection => ({
      scenarioId: scenarioId(`workflow-review-settled-${review}`),
      feature: WORKFLOW_FEATURE,
      inputMode: 'normal',
      sidebarVisible: true,
      events: [
        { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
        { type: 'plan_approved', ts: FIXED_TS + 50, phase: 'reviewing-plan' },
        { ...FIXTURE_TASKS_PLANNED, ts: FIXED_TS + 60 },
        ...FIXTURE_PLANNED_BRIEFS.flatMap((brief, index) => [
          orphanBriefStarted(brief, FIXED_TS + 100 * (index + 1)),
          fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1) + 10),
        ]),
        finalReviewStarted(FIXED_TS + 1_000, BASE_PLANNER),
        finalReviewCompleted({
          ts: FIXED_TS + 8_000,
          duration: 7_000,
          verdict: review === 'passed' ? 'pass' : 'fail',
          seat: BASE_PLANNER,
        }),
        { type: 'workflow_complete', ts: FIXED_TS + 8_000, phase: 'complete', review },
      ],
    }),
  ),
  ...(['summary', 'compaction'] as const).map(
    (role): WorkflowFixtureProjection => ({
      ...finalReviewProjection,
      scenarioId: scenarioId(`workflow-review-${role}`),
      events: finalReviewProjection.events.map(
        (event): EngineEvent => (event.type === 'runner_call_started' ? { ...event, role } : event),
      ),
    }),
  ),
  reviewChecksOffProjection,
  reviewFixNarrowRailProjection,
  taskStatusesProjection,
  implementationEscalatedProjection,
  implementationExtractedCodeProjection,
  implementationNarrationProjection,
  implementationAdjacentNarrationProjection,
  implementationFencedHandBackProjection,
  continuousTranscriptProjection,
  validationProjection,
  reviewProjection,
  approvalConfirmProjection,
  approvalConfirmSecretProjection,
  planCardProjection,
  { ...planCardProjection, scenarioId: scenarioId('workflow-plan-card-commenting') },
  planCardRenderNoteProjection,
  planCardSharedCommandProjection,
  { ...planCardProjection, scenarioId: scenarioId('workflow-selection-copy') },
  tasksCardProjection,
  questionProjection,
  questionOverflowProjection,
  questionInputProjection,
  plannerReplyProjection,
  answeredQuestionsProjection,
  consultQuestionProjection,
  decisionQuestionProjection,
  decisionGuidanceProjection,
  {
    ...buildReviewConsultProjection,
    scenarioId: scenarioId('workflow-reviewer-question'),
    inputMode: 'question',
    question: {
      seat: 'review',
      prompt: 'Which cache key must the repair preserve?',
      answer: '',
      questions: [],
    },
  },
  {
    ...consultQuestionProjection,
    scenarioId: scenarioId('workflow-consult-answer-typed'),
    question: {
      prompt: 'Reply to the planner…',
      answer: '',
      questions: [{ id: 'consult-store', type: 'input', text: 'Which store?' }],
    },
  },
  pausedMidBriefProjection,
  resumedKeptWorkProjection,
  pausedBoundaryProjection,
  stoppingProjection,
  failureProjection,
  plannerCommandsRefusedProjection,
  touchedNotSuggestedProjection,
  planCheckRefusedProjection,
  completedOrphanRowsProjection,
  usageLimitRecoveryProjection,
  noFallbackRecoveryProjection,
  fallbackUsedRecoveryProjection,
  fallbackNotInstalledRecoveryProjection,
  retryExhaustedRecoveryProjection,
  consultBoundRecoveryProjection,
  {
    ...consultBoundRecoveryProjection,
    scenarioId: scenarioId('workflow-recovery-consult-bound-note'),
  },
  reviewFailedRecoveryProjection,
  reviewUnverifiedRecoveryProjection,
  reviewContextRecoveryProjection,
  reviewCallFailedRecoveryProjection,
  leftIsolationRecoveryProjection,
  leftIsolationInPlaceRecoveryProjection,
  checkoutChangedRecoveryProjection,
  resolvedRetryRecoveryProjection,
  implementationAfterRetryProjection,
  apiContextRecoveryProjection,
  planSeatRecoveryProjection,
  planChecksRecoveryProjection,
  planQuestionsRecoveryProjection,
  planSeatSwappedProjection,
  reviewSeatRecoveryProjection,
  hintSeatRecoveryProjection,
  seatSwitchedProjection,
  manualSeatSwitchedProjection,
  planActivityProjection,
  planningClaudeFramesProjection,
  implementationSilentProjection,
  implementationToolRunningProjection,
  implementationSilentBareProjection,
  implementationShellWrapperProjection,
  reviewCheckRunningProjection,
  reviewRenderRunningProjection,
  reviewPauseRequestedProjection,
  reviewCheckLongCommandProjection,
  reviewChecksApproveProjection,
  reviewChecksSkippedProjection,
  reviewLegacySuiteProjection,
  reviewBaseRerunProjection,
  reviewBaseMixedProjection,
  fixCheckRunningProjection,
  fixCheckStoppedContinuedProjection,
  fixCheckDoneProjection,
  reviewBaseNotVerifiedProjection,
  reviewBaseRejectedProjection,
  reviewRedGateProjection,
  plannerSessionExpiredProjection,
] as const;

export const workflowFixtureProjections: ReadonlyMap<ScenarioId, WorkflowFixtureProjection> =
  new Map(
    [
      ...projections,
      spentB2ReplayProjection,
      retainedWorkspaceProjection,
      cliStopContinuedProjection,
      closedQueueProjection,
      ...atRestProjections,
    ].map((projection) => [projection.scenarioId, projection]),
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
  if (projection.reviewChecksPrompt !== undefined) {
    return reviewChecksCardLayout(projection.reviewChecksPrompt, cols).height;
  }
  const approvalState: ApprovalPromptState =
    projection.approval === undefined
      ? { status: 'idle' }
      : {
          status: 'pending',
          request: {
            tier: 'confirm',
            actionClass: projection.approval.actionClass ?? 'package_change',
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
    // The chrome facts ask whether a panel is open, not how tall it is at one height, so the plan
    // card is measured unshed.
    review: {
      artifact: projection.reviewArtifact ?? null,
      confirms: [],
      budgetRows: Number.POSITIVE_INFINITY,
    },
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
  const halts = [
    usageLimitRecoveryIssue(),
    planSeatRecoveryIssue(),
    reviewSeatRecoveryIssue(),
    consultSeatRecoveryIssue(),
    planSwappedRecoveryIssue(),
  ];
  const engineHaltText = [
    ...halts.flatMap((issue) => [issue.message, ...issue.details]),
    runnerHaltRow(usageLimitRecoveryIssue(), OLLAMA_LIMIT_WORDS),
  ];
  const oversized = projectionStrings(projection).find(
    // The answered card's flat text joins its bounded qa pairs; it is not independent content.
    // Nor is a halt the engine composed around the tool's own bounded words, or the plan card's
    // plan.md and plan.json, which the plan formatter and the plan schema write whole, or the
    // implementer's JSON report, which the transcript reads as one summary line.
    (value) =>
      value !== planCardProjection.review?.source &&
      value !== planCardProjection.review?.planJson &&
      value !== planCardRenderNoteProjection.review?.source &&
      value !== planCardRenderNoteProjection.review?.planJson &&
      value !== planCardSharedCommandProjection.review?.source &&
      value !== planCardSharedCommandProjection.review?.planJson &&
      value !== ANSWERED_QUESTIONS_TEXT &&
      value !== RESUMED_REPORT_TEXT &&
      !retainedWorkspaceNotices.includes(value) &&
      !engineHaltText.includes(value) &&
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
