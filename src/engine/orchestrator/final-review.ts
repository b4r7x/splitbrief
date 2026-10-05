import type { WorkflowState, ReviewRecord } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { ContinuationHolder } from './continuation.js';
import type { EventBus } from '../events/types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Config } from '../../core/schemas/config.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import {
  PLAN_FILE,
  REVIEW_FILE,
  REVIEW_JSON_FILE,
  SPEC_FILE,
  TASKS_FILE,
} from '../../core/paths.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import {
  getRunnerCatalogDisplayName,
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../core/config/accessors/runner-config.js';
import { error } from '../../utils/error.js';
import { nowIso } from '../../utils/format-time.js';
import { labelError } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { isAbortError } from '../../utils/abort.js';
import {
  buildFinalReviewPrompt,
  type ReviewPlanData,
  type ReviewTaskDiff,
  type ReviewTouchedNotSuggested,
} from '../spec/prompts/review.js';
import { workspaceReadInstructions } from '../spec/prompts/builder.js';
import { recordFinalReviewEvidence } from './evidence/reporting.js';
import { formatValidationEvidenceForPrompt } from './evidence/format-validation.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import { analyzeBriefDrift } from './drift/analyze.js';
import { writeDriftReport } from './drift/io.js';
import { formatDriftReportForPrompt, publishDriftReport } from './drift/format.js';

import type { Reviewer } from '../reviewers/types.js';
import { buildSummary, type SummaryBase } from './summary/build.js';
import { publishError, publishPlannerStatus, publishWarningFromError } from './events.js';
import { transitionAndSave } from './state-ops.js';
import { runReviewerCall } from './review-call.js';
import { touchedNotSuggestedFiles } from './task/commit.js';
import { taskFiles } from '../../core/schemas/task.js';
import { hashTaskBrief } from '../brief-hash.js';
import { writeReviewPacket } from './evidence/review-packet/write.js';
import { formatTasks } from '../spec/formatter.js';
import { drainQueue } from './queue/drain.js';
import { formatDrainedMessages } from './queue/prompt.js';
import { withContinuationLoop } from './continuation.js';
import { composeContinuation } from '../spec/prompts/continuation.js';
import { resolveRunUniverse } from './evidence/review-packet/sections-io.js';
import { resolveRunReviewScope, type RunReviewScope } from './evidence/review-packet/run-scope.js';
import { buildApiReviewContext } from './api-review-context.js';
import {
  apiContextError,
  readApiContextDiagnostic,
  type ApiContextDiagnostic,
} from '../providers/api-context-diagnostic.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  diagnosePlannerCallFailure,
  type PlannerCallDiagnosis,
} from './recovery/planner-call-failure.js';
import { ReviewVerdictSchema, type ReviewVerdict } from '../../core/schemas/review.js';
import {
  deriveReviewOutcome,
  verificationKey,
  reviewScopeFor,
  verdictCoverageErrors,
  type ReviewOutcome,
} from '../../core/review/verdict.js';
import { renderReviewMarkdown } from '../../core/review/render.js';
import { runChecks, type CheckRunResult } from './validation/run-checks.js';
import type { RequestTypedResult, SeatProtocolError } from '../runners/typed-output.js';
import { fixCyclesOf } from '../../core/schemas/workflow.js';

/** The code a failed review carries when the failure names none of its own. */
export const REVIEW_UNAVAILABLE = 'review-unavailable';

/**
 * Why a review reached no verdict. `insufficient-context` is the packet refusing
 * before anything was dispatched; `call-failed` is a transport or protocol
 * failure, summarized — never a fabricated blocker count; `seat-blocked` is a
 * seat that cannot run at all until its quota comes back or its login does.
 */
export type FinalReviewFailure =
  | Readonly<{ kind: 'insufficient-context'; diagnostic: ApiContextDiagnostic }>
  | Readonly<{ kind: 'call-failed'; code: string; message: string }>
  | Readonly<{ kind: 'seat-blocked'; diagnosis: PlannerCallDiagnosis }>
  | Readonly<{ kind: 'seat-protocol-error'; error: SeatProtocolError }>;

