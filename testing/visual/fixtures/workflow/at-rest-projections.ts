import type { Phase } from '../../../../src/core/schemas/enums.js';
import type { EvidenceLedger, EvidenceTask } from '../../../../src/core/schemas/evidence.js';
import type { RunRecord } from '../../../../src/core/sessions/run-record.js';
import type { RunStatus } from '../../../../src/core/sessions/run-status.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { makeMessage } from '../../../helpers/queue.js';
import type {
  CostBreakdown,
  OfferingBillingPresentation,
  ProviderRunMetadata,
  ReviewPacketSummary,
  Summary,
} from '../../../../src/core/schemas/summary.js';
import { taskId, type Task } from '../../../../src/core/schemas/task.js';
import type { TaskTokenUsage } from '../../../../src/core/schemas/tokens.js';
import {
  describeOfferingBillingPresentation,
  resolveProviderRunMetadata,
} from '../../../../src/engine/providers/cost/breakdown.js';
import { makeUsage } from '../../../helpers/factories/summary.js';
import { buildSeatDownIssue } from '../../../../src/engine/orchestrator/recovery/builders/task.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../../../src/engine/events/workflow-cancel.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../../src/core/sessions/workspace-notice.js';
import { retainedWorkspaceNotice } from '../../../../src/engine/orchestrator/isolation/retention.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { VISUAL_FIXTURE_EPOCH } from '../common.js';
import { VISUAL_FIXTURE_PROJECT_DIR, visualConfig } from '../screen-fixtures.js';
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

interface FixtureRunnerBilling {
  /** What the runner was metered for, or `null` when its offering never meters a token. */
  readonly meteredCost: number | null;
  readonly endpoint?: string;
}

/**
 * Billing identity read from the engine's own provider catalog, so a fixture crew reports the
 * offering and labels a real run of that crew would report rather than a transcribed guess.
 */
function billingFacts(
  runners: Readonly<Record<string, FixtureRunnerBilling>>,
): Pick<CostBreakdown, 'providerRunMetadata' | 'offeringPresentations'> {
  const providerRunMetadata: Record<string, ProviderRunMetadata> = {};
  const offeringPresentations: Record<string, OfferingBillingPresentation> = {};
  for (const [tool, runner] of Object.entries(runners)) {
    const metadata = resolveProviderRunMetadata({
      tool,
      ...(runner.endpoint !== undefined && { normalizedEndpoint: runner.endpoint }),
    });
    if (metadata === undefined) {
      throw new Error(`Summary fixture crew names a tool with no billing identity: ${tool}`);
    }
    providerRunMetadata[tool] = metadata;
    offeringPresentations[tool] = describeOfferingBillingPresentation(metadata, {
      hasUsage: runner.meteredCost !== null,
      meteredCost: runner.meteredCost ?? 0,
    });
  }
  return { providerRunMetadata, offeringPresentations };
}

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

