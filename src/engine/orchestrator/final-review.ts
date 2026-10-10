import { join } from 'node:path';
import type { WorkflowState, ReviewRecord } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { ContinuationHolder } from './continuation.js';
import type { EventBus } from '../events/types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { Config } from '../../core/schemas/config.js';
import { isTaskCompleted } from '../../core/schemas/task.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import {
  PLAN_FILE,
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  REVIEW_FILE,
  REVIEW_JSON_FILE,
  SESSION_LOG_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../core/paths.js';
import { CLI_TOOL_CATALOG, isCliToolId } from '../../core/runners/cli-tool-catalog.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../core/scope/declared-set.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { seatAxisWords } from '../../core/runners/effort-channel.js';
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
  triageLines,
  type ReviewPlanData,
  type ReviewTouchedNotSuggested,
} from '../spec/prompts/review.js';
import { workspaceReadInstructions } from '../spec/prompts/builder.js';
import { recordFinalReviewEvidence } from './evidence/reporting.js';
import { readPacketEvents } from './evidence/review-packet/artifacts.js';
import { renderChecksLogForPrompt, renderWholeChecksLog } from './evidence/review-packet/render.js';
import { buildChecks } from './evidence/review-packet/sections.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';
import { analyzeBriefDrift } from './drift/analyze.js';
import { writeDriftReport } from './drift/io.js';
import { formatDriftReportForPrompt, publishDriftReport } from './drift/format.js';

import type { Reviewer } from '../reviewers/types.js';
import { buildSummary, type SummaryBase } from './summary/build.js';
import {
  publishError,
  publishReviewEvent,
  publishWarning,
  publishWarningFromError,
} from './events.js';
import { transitionAndSave } from './state-ops.js';
import { runReviewerCall } from './review-call.js';
import { touchedNotSuggestedFiles } from './task/commit.js';
import { hashTaskBrief } from '../../core/evidence/brief-hash.js';
import { writeReviewPacket } from './evidence/review-packet/write.js';
import { formatTasks } from '../spec/formatter.js';
import { drainQueueForReview } from './queue/drain.js';
import { formatDrainedMessages } from './queue/prompt.js';
import { withContinuationLoop } from './continuation.js';
import { composeContinuation } from '../spec/prompts/continuation.js';
import { resolveRunUniverse } from './evidence/review-packet/sections-io.js';
import { resolveRunReviewScope, type RunReviewScope } from './evidence/review-packet/run-scope.js';
import { fitReviewPrompt, largestReviewFiles } from './evidence/review-packet/fit.js';
import type { BuildReviewPacketOptions } from './evidence/review-packet/types.js';
import { inputTooLargeFigures } from '../runners/input-limit.js';
import {
  typedRunnerCallErrorCode,
  typedRunnerCallErrorMessage,
} from '../implementers/pipeline/call-result.js';
import { reviewInputTooLargeMessage } from './recovery/builders/review-input.js';
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
import {
  REVIEW_ANSWER_JSON_SCHEMA,
  ReviewAnswerSchema,
  type ReviewAnswer,
  type ReviewVerdict,
  type TriageResult,
} from '../../core/schemas/review.js';
import {
  deriveReviewOutcome,
  findingInReviewScope,
  verificationKey,
  reviewScopeFor,
  verdictCoverageErrors,
  type ReviewOutcome,
  type ReviewScope,
} from '../../core/review/verdict.js';
import { renderReviewMarkdown } from '../../core/review/render.js';
import {
  checkRegistry,
  enabledReviewChecks,
  planApprovesNpmScripts,
  runChecks,
} from './validation/run-checks.js';
import { seatSupportsImages } from '../../core/runners/capabilities.js';
import { forceUnverifiedRenderCriteria, reviewRenders } from './review-renders.js';
import { currentCandidateId, recordCheckRuns } from './evidence/record-checks.js';
import { deserializeChangedFilesBaseline } from './changed-files-baseline.js';
import type { RequestTypedResult, SeatProtocolError } from '../runners/typed-output.js';
import { fixCyclesOf } from '../../core/schemas/workflow.js';
import {
  checkVerificationOutput,
  checkVerificationStatus,
  runTriageVerification,
  triageContractErrors,
} from './triage.js';
import type { PreReviewResult } from './run/pre-review-checks.js';
import { runReviewChecks } from './review-checks.js';
import { runBaseOf } from './isolation/base-tree.js';

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
  | Readonly<{
      kind: 'input-too-large';
      chars: number;
      maxChars: number | null;
      largestFiles: readonly Readonly<{ path: string; chars: number }>[];
    }>
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
  fixWork: TriageResult | null;
  reviewText: string;
  reviewStatus: ReviewPhaseStatus;
  /**
   * Why this review reached no verdict, when it reached none. Additive: a
   * caller that does not read it sees the status it always saw.
   */
  failure?: FinalReviewFailure;
  /**
   * The pre-review raised a halt before a reviewer call could run.
   */
  preReview?: 'stopped' | undefined;
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
      status: isTaskCompleted(task.status) ? 'done' : 'pending',
      title: task.title,
      intent: task.description,
      criteria: task.criteria ?? [],
      suggestedFiles: task.suggestedFiles,
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

