import { REVIEW_FILE } from '../../../../src/core/paths.js';
import { BASE_SPLIT_NAMED } from '../../../../src/core/review/base-split.js';
import type { Phase } from '../../../../src/core/schemas/enums.js';
import type { ClarificationQuestion } from '../../../../src/core/schemas/question.js';
import type {
  EvidenceLedger,
  EvidenceReview,
  EvidenceTask,
} from '../../../../src/core/schemas/evidence.js';
import type { RunRecord } from '../../../../src/core/sessions/run/record.js';
import { deriveRunStatus, type RunStatus } from '../../../../src/core/sessions/run/status.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow/state.js';
import type { SeatWait } from '../../../../src/core/schemas/workflow/seat.js';
import type { ReviewRecord } from '../../../../src/core/schemas/workflow/review-record.js';
import {
  reviewFindingCounts,
  reviewOutcomeOf,
  reviewOutcomeWord,
} from '../../../../src/core/review/verdict.js';
import type { Finding } from '../../../../src/core/review/scope.js';
import type { RecoveryIssue } from '../../../../src/core/schemas/recovery/schemas.js';
import type { TriageInput } from '../../../../src/core/schemas/review/verdict.js';
import type { EngineEvent, EngineEventOf } from '../../../../src/engine/events/types.js';
import {
  FIX_CYCLE_RUN_FEATURE,
  fixCycleRun,
  fixCycleRunLog,
} from '../../../helpers/factories/fix-cycle-run.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { makeTaskComplete, makeTaskStart } from '../../../helpers/events/task.js';
import { makeMessage } from '../../../helpers/queue.js';
import type { ReviewPacketSummary, Summary } from '../../../../src/core/schemas/summary.js';

import { taskId, type Task } from '../../../../src/core/schemas/task.js';
import type { BriefExecution } from '../../../../src/core/schemas/brief-execution.js';

import { buildLeftIsolationRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/isolation.js';
import { buildRunnerInputTooLargeRecoveryIssue } from '../../../../src/engine/orchestrator/recovery/builders/runner-defect.js';
import { buildSeatDownIssue } from '../../../../src/engine/orchestrator/recovery/builders/seat-down.js';
import { CODEX_INPUT_TOO_LARGE, LEFT_ISOLATION_WRITE } from './halt-text-projections.js';
import {
  buildApplyConflictRecoveryIssue,
  buildApplyPartialRecoveryIssue,
} from '../../../../src/engine/orchestrator/recovery/builders/apply.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../../src/engine/events/workflow-cancel.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../../src/core/sessions/workspace-notice.js';
import { checkFailureText } from '../../../../src/engine/orchestrator/validation/failure-text.js';
import {
  foreignWorkspaceNotice,
  retainedWorkspaceNotice,
} from '../../../../src/engine/orchestrator/isolation/kept-notice.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { VISUAL_FIXTURE_EPOCH } from '../common.js';
import { BASE_IMPLEMENTER, VISUAL_FIXTURE_PROJECT_DIR, visualConfig } from '../screen-fixtures.js';
import { retentionError } from '../../../../src/engine/orchestrator/isolation/retention.js';
import type { FixtureAtRestRoute, WorkflowFixtureProjection } from './projections.js';

export const AT_REST_FIXTURE_FEATURE = 'Add email validation with tests';
const SUMMARY_FIXTURE_FEATURE = AT_REST_FIXTURE_FEATURE;

const GENERATED_AT = '2026-09-14T09:41:00.000Z';

const FILES = Object.freeze({
  validate: 'src/validate.ts',
  form: 'src/form.ts',
  formTest: 'src/form.test.ts',
  signup: 'src/routes/signup.ts',
  signupTest: 'src/routes/signup.test.ts',
  docs: 'docs/validation-errors.md',
});

const BRIEFS = Object.freeze({
  validator: { id: taskId('T001'), title: 'Add validator module', file: FILES.validate },
  wire: { id: taskId('T002'), title: 'Wire validator into the signup form', file: FILES.form },
  routeTests: { id: taskId('T003'), title: 'Add signup route tests', file: FILES.signupTest },
  blur: { id: taskId('T004'), title: 'Validate on blur in the form', file: FILES.form },
  docs: { id: taskId('T005'), title: 'Add docs for the validation error codes', file: FILES.docs },
});

function ledger(input: {
  readonly sessionId: string;
  readonly tasks: readonly EvidenceTask[];
  readonly validationSummary: EvidenceLedger['validationSummary'];
  readonly finalReview?: EvidenceLedger['finalReview'];
}): EvidenceLedger {
  return {
    version: 1,
    sessionId: input.sessionId,
    feature: SUMMARY_FIXTURE_FEATURE,
    mode: 'standard',
    generatedAt: GENERATED_AT,
    tasks: [...input.tasks],
    validationSummary: input.validationSummary,
    ...(input.finalReview !== undefined && { finalReview: input.finalReview }),
  };
}

function packetMarkdownPath(sessionId: string): string {
  return `.splitbrief/sessions/${sessionId}/review-packet.md`;
}

/** The packet counts the saved final review the way the orchestrator writes it, so the two agree. */
function reviewPacket(input: {
  readonly sessionId: string;
  readonly review: ReviewRecord;
  readonly driftPassed: boolean;
  readonly tasks: number;
}): ReviewPacketSummary {
  const outcome = reviewOutcomeOf(input.review);
  return {
    jsonPath: `.splitbrief/sessions/${input.sessionId}/review-packet.json`,
    markdownPath: packetMarkdownPath(input.sessionId),
    generatedAt: GENERATED_AT,
    finalReviewStatus: 'written',
    finalReviewVerdict: reviewOutcomeWord(outcome),
    finalReviewFindingCounts: reviewFindingCounts(outcome),
    driftPassed: input.driftPassed,
    evidenceValidatedTasks: input.tasks,
    evidenceTotalTasks: input.tasks,
    missingArtifactCount: 0,
  };
}

/** The pre-packet mirror of the same verdict, so the two fields can never disagree in a fixture. */
function legacyReview(packet: ReviewPacketSummary): Summary['review'] {
  return {
    verdict: packet.finalReviewVerdict,
    critical: packet.finalReviewFindingCounts.critical,
    warnings: packet.finalReviewFindingCounts.warning,
    notes: packet.finalReviewFindingCounts.note,
  };
}

const INTERRUPTED_BUILD_SESSION = 'visual-closed-ended';
const COMPLETE_SESSION = 'visual-closed-complete';
const NEEDS_ATTENTION_SESSION = 'visual-closed-needs-attention';

const INTERRUPTED_BUILD_TASKS: readonly BriefExecution[] = [
  {
    taskId: BRIEFS.validator.id,
    taskTitle: BRIEFS.validator.title,
    method: 'local',

    retryCount: 0,
    tool: 'ollama',
    model: 'qwen2.5-coder:7b',
  },
  {
    taskId: BRIEFS.wire.id,
    taskTitle: BRIEFS.wire.title,
    method: 'escalated-full',

    retryCount: 2,
    tool: 'ollama',
    model: 'qwen2.5-coder:7b',
  },
];

const INTERRUPTED_BUILD_LEDGER: EvidenceLedger = ledger({
  sessionId: INTERRUPTED_BUILD_SESSION,
  tasks: [
    {
      id: BRIEFS.validator.id,
      title: BRIEFS.validator.title,
      file: BRIEFS.validator.file,
      status: 'done',
      method: 'local',
      retries: 0,
      durationMs: 84_200,
      changedFiles: [FILES.validate],
      expectedEvidence: [FILES.validate],
      observedEvidence: [FILES.validate],
      escalated: false,
    },
    {
      id: BRIEFS.wire.id,
      title: BRIEFS.wire.title,
      file: BRIEFS.wire.file,
      status: 'escalated',
      method: 'escalated-full',
      retries: 2,
      durationMs: 312_600,
      changedFiles: [FILES.form, FILES.formTest],
      expectedEvidence: [FILES.form],
      observedEvidence: [FILES.form, FILES.formTest],
      escalated: true,
    },
    {
      id: BRIEFS.routeTests.id,
      title: BRIEFS.routeTests.title,
      file: BRIEFS.routeTests.file,
      status: 'in_progress',
      retries: 0,
      changedFiles: [FILES.signup, FILES.signupTest],
      expectedEvidence: [FILES.signupTest],
      observedEvidence: [FILES.signup, FILES.signupTest],
      escalated: false,
    },
    {
      id: BRIEFS.blur.id,
      title: BRIEFS.blur.title,
      file: BRIEFS.blur.file,
      status: 'pending',
      retries: 0,
      changedFiles: [],
      expectedEvidence: [FILES.form],
      observedEvidence: [],
      escalated: false,
    },
    {
      id: BRIEFS.docs.id,
      title: BRIEFS.docs.title,
      file: BRIEFS.docs.file,
      status: 'pending',
      retries: 0,
      changedFiles: [],
      expectedEvidence: [FILES.docs],
      observedEvidence: [],
      escalated: false,
    },
  ],
  validationSummary: { passed: 6, failed: 0, skipped: 0, escalated: 1 },
});

/** Two briefs settled, one halted mid-write with its files kept, two never started. */
const INTERRUPTED_BUILD_SUMMARY: Readonly<Summary> = Object.freeze({
  feature: SUMMARY_FIXTURE_FEATURE,
  phase: 'implementing',
  totalTasks: 5,
  completedByLocal: 1,
  escalatedToPlanner: 1,
  skipped: 0,
  failed: 0,
  totalTime: 581_000,
  activeTime: 581_000,

  escalationRate: 0.2,
  taskBreakdown: [...INTERRUPTED_BUILD_TASKS],

  plannerTool: 'claude-code',
  plannerModel: 'claude-sonnet-4',
  implementerTool: 'ollama',
  implementerModel: 'qwen2.5-coder:7b',
  phaseTimings: { planning: 182_000, implementing: 399_000 },
  mode: 'standard',
  driftSummary: { passed: true, score: 1, errorCount: 0, warningCount: 0 },
  changedFiles: [FILES.formTest, FILES.form, FILES.signupTest, FILES.signup, FILES.validate],
  stoppedAt: { taskId: BRIEFS.routeTests.id, partialFiles: [FILES.signupTest, FILES.signup] },
});

const READY_TASKS: readonly BriefExecution[] = [
  {
    taskId: BRIEFS.validator.id,
    taskTitle: BRIEFS.validator.title,
    method: 'local',

    retryCount: 0,
    tool: 'codex',
    model: 'gpt-5-mini',
  },
  {
    taskId: BRIEFS.wire.id,
    taskTitle: BRIEFS.wire.title,
    method: 'local',

    retryCount: 1,
    tool: 'codex',
    model: 'gpt-5-mini',
  },
  {
    taskId: BRIEFS.routeTests.id,
    taskTitle: BRIEFS.routeTests.title,
    method: 'local',

    retryCount: 0,
    tool: 'codex',
    model: 'gpt-5-mini',
  },
];

function settledLocalTasks(
  durations: readonly [number, number, number],
): (EvidenceTask & { durationMs: number; file: string })[] {
  return [
    {
      id: BRIEFS.validator.id,
      title: BRIEFS.validator.title,
      file: BRIEFS.validator.file,
      status: 'done',
      method: 'local',
      retries: 0,
      durationMs: durations[0],
      changedFiles: [FILES.validate],
      expectedEvidence: [FILES.validate],
      observedEvidence: [FILES.validate],
      escalated: false,
    },
    {
      id: BRIEFS.wire.id,
      title: BRIEFS.wire.title,
      file: BRIEFS.wire.file,
      status: 'done',
      method: 'local',
      retries: 1,
      durationMs: durations[1],
      changedFiles: [FILES.form, FILES.formTest],
      expectedEvidence: [FILES.form],
      observedEvidence: [FILES.form, FILES.formTest],
      escalated: false,
    },
    {
      id: BRIEFS.routeTests.id,
      title: BRIEFS.routeTests.title,
      file: BRIEFS.routeTests.file,
      status: 'done',
      method: 'local',
      retries: 0,
      durationMs: durations[2],
      changedFiles: [FILES.signupTest],
      expectedEvidence: [FILES.signupTest],
      observedEvidence: [FILES.signupTest],
      escalated: false,
    },
  ];
}

const VALIDATOR_NOTE: Finding = {
  id: 'F1',
  kind: 'defect',
  severity: 'minor',
  taskId: BRIEFS.validator.id,
  file: FILES.validate,
  line: null,
  text: 'isEmail trims the input a second time; the form already trims it.',
  acceptance: null,
  checkIds: null,
  criterionId: null,
};

/** The ready run's final review: it passed with one minor note on the validator. */
const READY_FINAL_REVIEW: ReviewRecord = {
  scope: 'final',
  cycle: 0,
  verdict: { tasks: [], criteria: [], findings: [VALIDATOR_NOTE] },
  outcome: 'pass-with-notes',
  verification: [],
  at: GENERATED_AT,
};

/** The final review that blocks a run: the two findings an Accept as is names, and the same note. */
const FAILED_REVIEW: ReviewRecord = {
  scope: 'final',
  cycle: 0,
  verdict: {
    tasks: [],
    criteria: [],
    findings: [
      {
        ...VALIDATOR_NOTE,
        severity: 'blocking',
        taskId: BRIEFS.wire.id,
        file: FILES.form,
        text: 'src/form.ts re-validates on every keystroke',
      },
      {
        ...VALIDATOR_NOTE,
        id: 'F2',
        severity: 'blocking',
        taskId: null,
        file: FILES.docs,
        text: 'docs/validation-errors.md names a retired code',
      },
      { ...VALIDATOR_NOTE, id: 'F3' },
    ],
  },
  outcome: 'fail',
  verification: [],
  at: GENERATED_AT,
};

const READY_PACKET = reviewPacket({
  sessionId: COMPLETE_SESSION,
  review: READY_FINAL_REVIEW,
  driftPassed: true,
  tasks: 3,
});

const READY_BRIEFS = settledLocalTasks([84_200, 141_000, 96_300]);
const READY_LEDGER: EvidenceLedger = ledger({
  sessionId: COMPLETE_SESSION,
  tasks: READY_BRIEFS,
  validationSummary: { passed: 9, failed: 0, skipped: 0, escalated: 0 },
  finalReview: { path: packetMarkdownPath(COMPLETE_SESSION), status: 'written' },
});

const READY_BUILD = { tool: 'codex', model: 'gpt-5-mini' } as const;
const READY_REVIEW = { tool: 'codex', model: 'gpt-5-codex' } as const;
const READY_REVIEW_MS = 65_000;

/** The finished run every fact agrees on: packet written, verdict allows it, scope clean. */
const READY_SUMMARY: Readonly<Summary> = Object.freeze({
  feature: SUMMARY_FIXTURE_FEATURE,
  phase: 'complete',
  totalTasks: 3,
  completedByLocal: 3,
  escalatedToPlanner: 0,
  skipped: 0,
  failed: 0,
  totalTime: 727_000,
  activeTime: 727_000,

  escalationRate: 0,
  taskBreakdown: [...READY_TASKS],
  plannerTool: 'codex',
  plannerModel: 'gpt-5.1',
  implementerTool: READY_BUILD.tool,
  implementerModel: READY_BUILD.model,
  reviewerTool: READY_REVIEW.tool,
  reviewerModel: READY_REVIEW.model,
  phaseTimings: { planning: 170_000, implementing: 492_000, review: READY_REVIEW_MS },
  mode: 'standard',
  driftSummary: { passed: true, score: 1, errorCount: 0, warningCount: 0 },
  reviewPacket: READY_PACKET,
  review: legacyReview(READY_PACKET),
  changedFiles: [FILES.formTest, FILES.form, FILES.signupTest, FILES.validate],
});

const NEEDS_ATTENTION_TASKS: readonly BriefExecution[] = [
  {
    taskId: BRIEFS.validator.id,
    taskTitle: BRIEFS.validator.title,
    method: 'local',

    retryCount: 0,
    tool: 'claude-code',
    model: 'claude-haiku-4-5',
  },
  {
    taskId: BRIEFS.wire.id,
    taskTitle: BRIEFS.wire.title,
    method: 'escalated-full',

    retryCount: 2,
    tool: 'claude-code',
    model: 'claude-haiku-4-5',
  },
  {
    taskId: BRIEFS.routeTests.id,
    taskTitle: BRIEFS.routeTests.title,
    method: 'local',

    retryCount: 0,
    tool: 'claude-code',
    model: 'claude-haiku-4-5',
  },
];

const NEEDS_ATTENTION_PACKET = reviewPacket({
  sessionId: NEEDS_ATTENTION_SESSION,
  review: FAILED_REVIEW,
  driftPassed: false,
  tasks: 3,
});

const NEEDS_ATTENTION_LEDGER: EvidenceLedger = ledger({
  sessionId: NEEDS_ATTENTION_SESSION,
  tasks: settledLocalTasks([84_200, 311_000, 96_300]).map((task) =>
    task.id === BRIEFS.wire.id
      ? {
          ...task,
          status: 'escalated',
          method: 'escalated-full',
          retries: 2,
          escalated: true,
        }
      : task,
  ),
  validationSummary: { passed: 9, failed: 0, skipped: 0, escalated: 1 },
  finalReview: { path: packetMarkdownPath(NEEDS_ATTENTION_SESSION), status: 'written' },
});

/** The same run, recorded before a record kept how long it ran: its block reads `Ran not recorded`. */
const { activeTime: _ranNotKept, ...OLDER_READY_SUMMARY } = READY_SUMMARY;

/** Every brief settled, but the review blocks it and the scope check found deviations. */
const NEEDS_ATTENTION_SUMMARY: Readonly<Summary> = Object.freeze({
  feature: SUMMARY_FIXTURE_FEATURE,
  phase: 'complete',
  totalTasks: 3,
  completedByLocal: 2,
  escalatedToPlanner: 1,
  skipped: 0,
  failed: 0,
  totalTime: 727_000,
  activeTime: 727_000,

  escalationRate: 1 / 3,
  taskBreakdown: [...NEEDS_ATTENTION_TASKS],

  plannerTool: 'claude-code',
  plannerModel: 'claude-sonnet-4',
  implementerTool: 'claude-code',
  implementerModel: 'claude-haiku-4-5',
  phaseTimings: { planning: 170_000, implementing: 492_000, review: 65_000 },
  mode: 'standard',
  driftSummary: { passed: false, score: 0.6, errorCount: 1, warningCount: 1 },
  reviewPacket: NEEDS_ATTENTION_PACKET,
  review: legacyReview(NEEDS_ATTENTION_PACKET),
  changedFiles: [FILES.formTest, FILES.form, FILES.signupTest, FILES.signup, FILES.validate],
});

// The run started when its log says it did, so a record is never dated apart from the transcript it
// replays.
const STARTED_AT_ISO = GENERATED_AT;

/**
 * The saved state a run leaves behind. Every at-rest scenario carries one, because a run whose
 * state cannot be read is a different scenario with a different byline.
 */
function savedState(
  input: {
    readonly phase: Phase;
    readonly briefs: readonly { id: string; status: Task['status'] }[];
    readonly currentTaskIndex?: number;
  } & Partial<Omit<WorkflowState, 'phase' | 'tasks'>>,
): WorkflowState {
  const { phase, briefs, currentTaskIndex, ...rest } = input;
  return {
    stateVersion: 1,
    phase,
    feature: AT_REST_FIXTURE_FEATURE,
    currentTaskIndex: currentTaskIndex ?? 0,
    attempt: 0,
    tasks: briefs.map((brief) => {
      const known = Object.values(BRIEFS).find((item) => item.id === brief.id);
      return makeTask({
        id: brief.id,
        status: brief.status,
        title: briefTitle(brief.id),
        ...(known !== undefined && { suggestedFiles: [known.file] }),
      });
    }),
    plannerSessionId: null,
    startedAt: STARTED_AT_ISO,

    plannerTool: 'claude-code',
    plannerModel: 'claude-sonnet-4',
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5-coder:7b',
    awaitingContinue: false,
    messageQueue: [],
    ...rest,
  };
}

function briefTitle(id: string): string {
  return Object.values(BRIEFS).find((brief) => brief.id === id)?.title ?? id;
}

function record(input: {
  readonly sessionId: string;
  readonly status: RunStatus;
  readonly state: WorkflowState;
  readonly summary?: Readonly<Summary>;
  readonly ledger?: EvidenceLedger;
  readonly checkpoint?: RunRecord['checkpoint'];
}): RunRecord & { hydration: { kind: 'loaded'; state: WorkflowState } } {
  return {
    ref: { projectDir: VISUAL_FIXTURE_PROJECT_DIR, sessionId: input.sessionId },
    feature: AT_REST_FIXTURE_FEATURE,
    startedAt: STARTED_AT_ISO,
    hydration: { kind: 'loaded', state: input.state },
    status: input.status,
    summary: input.summary ?? null,
    ledger: input.ledger ?? null,
    checkpoint: input.checkpoint ?? null,
  };
}

const AT_REST_PAUSED = record({
  sessionId: 'visual-at-rest-paused',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
    resumeAt: { kind: 'brief', taskId: BRIEFS.routeTests.id, attempt: 0 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 2,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'done' },
      { id: BRIEFS.routeTests.id, status: 'in_progress' },
      { id: BRIEFS.blur.id, status: 'pending' },
      { id: BRIEFS.docs.id, status: 'pending' },
    ],
  }),
});

