import { projectRunnerCallActivity } from '../../../../src/engine/calls/activity.js';
import { buildArtifactExcerpt } from '../../../../src/engine/orchestrator/artifact-card.js';
import { formatTasks } from '../../../../src/engine/spec/formatter.js';
import type { RecoveryIssue } from '../../../../src/core/schemas/recovery/schemas.js';
import type { RunRecord } from '../../../../src/core/sessions/run-record.js';
import type { Summary } from '../../../../src/core/schemas/summary.js';
import { retainedWorkspaceNotices, retainedWorkspaceProjection } from './retained-workspace.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import { makeTask } from '../../../helpers/factories/task.js';
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
import type { EngineEvent, EngineEventOf } from '../../../../src/engine/events/types.js';
import type { ClarificationQuestion } from '../../../../src/core/schemas/question.js';
import type { ReviewArtifact } from '../../../../src/features/workflow/prompt-rows/approval.js';
import { getWorkflowPromptRows } from '../../../../src/features/workflow/prompt-rows/workflow.js';
import { formatRecoveryPrompt } from '../../../../src/features/workflow/recovery-prompt.js';
import { projectRunnerCallEvents } from '../../../../src/engine/calls/event-projection.js';
import type { RunnerCallEvent } from '../../../../src/engine/calls/types.js';
import {
  createStreamHandler,
  finishClaudeStream,
} from '../../../../src/engine/runners/claude/stream.js';
import type { ApprovalPromptState } from '../../../../src/stores/approval-prompt/prompt.js';
import type {
  ReviewChecksApprovalRequest,
  TieredApprovalRequest,
} from '../../../../src/core/approval/types.js';
import { reviewChecksCardLayout } from '../../../../src/features/workflow/review-checks/options.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../../src/stores/workflow/stop.js';
import type { ScenarioId } from '../../contracts/identifiers.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { tasksCardProjection } from './artifact-card-projections.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildReviewFailedRecoveryIssue,
  buildSeatDownIssue,
  buildLeftIsolationRecoveryIssue,
  buildCheckoutChangedRecoveryIssue,
  runnerHaltRow,
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
import {
  diagnosePlannerCallFailure,
  type PlannerCallDiagnosis,
} from '../../../../src/engine/orchestrator/recovery/planner-call-failure.js';
import { retryFailureLabel } from '../../../../src/engine/orchestrator/task/retry.js';
import {
  publishError,
  publishRecoveryActionSelected,
  publishRecoveryPrompted,
  publishRecoveryResolved,
  publishWarning,
} from '../../../../src/engine/orchestrator/events.js';
import type { Config } from '../../../../src/core/schemas/config.js';
import { error } from '../../../../src/utils/error.js';
import { createEventBus } from '../../../../src/engine/events/bus.js';
import type { EventBus } from '../../../../src/engine/events/types.js';
import { sanitizeDiscoveredValidation } from '../../../../src/engine/orchestrator/planning/sanitize-discovered-validation.js';
import {
  VISUAL_FIXTURE_PROJECT_DIR,
  visualConfig,
  VISUAL_WORKFLOW_SESSION_ID,
} from '../screen-fixtures.js';
import { VISUAL_FIXTURE_EPOCH } from '../common.js';
import { RUNNER_IDLE_WARN_MS } from '../../../../src/core/schemas/runner-fields.js';
import { atRestProjections } from './at-rest-projections.js';

type VisualConfigOverrides = Parameters<typeof visualConfig>[0];

export const WORKFLOW_FIXTURE_VERSION = 1;

export const WORKFLOW_FIXTURE_BOUNDS = Object.freeze({
  version: WORKFLOW_FIXTURE_VERSION,
  maxEventsPerFixture: 24,
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
  readonly approval?: FixtureApproval;
  /** The reviewer checks card, open on the commands the reviewer chose. */
  readonly reviewChecksPrompt?: ReviewChecksApprovalRequest;
  readonly review?: FixtureReview;
  /** The artifact the document review panel names, when the projection opens that gate. */
  readonly reviewArtifact?: ReviewArtifact;
  readonly streaming?: FixtureStreaming;
  /** The crew and workflow settings the saved run ran under, when they are not the gallery default. */
  readonly config?: VisualConfigOverrides;
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
        { id: 'C1', passed: true },
        { id: 'C2', passed: true },
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
  brief: (typeof FIXTURE_PLANNED_BRIEFS)[number],
  ts: number,
): EngineEvent {
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

function everyBriefPassed(): EngineEvent[] {
  return [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
    FIXTURE_TASKS_PLANNED,
    ...FIXTURE_PLANNED_BRIEFS.map((brief, index) =>
      fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1)),
    ),
  ];
}