function reviewPacket(input: {
  readonly sessionId: string;
  readonly verdict: ReviewPacketSummary['finalReviewVerdict'];
  readonly counts: ReviewPacketSummary['finalReviewFindingCounts'];
  readonly driftPassed: boolean;
  readonly tasks: number;
}): ReviewPacketSummary {
  return {
    jsonPath: `.splitbrief/sessions/${input.sessionId}/review-packet.json`,
    markdownPath: packetMarkdownPath(input.sessionId),
    generatedAt: GENERATED_AT,
    finalReviewStatus: 'written',
    finalReviewVerdict: input.verdict,
    finalReviewFindingCounts: input.counts,
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
/**
 * The one crew in the gallery a run can actually be billed for: `resolvePricing` prices API
 * endpoints only, so a CLI seat — subscription or not — can never report a known dollar figure.
 */
const READY_ENDPOINT = 'https://api.example.test/v1';
const NEEDS_ATTENTION_SESSION = 'visual-closed-needs-attention';

const INTERRUPTED_BUILD_TASKS: readonly TaskTokenUsage[] = [
  {
    taskId: BRIEFS.validator.id,
    taskTitle: BRIEFS.validator.title,
    method: 'local',
    implementerTokens: 41_200,
    escalationTokens: 0,
    retryCount: 0,
    tool: 'ollama',
    model: 'qwen2.5-coder:7b',
  },
  {
    taskId: BRIEFS.wire.id,
    taskTitle: BRIEFS.wire.title,
    method: 'escalated-full',
    implementerTokens: 62_800,
    escalationTokens: 44_000,
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
  tokenUsage: makeUsage({
    plannerInput: 17_400,
    plannerOutput: 4_000,
    implementerInput: 83_200,
    implementerOutput: 20_800,
    escalationInput: 35_200,
    escalationOutput: 8_800,
  }),
  escalationRate: 0.2,
  taskBreakdown: [...INTERRUPTED_BUILD_TASKS],
  costBreakdown: {
    actualPlannerCost: 0,
    actualImplementerCost: 0,
    totalActualCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: true,
    isActualPlannerCostKnown: false,
    isActualImplementerCostKnown: false,
    isTotalActualCostKnown: false,
    ...billingFacts({ 'claude-code': { meteredCost: null }, ollama: { meteredCost: null } }),
  },
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

const READY_TASKS: readonly TaskTokenUsage[] = [
  {
    taskId: BRIEFS.validator.id,
    taskTitle: BRIEFS.validator.title,
    method: 'local',
    implementerTokens: 62_400,
    escalationTokens: 0,
    retryCount: 0,
    tool: 'custom-endpoint',
    model: 'gpt-5-mini',
  },
  {
    taskId: BRIEFS.wire.id,
    taskTitle: BRIEFS.wire.title,
    method: 'local',
    implementerTokens: 88_700,
    escalationTokens: 0,
    retryCount: 1,
    tool: 'custom-endpoint',
    model: 'gpt-5-mini',
  },
  {
    taskId: BRIEFS.routeTests.id,
    taskTitle: BRIEFS.routeTests.title,
    method: 'local',
    implementerTokens: 53_400,
    escalationTokens: 0,
    retryCount: 0,
    tool: 'custom-endpoint',
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

const READY_PACKET = reviewPacket({
  sessionId: COMPLETE_SESSION,
  verdict: 'pass_with_notes',
  counts: { critical: 0, warning: 1, note: 2 },
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
  tokenUsage: makeUsage({
    plannerInput: 25_200,
    plannerOutput: 6_000,
    implementerInput: 168_500,
    implementerOutput: 36_000,
    reviewerInput: 15_700,
    reviewerOutput: 3_000,
  }),
  escalationRate: 0,
  taskBreakdown: [...READY_TASKS],
  costBreakdown: {
    actualPlannerCost: 0.16,
    actualImplementerCost: 0.22,
    actualReviewerCost: 0.04,
    totalActualCost: 0.42,
    hasPricedUsage: true,
    hasUnpricedUsage: false,
    isActualPlannerCostKnown: true,
    isActualImplementerCostKnown: true,
    isActualReviewerCostKnown: true,
    isTotalActualCostKnown: true,
    providerCosts: {
      'custom-endpoint': { inputTokens: 209_400, outputTokens: 45_000, cost: 0.42 },
    },
    ...billingFacts({ 'custom-endpoint': { meteredCost: 0.42, endpoint: READY_ENDPOINT } }),
  },
  plannerTool: 'custom-endpoint',
  plannerModel: 'gpt-5.1',
  implementerTool: 'custom-endpoint',
  implementerModel: 'gpt-5-mini',
  reviewerTool: 'custom-endpoint',
  reviewerModel: 'gpt-5-codex',
  phaseTimings: { planning: 170_000, implementing: 492_000, review: 65_000 },
  mode: 'standard',
  driftSummary: { passed: true, score: 1, errorCount: 0, warningCount: 0 },
  reviewPacket: READY_PACKET,
  review: legacyReview(READY_PACKET),
  changedFiles: [FILES.formTest, FILES.form, FILES.signupTest, FILES.validate],
});

const NEEDS_ATTENTION_TASKS: readonly TaskTokenUsage[] = [
  {
    taskId: BRIEFS.validator.id,
    taskTitle: BRIEFS.validator.title,
    method: 'local',
    implementerTokens: 48_600,
    escalationTokens: 0,
    retryCount: 0,
    tool: 'claude-code',
    model: 'claude-haiku-4-5',
  },
  {
    taskId: BRIEFS.wire.id,
    taskTitle: BRIEFS.wire.title,
    method: 'escalated-full',
    implementerTokens: 61_400,
    escalationTokens: 39_800,
    retryCount: 2,
    tool: 'claude-code',
    model: 'claude-haiku-4-5',
  },
  {
    taskId: BRIEFS.routeTests.id,
    taskTitle: BRIEFS.routeTests.title,
    method: 'local',
    implementerTokens: 23_400,
    escalationTokens: 0,
    retryCount: 0,
    tool: 'claude-code',
    model: 'claude-haiku-4-5',
  },
];

const NEEDS_ATTENTION_PACKET = reviewPacket({
  sessionId: NEEDS_ATTENTION_SESSION,
  verdict: 'fail',
  counts: { critical: 2, warning: 1, note: 0 },
  driftPassed: false,
  tasks: 3,
});

const NEEDS_ATTENTION_LEDGER: EvidenceLedger = ledger({
  sessionId: NEEDS_ATTENTION_SESSION,
  tasks: settledLocalTasks([84_200, 312_600, 96_300]).map((task) =>
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
  tokenUsage: makeUsage({
    plannerInput: 23_100,
    plannerOutput: 5_800,
    implementerInput: 107_600,
    implementerOutput: 25_800,
    escalationInput: 32_400,
    escalationOutput: 7_400,
    reviewerInput: 17_900,
    reviewerOutput: 3_600,
  }),
  escalationRate: 1 / 3,
  taskBreakdown: [...NEEDS_ATTENTION_TASKS],
  costBreakdown: {
    actualPlannerCost: 0,
    actualImplementerCost: 0,
    totalActualCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: true,
    isActualPlannerCostKnown: false,
    isActualImplementerCostKnown: false,
    isTotalActualCostKnown: false,
    ...billingFacts({ 'claude-code': { meteredCost: null } }),
  },
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

// The run started when its log says it did: a record dated apart from the transcript it replays
// paints an elapsed clock measured in days.
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
    tokenUsage: makeUsage(),
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

/** Ten minutes of build, a stop, a night at rest, five minutes more: fifteen minutes of run time. */
export const LONG_PARK_LOG = 'testing/fixtures/session-log/long-park.jsonl';

const AT_REST_LONG_PARK = record({
  sessionId: 'visual-at-rest-long-park',
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

/** The fallback the BUILD seat declares in config: a seat that cannot work moves to it. */
const SEAT_FALLBACK = {
  tool: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  variant: 'max',
} as const;

const AT_REST_HALTED = record({
  sessionId: 'visual-at-rest-halted',
  status: {
    kind: 'open',
    stop: {
      kind: 'waiting-for-you',
      on: {
        kind: 'halt',
        issue: buildSeatDownIssue({
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
        }),
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
  }),
});

/** The log carries the rows the halt wrote: the error that states the evidence and the recovery card. */
export const LEFT_ISOLATION_LOG = 'testing/fixtures/session-log/left-isolation.jsonl';

const AT_REST_LEFT_ISOLATION = record({
  sessionId: 'visual-at-rest-left-isolation',
  status: {
    kind: 'open',
    stop: {
      kind: 'waiting-for-you',
      on: {
        kind: 'halt',
        issue: {
          id: 'visual-left-isolation',
          reason: 'implementer-left-isolation',
          phase: 'implementing',
          status: 'awaiting-user',
          seat: 'build',
          taskId: BRIEFS.wire.id,
          files: [BRIEFS.wire.file],
          affectedTaskIds: [BRIEFS.wire.id],
          message: `${BRIEFS.wire.id} left the isolation directory · Google Antigravity CLI searched ~ (outside the workspace) with run_command: find ~ -name "form.ts" 2>/dev/null`,
          details: [
            'Google Antigravity CLI searched ~ (outside the workspace) with run_command: find ~ -name "form.ts" 2>/dev/null',
            "Your checkout gets the run's changes only through Apply.",
          ],
          facts: { tool: 'Google Antigravity CLI' },
          availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
          recommendedAction: 'retry-same-worker',
          createdAt: STARTED_AT_ISO,
        },
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
  }),
});

const AT_REST_WAITING_GATE = record({
  sessionId: 'visual-at-rest-waiting-gate',
  status: {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'spec', reopens: false } },
    resumeAt: { kind: 'gate', gate: 'spec' },
  },
  state: savedState({ phase: 'reviewing-spec', briefs: [] }),
});

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
  }),
  summary: READY_SUMMARY,
  ledger: READY_LEDGER,
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
    type: 'review_checks',
    ts: CONTINUOUS_READY_TS + 1_000,
    phase: 'final-review',
    scope: 'final',
    status: 'planned',
    commands: [
      { id: 'V1', command: 'npm test', reason: 'The form tests cover the changed input.' },
    ],
    declined: [],
    reason: null,
  },
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
      action: 'modify',
      index,
      total: READY_LEDGER.tasks.length,
      tool: 'ollama',
      model: 'qwen2.5-coder:7b',
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
      tool: 'ollama',
      model: 'qwen2.5-coder:7b',
    },
  ]),
  {
    type: 'review_started',
    ts: Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime - 62_000,
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
    verdict: 'pass-with-notes',
    findings: {
      blocking: READY_PACKET.finalReviewFindingCounts.critical,
      minor: READY_PACKET.finalReviewFindingCounts.warning,
      outOfScope: READY_PACKET.finalReviewFindingCounts.note,
    },
    duration: 62_000,
  },
  {
    type: 'workflow_complete',
    ts: Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime,
    phase: 'complete',
    review: 'passed',
    completedTasks: READY_LEDGER.tasks.length,
  },
];

const READY_OVERRIDE_LOG: readonly EngineEvent[] = READY_LOG.map((event) =>
  event.type === 'review_completed'
    ? { ...event, verdict: 'fail', findings: { blocking: 2, minor: 0, outOfScope: 0 } }
    : event.type === 'workflow_complete'
      ? { ...event, review: 'failed', blocking: 2 }
      : event,
);

const CLOSED_APPLIED = record({
  sessionId: 'visual-closed-applied',
  status: { kind: 'closed', as: 'applied' },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    applied: {
      at: GENERATED_AT,
      backupId: 'visual-backup',
      files: [FILES.formTest, FILES.form, FILES.signupTest, FILES.validate],
    },
    closed: { at: GENERATED_AT, as: 'applied' },
  }),
  summary: workspaceSummary('visual-closed-applied'),
  ledger: READY_LEDGER,
});

/**
 * An applied run whose final review ran a reviewer check that was red at the run base too: the
 * review raised no finding for it, and the closed block names the check and its failing tests.
 */
const CLOSED_PRE_EXISTING = record({
  sessionId: 'visual-closed-pre-existing',
  status: { kind: 'closed', as: 'applied' },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    review: {
      scope: 'final',
      cycle: 0,
      verdict: { tasks: [], criteria: [], findings: [] },
      outcome: 'pass',
      verification: [],
      preExistingChecks: [
        {
          id: 'V2',
          command: 'npx --no-install vitest run legacy',
          keys: [
            'legacy/report.test.ts > legacy report > total matches the ledger',
            'legacy/report.test.ts > legacy report > rounds the tax',
            'legacy/ledger.test.ts > legacy ledger > opens the ledger',
            'legacy/ledger.test.ts > legacy ledger > closes the ledger',
          ],
        },
      ],
      at: GENERATED_AT,
    },
    applied: {
      at: GENERATED_AT,
      backupId: 'visual-backup',
      files: [FILES.formTest, FILES.form, FILES.signupTest, FILES.validate],
    },
    closed: { at: GENERATED_AT, as: 'applied' },
  }),
  summary: workspaceSummary('visual-closed-pre-existing'),
  ledger: READY_LEDGER,
});