function errorKind(err: unknown): string | undefined {
  return isRecord(err) && typeof err.kind === 'string' ? err.kind : undefined;
}

/** How far the final review got: a written verdict, or a call that did not land. */
export type ReviewPhaseStatus = 'written' | 'failed' | 'unparseable';

export type FinalReview = {
  verdict: ReviewVerdict;
  outcome: ReviewOutcome;
};

export type FinalReviewResult = {
  state: WorkflowState;
  summaryBase?: SummaryBase | undefined;
  verdict: FinalReview | null;
  reviewText: string;
  reviewStatus: ReviewPhaseStatus;
  /**
   * Why this review reached no verdict, when it reached none. Additive: a
   * caller that does not read it sees the status it always saw.
   */
  failure?: FinalReviewFailure;
};

export const finalReviewError = {
  missingRunBaseline: () =>
    error(
      'final-review-missing-run-baseline',
      'Session state carries no run-start baseline, so the run diff cannot be bounded. Start a new run.',
    ),
} as const;

/** The plan's own data as the review prompt presents it. */
function reviewPlanData(state: WorkflowState): ReviewPlanData {
  return {
    criteria: (state.plan?.criteria ?? []).map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      checkIds: criterion.checkIds,
    })),
    decisions: state.plan?.decisions ?? [],
    tasks: state.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      intent: task.description,
      criteria: task.criteria ?? [],
      suggestedFiles: task.suggestedFiles ?? [...taskFiles(task)],
      exclusions: task.exclusions ?? task.scope?.outOfBounds ?? [],
    })),
  };
}

/** The recorded check runs: what each brief's checks returned, then the plan's. */
function reviewCheckResults(state: WorkflowState): string {
  const lines: string[] = [];
  for (const task of state.tasks) {
    for (const result of task.checkResults ?? []) {
      lines.push(`- ${task.id} check ${result.id}: ${result.passed ? 'pass' : 'fail'}`);
    }
  }
  const recorded = new Map(
    state.tasks.flatMap((task) => task.checkResults ?? []).map((result) => [result.id, result]),
  );
  for (const check of state.plan?.checks ?? []) {
    const result = recorded.get(check.id);
    lines.push(
      `- plan check ${check.id}: ${result === undefined ? 'not recorded' : result.passed ? 'pass' : 'fail'}`,
    );
  }
  return lines.join('\n');
}

function reviewConsultLog(state: WorkflowState): string {
  const lines: string[] = [];
  for (const lineage of Object.values(state.lineages ?? {})) {
    for (const record of lineage.consultRecords) {
      lines.push(
        `- ${record.at} ${record.taskId}: ${record.reason} → ${record.action}: ${record.diagnosis}`,
      );
    }
  }
  return lines.join('\n');
}

function reviewTriageLog(state: WorkflowState): string {
  return (state.triage ?? [])
    .flatMap((record) => [
      ...record.result.rejected.map((rejected) => `- ${rejected.findingId}: ${rejected.reason}`),
      ...(record.verification ?? []).map(
        (entry) =>
          `- cycle ${record.cycle}, candidate reviewed at ${record.reviewAt ?? record.at}, ${entry.id}: ${entry.status} — ${entry.output}`,
      ),
    ])
    .join('\n');
}

function reviewPlanningAnswers(state: WorkflowState): string {
  return (state.userAnswers ?? [])
    .map((answer) => `- ${answer.reply} → ${answer.answer}`)
    .join('\n');
}

export function checkVerificationStatus(
  runs: readonly CheckRunResult[],
): 'pass' | 'fail' | 'unverified' {
  if (runs.some((run) => run.status === 'fail')) return 'fail';
  if (runs.length > 0 && runs.every((run) => run.status === 'pass')) return 'pass';
  return 'unverified';
}

export function checkVerificationOutput(runs: readonly CheckRunResult[]): string {
  return runs
    .map((run) => {
      const output = run.output.trim();
      return `${run.checkId}: ${run.status}${output === '' ? '' : ` — ${output}`}`;
    })
    .join('\n');
}

type ReviewVerification = {
  entries: ReviewRecord['verification'];
  map: Map<string, 'pass' | 'fail' | 'unverified'>;
};