/**
 * The paused run of `workflow-at-rest-paused`, which another process ends while this screen shows
 * it. Its ledger is on disk, so the close books T003's partial work as the real End run does.
 */
const CLOSED_ELSEWHERE_SESSION = 'visual-at-rest-closed-elsewhere';
const AT_REST_CLOSED_ELSEWHERE = record({
  sessionId: CLOSED_ELSEWHERE_SESSION,
  status: AT_REST_PAUSED.status,
  state: {
    ...AT_REST_PAUSED.hydration.state,
    tasks: AT_REST_PAUSED.hydration.state.tasks.map((task) =>
      task.id === BRIEFS.wire.id ? { ...task, action: 'modify' } : task,
    ),
  },
  ledger: ledger({
    sessionId: CLOSED_ELSEWHERE_SESSION,
    tasks: INTERRUPTED_BUILD_LEDGER.tasks.map((task) =>
      task.id === BRIEFS.validator.id
        ? { ...task, durationMs: 10_000 }
        : task.id === BRIEFS.wire.id
          ? {
              ...task,
              status: 'done',
              method: 'local',
              retries: 0,
              durationMs: 10_000,
              escalated: false,
            }
          : task,
    ),
    validationSummary: INTERRUPTED_BUILD_LEDGER.validationSummary,
  }),
});

const AT_REST_QUEUED = record({
  sessionId: 'visual-at-rest-queued',
  status: AT_REST_PAUSED.status,
  state: {
    ...AT_REST_PAUSED.hydration.state,
    messageQueue: [
      {
        ...makeMessage('Already reviewed'),
        id: 'reviewed',
        deliveredTo: { reviewer: GENERATED_AT },
      },
      { ...makeMessage('Keep the validation API'), id: 'pending' },
    ],
  },
});

/** The fallback the BUILD seat declares in config: a seat that cannot work moves to it. */
const SEAT_FALLBACK = {
  tool: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  variant: 'max',
} as const;

const SEAT_DOWN_HALT = buildSeatDownIssue({
  id: 'visual-halt',
  seat: 'build',
  runner: { ...visualConfig().implementer, fallback: SEAT_FALLBACK },
  classification: { class: 'account', cause: 'quota' },
  words: 'usage limit reached',
  task: makeTask({
    id: BRIEFS.wire.id,
    title: BRIEFS.wire.title,
    suggestedFiles: [BRIEFS.wire.file],
  }),
  phase: 'implementing',
  createdAt: STARTED_AT_ISO,
});

const AT_REST_HALTED = record({
  sessionId: 'visual-at-rest-halted',
  status: {
    kind: 'open',
    stop: {
      kind: 'waiting-for-you',
      on: {
        kind: 'halt',
        issue: SEAT_DOWN_HALT,
      },
    },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 2 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
      { id: BRIEFS.routeTests.id, status: 'pending' },
    ],
    pendingRecovery: SEAT_DOWN_HALT,
  }),
});

const HALTED_BUILD_SEAT = { tool: BASE_IMPLEMENTER.provider, model: BASE_IMPLEMENTER.model };
const HALTED_BUILD_LOG: readonly EngineEvent[] = [
  makeTaskStart({
    taskId: BRIEFS.validator.id,
    title: BRIEFS.validator.title,
    file: BRIEFS.validator.file,
    ts: VISUAL_FIXTURE_EPOCH - 170_000,
    backendKind: BASE_IMPLEMENTER.kind,
    ...HALTED_BUILD_SEAT,
  }),
  makeTaskComplete({
    taskId: BRIEFS.validator.id,
    title: BRIEFS.validator.title,
    ts: VISUAL_FIXTURE_EPOCH - 110_000,
    duration: 60_000,
    ...HALTED_BUILD_SEAT,
  }),
  makeTaskStart({
    taskId: BRIEFS.wire.id,
    title: BRIEFS.wire.title,
    file: BRIEFS.wire.file,
    index: 1,
    lineageAttempt: 2,
    ts: VISUAL_FIXTURE_EPOCH - 50_000,
    backendKind: BASE_IMPLEMENTER.kind,
    ...HALTED_BUILD_SEAT,
  }),
  {
    type: 'error',
    phase: 'implementing',
    ts: VISUAL_FIXTURE_EPOCH,
    message: SEAT_DOWN_HALT.message,
  },
];

/** A BUILD seat on the one tool with an input limit, declaring a fallback that has none. */
const LIMITED_IMPLEMENTER = {
  kind: 'cli',
  tool: 'codex',
  model: 'gpt-5-codex',
  fallback: { tool: 'claude-code' },
} as const;

const PROMPT_TOO_LARGE_HALT = buildRunnerInputTooLargeRecoveryIssue({
  id: 'visual-prompt-too-large',
  task: makeTask({
    id: BRIEFS.wire.id,
    title: BRIEFS.wire.title,
    suggestedFiles: [BRIEFS.wire.file],
  }),
  phase: 'implementing',
  runner: LIMITED_IMPLEMENTER,
  toolMessage: CODEX_INPUT_TOO_LARGE,
  attempts: 1,
  seatSwap: {
    seat: 'build',
    currentTool: 'codex',
    fallback: LIMITED_IMPLEMENTER.fallback,
    detectedTools: [{ ...LIMITED_IMPLEMENTER.fallback, ready: true }],
  },
  createdAt: STARTED_AT_ISO,
});

const AT_REST_PROMPT_TOO_LARGE = record({
  sessionId: 'visual-at-rest-prompt-too-large',
  status: {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: PROMPT_TOO_LARGE_HALT } },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 1 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
      { id: BRIEFS.routeTests.id, status: 'pending' },
    ],
    implementerTool: LIMITED_IMPLEMENTER.tool,
    implementerModel: LIMITED_IMPLEMENTER.model,
    pendingRecovery: PROMPT_TOO_LARGE_HALT,
  }),
});

/**
 * A brief routed to a Codex profile hit its usage limit and the run waits for the reset; the saved
 * BUILD seat is Ollama, so the byline names the tool the wait is on, not the saved one.
 */
const CODEX_WAIT: SeatWait = {
  seat: 'build',
  tool: 'codex',
  kind: 'cli',
  resetAt: '2026-09-14T17:00:00.000Z',
};
const SEAT_WAIT_STATE = savedState({
  phase: 'implementing',
  currentTaskIndex: 1,
  briefs: [
    { id: BRIEFS.validator.id, status: 'done' },
    { id: BRIEFS.wire.id, status: 'in_progress' },
    { id: BRIEFS.routeTests.id, status: 'pending' },
  ],
  seatWait: CODEX_WAIT,
});

/** The log of a wait: its start, and the end a stop writes when it keeps the wait. */
function seatWaitLog(wait: SeatWait, kept: boolean): readonly EngineEvent[] {
  const ts = Date.parse(STARTED_AT_ISO) + 60_000;
  const started: EngineEvent = {
    type: 'seat_wait_started',
    ts,
    phase: 'implementing',
    seat: wait.seat,
    resetAt: wait.resetAt,
    tool: 'OpenAI Codex CLI',
    wait,
  };
  if (!kept) return [started];
  return [
    started,
    { type: 'seat_wait_ended', ts: ts + 1_000, phase: 'implementing', seat: wait.seat, kept: true },
  ];
}
const AT_REST_SEAT_WAIT = record({
  sessionId: 'visual-at-rest-seat-wait',
  status: deriveRunStatus({ state: SEAT_WAIT_STATE, liveness: 'not-alive', reviewNone: false }),
  state: SEAT_WAIT_STATE,
});

/** The same wait while another process holds the run: the byline names the wait it shows live. */
const AT_REST_SEAT_WAIT_ELSEWHERE = record({
  sessionId: 'visual-at-rest-seat-wait-elsewhere',
  status: deriveRunStatus({ state: SEAT_WAIT_STATE, liveness: 'alive', reviewNone: false }),
  state: SEAT_WAIT_STATE,
});

/**
 * The same wait after `/crew` moved BUILD off the Codex tool the wait holds: the run stopped, and
 * the byline names no wait on a tool the seat no longer runs.
 */
const SEAT_MOVED_WAIT: SeatWait = { ...CODEX_WAIT, holds: { tool: 'codex', kind: 'cli' } };
const SEAT_MOVED_STATE: WorkflowState = {
  ...SEAT_WAIT_STATE,
  awaitingContinue: true,
  seatWait: SEAT_MOVED_WAIT,
};
const AT_REST_SEAT_MOVED = record({
  sessionId: 'visual-at-rest-seat-moved',
  status: deriveRunStatus({ state: SEAT_MOVED_STATE, liveness: 'not-alive', reviewNone: false }),
  state: SEAT_MOVED_STATE,
});

/** The same halt with Try again chosen and saved, and the process killed before it ran. */
const SEAT_DOWN_HALT_CHOSEN: RecoveryIssue = {
  ...SEAT_DOWN_HALT,
  status: 'applying',
  selectedAction: 'retry-same-worker',
};
const AT_REST_HALTED_CHOSEN = record({
  sessionId: 'visual-at-rest-halted-chosen',
  status: {
    kind: 'open',
    stop: {
      kind: 'waiting-for-you',
      on: {
        kind: 'halt',
        issue: SEAT_DOWN_HALT_CHOSEN,
      },
    },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 2 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
      { id: BRIEFS.routeTests.id, status: 'pending' },
    ],
    pendingRecovery: SEAT_DOWN_HALT_CHOSEN,
  }),
});

/** The log carries the rows the halt wrote: the error that states the evidence and the recovery card. */
export const LEFT_ISOLATION_LOG = 'testing/fixtures/session-log/left-isolation.jsonl';

const LEFT_ISOLATION_IMPLEMENTER = {
  kind: 'cli',
  tool: 'antigravity',
  model: 'gemini-3-flash',
} as const;

const LEFT_ISOLATION_HALT: RecoveryIssue = buildLeftIsolationRecoveryIssue({
  id: 'visual-left-isolation',
  task: makeTask({
    id: BRIEFS.wire.id,
    title: BRIEFS.wire.title,
    suggestedFiles: [BRIEFS.wire.file],
  }),
  phase: 'implementing',
  runner: LEFT_ISOLATION_IMPLEMENTER,
  toolMessage: LEFT_ISOLATION_WRITE,
  attempts: 1,
  createdAt: STARTED_AT_ISO,
});

const AT_REST_LEFT_ISOLATION = record({
  sessionId: 'visual-at-rest-left-isolation',
  status: {
    kind: 'open',
    stop: {
      kind: 'waiting-for-you',
      on: {
        kind: 'halt',
        issue: LEFT_ISOLATION_HALT,
      },
    },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 0 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
      { id: BRIEFS.routeTests.id, status: 'pending' },
    ],
    pendingRecovery: LEFT_ISOLATION_HALT,
  }),
});

const AT_REST_WAITING_GATE = record({
  sessionId: 'visual-at-rest-waiting-gate',
  status: {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'spec' } },
    resumeAt: { kind: 'gate', gate: 'spec' },
  },
  state: savedState({ phase: 'reviewing-spec', briefs: [] }),
});