function orphanBriefStarted(
  brief: (typeof FIXTURE_PLANNED_BRIEFS)[number],
  ts: number,
): EngineEvent {
  return {
    type: 'task_started',
    ts,
    phase: 'implementing',
    taskId: brief.id,
    title: brief.title,
    index: brief.index,
    total: 3,
    file: WORKFLOW_FIXTURE_REVIEW_FILE,
    action: 'modify',
    tool: 'ollama',
    model: FIXED_RUNNER_MODEL,
  };
}

// Run-level rows and unsuggested files collapse with the completed brief when the next brief starts.
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
  sidebarVisible: false,
  config: { reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6-astra' } },
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    { type: 'user_message', ts: FIXED_TS + 10, phase: 'planning', text: WORKFLOW_FEATURE },
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
    {
      type: 'warning',
      ts: FIXED_TS + 21,
      phase: 'planning',
      code: 'discovered_validation_refused',
      category: 'validation',
      message: 'The test stage does not take the file pattern from the planner.',
    },
    { type: 'plan_approved', ts: FIXED_TS + 30, phase: 'reviewing-plan' },
    FIXTURE_TASKS_PLANNED,
    ...FIXTURE_PLANNED_BRIEFS.flatMap((brief, index) => [
      orphanBriefStarted(brief, FIXED_TS + 100 * (index + 1)),
      fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1) + 10),
    ]),
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
      model: 'gpt-6-astra',
      sequence: 1,
      activityId: 'visual-review-call-001:read',
      stage: 'completed',
      kind: 'read',
      label: 'reading the failing test',
      target: WORKFLOW_FIXTURE_SECOND_FILE,
      redacted: false,
    },
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
  config: { reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6-astra' } },
  get events(): EngineEvent[] {
    return [
      ...everyBriefPassed(),
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
        type: 'planner_status',
        ts: FIXED_TS + 500,
        phase: 'final-review',
        status: 'running',
        tool: 'codex',
        model: 'gpt-6-astra',
      },
      {
        type: 'runner_call_started',
        ts: FIXED_TS + 520,
        phase: 'final-review',
        callId: 'visual-review-call-001',
        role: 'review',
        backendKind: 'cli',
        runnerName: 'codex',
        model: 'gpt-6-astra',
        attempt: 1,
        sequence: 0,
      },
      {
        type: 'planner_text',
        ts: FIXED_TS + 540,
        phase: 'final-review',
        text: 'Reading the run diff against the spec before the verdict.',
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
// did in the S11 run: the confirms line names the command once.
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
      type: 'consult_answered',
      ts: FIXED_TS + 200,
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
function usageLimitRecoveryIssue(): RecoveryIssue {
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
      detectedTools: ['opencode', 'codex', 'claude-code', 'cursor', 'copilot', 'kilo-code'].map(
        (tool) => ({ tool, ready: true }),
      ),
    },
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

const AGY_BUILD_SEAT = {
  kind: 'cli',
  tool: 'antigravity',
  model: 'gemini-3.8-flash-high',
} as const;
/** The isolation halts are raised only on a CLI implementer's tool calls. */
const AGY_CREW: VisualConfigOverrides = { implementer: AGY_BUILD_SEAT };
/** Three local retries need the retry budget that allows them. */
const AGY_LADDER_CREW: VisualConfigOverrides = {
  implementer: AGY_BUILD_SEAT,
  workflow: { maxRetries: 3 },
};

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
  config: AGY_LADDER_CREW,
  resumeState: haltedResumeState(retryExhaustedRecoveryIssue),
};

const consultBoundRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_CONSULT_BOUND_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_LADDER_CREW,
  resumeState: haltedResumeState(consultBoundRecoveryIssue),
};

/** The final review still failed once its repair cycles ran out; every brief had landed. */
const reviewFailedRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_REVIEW_FAILED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_LADDER_CREW,
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

/** The final review left six criteria unverified, as in the S9 run: nothing for the planner to fix. */
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
  // worktree, as the S11 run that raised it did.
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
// leaves the scroll with that brief's completed row.
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
    'Adjust the plan seat with /crew plan or Settings, then /resume and choose retry.',
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

/**
 * What the engine makes of a planner-tier call that failed on a limit. Every halt below is built
 * when the capture reads it: the tools name their reset as a local clock, which resolves against
 * the capture's own clock and zone only then.
 */
function plannerLimitDiagnosis(
  input: Readonly<{ err: unknown; label: string; runner: Config['planner'] }>,
): PlannerCallDiagnosis {
  return diagnosePlannerCallFailure({ ...input, seat: 'plan' });
}

/** What the last readiness pass remembered for PLAN: every tool here ready. */
function planSeatSwap(currentTool: string, tools: readonly string[]): SeatSwapContext {
  return { seat: 'plan', currentTool, detectedTools: tools.map((tool) => ({ tool, ready: true })) };
}

/**
 * The plan seat out of quota mid-plan: the halt is about the seat, not a brief, and offers the
 * seat's other ready tools. Every surface that names the move names PLAN, never the build seat.
 */
function planSeatRecoveryIssue(): RecoveryIssue {
  const planner = visualConfig().planner;
  return buildPlannerCallFailedRecoveryIssue({
    id: 'rec_visual_plan_usage_limit',
    diagnosis: plannerLimitDiagnosis({
      err: plannerCallFailed('planner', CLAUDE_LIMIT_WORDS),
      label: 'Planning failed',
      runner: planner,
    }),
    phase: 'planning',
    runner: { ...planner, fallback: SEAT_FALLBACK },
    seatSwap: planSeatSwap('claude-code', ['claude-code', 'codex', 'opencode']),
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/**
 * The final review out of quota on the tool it follows PLAN onto: the halt is the review seat's,
 * and its swap moves the plan seat, so the review runs on the new tool with it.
 */
function reviewSeatRecoveryIssue(): RecoveryIssue {
  return buildPlannerCallFailedRecoveryIssue({
    id: 'rec_visual_review_usage_limit',
    diagnosis: plannerLimitDiagnosis({
      err: plannerCallFailed('review', CODEX_LIMIT_WORDS),
      label: 'Final review failed',
      runner: CODEX_PLAN_SEAT,
    }),
    seat: 'review',
    phase: 'final-review',
    runner: { ...CODEX_PLAN_SEAT, fallback: SEAT_FALLBACK },
    details: reviewSeatDetails(true),
    seatSwap: planSeatSwap('codex', ['codex', 'claude-code', 'opencode']),
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
    diagnosis: plannerLimitDiagnosis({
      err,
      label: retryFailureLabel(err, WORKFLOW_FIXTURE_TASK_ID),
      runner: CODEX_PLAN_SEAT,
    }),
    task: HALTED_TASK,
    phase: 'escalating',
    runner: CODEX_PLAN_SEAT,
    details: consultHaltDetails(WORKFLOW_FIXTURE_TASK_ID),
    seatSwap: planSeatSwap('codex', ['codex', 'claude-code', 'opencode']),
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/** A PLAN seat that ran out on Codex, and the only other tool it could move to. */
function planSwappedRecoveryIssue(): RecoveryIssue {
  return buildPlannerCallFailedRecoveryIssue({
    id: 'rec_visual_plan_swapped',
    diagnosis: plannerLimitDiagnosis({
      err: plannerCallFailed('planner', CODEX_LIMIT_WORDS),
      label: 'Planning failed',
      runner: CODEX_PLAN_SEAT,
    }),
    phase: 'planning',
    runner: CODEX_PLAN_SEAT,
    seatSwap: planSeatSwap('codex', ['codex', 'claude-code']),
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

/**
 * The build seat ran out on Ollama and moved to its declared fallback: one switch row, and the
 * header names the new seat.
 */
const seatSwitchedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-seat-switched'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { implementer: { kind: 'cli', ...SEAT_FALLBACK } },
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
      type: 'seat_switched',
      ts: FIXED_TS + 200,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'ollama', model: FIXED_RUNNER_MODEL },
      to: SEAT_FALLBACK,
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'visual-config-revision',
    },
  ],
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
    model: 'opus',
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
  model: 'opus',
  attempt: 0,
} as const;

/** Build narration as a real Claude Code call streamed it: each message on its own rows, once. */
const implementationNarrationProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_IMPLEMENTATION_NARRATION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { implementer: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' } },
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
      model: 'opus',
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
      text: 'I check the gallery diff before I edit it.',
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
      text: 'I checked the fixture size.',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 400,
      phase: 'implementing',
      role: 'implementer',
      messageStart: true,
      text: 'The gallery has an uncommitted change.',
    },
    {
      type: 'planner_text',
      ts: FIXED_TS + 500,
      phase: 'implementing',
      role: 'implementer',
      messageStart: true,
      text: 'I run the two brief checks now.',
    },
  ],
};

/** S11 run 2, 08:49: the build seat fenced its hand-back report in a json code block. */
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
      text: [
        'Both comment sites read the new field.',
        '',
        '```json',
        '{"status":"done","filesChanged":["src/row.ts"],"touchedNotSuggested":[],"notes":null}',
        '```',
      ].join('\n'),
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
  const { state, handleLine } = createStreamHandler({
    context: {
      callId: 'visual-claude-plan-001',
      role: 'planner',
      backendKind: 'cli',
      runnerName: 'claude',
      model: 'claude-sonnet-4',
      attempt: 1,
    },
    onOutput: (text) => {
      events.push({
        type: 'planner_text',
        ts: stamp(),
        phase: 'planning',
        text,
        content: 'markdown',
      });
    },
    onCallEvent: (event) => {
      events.push(
        ...projectRunnerCallEvents(
          { ...event, ts: stamp() },
          { phase: 'planning', sequence: events.length },
        ),
      );
    },
  });
  for (const frame of CLAUDE_PLAN_FRAMES) {
    handleLine(JSON.stringify({ session_id: 'visual-claude-session', ...frame }));
  }
  finishClaudeStream(state);
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
    attempt,
  } as const;
}

/** Call events as the workflow bus receives them: the typed event dropped, its activity kept. */
function planningCallActivity(ts: number, events: readonly RunnerCallEvent[]): EngineEvent[] {
  return events
    .flatMap((event, index) =>
      projectRunnerCallEvents({ ...event, ts: ts + index }, { phase: 'planning', sequence: index }),
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
      return { ...event, runnerName: CODEX_BUILD_SEAT.tool, model: CODEX_BUILD_SEAT.model };
    }
    return event;
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
    ...FIXTURE_PLANNED_BRIEFS.slice(0, 2).map((brief, index) =>
      fixtureBriefPassed(brief, PRE_REVIEW_TEST_STARTED_TS - 600_000 + 180_000 * index),
    ),
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
    reviewChecksPlanned(PRE_REVIEW_TEST_STARTED_TS - 30_000),
    reviewCheck(PRE_REVIEW_TEST_STARTED_TS - 20_000, REVIEW_CHECK_TYPECHECK, {
      status: 'done',
      passed: true,
      duration: 18_000,
    }),
    reviewCheck(PRE_REVIEW_TEST_STARTED_TS, REVIEW_CHECK_TEST, { status: 'running' }),
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
  sidebarVisible: false,
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
    {
      type: 'planner_text',
      ts: FIXED_TS + 1_000,
      phase: 'final-review',
      text: 'Check the fixture.',
    },
    { type: 'workflow_complete', ts: FIXED_TS + 8_000, phase: 'final-review', review: 'failed' },
    {
      type: 'user_message',
      ts: FIXED_TS + 9_000,
      phase: 'final-review',
      text: 'The fixture is updated.',
    },
    { type: 'planner_text', ts: FIXED_TS + 10_000, phase: 'final-review', text: 'Checking again.' },
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
    {
      type: 'planner_status',
      ts: PRE_REVIEW_TEST_STARTED_TS - 20_000,
      phase: 'final-review',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
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
  config: { reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6-astra' } },
  get events(): EngineEvent[] {
    return [
      { type: 'workflow_started', ts: FIXED_TS, phase: 'implementing', feature: WORKFLOW_FEATURE },
      { ...FIXTURE_TASKS_PLANNED, total: 1, tasks: FIXTURE_TASKS_PLANNED.tasks.slice(0, 1) },
      fixtureBriefPassed(FIXTURE_PLANNED_BRIEFS[0], FIXED_TS + 300),
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
          model: 'gpt-6-astra',
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
    ...everyBriefPassed(),
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
    const fixBuild = reviewFixProjection.events.slice(everyBriefPassed().length);
    return [
      ...everyBriefPassed(),
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

// Live run 2026-10-09: a fix brief's check says which of the failures it carries remain; the
// other failures of the same red command belong to other fix briefs.
const fixCheckDoneProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-fix-check-done'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  get events(): EngineEvent[] {
    const testCi = { ...REVIEW_CHECK_TEST, command: 'npm run test-ci' };
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
        error: 'check V2 did not pass (fail): src/checkout/total.ts(14,3): error TS2322',
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

const projections = [
  idleProjection,
  planningProjection,
  planCompiledProjection,
  firstBriefAfterPlanProjection,
  implementationProjection,
  implementationRetryProjection,
  reviewFixProjection,
  reviewFixCyclesProjection,
  completeAfterFixTasksProjection,
  reviewFixNoChangeProjection,
  finalReviewProjection,
  reviewCorrectedProjection,
  ...(['passed', 'failed'] as const).map(
    (review): WorkflowFixtureProjection => ({
      scenarioId: scenarioId(`workflow-review-settled-${review}`),
      feature: WORKFLOW_FEATURE,
      inputMode: 'normal',
      sidebarVisible: false,
      events: [
        { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
        { type: 'plan_approved', ts: FIXED_TS + 50, phase: 'reviewing-plan' },
        { ...FIXTURE_TASKS_PLANNED, ts: FIXED_TS + 60 },
        ...FIXTURE_PLANNED_BRIEFS.flatMap((brief, index) => [
          orphanBriefStarted(brief, FIXED_TS + 100 * (index + 1)),
          fixtureBriefPassed(brief, FIXED_TS + 100 * (index + 1) + 10),
        ]),
        {
          type: 'planner_text',
          ts: FIXED_TS + 1_000,
          phase: 'final-review',
          text: 'Checking the diff before the verdict.',
        },
        { type: 'workflow_complete', ts: FIXED_TS + 8_000, phase: 'complete', review },
      ],
    }),
  ),
  ...(['summary', 'compaction'] as const).map(
    (role): WorkflowFixtureProjection => ({
      ...finalReviewProjection,
      scenarioId: scenarioId(`workflow-review-${role}`),
      events: finalReviewProjection.events.map(
        (event): EngineEvent =>
          event.type === 'runner_call_started'
            ? { ...event, role }
            : event.type === 'planner_text'
              ? {
                  ...event,
                  text:
                    role === 'summary'
                      ? 'Preparing the run summary.'
                      : 'Compacting the run context.',
                }
              : event,
      ),
    }),
  ),
  reviewChecksOffProjection,
  implementationEscalatedProjection,
  implementationNarrationProjection,
  implementationAdjacentNarrationProjection,
  implementationFencedHandBackProjection,
  validationProjection,
  reviewProjection,
  approvalConfirmProjection,
  approvalConfirmSecretProjection,
  planCardProjection,
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
  pausedBoundaryProjection,
  stoppingProjection,
  failureProjection,
  plannerCommandsRefusedProjection,
  touchedNotSuggestedProjection,
  completedOrphanRowsProjection,
  usageLimitRecoveryProjection,
  retryExhaustedRecoveryProjection,
  consultBoundRecoveryProjection,
  {
    ...consultBoundRecoveryProjection,
    scenarioId: scenarioId('workflow-recovery-consult-bound-note'),
  },
  reviewFailedRecoveryProjection,
  reviewUnverifiedRecoveryProjection,
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
  planActivityProjection,
  planningClaudeFramesProjection,
  implementationSilentProjection,
  implementationToolRunningProjection,
  implementationSilentBareProjection,
  reviewCheckRunningProjection,
  reviewPauseRequestedProjection,
  reviewCheckLongCommandProjection,
  reviewChecksApproveProjection,
  reviewChecksSkippedProjection,
  reviewLegacySuiteProjection,
  reviewBaseRerunProjection,
  reviewBaseMixedProjection,
  fixCheckRunningProjection,
  fixCheckDoneProjection,
  reviewBaseNotVerifiedProjection,
  reviewRedGateProjection,
  plannerSessionExpiredProjection,
] as const;

export const workflowFixtureProjections: ReadonlyMap<ScenarioId, WorkflowFixtureProjection> =
  new Map(
    [...projections, retainedWorkspaceProjection, ...atRestProjections].map((projection) => [
      projection.scenarioId,
      projection,
    ]),
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
    // plan.md and plan.json, which the plan formatter and the plan schema write whole.
    (value) =>
      value !== planCardProjection.review?.source &&
      value !== planCardProjection.review?.planJson &&
      value !== planCardRenderNoteProjection.review?.source &&
      value !== planCardRenderNoteProjection.review?.planJson &&
      value !== planCardSharedCommandProjection.review?.source &&
      value !== planCardSharedCommandProjection.review?.planJson &&
      value !== ANSWERED_QUESTIONS_TEXT &&
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