function undoneApplyRecord(conflicts: string[]): RunRecord {
  const sessionId =
    conflicts.length === 0 ? 'visual-closed-undone' : 'visual-closed-undo-conflicts';
  return record({
    sessionId,
    status: { kind: 'closed', as: 'applied' },
    state: savedState({
      phase: 'complete',
      briefs: WORKSPACE_BRIEFS,
      reviewStatus: 'passed',
      workspace: RUN_WORKSPACE,
      applied: {
        at: GENERATED_AT,
        backupId: 'visual-backup',
        files: [FILES.formTest, FILES.form],
        undone: { at: GENERATED_AT, conflicts },
      },
      closed: { at: GENERATED_AT, as: 'applied' },
    }),
    summary: workspaceSummary(sessionId),
    ledger: READY_LEDGER,
  });
}

const CLOSED_DISCARDED = record({
  sessionId: 'visual-closed-discarded',
  status: { kind: 'closed', as: 'discarded' },
  state: savedState({
    phase: 'complete',
    briefs: WORKSPACE_BRIEFS,
    reviewStatus: 'passed',
    workspace: RUN_WORKSPACE,
    closed: {
      at: GENERATED_AT,
      as: 'discarded',
      patch: '.splitbrief/sessions/visual-closed-discarded/run.patch',
    },
  }),
  summary: workspaceSummary('visual-closed-discarded'),
  ledger: READY_LEDGER,
});