const AT_REST_QUESTIONS: readonly ClarificationQuestion[] = [
  {
    id: 'module',
    type: 'choice',
    text: 'Which module should change?',
    options: ['src/auth.ts', 'src/session.ts'],
    default: 'src/auth.ts',
  },
  { id: 'api', type: 'confirm', text: 'Keep the public API?', default: true },
];

/** A run that stopped while the planner waited for the answers to its first round. */
const AT_REST_QUESTION = record({
  sessionId: 'visual-at-rest-question',
  status: {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'question' } },
    resumeAt: { kind: 'planner', call: 'plan' },
  },
  state: savedState({
    phase: 'planning',
    briefs: [],
    pendingPlannerConversation: {
      call: 'plan',
      text: '',
      questions: [...AT_REST_QUESTIONS],
      answers: [],
      answered: false,
    },
  }),
});

const QUESTION_TS = VISUAL_FIXTURE_EPOCH - 60_000;
const AT_REST_QUESTION_LOG: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: QUESTION_TS,
    phase: 'planning',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  { type: 'user_message', ts: QUESTION_TS + 10, phase: 'planning', text: AT_REST_FIXTURE_FEATURE },
  {
    type: 'planner_text',
    ts: QUESTION_TS + 100,
    phase: 'planning',
    role: 'planner',
    content: 'plain',
    text: 'Questions before the plan · round 1 of 2',
  },
];

/**
 * A quick run saved while it still researched: the rail folds the phase into Plan, and the paused
 * stop marks Plan.
 */
const AT_REST_QUICK = record({
  sessionId: 'visual-at-rest-quick',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
    resumeAt: { kind: 'planner', call: 'plan' },
  },
  state: savedState({ phase: 'researching', briefs: [] }),
});

// The consult seat completed the brief that needed a retry.
const CLOSED_COMPLETE_SUMMARY: Summary = {
  ...OLDER_READY_SUMMARY,
  taskBreakdown: READY_TASKS.map((task) =>
    task.taskId === BRIEFS.wire.id ? { ...task, method: 'consulted' } : task,
  ),
};

/** The ready run's review ended its run time after the start: the run completed then. */
const READY_COMPLETED_AT = new Date(
  Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime,
).toISOString();

const CLOSED_COMPLETE = record({
  sessionId: COMPLETE_SESSION,
  status: { kind: 'closed', as: 'complete' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'done' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
    review: READY_FINAL_REVIEW,
    completedAt: READY_COMPLETED_AT,
  }),
  summary: CLOSED_COMPLETE_SUMMARY,
  ledger: {
    ...READY_LEDGER,
    tasks: READY_LEDGER.tasks.map((task) =>
      task.id === BRIEFS.wire.id ? { ...task, method: 'consulted' } : task,
    ),
  },
});

/** The reviewed workspace the checkout has not received: the result menu's own run. */
const RUN_WORKSPACE = {
  kind: 'worktree' as const,
  path: '.splitbrief/worktrees/visual/workspace',
  base: { snapshotId: 'workspace-base', head: null },
};

const WORKSPACE_BRIEFS = [
  { id: BRIEFS.validator.id, status: 'done' as const },
  { id: BRIEFS.wire.id, status: 'done' as const },
  { id: BRIEFS.routeTests.id, status: 'done' as const },
];

/** The ready run's record under another session: its packet sits in that session's own folder. */
function workspaceSummary(sessionId: string): Readonly<Summary> {
  return {
    ...READY_SUMMARY,
    reviewPacket: {
      ...READY_PACKET,
      jsonPath: `.splitbrief/sessions/${sessionId}/review-packet.json`,
      markdownPath: packetMarkdownPath(sessionId),
    },
  };
}

/** The record a run with REVIEW None writes: no review seat, verdict, scope report, packet or review time. */
function reviewNoneSummary(recorded: Readonly<Summary>): Readonly<Summary> {
  const {
    review: _noVerdict,
    reviewerTool: _noTool,
    reviewerModel: _noModel,
    driftSummary: _noScopeReport,
    reviewPacket: _noPacket,
    ...summary
  } = recorded;
  const phaseTimings = { planning: 170_000, implementing: 492_000 };
  const ran = phaseTimings.planning + phaseTimings.implementing;
  return {
    ...summary,
    reviewerSeat: 'none',

    phaseTimings,
    totalTime: ran,
    activeTime: ran,
  };
}

function reviewNoneLedger(sessionId: string): EvidenceLedger {
  return {
    ...READY_LEDGER,
    sessionId,
    finalReview: { path: REVIEW_FILE, status: 'skipped' },
  };
}

const CLOSED_REVIEW_NONE_SUMMARY = reviewNoneSummary(READY_SUMMARY);
const { review: _noReviewSaved, ...CLOSED_REVIEW_NONE_STATE } = CLOSED_COMPLETE.hydration.state;
const CLOSED_REVIEW_NONE = record({
  sessionId: 'visual-closed-none',
  status: CLOSED_COMPLETE.status,
  state: {
    ...CLOSED_REVIEW_NONE_STATE,
    reviewStatus: 'none',
    reviewerSeat: 'none',
    completedAt: new Date(
      Date.parse(STARTED_AT_ISO) + CLOSED_REVIEW_NONE_SUMMARY.totalTime,
    ).toISOString(),
  },
  summary: CLOSED_REVIEW_NONE_SUMMARY,
  ledger: reviewNoneLedger('visual-closed-none'),
});

const READY_TO_APPLY = record({
  sessionId: 'visual-ready-to-apply',
  status: { kind: 'ready-to-apply', override: false },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
  }),
  summary: workspaceSummary('visual-ready-to-apply'),
  ledger: READY_LEDGER,
});

const READY_REVIEW_NONE = record({
  sessionId: 'visual-ready-none',
  status: READY_TO_APPLY.status,
  state: { ...READY_TO_APPLY.hydration.state, reviewStatus: 'none', reviewerSeat: 'none' },
  summary: reviewNoneSummary(workspaceSummary('visual-ready-none')),
  ledger: reviewNoneLedger('visual-ready-none'),
});

/** The ready run whose reviewer ran Codex at a set effort, so its recorded crew names the effort. */
const READY_CREW_SAVED = record({
  sessionId: 'visual-ready-crew-saved',
  status: READY_TO_APPLY.status,
  state: READY_TO_APPLY.hydration.state,
  summary: {
    ...workspaceSummary('visual-ready-crew-saved'),
    reviewerTool: 'codex',
    reviewerModel: READY_REVIEW.model,
    reviewerKind: 'cli',
    reviewerAxes: ['high'],
  },
  ledger: { ...READY_LEDGER, sessionId: 'visual-ready-crew-saved' },
});

/**
 * A ready run whose BUILD seat moved to Antigravity with its model left automatic after the first
 * brief: the moved seat names the tool it moved to, and the sidebar breaks it after the arrow.
 */
const READY_SEAT_MOVED_AUTO = record({
  sessionId: 'visual-ready-seat-moved-auto',
  status: READY_TO_APPLY.status,
  state: READY_TO_APPLY.hydration.state,
  summary: {
    ...workspaceSummary('visual-ready-seat-moved-auto'),
    implementerTool: 'antigravity',
    implementerModel: 'auto',
    taskBreakdown: READY_TASKS.map((task, index) => ({
      ...task,
      ...(index === 0
        ? { tool: 'antigravity', model: 'gemini-3.8-flash-high' }
        : { tool: 'antigravity', model: 'auto' }),
    })),
  },
  ledger: { ...READY_LEDGER, sessionId: 'visual-ready-seat-moved-auto' },
});

/** The ready run while an Apply holds it: the record reads running, not ready. */
const APPLYING = record({
  sessionId: 'visual-at-rest-applying',
  status: { kind: 'running' },
  state: READY_TO_APPLY.hydration.state,
  summary: workspaceSummary('visual-at-rest-applying'),
  ledger: READY_LEDGER,
});

const CONTINUOUS_READY = record({
  sessionId: 'visual-continuous-transcript-ready',
  status: { kind: 'ready-to-apply', override: false },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'done' },
    ],
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
  }),
});

const CONTINUOUS_READY_TS = Date.parse(STARTED_AT_ISO);
const CONTINUOUS_READY_BUILD_SEAT = {
  kind: 'cli',
  tool: 'claude-code',
  model: 'opus',
  effort: 'max',
} as const;
const CONTINUOUS_READY_EVENTS: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: CONTINUOUS_READY_TS,
    phase: 'planning',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  {
    type: 'user_message',
    ts: CONTINUOUS_READY_TS + 10,
    phase: 'planning',
    text: 'Add email validation with tests.',
  },
  {
    type: 'planner_text',
    ts: CONTINUOUS_READY_TS + 20,
    phase: 'planning',
    content: 'markdown',
    text: 'Validate the input before the form sends it.',
  },
  {
    type: 'full_suite',
    ts: CONTINUOUS_READY_TS + 30,
    phase: 'planning',
    moment: 'plan',
    id: 'K1',
    command: 'npm run typecheck',
    status: 'done',
    passed: true,
    duration: 1_000,
  },
  { type: 'plan_approved', ts: CONTINUOUS_READY_TS + 50, phase: 'reviewing-plan' },
  {
    type: 'tasks_planned',
    ts: CONTINUOUS_READY_TS + 60,
    phase: 'implementing',
    total: 2,
    tasks: [BRIEFS.validator, BRIEFS.wire].map((brief, index) => ({
      ...brief,
      index,
      action: 'create',
    })),
  },
  ...[BRIEFS.validator, BRIEFS.wire].flatMap((brief, index): EngineEvent[] => [
    {
      type: 'task_started',
      ts: CONTINUOUS_READY_TS + 100 + index * 200,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      file: brief.file,
      index,
      total: 2,
      action: 'create',
      tool: CONTINUOUS_READY_BUILD_SEAT.tool,
      model: CONTINUOUS_READY_BUILD_SEAT.model,
      axes: ['max'],
    },
    {
      type: 'planner_text',
      ts: CONTINUOUS_READY_TS + 110 + index * 200,
      phase: 'implementing',
      role: 'implementer',
      text: `Checked \`${brief.file}\` against the form tests.`,
    },
    {
      type: 'task_completed',
      ts: CONTINUOUS_READY_TS + 200 + index * 200,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      method: 'local',
      retries: 0,
      duration: 2_000,
      tool: CONTINUOUS_READY_BUILD_SEAT.tool,
      model: CONTINUOUS_READY_BUILD_SEAT.model,
    },
  ]),
  {
    type: 'full_suite',
    ts: CONTINUOUS_READY_TS + 2_000,
    phase: 'final-review',
    moment: 'plan',
    id: 'K2',
    command: 'npm run lint',
    status: 'done',
    passed: true,
    duration: 1_000,
  },
  {
    type: 'full_suite',
    ts: CONTINUOUS_READY_TS + 3_000,
    phase: 'final-review',
    moment: 'pre-review',
    id: 'V1',
    command: 'npm test',
    status: 'done',
    passed: true,
    duration: 1_000,
  },
  {
    type: 'workflow_complete',
    ts: CONTINUOUS_READY_TS + 8_000,
    phase: 'complete',
    review: 'passed',
  },
];

const READY_OVERRIDE = record({
  sessionId: 'visual-ready-override',
  status: { kind: 'ready-to-apply', override: true },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'failed',
    acceptedAsIs: {
      at: GENERATED_AT,
      findings: [
        'src/form.ts re-validates on every keystroke',
        'docs/validation-errors.md names a retired code',
      ],
    },
    workspace: RUN_WORKSPACE,
  }),
  summary: workspaceSummary('visual-ready-override'),
  ledger: READY_LEDGER,
});

/** A reviewer finding keeps its title and body on two lines; the confirmation names it on one row. */
const READY_OVERRIDE_MULTILINE = record({
  sessionId: 'visual-ready-override-confirm',
  status: READY_OVERRIDE.status,
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'failed',
    acceptedAsIs: {
      at: GENERATED_AT,
      findings: [
        'Edge case missing\nsrc/form.ts re-validates on every keystroke',
        'docs/validation-errors.md names a retired code',
      ],
    },
    workspace: RUN_WORKSPACE,
  }),
  summary: workspaceSummary('visual-ready-override-confirm'),
  ledger: READY_LEDGER,
});

const RED_CHECK_COMMAND = 'npm test';
const RED_CHECK_LAST_LINE = 'Error: 2 specs failed';
const RED_CHECK_OUTPUT = [
  '> app@1.4.0 test',
  '> node tools/run-specs.mjs',
  '',
  'signup form: expected 1 message, got 0',
  'signup route: expected status 400, got 200',
  RED_CHECK_LAST_LINE,
].join('\n');
const RED_CHECK_KEY = 'exited with code 1';

/** The red reviewer check as the run queues it for the review: its command and its whole output. */
export const RED_CHECK_INPUT: TriageInput = {
  id: 'V1.1',
  kind: 'defect',
  source: 'check',
  file: null,
  text: `Reviewer check V1 (${RED_CHECK_COMMAND}) failed with new failures.\n${checkFailureText({
    checkId: 'V1',
    status: 'fail',
    command: RED_CHECK_COMMAND,
    exitCode: 1,
    output: RED_CHECK_OUTPUT,
    failure: { keys: [RED_CHECK_KEY], placeholder: `${RED_CHECK_KEY}: ${RED_CHECK_LAST_LINE}` },
    preExisting: [],
  })}`,
  checkIds: ['V1'],
  command: RED_CHECK_COMMAND,
  output: RED_CHECK_OUTPUT,
  redKeys: [RED_CHECK_KEY],
};

/** The same check as an Accept as is records it: its id, its command, the last line it printed. */
const RED_REVIEWER_CHECK = { id: 'V1', command: RED_CHECK_COMMAND, lastLine: RED_CHECK_LAST_LINE };
/** A plan check that ran no command, as the same accept records it. */
const RED_PLAN_CHECK = { id: 'K004', lastLine: 'src/a.ts(3,1): TS2322' };

/** You accepted a run with two red checks and two open findings: Apply as is names the checks first. */
const READY_RED_CHECK = record({
  sessionId: 'visual-ready-red-check',
  status: READY_OVERRIDE.status,
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'failed',
    acceptedAsIs: {
      at: GENERATED_AT,
      findings: [
        'src/form.ts re-validates on every keystroke',
        'docs/validation-errors.md names a retired code',
      ],
      redChecks: [RED_REVIEWER_CHECK, RED_PLAN_CHECK],
    },
    workspace: RUN_WORKSPACE,
  }),
  summary: workspaceSummary('visual-ready-red-check'),
  ledger: READY_LEDGER,
});

const PLANNER_ACCEPT_NOTE =
  'Re-validating on each keystroke is the documented form behaviour; the retired code is kept for old clients.';

/** The planner accepted the blockers of a review without progress: the confirmation names its note. */
const READY_PLANNER_ACCEPT = record({
  sessionId: 'visual-ready-planner-accept',
  status: READY_OVERRIDE.status,
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'failed',
    acceptedAsIs: {
      at: GENERATED_AT,
      findings: [
        'src/form.ts re-validates on every keystroke',
        'docs/validation-errors.md names a retired code',
      ],
      note: PLANNER_ACCEPT_NOTE,
      by: 'planner',
    },
    workspace: RUN_WORKSPACE,
  }),
  summary: workspaceSummary('visual-ready-planner-accept'),
  ledger: READY_LEDGER,
});

const PLANNER_ACCEPT_LONG_NOTE = Array.from(
  { length: 12 },
  (_, index) =>
    `Reason ${index + 1}: re-validating on each keystroke is the documented form behaviour, and the retired code is kept for old clients.`,
).join(' ');

/** A note taller than the terminal: the title, the rows and the findings stay on screen. */
const READY_PLANNER_ACCEPT_LONG_NOTE = record({
  sessionId: 'visual-ready-planner-accept-long-note',
  status: READY_OVERRIDE.status,
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'failed',
    acceptedAsIs: {
      at: GENERATED_AT,
      findings: [
        'src/form.ts re-validates on every keystroke',
        'docs/validation-errors.md names a retired code',
      ],
      note: PLANNER_ACCEPT_LONG_NOTE,
      by: 'planner',
    },
    workspace: RUN_WORKSPACE,
  }),
  summary: workspaceSummary('visual-ready-planner-accept-long-note'),
  ledger: READY_LEDGER,
});