/**
 * The checks of every unverified criterion and finding, run through the same
 * runner briefs use. A pass needs every named check to pass; any failure is a
 * failure; anything not runnable stays unverified and cannot verify a claim.
 */
async function verifyReviewClaims(args: {
  verdict: ReviewVerdict;
  state: WorkflowState;
  workspaceDir: string;
  config: Config;
  bus: EventBus;
  signal?: AbortSignal | undefined;
}): Promise<ReviewVerification> {
  const entries: ReviewRecord['verification'] = [];
  const map = new Map<string, 'pass' | 'fail' | 'unverified'>();
  const criterionCheckIds = (criterionId: string | null): readonly string[] =>
    args.state.plan?.criteria.find((criterion) => criterion.id === criterionId)?.checkIds ?? [];
  const run = async (
    kind: 'criterion' | 'finding',
    id: string,
    checkIds: readonly string[],
  ): Promise<void> => {
    if (checkIds.length === 0) return;
    const runs = await runChecks(checkIds, {
      plan: args.state.plan,
      tasks: args.state.tasks,
      projectDir: args.workspaceDir,
      config: args.config,
      bus: args.bus,
      phase: args.state.phase,
      planApproved: true,
      ...(args.state.discoveredValidation !== undefined && {
        discoveredValidation: args.state.discoveredValidation,
      }),
      ...(args.signal !== undefined && { signal: args.signal }),
    });
    const status = checkVerificationStatus(runs);
    const key = verificationKey(kind, id);
    map.set(key, status);
    entries.push({ id: key, status, output: checkVerificationOutput(runs) });
  };
  for (const criterion of args.verdict.criteria) {
    if (criterion.status !== 'unverified') continue;
    await run('criterion', criterion.id, criterionCheckIds(criterion.id));
  }
  for (const finding of args.verdict.findings) {
    if (finding.kind !== 'unverified') continue;
    const named = finding.checkIds ?? [];
    await run(
      'finding',
      finding.id,
      named.length > 0 ? named : criterionCheckIds(finding.criterionId),
    );
  }
  return { entries, map };
}