function reviewPlanningAnswers(state: WorkflowState): string {
  return (state.userAnswers ?? [])
    .map((answer) => `- ${answer.reply} → ${answer.answer}`)
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
  scope: ReviewScope;
  state: WorkflowState;
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  bus: EventBus;
  signal?: AbortSignal | undefined;
}): Promise<ReviewVerification> {
  const entries: ReviewRecord['verification'] = [];
  const map = new Map<string, 'pass' | 'fail' | 'unverified'>();
  if (args.state.pendingTriage?.inputs.some((input) => input.source === 'check')) {
    return { entries, map };
  }
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
      reviewChecks: enabledReviewChecks(args.config, args.state.reviewChecks),
      base: runBaseOf({ projectDir: args.projectDir, sessionId: args.sessionId }, args.state),
      projectDir: args.workspaceDir,
      sessionId: args.sessionId,
      checkoutDir: args.projectDir,
      config: args.config,
      bus: args.bus,
      phase: args.state.phase,
      npmScriptsApproved: planApprovesNpmScripts({ config: args.config, state: args.state }),
      ...(args.state.discoveredValidation !== undefined && {
        discoveredValidation: args.state.discoveredValidation,
      }),
      ...(args.signal !== undefined && { signal: args.signal }),
    });
    await recordCheckRuns({
      projectDir: args.projectDir,
      sessionId: args.sessionId,
      workspaceDir: args.workspaceDir,
      state: args.state,
      runs,
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
    if (!findingInReviewScope(finding, args.scope)) continue;
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
  afterTaskId?: TaskId | undefined;
  /**
   * The required checks run on the candidate before the review call. New
   * failures become pending inputs in the review answer.
   */
  preReview?: ((state: WorkflowState) => Promise<PreReviewResult>) | undefined;
  /**
   * The reviewer chooses the commands that verify this candidate and SPLITBRIEF runs them before
   * the verdict call. A review that only re-answers a pending question on the same candidate skips it.
   */
  reviewChecks?: boolean | undefined;
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

  // A required check that cannot run halts before the review.
  if (opts.preReview !== undefined) {
    const pre = await opts.preReview(state);
    state = pre.state;
    opts.setTrackedState?.(state);
    if (pre.kind !== 'review') {
      return {
        state,
        summaryBase,
        verdict: null,
        fixWork: null,
        reviewText: '',
        reviewStatus: 'failed',
        preReview: pre.kind,
      };
    }
  }

  const reviewRunner = resolveReviewerRunner(config).runner;
  const maxInputChars =
    reviewRunner.kind === 'cli' && isCliToolId(reviewRunner.tool)
      ? CLI_TOOL_CATALOG[reviewRunner.tool].maxInputChars
      : undefined;
  const reviewModel = getRunnerModelName(reviewRunner);
  const reviewAxes = seatAxisWords(reviewRunner);
  const scope = opts.scope ?? 'final';
  const reviewEvent = {
    scope,
    ...(scope === 'task' && opts.afterTaskId !== undefined && { afterTaskId: opts.afterTaskId }),
    tool: getRunnerDisplayName(reviewRunner),
    ...(reviewModel !== undefined && { model: reviewModel }),
    ...(reviewAxes.length > 0 && { axes: [...reviewAxes] }),
  };

  const finalReviewStart = Date.now();
  const interrupted = (): FinalReviewResult => {
    if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;
    publishReviewEvent(
      { bus, phase: state.phase },
      {
        type: 'review_completed',
        ...reviewEvent,
        verdict: 'stopped',
        duration: Date.now() - finalReviewStart,
      },
    );
    return {
      state,
      summaryBase,
      verdict: null,
      fixWork: null,
      reviewText: '',
      reviewStatus: 'failed',
    };
  };
  publishReviewEvent({ bus, phase: state.phase }, { type: 'review_started', ...reviewEvent });
  if (opts.signal?.aborted) return interrupted();
  if (opts.scope !== 'task') {
    bus.publish({ type: 'all_tasks_done', ts: Date.now(), phase: state.phase });
  }

  let writeStatus: 'written' | 'failed' = 'written';
  let reviewText = '';
  let verdict: FinalReview | null = null;
  let fixWork: TriageResult | null = null;
  let reviewScope: RunReviewScope | undefined;
  let failure: FinalReviewResult['failure'];
  let fullPrompt = '';
  let reviewInput: BuildReviewPacketOptions['reviewInput'];
  try {
    const baseline = state.changedFilesBaseline;
    if (baseline?.runStartChangedFiles === undefined) throw finalReviewError.missingRunBaseline();
    const universe = await resolveRunUniverse(workspaceDir, baseline);
    reviewScope = await resolveRunReviewScope({
      ref: { projectDir, sessionId },
      workspaceDir,
      tasks: state.tasks,
      workspaceFiles: universe.changedFiles,
      workspaceDiff: universe.fullDiff,
      ...(state.applyReview !== undefined && {
        mergedPaths: state.applyReview.merged.map((entry) => entry.path),
      }),
    });
    const scope = reviewScopeFor(state, opts.scope ?? 'final');
    let reviewChecksSection: string | undefined;
    let dischargedReviewCommands: string[] = [];
    if (opts.reviewChecks === true) {
      const changedFiles =
        opts.scope === 'task'
          ? [
              ...new Set(
                (readEvidenceLedger({ projectDir, sessionId })?.tasks ?? [])
                  .filter((entry) => scope.taskIds.includes(entry.id))
                  .flatMap((entry) => entry.changedFiles),
              ),
            ]
          : universe.changedFiles;
      const checks = await runReviewChecks({
        projectDir,
        workspaceDir,
        sessionId,
        config,
        bus,
        state,
        reviewer,
        scope: opts.scope ?? 'final',
        taskIds: scope.taskIds,
        changedFiles,
        signal: opts.signal,
        onApproval: callbacks.onReviewChecksApproval,
      });
      state = checks.state;
      opts.setTrackedState?.(state);
      if (checks.kind === 'protocol-error') {
        failure = { kind: 'seat-protocol-error', error: checks.error };
        throw checks.error;
      }
      reviewChecksSection = checks.section;
      dischargedReviewCommands = checks.discharged;
    }
    // A run planned on one session agreed on its plan; only an older run wrote a spec.
    const spec = readSpecFileOrEmpty(
      { projectDir, sessionId },
      state.plan === undefined ? SPEC_FILE : PLAN_FILE,
    );
    const taskBriefs =
      readSpecFileOrEmpty({ projectDir, sessionId }, TASKS_FILE) || formatTasks(state.tasks);

    let driftPromptSection: string | undefined;
    let checksLog: string | undefined;
    let wholeChecksLog: string | undefined;
    let ledger: EvidenceLedger | null = null;
    const evidencePaths = {
      validation: join(sessionDir(projectDir, sessionId), EVIDENCE_FILE),
      sessionLog: join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE),
      drift: join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE),
    };
    try {
      ledger = readEvidenceLedger({ projectDir, sessionId });
      const events = await readPacketEvents(projectDir, sessionId, []);
      if (ledger !== null) {
        const checks = buildChecks({ ledger, events });
        if (reviewRunner.kind === 'api') {
          wholeChecksLog = renderWholeChecksLog(checks);
        } else {
          checksLog = renderChecksLogForPrompt(checks, evidencePaths);
        }
      }
    } catch (err) {
      warnError('Failed to read validation evidence', err);
    }

    try {
      const driftReport = analyzeBriefDrift({
        tasks: state.tasks,
        changedFiles: reviewScope.provenance.promotedFiles,
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

    const drain = drainQueueForReview({ projectDir, sessionId, state });
    state = drain.state;
    const queueText = drain.messages.length > 0 ? formatDrainedMessages(drain.messages) : '';
    const promptPrefix = [
      workspaceReadInstructions(workspaceDir),
      ...(opts.integration !== undefined ? [opts.integration] : []),
      ...(reviewChecksSection !== undefined ? [reviewChecksSection] : []),
      queueText,
    ].join('\n\n');

    // Coverage is a contract rule: an incomplete or invented answer fails the
    // schema, so the seat gets its one repair instead of a silent pass.
    const verdictSchema = ReviewAnswerSchema.superRefine((candidate, ctx) => {
      for (const message of [
        ...verdictCoverageErrors(candidate, scope),
        ...triageContractErrors(
          candidate,
          state.plan,
          candidate.findings,
          state.pendingTriage?.inputs ?? [],
          state.tasks,
          enabledReviewChecks(config, state.reviewChecks),
          scope,
        ),
      ]) {
        ctx.addIssue({ code: 'custom', message });
      }
    });

    const plan = reviewPlanData(state);
    // The reviewer judges only the current candidate: an artifact from an earlier
    // candidate can never stand in for a render this run did not produce.
    let reviewCandidateId: string | undefined;
    try {
      reviewCandidateId = await currentCandidateId(
        workspaceDir,
        deserializeChangedFilesBaseline(baseline),
      );
    } catch (err) {
      warnError('failed to compute the review candidate id', err);
    }
    // The renders the checks log recorded: the seat takes up to four images per
    // check when its tool declares a channel, else it gets a manifest and the
    // no-vision statement.
    const renders = reviewRenders({
      ledger,
      registry: checkRegistry({
        plan: state.plan,
        tasks: state.tasks,
        reviewChecks: enabledReviewChecks(config, state.reviewChecks),
      }),
      projectDir,
      seatSupportsImages: seatSupportsImages({ runner: reviewRunner }),
      currentCandidateId: reviewCandidateId,
    });
    const criterionCheckIds = (criterionId: string): readonly string[] =>
      state.plan?.criteria.find((criterion) => criterion.id === criterionId)?.checkIds ?? [];
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
    const checkResults = reviewCheckResults(state);
    const consultLog = reviewConsultLog(state);
    const triageLog = triageLines(state.triage ?? []);
    const pendingInputs = state.pendingTriage?.inputs ?? [];
    const fixCycle = fixCyclesOf(state).used + 1;
    const planningAnswers = reviewPlanningAnswers(state);

    // An API seat reads no file of its own, so it is dispatched only once the
    // packet it is handed carries every required source, whole and untruncated.
    if (reviewRunner.kind === 'api') {
      const packet = buildApiReviewContext({
        feature: state.feature,
        spec,
        taskBriefs,
        reviewKind: opts.scope ?? 'final',
        fullDiff: universe.fullDiff,
        changedFiles: universe.changedFiles,
        baseline: { head: baseline.head, runStartChangedFiles: baseline.runStartChangedFiles },
        driftSection: driftPromptSection,
        validation: { recorded: wholeChecksLog !== undefined, evidence: wholeChecksLog },
        reviewScope,
        queueText: promptPrefix,
        taskIds: scope.taskIds,
        criterionIds: scope.criterionIds,
        plan,
        touchedNotSuggested,
        checkResults,
        consultLog,
        triageLog,
        planningAnswers,
        pendingInputs,
        fixCycle,
        ...(renders.section !== undefined && { renders: renders.section }),
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
      const result = fitReviewPrompt({
        prefix: promptPrefix,
        prompt: {
          spec,
          taskBriefs,
          reviewKind: opts.scope ?? 'final',
          files: reviewScope.files,
          laterDiff: reviewScope.laterDiff,
          workspaceContext: reviewScope.workspaceContext,
          plan,
          touchedNotSuggested,
          checkResults,
          consultLog,
          triageLog,
          planningAnswers,
          pendingInputs,
          fixCycle,
          taskIds: scope.taskIds,
          criterionIds: scope.criterionIds,
          changeCoverage: reviewScope.description,
          driftReport: driftPromptSection,
          checksLog,
          renders: renders.section,
          skillsContext: opts.skillsContext,
        },
        maxChars: maxInputChars,
        declared: (path) => isInDeclaredSet(path, state.tasks.flatMap(taskDeclaredPatterns)),
        evidencePaths,
      });
      if (maxInputChars !== undefined) {
        reviewInput = {
          chars: result.chars,
          maxChars: maxInputChars,
          dropped: [...result.dropped],
        };
        if (result.dropped.length > 0) {
          publishWarning({
            bus,
            phase: state.phase,
            message: `Review input trimmed to fit ${getRunnerCatalogDisplayName(reviewRunner)} (${result.chars.toLocaleString('en-US')} of ${maxInputChars.toLocaleString('en-US')} characters): ${result.dropped.map((drop) => `${drop.trim}: ${drop.items.join(', ')}`).join('; ')}`,
          });
        }
      }
      if (result.kind === 'too-large') {
        failure = {
          kind: 'input-too-large',
          chars: result.chars,
          maxChars: result.maxChars,
          largestFiles: result.largestFiles,
        };
        throw error('review-input-too-large', 'Review input exceeds the tool cap.');
      }
      fullPrompt = result.prompt;
    }

    const reviewStep = { kind: 'review' as const, cycle: fixCyclesOf(state).used };
    // One continuation, one call: a retried review is the whole prompt again
    // with the operator's note on the end, never a session resume.
    let seed = opts.continuation?.take(reviewStep);

    const callReviewer = async (prompt: string): Promise<RequestTypedResult<ReviewAnswer>> => {
      if (opts.sinks === undefined) {
        const call = await runReviewerCall({
          reviewer,
          prompt,
          schema: verdictSchema,
          jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
          schemaName: 'review_answer',
          projectDir,
          workspaceDir,
          sessionId,
          bus,
          state,
          ...(renders.images.length > 0 && { images: renders.images }),
          signal: opts.signal,
        });
        state = call.state;
        return call.result;
      }
      const loopSeed = seed;
      seed = undefined;
      const loop = await withContinuationLoop<RequestTypedResult<ReviewAnswer>>({
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
            jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
            schemaName: 'review_answer',
            projectDir,
            workspaceDir,
            sessionId,
            bus,
            state,
            ...(renders.images.length > 0 && { images: renders.images }),
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
    const answer = typed.value;
    const { tasks, criteria, findings } = answer;
    let reviewerVerdict: ReviewVerdict = { tasks, criteria, findings };
    fixWork = {
      fixTasks: answer.fixTasks,
      rejected: answer.rejected,
      verify: answer.verify,
      ask: answer.ask,
    };
    const fixVerification = await runTriageVerification(opts, state, fixWork);
    const verification = await verifyReviewClaims({
      verdict: reviewerVerdict,
      scope,
      state,
      projectDir,
      workspaceDir,
      sessionId,
      config,
      bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    // A render check with no attached image can only stay unverified: the
    // reviewer saw no render of it, so nothing it says may turn one into a pass.
    if (renders.missingCheckIds.length > 0) {
      const forced = forceUnverifiedRenderCriteria({
        verdict: reviewerVerdict,
        renderCheckIds: renders.missingCheckIds,
        criterionCheckIds,
        verification: verification.map,
      });
      reviewerVerdict = forced.verdict;
      if (forced.forcedCriterionIds.length > 0) {
        const forcedKeys = new Set(
          forced.forcedCriterionIds.map((id) => verificationKey('criterion', id)),
        );
        verification.entries = verification.entries.map((entry) =>
          forcedKeys.has(entry.id) ? { ...entry, status: 'unverified' as const } : entry,
        );
      }
    }
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
    const pendingCommands = (state.pendingReviewCommands ?? []).filter(
      (command) => !dischargedReviewCommands.includes(command),
    );
    if (pendingCommands.length !== (state.pendingReviewCommands ?? []).length) {
      state = transitionAndSave({ projectDir, sessionId }, state, {
        type: 'SET_PENDING_REVIEW_COMMANDS',
        commands: pendingCommands,
      });
    }
    if (
      fixWork.fixTasks.length > 0 ||
      fixWork.verify.length > 0 ||
      fixWork.rejected.length > 0 ||
      fixWork.ask !== null
    )
      state = transitionAndSave({ projectDir, sessionId }, state, {
        type: 'RECORD_TRIAGE',
        record: {
          cycle: fixCyclesOf(state).used + 1,
          at: nowIso(),
          reviewAt: record.at,
          inputIds: [
            ...findings
              .filter(
                (finding) =>
                  finding.severity === 'blocking' &&
                  finding.kind !== 'unverified' &&
                  findingInReviewScope(finding, scope),
              )
              .map((finding) => finding.id),
            ...(state.pendingTriage?.inputs ?? []).map((input) => input.id),
          ],
          result: fixWork,
          ...(fixVerification.length > 0 && { verification: fixVerification }),
        },
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
    if (typedRunnerCallErrorCode(err) === 'input-too-large') {
      const figures = inputTooLargeFigures(typedRunnerCallErrorMessage(err) ?? '');
      failure = {
        kind: 'input-too-large',
        chars: figures.chars ?? fullPrompt.length,
        maxChars: figures.maxChars ?? maxInputChars ?? null,
        largestFiles: largestReviewFiles({
          files: reviewScope?.files,
          workspaceContext: reviewScope?.workspaceContext,
        }),
      };
    }
    if (failure?.kind === 'input-too-large') {
      message = reviewInputTooLargeMessage(failure, getRunnerCatalogDisplayName(seat.runner));
    } else if (failure?.kind === 'seat-protocol-error') {
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
    // The one error row for this failure: the halt that follows raises the
    // recovery and publishes nothing of its own.
    publishError({
      bus: bus,
      phase: state.phase,
      message,
      resetAt,
      safety: {
        category: 'recovery',
        code: failure.kind === 'input-too-large' ? 'review_input_too_large' : 'review_failed',
      },
    });
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

  publishReviewEvent(
    { bus, phase: state.phase },
    {
      type: 'review_completed',
      ...reviewEvent,
      verdict: verdict?.outcome.kind ?? 'no-verdict',
      ...(verdict !== null && {
        findings: {
          blocking: verdict.outcome.blocking.length,
          minor: verdict.outcome.minor.length,
        },
      }),
      duration: Date.now() - finalReviewStart,
    },
  );

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
        ...(reviewInput !== undefined && { reviewInput }),
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
  return {
    state,
    summaryBase,
    verdict,
    fixWork,
    reviewText,
    reviewStatus,
    ...(failure && { failure }),
  };
}
