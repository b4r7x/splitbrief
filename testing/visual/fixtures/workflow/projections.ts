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
import { makeUsage } from '../../../helpers/factories/summary.js';
import { makeImplState, makeWorkflowState } from '../../../helpers/factories/workflow-state.js';
import type { EngineEvent, EngineEventOf } from '../../../../src/engine/events/types.js';
import type {
  TaskReviewRequest,
  UserEditConflict,
} from '../../../../src/engine/events/workflow-events.js';
import type { ClarificationQuestion } from '../../../../src/core/schemas/question.js';
import type { ReviewArtifact } from '../../../../src/features/workflow/prompt-rows/approval.js';
import { getWorkflowPromptRows } from '../../../../src/features/workflow/prompt-rows/workflow.js';
import { formatRecoveryPrompt } from '../../../../src/features/workflow/recovery-prompt.js';
import { formatUserEditConflictPrompt } from '../../../../src/features/workflow/user-edit-conflict-prompt.js';
import { formatTaskReviewPrompt } from '../../../../src/features/workflow/task-review-prompt.js';
import { projectRunnerCallEvents } from '../../../../src/engine/calls/event-projection.js';
import type { RunnerCallEvent } from '../../../../src/engine/calls/types.js';
import {
  createStreamHandler,
  finishClaudeStream,
} from '../../../../src/engine/runners/claude/stream.js';
import type { ApprovalPromptState } from '../../../../src/stores/approval-prompt/prompt.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../../src/stores/workflow/stop.js';
import type { ScenarioId } from '../../contracts/identifiers.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { specTasksCardsProjection, tasksCardProjection } from './artifact-card-projections.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildReviewFailedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  runnerHaltRow,
  type SeatSwapContext,
} from '../../../../src/engine/orchestrator/recovery/builders/task.js';
import {
  hintHaltDetails,
  reviewSeatDetails,
} from '../../../../src/engine/orchestrator/recovery/builders/details.js';
import { buildPlannerCallFailedRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/planner.js';
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
import { visualConfig, VISUAL_WORKFLOW_SESSION_ID } from '../screen-fixtures.js';
import { VISUAL_FIXTURE_EPOCH } from '../common.js';
import { RUNNER_IDLE_WARN_MS } from '../../../../src/core/schemas/runner-fields.js';
import { atRestProjections } from './at-rest-projections.js';

type VisualConfigOverrides = Parameters<typeof visualConfig>[0];

export const WORKFLOW_FIXTURE_VERSION = 1;

export const WORKFLOW_FIXTURE_BOUNDS = Object.freeze({
  version: WORKFLOW_FIXTURE_VERSION,
  maxEventsPerFixture: 8,
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
const BRIEFS_COMPILED_FEATURE = 'Rotate the session secrets in the config module so the tests pass';
export const WORKFLOW_FIXTURE_REVIEW_FILE = 'testing/visual/fixtures/workflow/projections.ts';
export const WORKFLOW_FIXTURE_REVIEW_PANEL_FILE =
  'testing/visual/fixtures/workflow/review-fixture.md';

export const WORKFLOW_FIXTURE_SECOND_FILE = 'testing/visual/fixtures/workflow/registry.ts';
export const WORKFLOW_FIXTURE_TASK_ID_2 = taskId('T902');
export const WORKFLOW_FIXTURE_TASK_ID_3 = taskId('T903');

export const WORKFLOW_FIXTURE_TEXT = Object.freeze({
  idle: 'no events yet',
  planning: 'Planning deterministic visual fixtures',
  planningNarration: 'Reading the parser before the fixture it pins.',
  planningRead: 'src/engine/streaming/parse-stream-json.ts',
  planningReply: 'The parser keeps the frames out of the reply.',
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
  recoveryUserEdits: 'Recovery needed · User edits conflict with T901',
  recoveryPlan: 'Change PLAN tool',
  retryExhausted: 'exhausted its retries',
  briefVerdict: 'the planner found the brief',
  reviewFailed: 'Send a correction',
  leftIsolation: 'Recovery needed · T901 left the isolation directory',
  checkoutChanged: 'Recovery needed · Your checkout changed under T901',
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
  readonly userEditConflict?: UserEditConflict;
  readonly approval?: FixtureApproval;
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
const WORKFLOW_QUICK_SETUP_ID = scenarioId('workflow-quick-setup');
const WORKFLOW_QUICK_RESEARCHING_ID = scenarioId('workflow-quick-researching');
const WORKFLOW_PLANNING_ID = scenarioId('workflow-planning');
const WORKFLOW_BRIEFS_COMPILED_ID = scenarioId('workflow-briefs-compiled');
const WORKFLOW_BRIEFS_APPROVED_ID = scenarioId('workflow-briefs-approved');
const WORKFLOW_IMPLEMENTATION_ID = scenarioId('workflow-implementation');
const WORKFLOW_IMPLEMENTATION_RETRY_ID = scenarioId('workflow-implementation-retry');
const WORKFLOW_VALIDATION_ID = scenarioId('workflow-validation');
const WORKFLOW_IMPLEMENTATION_ESCALATED_ID = scenarioId('workflow-implementation-escalated');
const WORKFLOW_IMPLEMENTATION_NARRATION_ID = scenarioId('workflow-implementation-narration');
const WORKFLOW_IMPLEMENTATION_ADJACENT_NARRATION_ID = scenarioId(
  'workflow-implementation-adjacent-narration',
);
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
const WORKFLOW_RECOVERY_USER_EDIT_ID = scenarioId('workflow-recovery-user-edits');
const WORKFLOW_RECOVERY_RETRY_EXHAUSTED_ID = scenarioId('workflow-recovery-retry-exhausted');
const WORKFLOW_RECOVERY_BRIEF_VERDICT_ID = scenarioId('workflow-recovery-brief-verdict');
const WORKFLOW_RECOVERY_REVIEW_FAILED_ID = scenarioId('workflow-recovery-review-failed');
const WORKFLOW_RECOVERY_LEFT_ISOLATION_ID = scenarioId('workflow-recovery-left-isolation');
const WORKFLOW_RECOVERY_CHECKOUT_CHANGED_ID = scenarioId('workflow-recovery-checkout-changed');
const WORKFLOW_API_CONTEXT_ID = scenarioId('workflow-api-context-insufficient');
const WORKFLOW_RECOVERY_PLAN_SEAT_ID = scenarioId('workflow-recovery-plan-seat');
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

const quickSetupProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_QUICK_SETUP_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { workflow: { mode: 'quick' } },
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    {
      type: 'planner_status',
      ts: FIXED_TS + 100,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
    },
    { type: 'user_message', ts: FIXED_TS + 200, phase: 'planning', text: WORKFLOW_FEATURE },
  ],
};

// A quick run researching: the first live phase an old quick run opens on, which the quick rail
// maps onto Plan. The frame pins that Spec stays pending while the byline names the live run.
const quickResearchingProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_QUICK_RESEARCHING_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: { workflow: { mode: 'quick' } },
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'researching', feature: WORKFLOW_FEATURE },
    {
      type: 'planner_status',
      ts: FIXED_TS + 100,
      phase: 'researching',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'research',
    },
    { type: 'user_message', ts: FIXED_TS + 200, phase: 'researching', text: WORKFLOW_FEATURE },
  ],
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

// The card the tasks step announces for three briefs, cut by the engine's own excerpt builder.
const COMPILED_BRIEFS_CARD: EngineEvent = {
  type: 'artifact_written',
  ts: FIXED_TS + 200,
  phase: 'planning',
  filename: 'tasks.md',
  path: '.splitbrief/sessions/2026-09-17-workflow-conversation-recovery/tasks.md',
  ...buildArtifactExcerpt(
    formatTasks([
      makeTask({
        id: WORKFLOW_FIXTURE_TASK_ID,
        title: WORKFLOW_FIXTURE_TEXT.implementationTask,
        file: WORKFLOW_FIXTURE_REVIEW_FILE,
        files: [
          WORKFLOW_FIXTURE_REVIEW_FILE,
          'testing/visual/fixtures/workflow/at-rest-projections.ts',
        ],
      }),
      makeTask({
        id: WORKFLOW_FIXTURE_TASK_ID_2,
        title: 'Register the bounded fixture projection',
        file: WORKFLOW_FIXTURE_SECOND_FILE,
        files: [WORKFLOW_FIXTURE_SECOND_FILE, 'testing/visual/fixtures/workflow/setup.ts'],
      }),
      makeTask({
        id: WORKFLOW_FIXTURE_TASK_ID_3,
        title: 'Capture the bounded fixture frame',
        file: WORKFLOW_FIXTURE_REVIEW_PANEL_FILE,
        files: [
          WORKFLOW_FIXTURE_REVIEW_PANEL_FILE,
          'testing/visual/fixtures/workflow/artifact-card-projections.ts',
        ],
      }),
    ]),
    'tasks.md',
  ),
};

// A quick run right after its tasks step, in the order the engine publishes it: the card the step
// announced, then the quality verdict and the prompt's risk advice. The quality
// pass kept the briefs, so no second card follows.
const briefsCompiledProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_BRIEFS_COMPILED_ID,
  feature: BRIEFS_COMPILED_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  config: { workflow: { mode: 'quick' } },
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'planning',
      feature: BRIEFS_COMPILED_FEATURE,
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
    COMPILED_BRIEFS_CARD,
    {
      type: 'brief_quality_passed',
      ts: FIXED_TS + 220,
      phase: 'planning',
      score: 1,
      warningCount: 0,
    },
    // The prompt's own risk advice, exactly as `adviseMode` scores this scenario's feature in quick
    // mode: the footer names the risk, and no brief or file count ever produces advice.
    {
      type: 'mode_advice',
      ts: FIXED_TS + 250,
      phase: 'planning',
      kind: 'upgrade',
      risk: 'high',
      currentMode: 'quick',
      suggestedMode: 'speckit',
      confidence: 0.89,
      factors: ['matched: \\bsession\\b', 'matched: \\bsecret(s)?\\b'],
      missing: [],
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

// A standard run right after its briefs gate, approved with no edit: the card from the tasks step
// and the verdict before the gate, then the readiness the approval re-measured. The approval
// changed nothing, so it announces no second card and no second verdict.
const briefsApprovedProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_BRIEFS_APPROVED_ID,
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
    COMPILED_BRIEFS_CARD,
    {
      type: 'brief_quality_passed',
      ts: FIXED_TS + 220,
      phase: 'planning',
      score: 1,
      warningCount: 0,
    },
    {
      type: 'planner_status',
      ts: FIXED_TS + 230,
      phase: 'reviewing-briefs',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
    },
    {
      type: 'brief_readiness_passed',
      ts: FIXED_TS + 300,
      phase: 'reviewing-briefs',
      taskCount: 3,
    },
    { ...FIXTURE_TASKS_PLANNED, ts: FIXED_TS + 400 },
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

/** What production code publishes on a bus of its own, stamped in order from `ts`. */
function publishedEvents(ts: number, publish: (bus: EventBus) => void): EngineEvent[] {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  publish(bus);
  return events.map((event, index) => ({ ...event, ts: ts + index }));
}

// Research suggested a package script for two stages. The production sanitizer refuses both on a
// bus of its own, so the transcript carries the words a real run records, one warning per stage.
function plannerCommandRefusals(ts: number): EngineEvent[] {
  return publishedEvents(ts, (bus) =>
    sanitizeDiscoveredValidation(
      {
        language: 'typescript',
        typecheckCommand: 'npm run typecheck',
        lintCommand: 'npm run lint',
        testCommand: 'npm test',
      },
      { bus, phase: 'researching' },
    ),
  );
}

const plannerCommandsRefusedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-planner-commands-refused'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'researching',
      feature: WORKFLOW_FEATURE,
    },
    {
      type: 'artifact_written',
      ts: FIXED_TS + 50,
      phase: 'researching',
      filename: 'research.md',
      path: '.splitbrief/sessions/2026-09-17-workflow-conversation-recovery/research.md',
      lineCount: 24,
      excerpt: ['Project Overview', 'Validation Tools'],
      omittedCount: 5,
      omittedUnit: 'section',
    },
    ...plannerCommandRefusals(FIXED_TS + 60),
    {
      type: 'planner_status',
      ts: FIXED_TS + 100,
      phase: 'specifying',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'spec',
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

const USER_EDITED_FILES = [
  'CHANGELOG.md',
  'docs/CLI-REFERENCE.md',
  'docs/ENGINE.md',
  'docs/FEATURES.md',
  'src/app/keys.ts',
];

const USER_EDIT_CONFLICT_PROMPT: UserEditConflict = {
  kind: 'future-task-stale-input',
  files: ['docs/a.ts', 'docs/b.ts', 'docs/c.ts', 'src/future.ts'],
  affectedTaskIds: [WORKFLOW_FIXTURE_TASK_ID],
  currentTaskId: taskId('T900'),
  fileConflicts: [
    { file: 'docs/a.ts', kind: 'unrelated', affectedTaskIds: [] },
    { file: 'docs/b.ts', kind: 'unrelated', affectedTaskIds: [] },
    { file: 'docs/c.ts', kind: 'unrelated', affectedTaskIds: [] },
    {
      file: 'src/future.ts',
      kind: 'future-task-stale-input',
      affectedTaskIds: [WORKFLOW_FIXTURE_TASK_ID],
    },
  ],
  safeToContinue: true,
  availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
};

// Edits the run did not make, in no brief's files, found before the one brief starts on a worker it
// nearly fills. The routing sentence rides on the event as it does in a real run.
const implementationUserEditsProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-implementation-user-edits'),
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
      type: 'tasks_planned',
      ts: FIXED_TS + 50,
      phase: 'implementing',
      total: 1,
      tasks: [
        {
          id: WORKFLOW_FIXTURE_TASK_ID,
          title: WORKFLOW_FIXTURE_TEXT.implementationTask,
          index: 0,
          file: WORKFLOW_FIXTURE_REVIEW_FILE,
          action: 'modify',
        },
      ],
    },
    {
      type: 'paused_external_changes',
      ts: FIXED_TS + 80,
      phase: 'implementing',
      conflict: {
        kind: 'unrelated',
        files: USER_EDITED_FILES,
        affectedTaskIds: [],
        currentTaskId: WORKFLOW_FIXTURE_TASK_ID,
        fileConflicts: USER_EDITED_FILES.map((file) => ({
          file,
          kind: 'unrelated',
          affectedTaskIds: [],
        })),
        safeToContinue: true,
        availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
      },
      selectedAction: 'continue-unrelated',
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
      files: [WORKFLOW_FIXTURE_REVIEW_FILE, WORKFLOW_FIXTURE_SECOND_FILE],
      action: 'modify',
      tool: FIXED_RUNNER_NAME,
      model: FIXED_RUNNER_MODEL,
      implementerProfile: 'default',
      contextFit: 'tight',
      estimatedTokens: 24_310,
      contextLength: 32_768,
      routingReason: 'Selected profile default (tight, estimated 24310/32768 tokens)',
    },
  ],
};

const userEditConflictPromptProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-user-edit-conflict-prompt'),
  feature: 'Review external edits before T900',
  inputMode: 'question',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: FIXED_TS,
      phase: 'implementing',
      feature: 'Review external edits before T900',
    },
  ],
  userEditConflict: USER_EDIT_CONFLICT_PROMPT,
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

// The warnings the brief parser raises when briefs share a file, two briefs and then three, and when
// a brief carries sections the grammar drops.
const briefsSharedFileProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-briefs-shared-file'),
  feature: WORKFLOW_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: FIXED_TS, phase: 'planning', feature: WORKFLOW_FEATURE },
    {
      type: 'warning',
      ts: FIXED_TS + 100,
      phase: 'planning',
      message:
        'Task Briefs T001 and T004 both declare docs/SUBSYSTEMS.md; the later brief modifies what the earlier one wrote',
    },
    {
      type: 'warning',
      ts: FIXED_TS + 101,
      phase: 'planning',
      message:
        'Task Briefs T005, T006 and T007 all declare src/run.ts; each later brief modifies what the earlier ones wrote',
    },
    {
      type: 'warning',
      ts: FIXED_TS + 102,
      phase: 'planning',
      message:
        'Task T002 has 2 sections not in the Task Brief grammar; they will be dropped: Edge Cases, Notes',
    },
  ],
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
  return buildRunnerUsageLimitRecoveryIssue({
    id: 'rec_visual_usage_limit',
    task: HALTED_TASK,
    phase: 'implementing',
    runner: config.implementer,
    toolMessage: OLLAMA_LIMIT_WORDS,
    attempts: 1,
    maxAttempts: config.workflow.maxRetries,
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
  file: WORKFLOW_FIXTURE_REVIEW_FILE,
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

const userEditRecoveryIssue: RecoveryIssue = {
  id: 'rec_visual_user_edit_conflict',
  reason: 'user-edit-conflict',
  phase: 'implementing',
  status: 'awaiting-user',
  taskId: WORKFLOW_FIXTURE_TASK_ID,
  taskTitle: 'Update session behavior',
  files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
  affectedTaskIds: [WORKFLOW_FIXTURE_TASK_ID],
  message: 'User edits conflict with T901',
  details: [
    'Conflict kind: current-task-conflict',
    'Safe to continue: no',
    `src/a.ts: current-task-conflict affects ${WORKFLOW_FIXTURE_TASK_ID}`,
  ],
  selectedImplementerProfile: 'default',
  facts: {
    conflictKind: 'current-task-conflict',
    safeToContinue: false,
    contextLength: 32_768,
  },
  availableActions: ['pause-run', 'end-run'],
  recommendedAction: 'pause-run',
  createdAt: new Date(FIXED_TS).toISOString(),
};

const userEditRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_USER_EDIT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  resumeState: haltedResumeState(userEditRecoveryIssue),
};

const FIXTURE_TYPECHECK_ERROR =
  "src/features/workflow/display/activity.ts(42,18): error TS2339: Property 'stop' does not exist on type 'Projection'.";

/**
 * Two local retries fail on one typecheck error; the third changes nothing and says why, which
 * ends the local rung on the same error. The planner answers, and the hinted retry fails on it too.
 */
const retryExhaustedRecoveryIssue = buildRetryExhaustedRecoveryIssue({
  id: 'rec_visual_retry_exhausted',
  task: HALTED_TASK,
  phase: 'escalating',
  validationSummary: FIXTURE_TYPECHECK_ERROR,
  attempts: 4,
  maxAttempts: 3,
  hintRungRan: true,
  allowRetryOverride: true,
  selectedImplementerProfile: 'default',
  handBack:
    'activity.ts reads projection.stop, but Projection has no stop field. I did not know its type, so I changed nothing.',
  plannerHint:
    'VERDICT: answer\nDeclare stop?: boolean on Projection in projections.ts. activity.ts then typechecks without a change.',
  plannerVerdict: 'answer',
  createdAt: new Date(FIXED_TS).toISOString(),
});

/** The first attempt changed nothing and asked; the planner found the brief wrong, so no retry ran. */
const briefVerdictRecoveryIssue = buildRetryExhaustedRecoveryIssue({
  id: 'rec_visual_brief_verdict',
  task: HALTED_TASK,
  phase: 'escalating',
  validationSummary: 'Tool implementer (antigravity) exited without changing any files',
  attempts: 0,
  maxAttempts: 3,
  allowRetryOverride: true,
  selectedImplementerProfile: 'default',
  handBack:
    'Projection is declared in src/core/projection.ts, which this brief does not list. May I edit that file?',
  plannerHint:
    'VERDICT: brief — the brief puts stop on a type that projections.ts does not declare\nProjection is declared in src/core/projection.ts. Add stop there in its own brief, then run this brief again.',
  plannerVerdict: 'brief',
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

const briefVerdictRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_BRIEF_VERDICT_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_LADDER_CREW,
  resumeState: haltedResumeState(briefVerdictRecoveryIssue),
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
    pendingRecovery: buildReviewFailedRecoveryIssue({
      id: 'rec_visual_review_failed',
      blocking: 4,
      phase: 'complete',
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
  message: `${WORKFLOW_FIXTURE_TASK_ID} left the isolation directory — Google Antigravity CLI searched ~ with run_command: find ~ -name "projections.ts" 2>/dev/null`,
  details: [
    'Google Antigravity CLI searched ~ with run_command: find ~ -name "projections.ts" 2>/dev/null',
    'Nothing from this attempt was promoted.',
  ],
  selectedImplementerProfile: 'default',
  switchSeat: { seat: 'build', candidates: [{ tool: 'codex' }] },
  facts: { tool: 'Google Antigravity CLI' },
  availableActions: [
    'retry-same-worker',
    'switch-seat',
    'skip-current-task',
    'pause-run',
    'end-run',
  ],
  recommendedAction: 'retry-same-worker',
  createdAt: new Date(FIXED_TS).toISOString(),
};

const leftIsolationRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_LEFT_ISOLATION_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_CREW,
  resumeState: haltedResumeState(leftIsolationRecoveryIssue),
};

/**
 * The halt `buildCheckoutChangedRecoveryIssue` writes when a branch moved and a hook changed in the
 * checkout while agy ran: the words name the checkout, never the tool, because the audit cannot
 * tell who made the change.
 */
const checkoutChangedRecoveryIssue: RecoveryIssue = {
  ...leftIsolationRecoveryIssue,
  id: 'rec_visual_checkout_changed',
  reason: 'checkout-changed',
  message: `Your checkout changed under ${WORKFLOW_FIXTURE_TASK_ID} — branch main · hook pre-commit`,
  details: [
    'Changed while Google Antigravity CLI ran: branch main · hook pre-commit',
    'Nothing from this attempt was promoted, and nothing in your checkout was reverted.',
  ],
};

const checkoutChangedRecoveryProjection: WorkflowFixtureProjection = {
  scenarioId: WORKFLOW_RECOVERY_CHECKOUT_CHANGED_ID,
  feature: WORKFLOW_FEATURE,
  inputMode: 'question',
  sidebarVisible: false,
  events: [],
  config: AGY_CREW,
  resumeState: haltedResumeState(checkoutChangedRecoveryIssue),
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
    details: reviewSeatDetails(true),
    seatSwap: planSeatSwap('codex', ['codex', 'claude-code', 'opencode']),
    createdAt: new Date(FIXED_TS).toISOString(),
  });
}

/**
 * The planner out of quota on a brief's hint: the halt is the plan seat's, and it names the brief,
 * so taking the swap replays that brief from its first attempt.
 */
function hintSeatRecoveryIssue(): RecoveryIssue {
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
    details: hintHaltDetails(WORKFLOW_FIXTURE_TASK_ID),
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
    return haltErrorEvents(hintSeatRecoveryIssue());
  },
  config: CODEX_PLAN_CREW,
  get resumeState() {
    return haltedResumeState(hintSeatRecoveryIssue());
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
    phase: 'researching',
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
    { type: 'workflow_started', ts: FIXED_TS, phase: 'researching', feature: WORKFLOW_FEATURE },
    {
      type: 'planner_status',
      ts: FIXED_TS + 50,
      phase: 'researching',
      status: 'running',
      tool: 'claude-code',
      model: 'opus',
      call: 'research',
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
      text: 'The gallery file already carries an uncommitted change. I check that diff before I edit it, so my edit does not disturb it.',
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

const projections = [
  idleProjection,
  quickSetupProjection,
  quickResearchingProjection,
  planningProjection,
  briefsCompiledProjection,
  briefsApprovedProjection,
  implementationProjection,
  implementationRetryProjection,
  implementationEscalatedProjection,
  implementationNarrationProjection,
  implementationAdjacentNarrationProjection,
  validationProjection,
  implementationUserEditsProjection,
  userEditConflictPromptProjection,
  reviewProjection,
  approvalDocumentProjection,
  { ...approvalDocumentProjection, scenarioId: scenarioId('workflow-selection-copy') },
  approvalPermissionProjection,
  reviewingBriefsProjection,
  tasksCardProjection,
  specTasksCardsProjection,
  questionProjection,
  questionOverflowProjection,
  questionInputProjection,
  plannerReplyProjection,
  briefsSharedFileProjection,
  answeredQuestionsProjection,
  taskReviewProjection,
  pausedMidBriefProjection,
  pausedBoundaryProjection,
  stoppingProjection,
  stoppedProjection,
  failureProjection,
  plannerCommandsRefusedProjection,
  usageLimitRecoveryProjection,
  userEditRecoveryProjection,
  retryExhaustedRecoveryProjection,
  briefVerdictRecoveryProjection,
  reviewFailedRecoveryProjection,
  leftIsolationRecoveryProjection,
  checkoutChangedRecoveryProjection,
  apiContextRecoveryProjection,
  planSeatRecoveryProjection,
  planSeatSwappedProjection,
  reviewSeatRecoveryProjection,
  hintSeatRecoveryProjection,
  planActivityProjection,
  planningClaudeFramesProjection,
  implementationSilentProjection,
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
  if (projection.userEditConflict !== undefined)
    return formatUserEditConflictPrompt(projection.userEditConflict);
  if (projection.taskReview !== undefined) return formatTaskReviewPrompt(projection.taskReview);
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
  const halts = [
    usageLimitRecoveryIssue(),
    planSeatRecoveryIssue(),
    reviewSeatRecoveryIssue(),
    hintSeatRecoveryIssue(),
    planSwappedRecoveryIssue(),
  ];
  const engineHaltText = [
    ...halts.flatMap((issue) => [issue.message, ...issue.details]),
    runnerHaltRow(usageLimitRecoveryIssue(), OLLAMA_LIMIT_WORDS),
  ];
  const oversized = projectionStrings(projection).find(
    // The production formatter joins bounded facts and commands into one multiline prompt, and
    // the answered card's flat text joins its bounded qa pairs; neither is independent content.
    // Nor is a halt the engine composed around the tool's own bounded words.
    (value) =>
      value !== formatTaskReviewPrompt(taskReviewRequest) &&
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