/** The transcript names each brief's action the way the saved task the closed block reads names it. */
function savedAction(state: WorkflowState, id: string): Task['action'] {
  const task = state.tasks.find((item) => item.id === id);
  if (task === undefined) throw new Error(`The fixture state has no brief ${id}`);
  return task.action;
}

/**
 * The transcript of a closed run, built from its own record: the plan, each brief on the seat that
 * built it, each review the ledger names, the review of record as the packet states it, then the
 * way the run closed. The record keeps one time for all its reviews, so they share it in equal parts.
 */
function recordedRunLog(run: RunRecord): EngineEvent[] {
  const { summary, ledger, hydration } = run;
  const packet = summary?.reviewPacket;
  const reviewTool = summary?.reviewerTool ?? summary?.plannerTool;
  const planMs = summary?.phaseTimings?.planning;
  const reviewPhaseMs = summary?.phaseTimings?.review;
  if (
    summary === null ||
    ledger === null ||
    hydration.kind !== 'loaded' ||
    packet === undefined ||
    reviewTool === undefined ||
    planMs === undefined ||
    reviewPhaseMs === undefined
  ) {
    throw new Error(`The fixture run ${run.ref.sessionId} holds no reviewed record`);
  }
  const { state } = hydration;
  const reviewModel =
    summary.reviewerTool === undefined ? summary.plannerModel : summary.reviewerModel;
  const reviewSeat = { tool: reviewTool, ...(reviewModel !== undefined && { model: reviewModel }) };
  const reviews = ledger.reviews ?? [];
  const earlier = reviews.slice(0, -1);
  const reviewMs = reviewPhaseMs / Math.max(reviews.length, 1);
  const verdict =
    packet.finalReviewStatus !== 'written' || packet.finalReviewVerdict === null
      ? 'no-verdict'
      : packet.finalReviewVerdict === 'pass_with_notes'
        ? 'pass-with-notes'
        : packet.finalReviewVerdict;
  const events: EngineEvent[] = [];
  let ts = Date.parse(STARTED_AT_ISO);
  let fixCycles = 0;

  const review = (
    entry: Pick<EvidenceReview, 'scope' | 'afterTaskId' | 'cycle'>,
    outcome: Pick<EngineEventOf<'review_completed'>, 'verdict' | 'findings' | 'blockingFindings'>,
  ) => {
    if (entry.scope === 'final' && entry.cycle > fixCycles) {
      fixCycles = entry.cycle;
      events.push({
        type: 'review_fix_started',
        ts,
        phase: 'implementing',
        cycle: fixCycles,
        taskIds: [],
      });
    }
    const phase: Phase = entry.scope === 'final' ? 'final-review' : 'implementing';
    const call = {
      phase,
      scope: entry.scope,
      ...(entry.afterTaskId !== undefined && { afterTaskId: entry.afterTaskId }),
      ...reviewSeat,
    };
    events.push({ type: 'review_started', ts, ...call });
    ts += reviewMs;
    events.push({ type: 'review_completed', ts, ...call, ...outcome, duration: reviewMs });
  };
  const ledgerReview = (entry: EvidenceReview) =>
    review(entry, {
      verdict: entry.outcome,
      findings: { blocking: entry.blocking.length, minor: 0, outOfScope: 0 },
      blockingFindings: entry.blocking,
    });

  events.push({ type: 'workflow_started', ts, phase: 'planning', feature: run.feature });
  ts += planMs;
  events.push({ type: 'plan_approved', ts, phase: 'planning' });
  ledger.tasks.forEach((brief, index) => {
    const built = summary.taskBreakdown?.find((task) => task.taskId === brief.id);
    if (built === undefined || brief.durationMs === undefined) {
      throw new Error(`The fixture run ${run.ref.sessionId} holds no build record of ${brief.id}`);
    }
    const seat = {
      ...(built.tool !== undefined && { tool: built.tool }),
      ...(built.model !== undefined && { model: built.model }),
      ...(built.implementerProfile !== undefined && {
        implementerProfile: built.implementerProfile,
      }),
    };
    events.push({
      type: 'task_started',
      ts,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      file: brief.file,
      action: savedAction(state, brief.id),
      index,
      total: ledger.tasks.length,
      ...seat,
    });
    ts += brief.durationMs;
    events.push({
      type: 'task_completed',
      ts,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      method: built.method,
      retries: built.retryCount,
      duration: brief.durationMs,
      ...seat,
    });
    for (const entry of earlier) {
      if (entry.scope === 'task' && entry.afterTaskId === brief.id) ledgerReview(entry);
    }
  });
  for (const entry of earlier) {
    if (entry.scope === 'final') ledgerReview(entry);
  }
  const counts = packet.finalReviewFindingCounts;
  review(
    { scope: 'final', cycle: reviews.at(-1)?.cycle ?? 0 },
    verdict === 'no-verdict'
      ? { verdict }
      : {
          verdict,
          findings: { blocking: counts.critical, minor: counts.warning, outOfScope: counts.note },
        },
  );
  if (verdict !== 'no-verdict') {
    events.push({
      type: 'workflow_complete',
      ts,
      phase: 'complete',
      review: verdict === 'fail' ? 'failed' : 'passed',
      ...(verdict === 'fail' && { blocking: counts.critical }),
      completedTasks: ledger.tasks.length,
    });
  }
  if (run.status.kind === 'closed' && run.status.as === 'ended') {
    events.push({
      type: 'workflow_cancelled',
      ts,
      phase: state.phase,
      reason: WORKFLOW_CANCEL_REASON_USER,
    });
  }
  return events;
}

const READY_LOG: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: Date.parse(STARTED_AT_ISO),
    phase: 'implementing',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  ...READY_BRIEFS.flatMap((brief, index): EngineEvent[] => [
    {
      type: 'task_started',
      ts: Date.parse(STARTED_AT_ISO) + index * 180_000,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      file: brief.file,
      action: savedAction(READY_TO_APPLY.hydration.state, brief.id),
      index,
      total: READY_LEDGER.tasks.length,
      ...READY_BUILD,
    },
    {
      type: 'task_completed',
      ts: Date.parse(STARTED_AT_ISO) + index * 180_000 + brief.durationMs,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      method: 'local',
      retries: brief.retries,
      duration: brief.durationMs,
      ...READY_BUILD,
    },
  ]),
  {
    type: 'review_started',
    ts: Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime - READY_REVIEW_MS,
    phase: 'final-review',
    scope: 'final',
    tool: 'claude-code',
    model: 'claude-sonnet-4',
  },
  {
    type: 'review_completed',
    ts: Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime,
    phase: 'final-review',
    scope: 'final',
    tool: 'claude-code',
    model: 'claude-sonnet-4',
    verdict: READY_FINAL_REVIEW.outcome,
    findings: {
      blocking: READY_PACKET.finalReviewFindingCounts.critical,
      minor: READY_PACKET.finalReviewFindingCounts.warning,
      outOfScope: READY_PACKET.finalReviewFindingCounts.note,
    },
    duration: READY_REVIEW_MS,
  },
  {
    type: 'workflow_complete',
    ts: Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime,
    phase: 'complete',
    review: 'passed',
    completedTasks: READY_LEDGER.tasks.length,
  },
];

const READY_REVIEW_NONE_LOG: readonly EngineEvent[] = READY_LOG.flatMap((event): EngineEvent[] => {
  if (event.type === 'review_started' || event.type === 'review_completed') return [];
  return event.type === 'workflow_complete' ? [{ ...event, review: 'none' }] : [event];
});

/**
 * A transcript built on the ready log, under the plan stage of a closed run's own record: the plan
 * opens the run, and every later event moves by the plan time, so the build starts at the approval.
 */
function withRecordedPlan(run: RunRecord, log: readonly EngineEvent[]): EngineEvent[] {
  const planMs = run.summary?.phaseTimings?.planning;
  const [started, ...rest] = log;
  if (planMs === undefined || started?.type !== 'workflow_started') {
    throw new Error(`The fixture run ${run.ref.sessionId} holds no plan time or its log no start`);
  }
  return [
    { ...started, phase: 'planning' },
    { type: 'plan_approved', ts: started.ts + planMs, phase: 'planning' },
    ...rest.map((event) => ({ ...event, ts: event.ts + planMs })),
  ];
}

const READY_OVERRIDE_LOG: readonly EngineEvent[] = READY_LOG.map((event) =>
  event.type === 'review_completed'
    ? { ...event, verdict: 'fail', findings: { blocking: 2, minor: 0, outOfScope: 0 } }
    : event.type === 'workflow_complete'
      ? { ...event, review: 'failed', blocking: 2 }
      : event,
);

/** The row of the red reviewer check: all its failures are new, and it settles before the review. */
function redReviewerCheckRow(ts: number): EngineEvent {
  return {
    type: 'full_suite',
    ts,
    phase: 'final-review',
    moment: 'pre-review',
    status: 'done',
    id: RED_REVIEWER_CHECK.id,
    command: RED_CHECK_COMMAND,
    passed: false,
    newFailures: 1,
    preExisting: 0,
    newKeys: [RED_CHECK_KEY],
    preExistingKeys: [],
    duration: 12_400,
  };
}

/** Both red checks stand before the failed review, which counts each one as blocking. */
const READY_RED_CHECK_LOG: readonly EngineEvent[] = READY_OVERRIDE_LOG.flatMap(
  (event): EngineEvent[] => {
    if (event.type === 'review_started') {
      return [
        {
          type: 'full_suite',
          ts: event.ts,
          phase: 'final-review',
          moment: 'plan',
          status: 'done',
          id: RED_PLAN_CHECK.id,
          command: '',
          passed: false,
          detail: RED_PLAN_CHECK.lastLine,
          duration: 3_100,
        },
        redReviewerCheckRow(event.ts),
        event,
      ];
    }
    if (event.type === 'review_completed') {
      return [{ ...event, findings: { blocking: 4, minor: 0, outOfScope: 0 } }];
    }
    return [event.type === 'workflow_complete' ? { ...event, blocking: 4 } : event];
  },
);

/** The planner's accept stands in the transcript between the failed review and the run's end. */
const READY_PLANNER_ACCEPT_LOG: readonly EngineEvent[] = READY_OVERRIDE_LOG.flatMap(
  (event): EngineEvent[] =>
    event.type === 'workflow_complete'
      ? [
          {
            type: 'consult_answered',
            ts: event.ts,
            phase: 'final-review',
            taskId: BRIEFS.routeTests.id,
            reason: 'no-progress',
            seat: 'plan',
            action: 'accept',
            diagnosis: 'Both findings restate behaviour the plan keeps on purpose.',
            newTaskIds: null,
            note: PLANNER_ACCEPT_NOTE,
          },
          event,
        ]
      : [event],
);

const READY_PLANNER_ACCEPT_LONG_NOTE_LOG: readonly EngineEvent[] = READY_PLANNER_ACCEPT_LOG.map(
  (event) =>
    event.type === 'consult_answered' ? { ...event, note: PLANNER_ACCEPT_LONG_NOTE } : event,
);

/** The review passed and both sides changed two entries differently: the run waits at Apply. */
const APPLY_CONFLICT = buildApplyConflictRecoveryIssue({
  conflicts: [
    { path: FILES.form, kind: 'mode' },
    { path: FILES.docs, kind: 'symlink' },
  ],
  workspacePath: RUN_WORKSPACE.path,
  createdAt: STARTED_AT_ISO,
});

const AT_REST_APPLY_CONFLICT = record({
  sessionId: 'visual-at-rest-apply-conflict',
  status: {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: APPLY_CONFLICT } },
    resumeAt: { kind: 'apply' },
  },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    pendingRecovery: APPLY_CONFLICT,
  }),
  summary: workspaceSummary('visual-at-rest-apply-conflict'),
  ledger: READY_LEDGER,
});

const APPLY_CONFLICT_LOG: readonly EngineEvent[] = [
  ...READY_LOG,
  {
    type: 'error',
    ts: Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime + 30_000,
    phase: 'complete',
    message: APPLY_CONFLICT.message,
    category: 'recovery',
    code: 'apply_conflict',
  },
];

/** Apply stopped part way, Restore backup was chosen and saved, and the process went away first. */
const APPLY_PARTIAL_CHOSEN = {
  ...buildApplyPartialRecoveryIssue({
    backupId: 'visual-apply',
    backupDir: '.splitbrief/apply-backups/visual-apply',
    createdAt: STARTED_AT_ISO,
    written: [FILES.form],
    files: [FILES.form, FILES.docs],
    failedFile: FILES.docs,
    cause: 'EACCES: permission denied',
  }),
  status: 'applying',
  selectedAction: 'restore-backup',
} as const;

export const AT_REST_TYPED_WORDS_SESSION = 'visual-at-rest-typed-words';

const AT_REST_TYPED_WORDS = record({
  sessionId: AT_REST_TYPED_WORDS_SESSION,
  status: {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: APPLY_PARTIAL_CHOSEN } },
    resumeAt: { kind: 'apply' },
  },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    pendingRecovery: APPLY_PARTIAL_CHOSEN,
  }),
  summary: workspaceSummary(AT_REST_TYPED_WORDS_SESSION),
  ledger: READY_LEDGER,
});

const APPLY_PARTIAL_LOG: readonly EngineEvent[] = [
  ...READY_LOG,
  {
    type: 'error',
    ts: Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime + 30_000,
    phase: 'complete',
    message: APPLY_PARTIAL_CHOSEN.message,
    category: 'recovery',
    code: 'apply_partial',
  },
];

/** Apply was writing to the checkout when the process went away: no halt, and Apply is next. */
const CRASHED_APPLY = record({
  sessionId: 'visual-at-rest-crashed-apply',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    resumeAt: { kind: 'apply' },
  },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    applying: { at: STARTED_AT_ISO, backupId: 'visual-apply' },
  }),
  summary: workspaceSummary('visual-at-rest-crashed-apply'),
  ledger: READY_LEDGER,
});

/** Apply wrote the ready run's four files into the checkout half a minute after its review. */
const APPLIED_AT = new Date(Date.parse(READY_COMPLETED_AT) + 30_000).toISOString();
const APPLIED = {
  at: APPLIED_AT,
  backupId: 'visual-backup',
  files: [FILES.formTest, FILES.form, FILES.signupTest, FILES.validate],
};

const CLOSED_APPLIED = record({
  sessionId: 'visual-closed-applied',
  status: { kind: 'closed', as: 'applied' },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    review: READY_FINAL_REVIEW,
    applied: APPLIED,
    closed: { at: APPLIED_AT, as: 'applied' },
  }),
  summary: workspaceSummary('visual-closed-applied'),
  ledger: READY_LEDGER,
});
/** The transcript of an applied run: its own record, then the Apply that closed it. */
function appliedRunLog(run: RunRecord): EngineEvent[] {
  return [
    ...recordedRunLog(run),
    { type: 'apply_started', ts: Date.parse(APPLIED_AT) - 4_000 },
    { type: 'apply_finished', ts: Date.parse(APPLIED_AT) },
  ];
}
const APPLIED_LOG: readonly EngineEvent[] = appliedRunLog(CLOSED_APPLIED);

const PRE_EXISTING_CHECK = {
  id: 'V2',
  command: 'npx --no-install vitest run legacy',
  keys: [
    'legacy/report.test.ts > legacy report > total matches the ledger',
    'legacy/report.test.ts > legacy report > rounds the tax',
    'legacy/ledger.test.ts > legacy ledger > opens the ledger',
    'legacy/ledger.test.ts > legacy ledger > closes the ledger',
  ],
};

/**
 * An applied run whose final review ran a reviewer check that was red at the run base too: the
 * review raised no finding for it, and the summary names the check and its failing tests.
 */