export async function runFinalReviewPhase(opts: {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  reviewer: Reviewer;
  metadata?: SpecMetadata | null;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
  continuation?: ContinuationHolder | undefined;
  summaryBase?: SummaryBase | undefined;
  taskBreakdowns?: TaskTokenUsage[] | undefined;
  phaseTimings?: Record<string, number>;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
  skillsContext?: string | undefined;
  /** The integration re-check section when an Apply merge changed the reviewed candidate. */
  integration?: string | undefined;
  /** The cadence this review serves: 'task' is the scheduled mid-run review, 'final' the run's last. */
  scope?: 'final' | 'task' | undefined;
}): Promise<FinalReviewResult> {
  let { state } = opts;
  const {
    projectDir,
    workspaceDir,
    sessionId,
    config,
    callbacks,
    bus,
    reviewer,
    metadata,
    summaryBase,
    taskBreakdowns,
    phaseTimings,
  } = opts;

  // On resume the state is already persisted in 'final-review' (a previously failed
  // gate); only dispatch ALL_DONE from 'implementing' on a fresh forward run. A
  // task-cadence review runs mid-run and leaves the phase where it found it.
  if (state.phase === 'implementing' && opts.scope !== 'task') {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'ALL_DONE' });
    // The call publisher stamps runner events with the tracked phase; the
    // reviewer's own call must read as final-review, not the last brief's.
    opts.setTrackedState?.(state);
  }

  // The status names the seat that runs the review, which is the planner's only when no reviewer
  // is configured.
  const reviewRunner = resolveReviewerRunner(config).runner;
  const reviewModel = getRunnerModelName(reviewRunner);
  const reviewSeat = {
    tool: getRunnerDisplayName(reviewRunner),
    ...(reviewModel !== undefined && { model: reviewModel }),
  };

  const finalReviewStart = Date.now();
  const interrupted = (): FinalReviewResult => {
    if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;
    publishPlannerStatus(bus, state, 'done', {
      ...reviewSeat,
      duration: Date.now() - finalReviewStart,
      summary: 'Final review aborted',
    });
    return { state, summaryBase, verdict: null, reviewText: '', reviewStatus: 'failed' };
  };
  if (opts.signal?.aborted) return interrupted();
  publishPlannerStatus(bus, state, 'running', reviewSeat);
  if (opts.scope !== 'task') {
    bus.publish({ type: 'all_tasks_done', ts: Date.now(), phase: state.phase });
  }

  let writeStatus: 'written' | 'failed' = 'written';
  let reviewText = '';
  let verdict: FinalReview | null = null;
  let reviewScope: RunReviewScope | undefined;
  let failure: FinalReviewResult['failure'];
  try {
    const baseline = state.changedFilesBaseline;
    if (baseline?.runStartChangedFiles === undefined) throw finalReviewError.missingRunBaseline();
    const universe = await resolveRunUniverse(workspaceDir, baseline);
    reviewScope = await resolveRunReviewScope({
      ref: { projectDir, sessionId },
      workspaceDir,
      tasks: state.tasks,
      workspaceFiles: universe.changedFiles,
    });
    const fullDiff = [universe.fullDiff, reviewScope.laterDiff].filter(Boolean).join('\n');
    // A run planned on one session agreed on its plan; only an older run wrote a spec.
    const spec = readSpecFileOrEmpty(
      { projectDir, sessionId },
      state.plan === undefined ? SPEC_FILE : PLAN_FILE,
    );
    const taskBriefs =
      readSpecFileOrEmpty({ projectDir, sessionId }, TASKS_FILE) || formatTasks(state.tasks);

    let driftPromptSection: string | undefined;
    let validationPromptSection: string | undefined;
    let ledger: EvidenceLedger | null = null;
    try {
      ledger = readEvidenceLedger({ projectDir, sessionId });
      // The review's validation claims must quote this recorded output; a
      // review left to re-derive test results invents counts.
      validationPromptSection = formatValidationEvidenceForPrompt(ledger);
    } catch (err) {
      warnError('Failed to read validation evidence', err);
    }

    try {
      const driftReport = analyzeBriefDrift({
        tasks: state.tasks,
        changedFiles: reviewScope.provenance.promotedFiles,
        diff: reviewScope.diff,
        ledger,
        briefHash: hashTaskBrief(state.tasks),
        preRunChangedFiles: baseline.runStartChangedFiles,
      });
      writeDriftReport({ projectDir, sessionId }, driftReport);
      publishDriftReport(bus, state.phase, driftReport);
      driftPromptSection = formatDriftReportForPrompt(driftReport);
    } catch (err) {
      warnError('Failed to compute drift report', err);
    }

    const drain = drainQueue({ projectDir, sessionId, state, bus });
    state = drain.state;
    const queueText = drain.messages.length > 0 ? formatDrainedMessages(drain.messages) : '';
    const promptPrefix = [
      workspaceReadInstructions(workspaceDir),
      ...(opts.integration !== undefined ? [opts.integration] : []),
      queueText,
    ].join('\n\n');

    const scope = reviewScopeFor(state, opts.scope ?? 'final');
    // Coverage is a contract rule: an incomplete or invented answer fails the
    // schema, so the seat gets its one repair instead of a silent pass.
    const verdictSchema = ReviewVerdictSchema.superRefine((candidate, ctx) => {
      for (const message of verdictCoverageErrors(candidate, scope)) {
        ctx.addIssue({ code: 'custom', message });
      }
    });

    const plan = reviewPlanData(state);
    const ledgerChangedFiles = new Map(
      (ledger?.tasks ?? []).map((entry) => [entry.id, entry.changedFiles]),
    );
    const touchedNotSuggested: ReviewTouchedNotSuggested[] = state.tasks
      .map((task, index) => ({
        taskId: task.id,
        files: touchedNotSuggestedFiles({
          task,
          tasks: state.tasks.slice(0, index),
          taskChangedFiles: ledgerChangedFiles.get(task.id) ?? [],
        }),
      }))
      .filter((entry) => entry.files.length > 0);
    const diffByTask: ReviewTaskDiff[] = [
      ...reviewScope.byTask,
      ...(reviewScope.laterDiff === ''
        ? []
        : [{ taskId: null, diff: reviewScope.laterDiff } satisfies ReviewTaskDiff]),
    ];
    const checkResults = reviewCheckResults(state);
    const consultLog = reviewConsultLog(state);
    const triageLog = reviewTriageLog(state);
    const planningAnswers = reviewPlanningAnswers(state);

    // An API seat reads no file of its own, so it is dispatched only once the
    // packet it is handed carries every required source, whole and untruncated.
    let fullPrompt: string;
    if (reviewRunner.kind === 'api') {
      const packet = buildApiReviewContext({
        feature: state.feature,
        spec,
        taskBriefs,
        fullDiff,
        changedFiles: universe.changedFiles,
        baseline: { head: baseline.head, runStartChangedFiles: baseline.runStartChangedFiles },
        driftSection: driftPromptSection,
        validation: { recorded: ledger !== null, evidence: validationPromptSection },
        reviewScope,
        queueText: promptPrefix,
        taskIds: scope.taskIds,
        criterionIds: scope.criterionIds,
        plan,
        diffByTask,
        touchedNotSuggested,
        checkResults,
        consultLog,
        triageLog,
        planningAnswers,
        ...(opts.skillsContext !== undefined && { skillsContext: opts.skillsContext }),
        ...(reviewRunner.contextLength !== undefined && {
          contextLength: reviewRunner.contextLength,
        }),
        ...(reviewRunner.model !== undefined && { model: reviewRunner.model }),
      });
      if (packet.kind === 'insufficient-context') {
        throw apiContextError({
          code: 'insufficient-context',
          seat: 'review',
          cause: packet.cause,
          missingSections: [...packet.missingSections],
          ...(reviewRunner.model !== undefined && { model: reviewRunner.model }),
          requiredTokens: packet.requiredTokens,
          availableTokens: packet.availableTokens,
        });
      }
      fullPrompt = packet.text;
    } else {
      const basePrompt = buildFinalReviewPrompt({
        spec,
        taskBriefs,
        diff: reviewScope.diff,
        diffByTask,
        plan,
        touchedNotSuggested,
        checkResults,
        consultLog,
        triageLog,
        planningAnswers,
        taskIds: scope.taskIds,
        criterionIds: scope.criterionIds,
        changeCoverage: reviewScope.description,
        workspaceDiff: fullDiff,
        driftReport: driftPromptSection,
        validationEvidence: validationPromptSection,
        skillsContext: opts.skillsContext,
      });
      fullPrompt = promptPrefix + basePrompt;
    }

    const reviewStep = { kind: 'review' as const, cycle: fixCyclesOf(state).used };
    // One continuation, one call: a retried review is the whole prompt again
    // with the operator's note on the end, never a session resume.
    let seed = opts.continuation?.take(reviewStep);

    const callReviewer = async (prompt: string): Promise<RequestTypedResult<ReviewVerdict>> => {
      if (opts.sinks === undefined) {
        const call = await runReviewerCall({
          reviewer,
          prompt,
          schema: verdictSchema,
          projectDir,
          workspaceDir,
          sessionId,
          bus,
          state,
          signal: opts.signal,
        });
        state = call.state;
        return call.result;
      }
      const loopSeed = seed;
      seed = undefined;
      const loop = await withContinuationLoop<RequestTypedResult<ReviewVerdict>>({
        ctx: {
          projectDir,
          sessionId,
          callbacks,
          bus,
          signal: opts.signal,
          sinks: opts.sinks,
        },
        state,
        step: reviewStep,
        ...(loopSeed === undefined ? {} : { seed: loopSeed }),
        onStateChange: (s) => {
          state = s;
        },
        // The review is one shot by constitution: a continuation re-issues the
        // whole deterministic prompt — spec, briefs, diff, drift, evidence — with
        // the operator's note on the end. It never resumes a session.
        body: async ({ signal: callSignal, partial, steer }) => {
          const call = await runReviewerCall({
            reviewer,
            prompt:
              partial === undefined && steer === undefined
                ? prompt
                : composeContinuation({ basePrompt: prompt, partial, steer }),
            schema: verdictSchema,
            projectDir,
            workspaceDir,
            sessionId,
            bus,
            state,
            signal: callSignal,
          });
          state = call.state;
          return call.result;
        },
      });
      return loop.value;
    };

    const typed = await callReviewer(fullPrompt);
    if ('error' in typed) {
      failure = { kind: 'seat-protocol-error', error: typed.error };
      throw typed.error;
    }
    const reviewerVerdict = typed.value;
    const verification = await verifyReviewClaims({
      verdict: reviewerVerdict,
      state,
      workspaceDir,
      config,
      bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    const outcome = deriveReviewOutcome(reviewerVerdict, scope, verification.map);
    const record: ReviewRecord = {
      scope: opts.scope ?? 'final',
      cycle: fixCyclesOf(state).used,
      verdict: reviewerVerdict,
      outcome: outcome.kind,
      verification: verification.entries,
      at: nowIso(),
    };
    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'RECORD_REVIEW',
      review: record,
    });
    verdict = { verdict: reviewerVerdict, outcome };
    reviewText = renderReviewMarkdown(reviewerVerdict, outcome);
    writeSpecFile(
      { projectDir, sessionId },
      REVIEW_JSON_FILE,
      `${JSON.stringify(record)}\n`,
      metadata,
    );
    writeSpecFile({ projectDir, sessionId }, REVIEW_FILE, reviewText, metadata);
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err)) return interrupted();
    const seat = resolveReviewerRunner(config);
    const label =
      seat.source === 'configured'
        ? `Final review failed (reviewer: ${getRunnerCatalogDisplayName(seat.runner)})`
        : 'Final review failed';
    // The diagnosis is read off the error's own data, never off its wording, so
    // recovery keeps every missing section this review was refused for.
    const diagnostic = readApiContextDiagnostic(err);
    let message: string;
    let resetAt: string | undefined;
    if (failure?.kind === 'seat-protocol-error') {
      message = failure.error.message;
    } else if (diagnostic !== null) {
      message = labelError(label, err);
      failure = { kind: 'insufficient-context', diagnostic };
    } else {
      const diagnosis = diagnosePlannerCallFailure({
        err,
        label,
        runner: seat.runner,
        seat: seat.source === 'configured' ? 'review' : 'plan',
      });
      message = diagnosis.message;
      resetAt = diagnosis.resetsAt?.toISOString();
      failure =
        diagnosis.failure === 'call-failed'
          ? { kind: 'call-failed', code: errorKind(err) ?? REVIEW_UNAVAILABLE, message }
          : { kind: 'seat-blocked', diagnosis };
    }
    publishError({ bus: bus, phase: state.phase, message, resetAt });
    writeStatus = 'failed';
  }
  if (opts.signal?.aborted) return interrupted();

  try {
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    if (ledger) {
      writeEvidenceLedger(
        { projectDir, sessionId },
        recordFinalReviewEvidence({ ledger, status: writeStatus }),
      );
    }
  } catch (err) {
    warnError('Failed to record final review evidence', err);
  }

  if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;

  publishPlannerStatus(bus, state, 'done', {
    ...reviewSeat,
    duration: Date.now() - finalReviewStart,
    ...(writeStatus === 'failed' && { summary: 'Final review failed' }),
  });

  // The packet is the final review's artifact; a task-cadence review writes only
  // review.json and review.md.
  if (opts.scope !== 'task' && summaryBase !== undefined && taskBreakdowns !== undefined) {
    try {
      await writeReviewPacket({
        projectDir,
        sessionId,
        summary: buildSummary({
          ...summaryBase,
          projectDir,
          sessionId,
          state,
          taskBreakdowns,
          ...(phaseTimings && { phaseTimings }),
        }),
        state,
        finalReviewStatus: writeStatus,
        ...(reviewScope !== undefined && { provenance: reviewScope.provenance }),
      });
    } catch (err) {
      publishWarningFromError(
        { bus: bus, phase: state.phase },
        'Review packet generation failed',
        err,
      );
    }
  }

  const reviewStatus: ReviewPhaseStatus =
    writeStatus === 'failed' || verdict === null ? 'failed' : 'written';
  return { state, summaryBase, verdict, reviewText, reviewStatus, ...(failure && { failure }) };
}
