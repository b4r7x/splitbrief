import type { Phase } from '../../../../src/core/schemas/enums.js';
import type { EvidenceLedger, EvidenceTask } from '../../../../src/core/schemas/evidence.js';
import type { RunRecord } from '../../../../src/core/sessions/run-record.js';
import type { RunStatus } from '../../../../src/core/sessions/run-status.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import { makeTask } from '../../../helpers/factories/task.js';
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
import { scenarioId } from '../../contracts/identifiers.js';
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

const PASSED_STAGES: readonly EvidenceTask['validation'][number][] = [
  { stage: 'typecheck', passed: true, command: 'npm run typecheck' },
  { stage: 'lint', passed: true, command: 'npm run lint' },
  { stage: 'test', passed: true, command: 'npm test' },
];

const ESCALATED_STAGES: readonly EvidenceTask['validation'][number][] = [
  { stage: 'typecheck', passed: true, command: 'npm run typecheck' },
  { stage: 'lint', passed: true, command: 'npm run lint' },
  { stage: 'test', passed: true, command: 'npm test', retryState: 'escalated' },
];

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
const READY_SESSION = 'visual-closed-ready';
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
      validation: [...PASSED_STAGES],
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
      validation: [...ESCALATED_STAGES],
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
      validation: [],
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
      validation: [],
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
      validation: [],
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

function settledLocalTasks(durations: readonly [number, number, number]): EvidenceTask[] {
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
      validation: [...PASSED_STAGES],
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
      validation: [...PASSED_STAGES],
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
      validation: [...PASSED_STAGES],
      expectedEvidence: [FILES.signupTest],
      observedEvidence: [FILES.signupTest],
      escalated: false,
    },
  ];
}

const READY_PACKET = reviewPacket({
  sessionId: READY_SESSION,
  verdict: 'pass_with_notes',
  counts: { critical: 0, warning: 1, note: 2 },
  driftPassed: true,
  tasks: 3,
});

const READY_LEDGER: EvidenceLedger = ledger({
  sessionId: READY_SESSION,
  tasks: settledLocalTasks([84_200, 141_000, 96_300]),
  validationSummary: { passed: 9, failed: 0, skipped: 0, escalated: 0 },
  finalReview: { path: packetMarkdownPath(READY_SESSION), status: 'written' },
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
          validation: [...ESCALATED_STAGES],
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
}): RunRecord {
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

const CLOSED_READY = record({
  sessionId: READY_SESSION,
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

/** The S9 run's close: a worktree run ended on its failed-review halt, the result in run.patch. */
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

export const atRestProjections: readonly WorkflowFixtureProjection[] = [
  atRestProjection({
    id: 'workflow-at-rest-paused',
    route: { record: AT_REST_PAUSED, log: 'testing/fixtures/session-log/paused-mid-brief.jsonl' },
  }),
  atRestProjection({
    id: 'workflow-at-rest-long-park',
    route: { record: AT_REST_LONG_PARK, log: LONG_PARK_LOG },
  }),
  atRestProjection({ id: 'workflow-at-rest-quick', route: { record: AT_REST_QUICK } }),
  atRestProjection({ id: 'workflow-at-rest-halted', route: { record: AT_REST_HALTED } }),
  atRestProjection({
    id: 'workflow-at-rest-left-isolation',
    route: { record: AT_REST_LEFT_ISOLATION, log: LEFT_ISOLATION_LOG },
  }),
  atRestProjection({
    id: 'workflow-at-rest-waiting-gate',
    route: { record: AT_REST_WAITING_GATE },
  }),
  atRestProjection({ id: 'workflow-closed-complete-ready', route: { record: CLOSED_READY } }),
  atRestProjection({ id: 'workflow-ready-to-apply', route: { record: READY_TO_APPLY } }),
  atRestProjection({ id: 'workflow-ready-override', route: { record: READY_OVERRIDE } }),
  atRestProjection({ id: 'workflow-closed-applied', route: { record: CLOSED_APPLIED } }),
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