const PRE_EXISTING_REVIEW: ReviewRecord = {
  scope: 'final',
  cycle: 0,
  verdict: { tasks: [], criteria: [], findings: [] },
  outcome: 'pass',
  verification: [],
  preExistingChecks: [PRE_EXISTING_CHECK],
  at: GENERATED_AT,
};
const PRE_EXISTING_PACKET = reviewPacket({
  sessionId: 'visual-closed-pre-existing',
  review: PRE_EXISTING_REVIEW,
  driftPassed: true,
  tasks: 3,
});
const CLOSED_PRE_EXISTING = record({
  sessionId: 'visual-closed-pre-existing',
  status: { kind: 'closed', as: 'applied' },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    review: PRE_EXISTING_REVIEW,
    applied: APPLIED,
    closed: { at: APPLIED_AT, as: 'applied' },
  }),
  summary: {
    ...READY_SUMMARY,
    reviewPacket: PRE_EXISTING_PACKET,
    review: legacyReview(PRE_EXISTING_PACKET),
  },
  ledger: READY_LEDGER,
});
/** The check ran before the review and every one of its failures was red at the run base too. */
const CLOSED_PRE_EXISTING_LOG: readonly EngineEvent[] = appliedRunLog(CLOSED_PRE_EXISTING).flatMap(
  (event): EngineEvent[] =>
    event.type === 'review_started'
      ? [
          {
            type: 'full_suite',
            ts: event.ts,
            phase: 'final-review',
            moment: 'pre-review',
            status: 'done',
            id: PRE_EXISTING_CHECK.id,
            command: PRE_EXISTING_CHECK.command,
            passed: false,
            newFailures: 0,
            preExisting: PRE_EXISTING_CHECK.keys.length,
            preExistingKeys: PRE_EXISTING_CHECK.keys.slice(0, BASE_SPLIT_NAMED),
          },
          event,
        ]
      : [event],
);

/**
 * A completed run whose task review and first final review failed before its fix cycle passed: the
 * closed block names each failed review under the Review row, with the findings that failed it.
 */
const CLOSED_FIX_CYCLE: RunRecord = {
  ...CLOSED_COMPLETE,
  ref: { ...CLOSED_COMPLETE.ref, sessionId: 'visual-closed-fix-cycle' },
  summary: {
    ...CLOSED_COMPLETE_SUMMARY,
    reviewPacket: {
      ...READY_PACKET,
      jsonPath: '.splitbrief/sessions/visual-closed-fix-cycle/review-packet.json',
      markdownPath: packetMarkdownPath('visual-closed-fix-cycle'),
    },
  },
  ledger: {
    ...READY_LEDGER,
    sessionId: 'visual-closed-fix-cycle',
    reviews: [
      {
        scope: 'task',
        afterTaskId: BRIEFS.wire.id,
        cycle: 0,
        outcome: 'fail',
        blocking: [
          {
            id: 'F1',
            text: 'An empty email passes validation, so the form submits a blank address.',
          },
        ],
        at: GENERATED_AT,
      },
      {
        scope: 'final',
        cycle: 0,
        outcome: 'fail',
        blocking: [
          { id: 'F1', text: 'The signup route returns 500 when the email field is missing.' },
          { id: 'F2', text: 'The route tests never assert the error code of a rejected email.' },
        ],
        at: GENERATED_AT,
      },
      {
        scope: 'final',
        cycle: 1,
        outcome: 'fail',
        blocking: [
          { id: 'F1', text: 'The signup route returns 500 when the email field is missing.' },
        ],
        at: GENERATED_AT,
      },
      { scope: 'final', cycle: 2, outcome: 'pass-with-notes', blocking: [], at: GENERATED_AT },
    ],
  },
};

const CLOSED_SUMMARY_RUN = fixCycleRun('visual-closed-summary');
/** A long applied run: 15 briefs, 65 files, three failed reviews before the one that passed. */
const CLOSED_SUMMARY: RunRecord = {
  ...record({
    sessionId: 'visual-closed-summary',
    status: { kind: 'closed', as: 'applied' },
    state: { ...CLOSED_SUMMARY_RUN.state, workspace: RUN_WORKSPACE },
    summary: CLOSED_SUMMARY_RUN.summary,
    ledger: CLOSED_SUMMARY_RUN.ledger,
  }),
  feature: FIX_CYCLE_RUN_FEATURE,
};

const SET_ASIDE_CHECK = {
  id: 'V1',
  reason:
    'npm run lint fails on src/legacy/report.ts, which no brief touches; the same error is red at the run base.',
};
/**
 * An applied run whose final review set aside a red reviewer check with a reason: the closed block
 * names it under the Review row, in the words of the transcript.
 */
const CLOSED_SET_ASIDE = record({
  sessionId: 'visual-closed-set-aside',
  status: { kind: 'closed', as: 'applied' },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    review: READY_FINAL_REVIEW,
    applied: APPLIED,
    closed: { at: APPLIED_AT, as: 'applied' },
  }),
  summary: workspaceSummary('visual-closed-set-aside'),
  ledger: {
    ...READY_LEDGER,
    sessionId: 'visual-closed-set-aside',
    reviews: [
      {
        scope: 'final',
        cycle: 0,
        outcome: 'pass-with-notes',
        blocking: [],
        setAside: [SET_ASIDE_CHECK],
        at: GENERATED_AT,
      },
    ],
  },
});
const CLOSED_SET_ASIDE_LOG: readonly EngineEvent[] = APPLIED_LOG.map((event) =>
  event.type === 'review_completed' ? { ...event, setAside: [SET_ASIDE_CHECK] } : event,
);

function undoneApplyRecord(conflicts: string[]): RunRecord {
  const sessionId =
    conflicts.length === 0 ? 'visual-closed-undone' : 'visual-closed-undo-conflicts';
  return record({
    sessionId,
    status: { kind: 'closed', as: 'undone' },
    state: savedState({
      phase: 'complete',
      briefs: WORKSPACE_BRIEFS,
      reviewStatus: 'passed',
      workspace: RUN_WORKSPACE,
      review: READY_FINAL_REVIEW,
      applied: {
        ...APPLIED,
        undone: { at: new Date(Date.parse(APPLIED_AT) + 60_000).toISOString(), conflicts },
      },
      closed: { at: APPLIED_AT, as: 'applied' },
    }),
    summary: workspaceSummary(sessionId),
    ledger: READY_LEDGER,
  });
}

const CLOSED_DISCARDED_AT = Date.parse(READY_COMPLETED_AT) + 40_000;
const CLOSED_DISCARDED = record({
  sessionId: 'visual-closed-discarded',
  status: { kind: 'closed', as: 'discarded' },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    review: READY_FINAL_REVIEW,
    closed: {
      at: new Date(CLOSED_DISCARDED_AT).toISOString(),
      as: 'discarded',
      patch: '.splitbrief/sessions/visual-closed-discarded/run.patch',
    },
  }),
  summary: workspaceSummary('visual-closed-discarded'),
  ledger: READY_LEDGER,
});
/** End run on the ready run: it discards, saves the patch and stops nothing, so the log has no stop. */
const CLOSED_DISCARDED_LOG: readonly EngineEvent[] = [
  ...recordedRunLog(CLOSED_DISCARDED),
  { type: 'workspace_closed', ts: CLOSED_DISCARDED_AT, phase: 'complete' },
];

/**
 * The ready run with its BUILD seat moved mid-run, as a real run did: the first brief ran on
 * Antigravity, the two after it on OpenCode, one profile throughout.
 */
const SEAT_MOVED_SESSION = 'visual-closed-seat-moved';
const SEAT_MOVED_TOOL = { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' } as const;
const SEAT_MOVED_PACKET = reviewPacket({
  sessionId: SEAT_MOVED_SESSION,
  review: READY_FINAL_REVIEW,
  driftPassed: true,
  tasks: 3,
});
const CLOSED_SEAT_MOVED = record({
  sessionId: SEAT_MOVED_SESSION,
  status: { kind: 'closed', as: 'complete' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'done' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
    review: READY_FINAL_REVIEW,
    completedAt: READY_COMPLETED_AT,
  }),
  summary: Object.freeze({
    ...READY_SUMMARY,
    reviewPacket: SEAT_MOVED_PACKET,
    review: legacyReview(SEAT_MOVED_PACKET),
    implementerTool: SEAT_MOVED_TOOL.tool,
    implementerModel: SEAT_MOVED_TOOL.model,
    taskBreakdown: READY_TASKS.map((task, index) => ({
      ...task,
      implementerProfile: 'default',
      ...(index === 0 ? { tool: 'antigravity', model: 'gemini-3.8-flash-high' } : SEAT_MOVED_TOOL),
    })),
  }),
  ledger: ledger({
    sessionId: SEAT_MOVED_SESSION,
    tasks: settledLocalTasks([84_200, 141_000, 96_300]),
    validationSummary: { passed: 9, failed: 0, skipped: 0, escalated: 0 },
    finalReview: { path: packetMarkdownPath(SEAT_MOVED_SESSION), status: 'written' },
  }),
});

const MIXED_WORKERS_SESSION = 'visual-closed-mixed-workers';
const MIXED_WORKERS_PACKET = reviewPacket({
  sessionId: MIXED_WORKERS_SESSION,
  review: READY_FINAL_REVIEW,
  driftPassed: true,
  tasks: 3,
});
const CLOSED_MIXED_WORKERS = record({
  sessionId: MIXED_WORKERS_SESSION,
  status: { kind: 'closed', as: 'complete' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'done' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
    review: READY_FINAL_REVIEW,
    completedAt: READY_COMPLETED_AT,
  }),
  summary: Object.freeze({
    ...READY_SUMMARY,
    reviewPacket: MIXED_WORKERS_PACKET,
    review: legacyReview(MIXED_WORKERS_PACKET),
    taskBreakdown: READY_TASKS.map((task, index) => ({
      ...task,
      implementerProfile: index === 0 ? 'a' : 'b',
    })),
  }),
  ledger: ledger({
    sessionId: MIXED_WORKERS_SESSION,
    tasks: settledLocalTasks([84_200, 141_000, 96_300]),
    validationSummary: { passed: 9, failed: 0, skipped: 0, escalated: 0 },
    finalReview: { path: packetMarkdownPath(MIXED_WORKERS_SESSION), status: 'written' },
  }),
});

const CLOSED_NEEDS_ATTENTION = record({
  sessionId: NEEDS_ATTENTION_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'escalated' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
    reviewStatus: 'failed',
    closed: { as: 'ended', at: READY_COMPLETED_AT },
    review: FAILED_REVIEW,
    completedAt: READY_COMPLETED_AT,
  }),
  summary: NEEDS_ATTENTION_SUMMARY,
  ledger: NEEDS_ATTENTION_LEDGER,
});

const PLANNER_ACCEPT_PACKET = reviewPacket({
  sessionId: 'visual-closed-planner-accept',
  review: FAILED_REVIEW,
  driftPassed: false,
  tasks: 3,
});

/** A checkout run the planner accepted at a review without progress: it closed with the note. */
const CLOSED_PLANNER_ACCEPT = record({
  sessionId: 'visual-closed-planner-accept',
  status: { kind: 'closed', as: 'complete' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'escalated' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
    reviewStatus: 'failed',
    review: FAILED_REVIEW,
    completedAt: READY_COMPLETED_AT,
    acceptedAsIs: {
      at: GENERATED_AT,
      findings: [
        'src/form.ts re-validates on every keystroke',
        'docs/validation-errors.md names a retired code',
      ],
      note: PLANNER_ACCEPT_NOTE,
      by: 'planner',
    },
  }),
  summary: {
    ...NEEDS_ATTENTION_SUMMARY,
    reviewPacket: PLANNER_ACCEPT_PACKET,
    review: legacyReview(PLANNER_ACCEPT_PACKET),
  },
  ledger: {
    ...NEEDS_ATTENTION_LEDGER,
    sessionId: 'visual-closed-planner-accept',
    finalReview: { path: packetMarkdownPath('visual-closed-planner-accept'), status: 'written' },
  },
});
/** The accept is the one the ready run's log states: the same findings, the same note. */
const CLOSED_PLANNER_ACCEPT_LOG: readonly EngineEvent[] = recordedRunLog(
  CLOSED_PLANNER_ACCEPT,
).flatMap((event): EngineEvent[] =>
  event.type === 'workflow_complete'
    ? [
        ...READY_PLANNER_ACCEPT_LOG.filter((accept) => accept.type === 'consult_answered').map(
          (accept): EngineEvent => ({ ...accept, ts: event.ts }),
        ),
        event,
      ]
    : [event],
);

/** The failed review of a run whose reviewer check stays red: the check blocks it beside the findings. */
const RED_CHECK_REVIEW: ReviewRecord = {
  ...FAILED_REVIEW,
  redInputs: [{ id: RED_CHECK_INPUT.id, text: RED_CHECK_INPUT.text }],
};

const RED_CHECK_ACCEPT_PACKET = reviewPacket({
  sessionId: 'visual-closed-red-check-accept',
  review: RED_CHECK_REVIEW,
  driftPassed: false,
  tasks: 3,
});

/** A checkout run you accepted as is while a reviewer check was red: it closed with that check named. */
const CLOSED_RED_CHECK_ACCEPT = record({
  sessionId: 'visual-closed-red-check-accept',
  status: { kind: 'closed', as: 'complete' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'escalated' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
    reviewStatus: 'failed',
    review: RED_CHECK_REVIEW,
    completedAt: READY_COMPLETED_AT,
    acceptedAsIs: {
      at: GENERATED_AT,
      findings: [
        'src/form.ts re-validates on every keystroke',
        'docs/validation-errors.md names a retired code',
      ],
      redChecks: [RED_REVIEWER_CHECK],
    },
  }),
  summary: {
    ...NEEDS_ATTENTION_SUMMARY,
    reviewPacket: RED_CHECK_ACCEPT_PACKET,
    review: legacyReview(RED_CHECK_ACCEPT_PACKET),
  },
  ledger: {
    ...NEEDS_ATTENTION_LEDGER,
    sessionId: 'visual-closed-red-check-accept',
    finalReview: { path: packetMarkdownPath('visual-closed-red-check-accept'), status: 'written' },
  },
});
const CLOSED_RED_CHECK_ACCEPT_LOG: readonly EngineEvent[] = recordedRunLog(
  CLOSED_RED_CHECK_ACCEPT,
).flatMap((event): EngineEvent[] =>
  event.type === 'review_started' ? [redReviewerCheckRow(event.ts), event] : [event],
);

/**
 * The user chose Decide for me at a planning question; later the planner said T002 cannot be done
 * and named skipping it, so the run skipped it with no panel and the review judged the rest.
 */
const DECIDED_SKIP_SESSION = 'visual-closed-decided-skip';
const DECIDED_SKIP_REASON =
  'The signup form is generated from the schema; the plan rules out a hand edit of it.';
const DECIDED_SKIP_PACKET = {
  ...reviewPacket({
    sessionId: DECIDED_SKIP_SESSION,
    review: READY_FINAL_REVIEW,
    driftPassed: true,
    tasks: 3,
  }),
  evidenceValidatedTasks: 2,
};
const DECIDED_SKIP_LOG: readonly EngineEvent[] = READY_LOG.flatMap((event): EngineEvent[] =>
  event.type === 'task_completed' && event.taskId === BRIEFS.wire.id
    ? [
        {
          type: 'consult_answered',
          ts: event.ts,
          phase: 'escalating',
          taskId: BRIEFS.wire.id,
          reason: 'failed',
          action: 'cannot',
          diagnosis: 'The form file is generated; every attempt is overwritten by the build.',
          newTaskIds: null,
        },
        {
          type: 'task_skipped',
          ts: event.ts,
          phase: 'implementing',
          taskId: BRIEFS.wire.id,
          title: BRIEFS.wire.title,
          reason: `Planner said: ${DECIDED_SKIP_REASON}`,
        },
      ]
    : event.type === 'workflow_complete'
      ? [{ ...event, completedTasks: 2 }]
      : [event],
);
const CLOSED_DECIDED_SKIP = record({
  sessionId: DECIDED_SKIP_SESSION,
  status: { kind: 'closed', as: 'complete' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'skipped' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
    decideForMe: true,
    review: READY_FINAL_REVIEW,
    completedAt: READY_COMPLETED_AT,
  }),
  summary: Object.freeze({
    ...READY_SUMMARY,
    completedByLocal: 2,
    skipped: 1,
    changedFiles: [FILES.signupTest, FILES.validate],
    reviewPacket: DECIDED_SKIP_PACKET,
    review: legacyReview(DECIDED_SKIP_PACKET),
    taskBreakdown: READY_TASKS.map((task) =>
      task.taskId === BRIEFS.wire.id ? { ...task, method: 'skipped' as const } : task,
    ),
  }),
  ledger: ledger({
    sessionId: DECIDED_SKIP_SESSION,
    tasks: settledLocalTasks([84_200, 141_000, 96_300]).map((task) =>
      task.id === BRIEFS.wire.id
        ? { ...task, status: 'skipped', method: 'skipped', changedFiles: [], observedEvidence: [] }
        : task,
    ),
    validationSummary: { passed: 6, failed: 0, skipped: 1, escalated: 0 },
    finalReview: { path: packetMarkdownPath(DECIDED_SKIP_SESSION), status: 'written' },
  }),
});