/**
 * The ready run with its BUILD seat moved mid-run, as a real run did: the first brief ran on
 * Antigravity, the two after it on OpenCode, one profile throughout.
 */
const SEAT_MOVED_SESSION = 'visual-closed-seat-moved';
const SEAT_MOVED_TOOL = { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' } as const;
const SEAT_MOVED_PACKET = reviewPacket({
  sessionId: SEAT_MOVED_SESSION,
  verdict: 'pass_with_notes',
  counts: { critical: 0, warning: 1, note: 2 },
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
  verdict: 'pass_with_notes',
  counts: { critical: 0, warning: 1, note: 2 },
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
  status: { kind: 'closed', as: 'complete' },
  state: savedState({
    phase: 'complete',
    briefs: [
      { id: BRIEFS.validator.id, status: 'done' },
      { id: BRIEFS.wire.id, status: 'escalated' },
      { id: BRIEFS.routeTests.id, status: 'done' },
    ],
  }),
  summary: NEEDS_ATTENTION_SUMMARY,
  ledger: NEEDS_ATTENTION_LEDGER,
});

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
  }),
  summary: INTERRUPTED_BUILD_SUMMARY,
  ledger: INTERRUPTED_BUILD_LEDGER,
});

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
const ENDED_WORKSPACE_AT = Date.parse(STARTED_AT_ISO) + INTERRUPTED_BUILD_SUMMARY.totalTime;
const ENDED_WORKSPACE_PATCH = `.splitbrief/sessions/${ENDED_WORKSPACE_SESSION}/run.patch`;
const CLOSED_ENDED_WORKSPACE = record({
  sessionId: ENDED_WORKSPACE_SESSION,
  status: { kind: 'closed', as: 'ended' },
  state: {
    ...CLOSED_ENDED.hydration.state,
    workspace: RUN_WORKSPACE,
    closed: {
      at: new Date(ENDED_WORKSPACE_AT).toISOString(),
      as: 'ended',
      patch: ENDED_WORKSPACE_PATCH,
    },
  },
  summary: INTERRUPTED_BUILD_SUMMARY,
  ledger: { ...INTERRUPTED_BUILD_LEDGER, sessionId: ENDED_WORKSPACE_SESSION },
});
const ENDED_WORKSPACE_LOG: readonly EngineEvent[] = [
  {
    type: 'workflow_started',
    ts: Date.parse(STARTED_AT_ISO),
    phase: 'planning',
    feature: AT_REST_FIXTURE_FEATURE,
  },
  {
    type: 'turn_interrupted',
    ts: ENDED_WORKSPACE_AT - 3_000,
    phase: 'implementing',
    source: 'user',
    at: 'mid-step',
    step: { kind: 'brief', taskId: BRIEFS.routeTests.id, attempt: 0 },
  },
  {
    type: 'warning',
    ts: ENDED_WORKSPACE_AT - 2_000,
    phase: 'implementing',
    message: retainedWorkspaceNotice(RUN_WORKSPACE.path),
    category: WORKSPACE_NOTICE_CATEGORY,
    code: WORKSPACE_KEPT_CODE,
  },
  {
    type: 'warning',
    ts: ENDED_WORKSPACE_AT - 1_000,
    phase: 'implementing',
    message: `Run changes not applied are saved in ${ENDED_WORKSPACE_PATCH}; apply them with git apply.`,
  },
  { type: 'workspace_closed', ts: ENDED_WORKSPACE_AT - 1_000, phase: 'implementing' },
  {
    type: 'workflow_cancelled',
    ts: ENDED_WORKSPACE_AT,
    phase: 'implementing',
    reason: WORKFLOW_CANCEL_REASON_USER,
  },
];