const CLOSED_ENDED_AT = Date.parse(STARTED_AT_ISO) + INTERRUPTED_BUILD_SUMMARY.totalTime;
const CLOSED_ENDED = record({
  sessionId: INTERRUPTED_BUILD_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 2,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'escalated' },
      { id: BRIEFS.routeTests.id, status: 'in_progress' },
      { id: BRIEFS.blur.id, status: 'pending' },
      { id: BRIEFS.docs.id, status: 'pending' },
    ],
    closed: { at: new Date(CLOSED_ENDED_AT).toISOString(), as: 'ended' },
  }),
  summary: INTERRUPTED_BUILD_SUMMARY,
  ledger: INTERRUPTED_BUILD_LEDGER,
});
const ENDED_BUILD = { tool: 'ollama', model: 'qwen2.5-coder:7b' } as const;
/** The interrupted run up to its stop: the plan, two settled briefs and the brief it stopped in. */
const ENDED_BUILD_LOG: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: Date.parse(STARTED_AT_ISO),
    phase: 'planning',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  { type: 'plan_approved', ts: Date.parse(STARTED_AT_ISO) + 182_000, phase: 'planning' },
  ...(
    [
      { brief: BRIEFS.validator, startedAfter: 182_000, method: 'local', retries: 0, ms: 84_200 },
      {
        brief: BRIEFS.wire,
        startedAfter: 266_700,
        method: 'escalated-full',
        retries: 2,
        ms: 312_600,
      },
      { brief: BRIEFS.routeTests, startedAfter: 579_400, method: null, retries: 0, ms: 0 },
    ] as const
  ).flatMap(({ brief, startedAfter, method, retries, ms }, index): EngineEvent[] => [
    {
      type: 'task_started',
      ts: Date.parse(STARTED_AT_ISO) + startedAfter,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      file: brief.file,
      action: savedAction(CLOSED_ENDED.hydration.state, brief.id),
      index,
      total: INTERRUPTED_BUILD_SUMMARY.totalTasks,
      ...ENDED_BUILD,
    },
    ...(method === null
      ? []
      : [
          {
            type: 'task_completed' as const,
            ts: Date.parse(STARTED_AT_ISO) + startedAfter + ms,
            phase: 'implementing' as const,
            taskId: brief.id,
            title: brief.title,
            method,
            retries,
            duration: ms,
            ...ENDED_BUILD,
          },
        ]),
  ]),
];
const CLOSED_ENDED_LOG: readonly EngineEvent[] = [
  ...ENDED_BUILD_LOG,
  {
    type: 'turn_interrupted',
    ts: CLOSED_ENDED_AT - 1_000,
    phase: 'implementing',
    source: 'user',
    at: 'mid-step',
    step: { kind: 'brief', taskId: BRIEFS.routeTests.id, attempt: 0 },
  },
  {
    type: 'workflow_cancelled',
    ts: CLOSED_ENDED_AT,
    phase: 'implementing',
    reason: WORKFLOW_CANCEL_REASON_USER,
  },
];

/**
 * A checkout run stopped inside T003, rejected once in part (it left a file the user had changed),
 * then rejected again and closed as discarded. The reject put the run's files back, so nothing is
 * in a run.patch, and each reject is a row of its own above the closed block.
 */
const CLOSED_REJECTED_SESSION = 'visual-closed-rejected';
const CLOSED_REJECTED_AT = Date.parse(STARTED_AT_ISO) + 600_000;
const CLOSED_REJECTED = record({
  sessionId: CLOSED_REJECTED_SESSION,
  status: { kind: 'closed', as: 'discarded' },
  checkpoint: {
    kind: 'rejected',
    putBack: {
      restored: [FILES.validate, FILES.formTest, FILES.signup, FILES.signupTest, FILES.form],
      removed: [FILES.validate, FILES.formTest, FILES.signup, FILES.signupTest, FILES.form],
    },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 2,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'escalated' },
      { id: BRIEFS.routeTests.id, status: 'in_progress' },
      { id: BRIEFS.blur.id, status: 'pending' },
      { id: BRIEFS.docs.id, status: 'pending' },
    ],
    workspace: {
      kind: 'checkout',
      path: VISUAL_FIXTURE_PROJECT_DIR,
      base: { snapshotId: 'run-baseline', head: null },
    },
    closed: { at: new Date(CLOSED_REJECTED_AT + 120_000).toISOString(), as: 'discarded' },
  }),
  summary: INTERRUPTED_BUILD_SUMMARY,
  ledger: INTERRUPTED_BUILD_LEDGER,
});
// Each reject saves the files it replaces in a folder named for the time it ran.
const CLOSED_REJECTED_LOG: readonly EngineEvent[] = [
  ...CLOSED_ENDED_LOG,
  {
    type: 'run_rejected',
    ts: CLOSED_REJECTED_AT,
    restored: [FILES.validate, FILES.formTest, FILES.signup, FILES.signupTest],
    removed: [FILES.validate, FILES.formTest, FILES.signup, FILES.signupTest],
    conflicted: [FILES.form],
    missing: 0,
    savedTo: `.splitbrief/sessions/${CLOSED_REJECTED_SESSION}/reverted/2026-09-14T09-51-00-000Z`,
  },
  {
    type: 'run_rejected',
    ts: CLOSED_REJECTED_AT + 120_000,
    restored: [FILES.form],
    removed: [FILES.form],
    conflicted: [],
    missing: 0,
    savedTo: `.splitbrief/sessions/${CLOSED_REJECTED_SESSION}/reverted/2026-09-14T09-53-00-000Z`,
  },
];

const CLOSED_ENDED_EMPTY = record({
  sessionId: 'visual-closed-ended-empty',
  status: { kind: 'closed', as: 'ended' },
  state: savedState({
    phase: 'implementing',
    briefs: [{ id: BRIEFS.validator.id, status: 'in_progress' }],
    workspace: RUN_WORKSPACE,
    closed: { at: new Date(Date.parse(STARTED_AT_ISO) + 2_000).toISOString(), as: 'ended' },
  }),
  summary: {
    ...INTERRUPTED_BUILD_SUMMARY,
    totalTasks: 1,
    completedByLocal: 0,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 2_000,
    activeTime: 2_000,
    phaseTimings: { planning: 1_000, implementing: 1_000 },
    taskBreakdown: [],
    changedFiles: [],
    stoppedAt: { taskId: BRIEFS.validator.id, partialFiles: [] },
  },
});

/**
 * A real run's close: a worktree run ended inside a brief. The run.patch holds the stopped brief's
 * partial files, and its log kept the workspace for Continue before the close let it go.
 */
const ENDED_WORKSPACE_SESSION = 'visual-closed-ended-workspace';
const ENDED_WORKSPACE_PATCH = `.splitbrief/sessions/${ENDED_WORKSPACE_SESSION}/run.patch`;
const CLOSED_ENDED_WORKSPACE = record({
  sessionId: ENDED_WORKSPACE_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: {
    ...CLOSED_ENDED.hydration.state,
    workspace: RUN_WORKSPACE,
    closed: {
      at: new Date(CLOSED_ENDED_AT).toISOString(),
      as: 'ended',
      patch: ENDED_WORKSPACE_PATCH,
    },
  },
  summary: INTERRUPTED_BUILD_SUMMARY,
  ledger: { ...INTERRUPTED_BUILD_LEDGER, sessionId: ENDED_WORKSPACE_SESSION },
});
const ENDED_WORKSPACE_LOG: readonly EngineEvent[] = [
  ...ENDED_BUILD_LOG,
  {
    type: 'turn_interrupted',
    ts: CLOSED_ENDED_AT - 1_500,
    phase: 'implementing',
    source: 'user',
    at: 'mid-step',
    step: { kind: 'brief', taskId: BRIEFS.routeTests.id, attempt: 0 },
  },
  {
    type: 'warning',
    ts: CLOSED_ENDED_AT - 1_000,
    phase: 'implementing',
    message: retainedWorkspaceNotice(RUN_WORKSPACE.path),
    category: WORKSPACE_NOTICE_CATEGORY,
    code: WORKSPACE_KEPT_CODE,
  },
  { type: 'workspace_closed', ts: CLOSED_ENDED_AT - 500, phase: 'implementing' },
  {
    type: 'workflow_cancelled',
    ts: CLOSED_ENDED_AT,
    phase: 'implementing',
    reason: WORKFLOW_CANCEL_REASON_USER,
  },
];

const ENDED_MOVED_WORKSPACE_SESSION = 'visual-closed-ended-moved-workspace';
const ENDED_MOVED_WORKSPACE_PATCH = `.splitbrief/sessions/${ENDED_MOVED_WORKSPACE_SESSION}/run.patch`;
const CLOSED_ENDED_MOVED_WORKSPACE = record({
  sessionId: ENDED_MOVED_WORKSPACE_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: {
    ...CLOSED_ENDED.hydration.state,
    workspace: RUN_WORKSPACE,
    closed: {
      at: new Date(CLOSED_ENDED_AT).toISOString(),
      as: 'ended',
      patch: ENDED_MOVED_WORKSPACE_PATCH,
    },
  },
  summary: INTERRUPTED_BUILD_SUMMARY,
  ledger: { ...INTERRUPTED_BUILD_LEDGER, sessionId: ENDED_MOVED_WORKSPACE_SESSION },
});
const ENDED_MOVED_WORKSPACE_LOG: readonly EngineEvent[] = [
  ...ENDED_BUILD_LOG,
  {
    type: 'turn_interrupted',
    ts: CLOSED_ENDED_AT - 1_500,
    phase: 'implementing',
    source: 'user',
    at: 'mid-step',
    step: { kind: 'brief', taskId: BRIEFS.routeTests.id, attempt: 0 },
  },
  {
    type: 'info',
    ts: CLOSED_ENDED_AT - 1_000,
    phase: 'implementing',
    message: foreignWorkspaceNotice(RUN_WORKSPACE.path),
  },
  { type: 'workspace_closed', ts: CLOSED_ENDED_AT - 500, phase: 'implementing' },
  {
    type: 'workflow_cancelled',
    ts: CLOSED_ENDED_AT,
    phase: 'implementing',
    reason: WORKFLOW_CANCEL_REASON_USER,
  },
];

const ENDED_REVIEW_SESSION = 'visual-ended-review';
const ENDED_REVIEW_PACKET = reviewPacket({
  sessionId: ENDED_REVIEW_SESSION,
  review: FAILED_REVIEW,
  driftPassed: true,
  tasks: 3,
});

const CLOSED_ENDED_REVIEW = record({
  sessionId: ENDED_REVIEW_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: {
    ...savedState({
      phase: 'complete',
      currentTaskIndex: 3,
      briefs: [
        { id: BRIEFS.validator.id, status: 'done' },
        { id: BRIEFS.wire.id, status: 'done' },
        { id: BRIEFS.routeTests.id, status: 'done' },
      ],
    }),
    reviewStatus: 'failed',
    review: FAILED_REVIEW,
    completedAt: READY_COMPLETED_AT,
    closed: { as: 'ended', at: READY_COMPLETED_AT },
  },
  summary: {
    ...READY_SUMMARY,
    reviewPacket: ENDED_REVIEW_PACKET,
    review: legacyReview(ENDED_REVIEW_PACKET),
  },
  ledger: {
    ...READY_LEDGER,
    sessionId: ENDED_REVIEW_SESSION,
    finalReview: { path: packetMarkdownPath(ENDED_REVIEW_SESSION), status: 'written' },
  },
});

/** A run ended on the halt of a final review that ran and returned no verdict. */
const REVIEW_NO_VERDICT_SESSION = 'visual-closed-review-no-verdict';
const { review: _noVerdictSaved, ...REVIEW_NO_VERDICT_STATE } = CLOSED_ENDED_REVIEW.hydration.state;
const CLOSED_REVIEW_NO_VERDICT = record({
  sessionId: REVIEW_NO_VERDICT_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: REVIEW_NO_VERDICT_STATE,
  summary: {
    ...READY_SUMMARY,
    reviewPacket: { ...ENDED_REVIEW_PACKET, finalReviewStatus: 'failed' },
  },
  ledger: {
    ...READY_LEDGER,
    sessionId: REVIEW_NO_VERDICT_SESSION,
    finalReview: { path: packetMarkdownPath(REVIEW_NO_VERDICT_SESSION), status: 'failed' },
  },
});

/** A real run's close: a worktree run ended on its failed-review halt, the result in run.patch. */
const ENDED_REVIEW_WORKSPACE_SESSION = 'visual-ended-review-workspace';
const CLOSED_ENDED_REVIEW_WORKSPACE = record({
  sessionId: ENDED_REVIEW_WORKSPACE_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: savedState({
    phase: 'complete',
    currentTaskIndex: 3,
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'failed',
    workspace: RUN_WORKSPACE,
    review: FAILED_REVIEW,
    completedAt: READY_COMPLETED_AT,
    closed: {
      at: READY_COMPLETED_AT,
      as: 'ended',
      patch: `.splitbrief/sessions/${ENDED_REVIEW_WORKSPACE_SESSION}/run.patch`,
    },
  }),
  summary: {
    ...READY_SUMMARY,
    reviewPacket: {
      ...ENDED_REVIEW_PACKET,
      markdownPath: packetMarkdownPath(ENDED_REVIEW_WORKSPACE_SESSION),
    },
    review: legacyReview(ENDED_REVIEW_PACKET),
  },
  ledger: { ...READY_LEDGER, sessionId: ENDED_REVIEW_WORKSPACE_SESSION },
});

const REPLAYED_HISTORY = record({
  sessionId: 'visual-replayed-history',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 0 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
    ],
  }),
});

/**
 * The replayed-history transcript, read from a real session log. The left-isolation,
 * approved-gates, stopped-gate and corrected-gate projections read logs the same way; every other
 * projection here stages its events.
 */
export const REPLAYED_HISTORY_LOG = 'testing/fixtures/session-log/run.jsonl';

/** The log carries the spec, plan and briefs gates, each approved, and the build they released. */
export const GATES_APPROVED_LOG = 'testing/fixtures/session-log/gates-approved.jsonl';

const GATES_APPROVED = record({
  sessionId: 'visual-gates-approved',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 0 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
    ],
  }),
});

/** The log stops at the plan gate: the spec gate was approved, then the operator stopped the run. */
export const GATE_STOPPED_LOG = 'testing/fixtures/session-log/gate-stopped.jsonl';

const GATE_STOPPED = record({
  sessionId: 'visual-gate-stopped',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
    resumeAt: { kind: 'gate', gate: 'plan' },
  },
  state: savedState({
    phase: 'reviewing-plan',
    briefs: [
      { id: BRIEFS.validator.id, status: 'pending' },
      { id: BRIEFS.wire.id, status: 'pending' },
    ],
  }),
});

function atRestProjection(input: {
  readonly id: string;
  readonly route: FixtureAtRestRoute;
}): WorkflowFixtureProjection {
  return {
    scenarioId: scenarioId(input.id),
    feature: AT_REST_FIXTURE_FEATURE,
    inputMode: 'normal',
    sidebarVisible: false,
    events: [],
    atRest: input.route,
  };
}

const CADENCE_REVIEWER = {
  kind: 'cli',
  tool: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
} as const;
const CADENCE_IMPLEMENTER = {
  kind: 'cli',
  tool: 'antigravity',
  model: 'gemini-3.8-flash-high',
} as const;
const CADENCE_SEAT = { tool: CADENCE_REVIEWER.tool, model: CADENCE_REVIEWER.model, axes: ['high'] };
const CADENCE_BRIEFS = [
  BRIEFS.validator,
  BRIEFS.wire,
  { id: taskId('T003'), title: 'Fix empty email validation', file: FILES.validate },
] as const;
const CADENCE_TS = VISUAL_FIXTURE_EPOCH - 258_000;

function cadenceBrief({
  brief,
  index,
  started,
  completed,
}: {
  brief: (typeof CADENCE_BRIEFS)[number];
  index: number;
  started: number;
  completed: number;
}): EngineEvent[] {
  return [
    {
      type: 'task_started',
      ts: CADENCE_TS + started,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      file: brief.file,
      action: 'modify',
      index,
      total: index === 2 ? 3 : 2,
      tool: CADENCE_IMPLEMENTER.tool,
      model: CADENCE_IMPLEMENTER.model,
    },
    {
      type: 'task_completed',
      ts: CADENCE_TS + completed,
      phase: 'implementing',
      taskId: brief.id,
      title: brief.title,
      method: 'local',
      retries: 0,
      duration: completed - started,
      tool: CADENCE_IMPLEMENTER.tool,
      model: CADENCE_IMPLEMENTER.model,
    },
  ];
}

const CADENCE_EVENTS: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: CADENCE_TS,
    phase: 'implementing',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  {
    type: 'tasks_planned',
    ts: CADENCE_TS + 10,
    phase: 'implementing',
    total: 2,
    tasks: CADENCE_BRIEFS.slice(0, 2).map((brief, index) => ({
      id: brief.id,
      title: brief.title,
      file: brief.file,
      action: 'modify',
      index,
    })),
  },
  ...cadenceBrief({ brief: CADENCE_BRIEFS[0], index: 0, started: 1_000, completed: 61_000 }),
  {
    type: 'review_started',
    ts: CADENCE_TS + 62_000,
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T001',
    ...CADENCE_SEAT,
  },
  {
    type: 'review_completed',
    ts: CADENCE_TS + 111_000,
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T001',
    verdict: 'pass',
    findings: { blocking: 0, minor: 0, outOfScope: 0 },
    duration: 49_000,
    ...CADENCE_SEAT,
  },
  ...cadenceBrief({ brief: CADENCE_BRIEFS[1], index: 1, started: 112_000, completed: 232_000 }),
  {
    type: 'review_started',
    ts: CADENCE_TS + 233_000,
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T002',
    ...CADENCE_SEAT,
  },
  {
    type: 'full_suite',
    ts: CADENCE_TS + 265_000,
    phase: 'implementing',
    id: 'V1',
    command: 'npm test',
    moment: 'pre-review',
    status: 'running',
  },
];

export const reviewTaskCadenceProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-task-cadence'),
  feature: AT_REST_FIXTURE_FEATURE,
  inputMode: 'normal',
  sidebarVisible: true,
  config: {
    reviewer: CADENCE_REVIEWER,
    implementer: CADENCE_IMPLEMENTER,
    workflow: { review: 'task' },
  },
  events: CADENCE_EVENTS,
};

export const reviewTaskOutOfScopeProjection: WorkflowFixtureProjection = {
  ...reviewTaskCadenceProjection,
  scenarioId: scenarioId('workflow-review-task-out-of-scope'),
  events: CADENCE_EVENTS.slice(
    0,
    CADENCE_EVENTS.findLastIndex((event) => event.type === 'review_started'),
  ).map((event) =>
    event.type === 'review_completed' && event.afterTaskId === 'T001'
      ? {
          ...event,
          verdict: 'pass-with-notes',
          findings: { blocking: 0, minor: 0, outOfScope: 3 },
        }
      : event,
  ),
};

/**
 * The fix brief's first attempt fails its check, so the brief goes back to BUILD with the failure
 * and passes on its second attempt.
 */
function cadenceFixBrief(): EngineEvent[] {
  const [started, completed] = cadenceBrief({
    brief: CADENCE_BRIEFS[2],
    index: 2,
    started: 284_000,
    completed: 310_000,
  });
  if (started === undefined || completed?.type !== 'task_completed') {
    throw new Error('A cadence brief starts and completes');
  }
  return [
    started,
    {
      type: 'task_retry',
      ts: CADENCE_TS + 297_000,
      phase: 'implementing',
      taskId: taskId('T003'),
      attempt: 1,
      maxRetries: 3,
      error: checkFailureText({
        checkId: 'T003-K1',
        status: 'fail',
        failure: { keys: ['src/validate.test.ts::rejects an empty email'] },
        output: '',
      }),
    },
    { ...completed, retries: 1 },
  ];
}

const CADENCE_SETTLED_EVENTS: readonly EngineEvent[] = [
  ...CADENCE_EVENTS,
  {
    type: 'full_suite',
    ts: CADENCE_TS + 281_000,
    phase: 'implementing',
    id: 'V1',
    command: 'npm test',
    moment: 'pre-review',
    status: 'done',
    passed: true,
    duration: 16_000,
  },
  {
    type: 'review_completed',
    ts: CADENCE_TS + 282_000,
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T002',
    verdict: 'fail',
    findings: { blocking: 1, minor: 0, outOfScope: 0 },
    blockingFindings: [
      { id: 'F1', text: 'An empty email passes validation, so the form submits a blank address.' },
    ],
    duration: 49_000,
    ...CADENCE_SEAT,
  },
  {
    type: 'review_fix_started',
    ts: CADENCE_TS + 283_000,
    phase: 'implementing',
    cycle: 1,
    taskIds: [taskId('T003')],
  },
  ...cadenceFixBrief(),
  {
    type: 'review_started',
    ts: CADENCE_TS + 311_000,
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T002',
    ...CADENCE_SEAT,
  },
  {
    type: 'review_completed',
    ts: CADENCE_TS + 360_000,
    phase: 'implementing',
    scope: 'task',
    afterTaskId: 'T002',
    verdict: 'pass',
    findings: { blocking: 0, minor: 0, outOfScope: 0 },
    duration: 49_000,
    ...CADENCE_SEAT,
  },
  {
    type: 'review_started',
    ts: CADENCE_TS + 361_000,
    phase: 'final-review',
    scope: 'final',
    ...CADENCE_SEAT,
  },
  {
    type: 'review_completed',
    ts: CADENCE_TS + 423_000,
    phase: 'final-review',
    scope: 'final',
    verdict: 'pass',
    findings: { blocking: 0, minor: 0, outOfScope: 0 },
    duration: 62_000,
    ...CADENCE_SEAT,
  },
  {
    type: 'workflow_complete',
    ts: CADENCE_TS + 424_000,
    phase: 'complete',
    review: 'passed',
    completedTasks: 3,
  },
];

const CADENCE_SETTLED_STATE: WorkflowState = {
  ...savedState({
    phase: 'complete',
    currentTaskIndex: 3,
    briefs: CADENCE_BRIEFS.map((brief) => ({ id: brief.id, status: 'done' })),
    startedAt: new Date(CADENCE_TS).toISOString(),
    completedAt: new Date(CADENCE_TS + 424_000).toISOString(),
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    implementerTool: CADENCE_IMPLEMENTER.tool,
    implementerModel: CADENCE_IMPLEMENTER.model,
  }),
  tasks: CADENCE_BRIEFS.map((brief) =>
    makeTask({ id: brief.id, title: brief.title, status: 'done', suggestedFiles: [brief.file] }),
  ),
};

/**
 * A run whose process went away mid-call: the log stops inside the call, with no end and no stop
 * written. The state is saved where the call began, and nothing records why it stopped.
 */
const CRASH_TS = Date.parse(STARTED_AT_ISO);
const CRASH_BUILD_CALL = {
  callId: 'implementer-2',
  role: 'implementer',
  backendKind: 'api',
  runnerName: 'ollama',
  model: 'qwen2.5-coder:7b',
} as const;
const CRASH_REVIEW_CALL = {
  callId: 'review-1',
  role: 'review',
  backendKind: 'cli',
  runnerName: 'claude',
  model: 'claude-sonnet-4',
} as const;

function crashBrief(brief: { id: Task['id']; title: string; file: string }, index: number) {
  return {
    type: 'task_started',
    ts: CRASH_TS + index * 60_000,
    phase: 'implementing',
    taskId: brief.id,
    title: brief.title,
    file: brief.file,
    action: 'modify',
    index,
    total: 2,
    tool: 'ollama',
    model: 'qwen2.5-coder:7b',
  } satisfies EngineEvent;
}

function crashBriefDone(brief: { id: Task['id']; title: string }, index: number) {
  return {
    type: 'task_completed',
    ts: CRASH_TS + index * 60_000 + 40_000,
    phase: 'implementing',
    taskId: brief.id,
    title: brief.title,
    method: 'local',
    retries: 0,
    duration: 40_000,
    tool: 'ollama',
    model: 'qwen2.5-coder:7b',
  } satisfies EngineEvent;
}

function crashActivity(
  call: typeof CRASH_BUILD_CALL | typeof CRASH_REVIEW_CALL,
  input: {
    readonly ts: number;
    readonly phase: Phase;
    readonly sequence: number;
    readonly kind: 'read' | 'edit' | 'command';
    readonly label: string;
    readonly target: string;
    readonly taskId?: Task['id'];
  },
): EngineEvent {
  return {
    type: 'runner_call_activity',
    ts: input.ts,
    phase: input.phase,
    ...(input.taskId !== undefined && { taskId: input.taskId }),
    ...call,
    sequence: input.sequence,
    activityId: `${call.callId}:tool:${input.sequence}`,
    stage: 'completed',
    kind: input.kind,
    label: input.label,
    target: input.target,
    redacted: false,
  };
}

const CRASHED_BUILD_LOG: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: CRASH_TS,
    phase: 'implementing',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  crashBrief(BRIEFS.validator, 0),
  crashBriefDone(BRIEFS.validator, 0),
  crashBrief(BRIEFS.wire, 1),
  {
    type: 'implementer_generate_running',
    ts: CRASH_TS + 60_100,
    phase: 'implementing',
    taskId: BRIEFS.wire.id,
    file: BRIEFS.wire.file,
  },
  {
    type: 'runner_call_started',
    ts: CRASH_TS + 60_200,
    phase: 'implementing',
    taskId: BRIEFS.wire.id,
    ...CRASH_BUILD_CALL,
    sequence: 0,
  },
  crashActivity(CRASH_BUILD_CALL, {
    ts: CRASH_TS + 64_000,
    phase: 'implementing',
    sequence: 1,
    kind: 'read',
    label: 'Read',
    target: FILES.form,
    taskId: BRIEFS.wire.id,
  }),
  crashActivity(CRASH_BUILD_CALL, {
    ts: CRASH_TS + 71_000,
    phase: 'implementing',
    sequence: 2,
    kind: 'edit',
    label: 'Edit',
    target: FILES.form,
    taskId: BRIEFS.wire.id,
  }),
];

const CRASHED_BUILD = record({
  sessionId: 'visual-at-rest-crashed-build',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 0 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
    ],
  }),
});

const UNSAVED_FAILURE_MESSAGE =
  'Could not save the run state: permission denied · .splitbrief/sessions/visual-at-rest-failed-unsaved/state.json';

const FAILED_UNSAVED_LOG: readonly EngineEvent[] = [
  ...CRASHED_BUILD_LOG,
  {
    type: 'error',
    ts: CRASH_TS + 74_000,
    phase: 'implementing',
    message: UNSAVED_FAILURE_MESSAGE,
  },
];

const FAILED_UNSAVED = record({
  sessionId: 'visual-at-rest-failed-unsaved',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'failed' } },
    resumeAt: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 0 },
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
    ],
    lastFailure: {
      step: { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 0 },
      message: UNSAVED_FAILURE_MESSAGE,
      at: new Date(CRASH_TS + 74_000).toISOString(),
    },
  }),
});

/** The folder a run started in, before its project moved to the fixture's folder. */
export const MOVED_PROJECT_STARTED_IN = '/Users/me/projects/shop';

export const MOVED_PROJECT_MESSAGE = retentionError.moved(MOVED_PROJECT_STARTED_IN).message;

/** The folder the moved run stopped in, gone once the user moved the project back. */
export const PROJECT_GONE_DIR = '/Users/me/projects/shop-moved';

const MOVED_PROJECT_STEP = { kind: 'brief', taskId: BRIEFS.wire.id, attempt: 0 } as const;
const MOVED_PROJECT_TS = CRASH_TS + 300_000;

/** The user stopped the build, moved the project folder, and continued: the Continue stopped on the move. */
const MOVED_PROJECT_LOG: readonly EngineEvent[] = [
  ...CRASHED_BUILD_LOG,
  {
    type: 'turn_interrupted',
    ts: CRASH_TS + 72_000,
    phase: 'implementing',
    source: 'user',
    at: 'mid-step',
    step: MOVED_PROJECT_STEP,
  },
  { type: 'workflow_resumed', ts: MOVED_PROJECT_TS, phase: 'implementing' },
  {
    type: 'error',
    ts: MOVED_PROJECT_TS + 100,
    phase: 'implementing',
    message: MOVED_PROJECT_MESSAGE,
  },
  {
    type: 'run_failed',
    ts: MOVED_PROJECT_TS + 100,
    phase: 'implementing',
    step: MOVED_PROJECT_STEP,
    message: MOVED_PROJECT_MESSAGE,
  },
];

const MOVED_PROJECT_RUN = record({
  sessionId: 'visual-moved-project-run',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'failed' } },
    resumeAt: MOVED_PROJECT_STEP,
  },
  state: savedState({
    phase: 'implementing',
    currentTaskIndex: 1,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'in_progress' },
    ],
    workspace: {
      kind: 'checkout',
      path: MOVED_PROJECT_STARTED_IN,
      base: { snapshotId: 'baseline', head: null },
    },
    lastFailure: {
      step: MOVED_PROJECT_STEP,
      message: MOVED_PROJECT_MESSAGE,
      at: new Date(MOVED_PROJECT_TS + 100).toISOString(),
    },
  }),
});

const PLAN_UNSAVED_MESSAGE =
  'Could not save a run file: permission denied · .splitbrief/sessions/visual-at-rest-plan-unsaved/plan.json';

const PLAN_UNSAVED_LOG: readonly EngineEvent[] = [
  { type: 'workflow_started', ts: CRASH_TS, phase: 'planning', feature: AT_REST_FIXTURE_FEATURE },
  { type: 'user_message', ts: CRASH_TS + 10, phase: 'planning', text: AT_REST_FIXTURE_FEATURE },
  {
    type: 'planner_text',
    ts: CRASH_TS + 20_000,
    phase: 'planning',
    role: 'planner',
    content: 'markdown',
    text: 'Validate the input before the form sends it.',
  },
  { type: 'error', ts: CRASH_TS + 21_000, phase: 'planning', message: PLAN_UNSAVED_MESSAGE },
];

/** The planner answered, but the session folder took no plan.json: a save failure, not the planner's. */
const PLAN_UNSAVED = record({
  sessionId: 'visual-at-rest-plan-unsaved',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'failed' } },
    resumeAt: { kind: 'planner', call: 'plan' },
  },
  state: savedState({
    phase: 'planning',
    briefs: [],
    lastFailure: {
      step: { kind: 'planner', call: 'plan' },
      message: PLAN_UNSAVED_MESSAGE,
      at: new Date(CRASH_TS + 21_000).toISOString(),
    },
  }),
});

/** The run up to the start of its final review, before the project gate and the verdict call. */
const CRASHED_REVIEW_START_LOG: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: CRASH_TS,
    phase: 'implementing',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  crashBrief(BRIEFS.validator, 0),
  crashBriefDone(BRIEFS.validator, 0),
  crashBrief(BRIEFS.wire, 1),
  crashBriefDone(BRIEFS.wire, 1),
  {
    type: 'full_suite',
    ts: CRASH_TS + 101_000,
    phase: 'final-review',
    status: 'done',
    id: 'K1',
    command: 'npm test',
    moment: 'plan',
    passed: true,
  },
  {
    type: 'review_started',
    ts: CRASH_TS + 102_000,
    phase: 'final-review',
    scope: 'final',
    tool: 'claude-code',
    model: 'claude-sonnet-4',
  },
];

const CRASHED_REVIEW_LOG: readonly EngineEvent[] = [
  ...CRASHED_REVIEW_START_LOG,
  {
    type: 'runner_call_started',
    ts: CRASH_TS + 102_100,
    phase: 'final-review',
    ...CRASH_REVIEW_CALL,
    sequence: 0,
  },
  crashActivity(CRASH_REVIEW_CALL, {
    ts: CRASH_TS + 106_000,
    phase: 'final-review',
    sequence: 1,
    kind: 'command',
    label: 'Run',
    target: 'git diff HEAD --stat',
  }),
  crashActivity(CRASH_REVIEW_CALL, {
    ts: CRASH_TS + 109_000,
    phase: 'final-review',
    sequence: 2,
    kind: 'read',
    label: 'Read',
    target: FILES.form,
  }),
];