const ENDED_REVIEW_SESSION = 'visual-ended-review';
const ENDED_REVIEW_AT = new Date(
  Date.parse(STARTED_AT_ISO) + READY_SUMMARY.totalTime,
).toISOString();
const ENDED_REVIEW_PACKET = reviewPacket({
  sessionId: ENDED_REVIEW_SESSION,
  verdict: 'fail',
  counts: { critical: 2, warning: 1, note: 0 },
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
    completedAt: ENDED_REVIEW_AT,
    closed: { as: 'ended', at: ENDED_REVIEW_AT },
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
    completedAt: ENDED_REVIEW_AT,
    closed: {
      at: ENDED_REVIEW_AT,
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
    type: 'review_checks',
    ts: CADENCE_TS + 234_000,
    phase: 'implementing',
    scope: 'task',
    status: 'planned',
    commands: [{ id: 'V1', command: 'npm test', reason: 'Verify the email validation cases.' }],
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
  ...cadenceBrief({ brief: CADENCE_BRIEFS[2], index: 2, started: 284_000, completed: 310_000 }),
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

const CRASHED_REVIEW_LOG: readonly EngineEvent[] = [
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
  atRestProjection({
    id: 'workflow-at-rest-long-park',
    route: { record: AT_REST_LONG_PARK, log: LONG_PARK_LOG },
  }),
  atRestProjection({ id: 'workflow-at-rest-quick', route: { record: AT_REST_QUICK } }),
  atRestProjection({ id: 'workflow-at-rest-halted', route: { record: AT_REST_HALTED } }),
  {
    ...atRestProjection({
      id: 'workflow-at-rest-crashed-build',
      route: { record: CRASHED_BUILD, log: CRASHED_BUILD_LOG },
    }),
    sidebarVisible: true,
  },
  atRestProjection({
    id: 'workflow-at-rest-crashed-review',
    route: { record: CRASHED_REVIEW, log: CRASHED_REVIEW_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-left-isolation',
    route: { record: AT_REST_LEFT_ISOLATION, log: LEFT_ISOLATION_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-waiting-gate',
    route: { record: AT_REST_WAITING_GATE },
  }),
  atRestProjection({ id: 'workflow-closed-complete', route: { record: CLOSED_COMPLETE } }),
  atRestProjection({
    id: 'workflow-ready-to-apply',
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
  atRestProjection({ id: 'workflow-closed-applied', route: { record: CLOSED_APPLIED } }),
  atRestProjection({
    id: 'workflow-closed-pre-existing',
    route: { record: CLOSED_PRE_EXISTING },
  }),
  atRestProjection({ id: 'workflow-closed-undone', route: { record: undoneApplyRecord([]) } }),
  atRestProjection({
    id: 'workflow-closed-undo-conflicts',
    route: { record: undoneApplyRecord([FILES.form]) },
  }),
  atRestProjection({ id: 'workflow-closed-discarded', route: { record: CLOSED_DISCARDED } }),
  atRestProjection({
    id: 'workflow-closed-complete-needs-attention',
    route: { record: CLOSED_NEEDS_ATTENTION },
  }),
  atRestProjection({ id: 'workflow-closed-ended', route: { record: CLOSED_ENDED } }),
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
  atRestProjection({ id: 'workflow-closed-ended-review', route: { record: CLOSED_ENDED_REVIEW } }),
  atRestProjection({
    id: 'workflow-closed-ended-review-workspace',
    route: { record: CLOSED_ENDED_REVIEW_WORKSPACE },
  }),
  atRestProjection({ id: 'workflow-closed-seat-moved', route: { record: CLOSED_SEAT_MOVED } }),
  atRestProjection({
    id: 'workflow-closed-mixed-workers',
    route: { record: CLOSED_MIXED_WORKERS },
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