const CRASHED_REVIEW = record({
  sessionId: 'visual-at-rest-crashed-review',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    resumeAt: { kind: 'review', cycle: 0 },
  },
  state: savedState({
    phase: 'final-review',
    currentTaskIndex: 2,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'done' },
    ],
  }),
});

/** A crash while the first command of the project gate ran, before the verdict call. */
const CRASHED_REVIEW_CHECK_LOG: readonly EngineEvent[] = [
  ...CRASHED_REVIEW_START_LOG,
  {
    type: 'full_suite',
    ts: CRASH_TS + 102_200,
    phase: 'final-review',
    status: 'running',
    id: 'V1',
    command: 'npm test',
    moment: 'pre-review',
  },
];

const CRASHED_REVIEW_CHECK = record({
  sessionId: 'visual-at-rest-crashed-review-check',
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    resumeAt: { kind: 'review', cycle: 0 },
  },
  state: savedState({
    phase: 'final-review',
    currentTaskIndex: 2,
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'done' },
    ],
  }),
});

function follower(source: RunRecord, kind: 'live' | 'stale') {
  return { ...source, status: { kind: 'running' as const }, owner: { kind, pid: 4107 } };
}

export const atRestProjections: readonly WorkflowFixtureProjection[] = [
  {
    ...reviewTaskCadenceProjection,
    scenarioId: scenarioId('workflow-review-task-cadence-settled'),
    events: [],
    atRest: {
      record: {
        ...record({
          sessionId: 'visual-review-task-cadence-settled',
          status: { kind: 'ready-to-apply', override: false },
          state: CADENCE_SETTLED_STATE,
        }),
        startedAt: CADENCE_SETTLED_STATE.startedAt,
      },
      log: CADENCE_SETTLED_EVENTS,
    },
  },

  atRestProjection({
    id: 'workflow-at-rest-paused',
    route: { record: AT_REST_PAUSED, log: 'testing/fixtures/session-log/paused-mid-brief.jsonl' },
  }),
  atRestProjection({
    id: 'workflow-at-rest-follower',
    route: { record: follower(CRASHED_BUILD, 'live'), log: CRASHED_BUILD_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-follower-waiting',
    route: { record: follower(AT_REST_QUESTION, 'live'), log: AT_REST_QUESTION_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-follower-stale',
    route: { record: follower(CRASHED_BUILD, 'stale'), log: CRASHED_BUILD_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-closed-elsewhere',
    route: {
      record: AT_REST_CLOSED_ELSEWHERE,
      log: 'testing/fixtures/session-log/paused-mid-brief.jsonl',
    },
  }),
  atRestProjection({
    id: 'workflow-at-rest-queued',
    route: { record: AT_REST_QUEUED, log: 'testing/fixtures/session-log/paused-mid-brief.jsonl' },
  }),
  atRestProjection({ id: 'workflow-at-rest-quick', route: { record: AT_REST_QUICK } }),
  atRestProjection({
    id: 'workflow-at-rest-halted',
    route: {
      record: AT_REST_HALTED,
      log: HALTED_BUILD_LOG,
    },
  }),
  atRestProjection({
    id: 'workflow-at-rest-seat-wait',
    route: { record: AT_REST_SEAT_WAIT, log: seatWaitLog(CODEX_WAIT, true) },
  }),
  atRestProjection({
    id: 'workflow-at-rest-seat-moved',
    route: { record: AT_REST_SEAT_MOVED, log: seatWaitLog(SEAT_MOVED_WAIT, true) },
  }),
  atRestProjection({
    id: 'workflow-at-rest-seat-wait-elsewhere',
    route: { record: AT_REST_SEAT_WAIT_ELSEWHERE, log: seatWaitLog(CODEX_WAIT, false) },
  }),
  atRestProjection({
    id: 'workflow-at-rest-halted-chosen',
    route: { record: AT_REST_HALTED_CHOSEN },
  }),
  {
    ...atRestProjection({
      id: 'workflow-at-rest-prompt-too-large',
      route: { record: AT_REST_PROMPT_TOO_LARGE },
    }),
    config: { implementer: LIMITED_IMPLEMENTER },
  },
  atRestProjection({
    id: 'workflow-at-rest-apply-conflict',
    route: { record: AT_REST_APPLY_CONFLICT, log: APPLY_CONFLICT_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-typed-words',
    route: { record: AT_REST_TYPED_WORDS, log: APPLY_PARTIAL_LOG },
  }),
  {
    ...atRestProjection({
      id: 'workflow-at-rest-crashed-build',
      route: { record: CRASHED_BUILD, log: CRASHED_BUILD_LOG },
    }),
    sidebarVisible: true,
  },
  atRestProjection({
    id: 'workflow-at-rest-failed-unsaved',
    route: { record: FAILED_UNSAVED, log: FAILED_UNSAVED_LOG },
  }),
  {
    ...atRestProjection({
      id: 'workflow-moved-project-run',
      route: { record: MOVED_PROJECT_RUN, log: MOVED_PROJECT_LOG },
    }),
    config: { workflow: { isolation: 'none' } },
  },
  {
    ...atRestProjection({
      id: 'workflow-project-gone-at-rest',
      route: { record: MOVED_PROJECT_RUN, log: MOVED_PROJECT_LOG },
    }),
    config: { workflow: { isolation: 'none' } },
  },
  {
    ...atRestProjection({
      id: 'workflow-project-gone-draft',
      route: { record: MOVED_PROJECT_RUN, log: MOVED_PROJECT_LOG },
    }),
    config: { workflow: { isolation: 'none' } },
  },
  atRestProjection({
    id: 'workflow-at-rest-plan-unsaved',
    route: { record: PLAN_UNSAVED, log: PLAN_UNSAVED_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-crashed-review',
    route: { record: CRASHED_REVIEW, log: CRASHED_REVIEW_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-crashed-apply',
    route: { record: CRASHED_APPLY, log: READY_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-crashed-review-check',
    route: { record: CRASHED_REVIEW_CHECK, log: CRASHED_REVIEW_CHECK_LOG },
  }),
  {
    ...atRestProjection({
      id: 'workflow-at-rest-left-isolation',
      route: { record: AT_REST_LEFT_ISOLATION, log: LEFT_ISOLATION_LOG },
    }),
    config: { implementer: LEFT_ISOLATION_IMPLEMENTER },
  },
  atRestProjection({
    id: 'workflow-at-rest-question',
    route: { record: AT_REST_QUESTION, log: AT_REST_QUESTION_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-waiting-gate',
    route: { record: AT_REST_WAITING_GATE },
  }),
  atRestProjection({
    id: 'workflow-closed-complete',
    route: { record: CLOSED_COMPLETE, log: recordedRunLog(CLOSED_COMPLETE) },
  }),
  atRestProjection({
    id: 'workflow-closed-complete-review-none',
    route: {
      record: CLOSED_REVIEW_NONE,
      log: withRecordedPlan(CLOSED_REVIEW_NONE, READY_REVIEW_NONE_LOG),
    },
  }),
  atRestProjection({
    id: 'workflow-ready-to-apply-review-none',
    route: { record: READY_REVIEW_NONE, log: READY_REVIEW_NONE_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-to-apply',
    route: { record: READY_TO_APPLY, log: READY_LOG },
  }),
  {
    ...atRestProjection({
      id: 'workflow-ready-crew-saved',
      route: { record: READY_CREW_SAVED, log: READY_LOG },
    }),
    sidebarVisible: true,
  },
  {
    ...atRestProjection({
      id: 'workflow-ready-seat-moved-auto',
      route: { record: READY_SEAT_MOVED_AUTO },
    }),
    sidebarVisible: true,
  },
  atRestProjection({
    id: 'workflow-at-rest-applying',
    route: { record: APPLYING, log: READY_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-applying-home-queued',
    route: { record: APPLYING, log: READY_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-applying-quit-queued',
    route: { record: APPLYING, log: READY_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-applying-closed',
    route: { record: CLOSED_APPLIED, log: APPLIED_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-applying-closed-quit-queued',
    route: { record: CLOSED_APPLIED, log: APPLIED_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-other-process-applying',
    route: { record: APPLYING, log: READY_LOG },
  }),
  // The other process's Apply began 6 seconds before the gallery clock. The replay folds the log in
  // its file order, so the start counts after the ready log whatever its time.
  atRestProjection({
    id: 'workflow-at-rest-other-process-applying-clock',
    route: {
      record: APPLYING,
      log: [...READY_LOG, { type: 'apply_started', ts: VISUAL_FIXTURE_EPOCH + 36_000 }],
    },
  }),
  atRestProjection({
    id: 'workflow-ready-composer-focus',
    route: { record: READY_TO_APPLY, log: READY_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-slash-command',
    route: { record: READY_TO_APPLY, log: READY_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-typed-words',
    route: { record: READY_TO_APPLY, log: READY_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-empty-diff',
    route: {
      record: record({
        sessionId: 'visual-ready-empty-diff',
        status: READY_TO_APPLY.status,
        state: READY_TO_APPLY.hydration.state,
        summary: { ...workspaceSummary('visual-ready-empty-diff'), changedFiles: [] },
        ledger: {
          ...READY_LEDGER,
          sessionId: 'visual-ready-empty-diff',
          tasks: READY_LEDGER.tasks.map((task) => ({ ...task, changedFiles: [] })),
        },
      }),
      log: READY_LOG,
    },
  }),
  {
    ...atRestProjection({
      id: 'workflow-continuous-transcript-ready',
      route: { record: CONTINUOUS_READY },
    }),
    sidebarVisible: true,
    config: { implementer: CONTINUOUS_READY_BUILD_SEAT },
    events: CONTINUOUS_READY_EVENTS,
  },
  atRestProjection({
    id: 'workflow-ready-override',
    route: { record: READY_OVERRIDE, log: READY_OVERRIDE_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-override-confirm',
    route: { record: READY_OVERRIDE_MULTILINE, log: READY_OVERRIDE_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-red-check',
    route: { record: READY_RED_CHECK, log: READY_RED_CHECK_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-red-check-confirm',
    route: { record: READY_RED_CHECK, log: READY_RED_CHECK_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-planner-accept-confirm',
    route: { record: READY_PLANNER_ACCEPT, log: READY_PLANNER_ACCEPT_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-planner-accept-long-note',
    route: { record: READY_PLANNER_ACCEPT_LONG_NOTE, log: READY_PLANNER_ACCEPT_LONG_NOTE_LOG },
  }),
  atRestProjection({
    id: 'workflow-ready-planner-accept-short',
    route: { record: READY_PLANNER_ACCEPT_LONG_NOTE, log: READY_PLANNER_ACCEPT_LONG_NOTE_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-applied',
    route: { record: CLOSED_APPLIED, log: APPLIED_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-pre-existing',
    route: { record: CLOSED_PRE_EXISTING, log: CLOSED_PRE_EXISTING_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-fix-cycle',
    route: { record: CLOSED_FIX_CYCLE, log: recordedRunLog(CLOSED_FIX_CYCLE) },
  }),
  {
    ...atRestProjection({
      id: 'workflow-closed-summary',
      route: { record: CLOSED_SUMMARY, log: fixCycleRunLog() },
    }),
    sidebarVisible: true,
  },
  atRestProjection({
    id: 'workflow-closed-set-aside',
    route: { record: CLOSED_SET_ASIDE, log: CLOSED_SET_ASIDE_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-undone',
    route: { record: undoneApplyRecord([]), log: APPLIED_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-undo-conflicts',
    route: { record: undoneApplyRecord([FILES.form]), log: APPLIED_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-discarded',
    route: { record: CLOSED_DISCARDED, log: CLOSED_DISCARDED_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-complete-needs-attention',
    route: { record: CLOSED_NEEDS_ATTENTION, log: recordedRunLog(CLOSED_NEEDS_ATTENTION) },
  }),
  atRestProjection({
    id: 'workflow-closed-planner-accept',
    route: { record: CLOSED_PLANNER_ACCEPT, log: CLOSED_PLANNER_ACCEPT_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-red-check-accept',
    route: { record: CLOSED_RED_CHECK_ACCEPT, log: CLOSED_RED_CHECK_ACCEPT_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-decided-skip',
    route: {
      record: CLOSED_DECIDED_SKIP,
      log: withRecordedPlan(CLOSED_DECIDED_SKIP, DECIDED_SKIP_LOG),
    },
  }),
  atRestProjection({
    id: 'workflow-closed-rejected',
    route: { record: CLOSED_REJECTED, log: CLOSED_REJECTED_LOG },
  }),
  {
    ...atRestProjection({
      id: 'workflow-closed-ended',
      route: { record: CLOSED_ENDED, log: CLOSED_ENDED_LOG },
    }),
    sidebarVisible: true,
  },
  atRestProjection({
    id: 'workflow-closed-ended-empty',
    route: {
      record: CLOSED_ENDED_EMPTY,
      log: [
        {
          type: 'workflow_started',
          ts: Date.parse(STARTED_AT_ISO),
          phase: 'planning',
          feature: AT_REST_FIXTURE_FEATURE,
        },
        { type: 'plan_approved', ts: Date.parse(STARTED_AT_ISO) + 1_000, phase: 'planning' },
        {
          type: 'task_started',
          ts: Date.parse(STARTED_AT_ISO) + 1_000,
          phase: 'implementing',
          taskId: BRIEFS.validator.id,
          title: BRIEFS.validator.title,
          file: BRIEFS.validator.file,
          action: savedAction(CLOSED_ENDED_EMPTY.hydration.state, BRIEFS.validator.id),
          index: 0,
          total: CLOSED_ENDED_EMPTY.hydration.state.tasks.length,
          ...ENDED_BUILD,
        },
        {
          type: 'turn_interrupted',
          ts: Date.parse(STARTED_AT_ISO) + 1_800,
          phase: 'implementing',
          source: 'user',
          at: 'mid-step',
          step: { kind: 'brief', taskId: BRIEFS.validator.id, attempt: 0 },
        },
        { type: 'workspace_closed', ts: Date.parse(STARTED_AT_ISO) + 1_900, phase: 'implementing' },
        {
          type: 'workflow_cancelled',
          ts: Date.parse(STARTED_AT_ISO) + 2_000,
          phase: 'implementing',
          reason: WORKFLOW_CANCEL_REASON_USER,
        },
      ],
    },
  }),
  atRestProjection({
    id: 'workflow-closed-ended-workspace',
    route: { record: CLOSED_ENDED_WORKSPACE, log: ENDED_WORKSPACE_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-ended-moved-workspace',
    route: { record: CLOSED_ENDED_MOVED_WORKSPACE, log: ENDED_MOVED_WORKSPACE_LOG },
  }),
  atRestProjection({
    id: 'workflow-closed-ended-review',
    route: { record: CLOSED_ENDED_REVIEW, log: recordedRunLog(CLOSED_ENDED_REVIEW) },
  }),
  atRestProjection({
    id: 'workflow-closed-review-no-verdict',
    route: { record: CLOSED_REVIEW_NO_VERDICT, log: recordedRunLog(CLOSED_REVIEW_NO_VERDICT) },
  }),
  atRestProjection({
    id: 'workflow-closed-ended-review-workspace',
    route: {
      record: CLOSED_ENDED_REVIEW_WORKSPACE,
      log: recordedRunLog(CLOSED_ENDED_REVIEW_WORKSPACE),
    },
  }),
  atRestProjection({
    id: 'workflow-closed-seat-moved',
    route: { record: CLOSED_SEAT_MOVED, log: recordedRunLog(CLOSED_SEAT_MOVED) },
  }),
  atRestProjection({
    id: 'workflow-closed-mixed-workers',
    route: { record: CLOSED_MIXED_WORKERS, log: recordedRunLog(CLOSED_MIXED_WORKERS) },
  }),
  atRestProjection({
    id: 'workflow-replayed-history',
    route: { record: REPLAYED_HISTORY, log: REPLAYED_HISTORY_LOG },
  }),
  atRestProjection({
    id: 'workflow-gates-approved',
    route: { record: GATES_APPROVED, log: GATES_APPROVED_LOG },
  }),
  atRestProjection({
    id: 'workflow-gate-stopped',
    route: { record: GATE_STOPPED, log: GATE_STOPPED_LOG },
  }),
];
