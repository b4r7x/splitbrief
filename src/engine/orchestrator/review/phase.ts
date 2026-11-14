import { join } from 'node:path';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { requireReviewSeat } from '../../../core/config/accessors/reviewer-runner.js';
import {
  getRunnerModelName,
  getRunnerDisplayName,
  getRunnerCatalogDisplayName,
} from '../../../core/config/accessors/runner-config.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import {
  reviewChangeFile,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  sessionDir,
  EVIDENCE_FILE,
  SESSION_LOG_FILE,
  DRIFT_REPORT_FILE,
  REVIEW_JSON_FILE,
  REVIEW_FILE,
} from '../../../core/paths.js';
import { phaseStage } from '../../../core/phases/rail.js';
import { isQueuedMessagePendingReviewer } from '../../../core/queue/state.js';
import { reviewName } from '../../../core/recovery/causes.js';
import { renderReviewMarkdown } from '../../../core/review/render.js';
import {
  reviewScopeFor,
  verdictCoverageErrors,
  findingInReviewScope,
} from '../../../core/review/scope.js';
import {
  blockingRedInputs,
  verificationKey,
  deriveReviewOutcome,
  setAsideInputs,
  blockingEntries,
  blockingKeys,
} from '../../../core/review/verdict.js';
import { seatReadsChangeFile, seatSupportsImages } from '../../../core/runners/capabilities.js';
import { seatAxisWords } from '../../../core/runners/effort-channel.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import {
  type TriageResult,
  type SetAside,
  ReviewAnswerSchema,
  type ReviewAnswer,
  REVIEW_ANSWER_JSON_SCHEMA,
  type ReviewVerdict,
} from '../../../core/schemas/review/verdict.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { ReviewRecord } from '../../../core/schemas/workflow/review-record.js';
import { type WorkflowState, fixCyclesOf } from '../../../core/schemas/workflow/state.js';
import { sessionError } from '../../../core/sessions/errors.js';
import {
  type SpecMetadata,
  readSpecFileOrEmpty,
  writeSpecFile,
} from '../../../core/sessions/spec-files.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs/secure.js';
import { warnError } from '../../../lib/warn.js';
import { throwIfAborted, isAbortError } from '../../../utils/abort.js';
import { error } from '../../../utils/error.js';
import { labelError } from '../../../utils/format/errors.js';
import { nowIso } from '../../../utils/format/time.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { SteeringPort } from '../../calls/steering.js';
import type { EventBus } from '../../events/types.js';
import {
  typedRunnerCallErrorCode,
  typedRunnerCallErrorMessage,
} from '../../implementers/pipeline/call-result.js';
import {
  apiContextError,
  readApiContextDiagnostic,
} from '../../providers/api/context-diagnostic.js';
import { resolveSeatImageFact } from '../../providers/model/resolution.js';
import { NULL_CACHE } from '../../providers/model/runtime-snapshot.js';
import type { ModelCacheAccessor } from '../../providers/model/runtime-snapshot.js';
import type { Reviewer } from '../../planners/reviewer.js';
import { cliPromptLimit } from '../../runners/cli-tools/registry.js';
import { promptLength, inputTooLargeFigures } from '../../runners/input-limit.js';
import type { RequestTypedResult } from '../../runners/typed-output.js';
import { formatTasks } from '../../spec/formatter.js';
import { refusedCheckErrors } from '../../spec/plan/render-checks.js';
import { unconfiguredRenderCheckErrors } from '../../spec/plan/render-checks.js';
import { workspaceReadInstructions } from '../../spec/prompts/builder.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';
import { triageLines } from '../../spec/prompts/review/changes.js';
import { reviewChangeText } from '../../spec/prompts/review/changes.js';
import type { ReviewTouchedNotSuggested } from '../../spec/prompts/review/types.js';
import { deserializeChangedFilesBaseline } from '../changed-files-baseline.js';
import { withContinuationLoop } from '../continuation/loop.js';
import type { ContinuationHolder } from '../continuation/holder.js';
import { analyzeBriefDrift } from '../drift/analyze.js';
import { publishDriftReport, formatDriftReportForPrompt } from '../drift/format.js';
import { writeDriftReport } from '../drift/io.js';
import { publishWarning } from '../publish/notice.js';
import { publishReviewEvent } from '../publish/review.js';
import { publishWarningFromError } from '../publish/notice.js';
import { publishError } from '../publish/notice.js';
import { persistReviewEvidence } from '../evidence/persistence.js';
import { currentCandidateId } from '../evidence/record-checks.js';
import { readPacketEvents } from '../evidence/review-packet/artifacts.js';
import { fitReviewPrompt } from '../evidence/review-packet/fit.js';
import {
  renderWholeChecksLog,
  renderChecksLogForPrompt,
} from '../evidence/review-packet/checks-log.js';
import { type RunReviewScope, resolveRunReviewScope } from '../evidence/review-packet/run-scope.js';
import { resolveRunUniverse, runUserFiles } from '../evidence/review-packet/sections-io.js';
import { buildChecks } from '../evidence/review-packet/sections.js';
import type { BuildReviewPacketOptions } from '../evidence/review-packet/types.js';
import { writeReviewPacket } from '../evidence/review-packet/build.js';
import { runBaseOf } from '../isolation/run-base/tree.js';
import { drainQueueForReview } from '../queue/drain.js';
import { settleMidCallDeliveries } from '../queue/mid-call.js';
import { formatDrainedMessages, imagesFromMessages } from '../queue/prompt.js';
import { reviewInputTooLargeMessage } from '../recovery/builders/review-input.js';
import { diagnosePlannerCallFailure } from '../recovery/planner-call-failure.js';
import { runReviewChecks } from './checks/run-all.js';
import { plannerFeature } from '../run/planner-callbacks-context.js';
import type { PreReviewResult } from './checks/gate.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { type SummaryBase, buildSummary } from '../summary/build.js';
import { touchedNotSuggestedFiles } from '../task/commit.js';
import { triageContractErrors, fixTaskTargetErrors } from './contract-errors.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { BaseGate } from '../validation/base-gate.js';
import {
  enabledReviewChecks,
  planApprovesNpmScripts,
  checkRegistry,
} from '../validation/checks/runner.js';
import { buildStageContext, unresolvedTestCheckErrors } from '../validation/run.js';
import { buildApiReviewContext } from './api-context.js';
import { runReviewerCall } from './call.js';
import { reviewPlanData, reviewOperatorInstructions } from './plan.js';
import { reviewCheckResults, reviewConsultLog, reviewPlanningAnswers } from './prompt.js';
import { recordFinalReviewStatus } from './record.js';
import { reviewRenders, forceUnverifiedRenderCriteria } from './renders.js';
import {
  type FinalReviewResult,
  type FinalReview,
  finalReviewError,
  REVIEW_UNAVAILABLE,
  type ReviewPhaseStatus,
} from './types.js';
import { verifyReviewClaims } from './verify-claims.js';

function errorKind(err: unknown): string | undefined {
  return isRecord(err) && typeof err.kind === 'string' ? err.kind : undefined;
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
  steering?: SteeringPort | undefined;
  metadata?: SpecMetadata | null;
  modelCache: ModelCacheAccessor | undefined;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
  continuation?: ContinuationHolder | undefined;
  summaryBase?: SummaryBase | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
  skillsContext?: string | undefined;
  /** The integration re-check section when an Apply merge changed the reviewed candidate. */
  integration?: string | undefined;
  /** The cadence this review serves: 'task' is the scheduled mid-run review, 'final' the run's last. */
  scope?: 'final' | 'task' | undefined;
  afterTaskId?: TaskId | undefined;
  /**
   * The checks run on the candidate before the review call. New
   * failures become pending inputs in the review answer.
   */
  preReview?: ((state: WorkflowState) => Promise<PreReviewResult>) | undefined;
  /**
   * SPLITBRIEF runs the project gate the plan names before the verdict call of the final review,
   * and compares a red command with its run at the run base (`baseGate`). A review that only
   * re-answers a pending question on the same candidate skips it.
   */
  reviewChecks?: { baseGate: BaseGate | undefined } | undefined;
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
  } = opts;

  state = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state, { keepUnsaved: true });
  const reviewedBeforeStart = new Set(
    state.messageQueue
      .filter((message) => message.deliveredTo?.reviewer !== undefined)
      .map((message) => message.id),
  );

  // On resume the state is already persisted in 'final-review' (a previously failed
  // gate); only dispatch ALL_DONE from 'implementing' on a fresh forward run. A
  // task-cadence review runs mid-run and leaves the phase where it found it.
  if (state.phase === 'implementing' && opts.scope !== 'task') {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'ALL_DONE' });
    // The call publisher stamps runner events with the tracked phase; the
    // reviewer's own call must read as final-review, not the last brief's.
    opts.setTrackedState?.(state);
  }

  // A check that cannot run halts before the review.
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

  const reviewRunner = requireReviewSeat(config).runner;
  const limit =
    reviewRunner.kind === 'cli' ? cliPromptLimit('planner', reviewRunner.tool) : undefined;
  // `.splitbrief/` in the run workspace is never a run change.
  const changeFile = seatReadsChangeFile(reviewRunner)
    ? join(workspaceDir, reviewChangeFile(sessionId))
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
  bus.publish({ type: 'review_step', ts: Date.now(), phase: state.phase, step: 'verdict' });
  if (opts.signal?.aborted) return interrupted();
  if (opts.scope !== 'task') {
    bus.publish({ type: 'all_tasks_done', ts: Date.now(), phase: state.phase });
  }

  let writeStatus: 'written' | 'failed' = 'written';
  let reviewText = '';
  let verdict: FinalReview | null = null;
  let fixWork: TriageResult | null = null;
  let setAside: SetAside[] = [];
  let reviewScope: RunReviewScope | undefined;
  let failure: FinalReviewResult['failure'];
  let fullPrompt = '';
  // The text the call appends after the prompt, such as the answer schema; it counts toward the
  // tool's limit too.
  let promptSuffix = '';
  let reviewInput: BuildReviewPacketOptions['reviewInput'];
  try {
    const baseline = state.changedFilesBaseline;
    if (baseline?.runStartChangedFiles === undefined) throw finalReviewError.missingRunBaseline();
    const universe = await resolveRunUniverse({
      workspaceDir,
      baseline,
      runBase: runBaseOf({ projectDir, sessionId }, state),
    });
    const userFiles = runUserFiles(universe);
    reviewScope = await resolveRunReviewScope({
      ref: { projectDir, sessionId },
      workspaceDir,
      tasks: state.tasks,
      workspaceFiles: universe.changedFiles,
      workspaceDiff: universe.fullDiff,
      preRunFiles: universe.preRunFiles,
      setupFiles: universe.setupFiles,
      ...(state.applyReview !== undefined && {
        mergedPaths: state.applyReview.merged.map((entry) => entry.path),
      }),
    });
    const scope = reviewScopeFor(state, opts.scope ?? 'final');
    let reviewChecksSection: string | undefined;
    // A review that only re-answers its question on the same candidate keeps the checks it ran.
    let preExistingChecks = state.review?.preExistingChecks ?? [];
    if (opts.reviewChecks !== undefined) {
      const checks = await runReviewChecks({
        projectDir,
        workspaceDir,
        sessionId,
        config,
        bus,
        state,
        baseGate: opts.reviewChecks.baseGate,
        signal: opts.signal,
      });
      state = checks.state;
      opts.setTrackedState?.(state);
      reviewChecksSection = checks.section;
      preExistingChecks = checks.preExistingChecks;
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
        preRunChangedFiles: universe.preRunFiles,
      });
      writeDriftReport({ projectDir, sessionId }, driftReport);
      publishDriftReport(bus, state.phase, driftReport);
      driftPromptSection = formatDriftReportForPrompt(driftReport);
    } catch (err) {
      warnError('Failed to compute drift report', err);
    }

    const testChecks = buildStageContext({
      projectDir: workspaceDir,
      config,
      discoveredValidation: state.discoveredValidation,
      notices: { bus, phase: state.phase },
    });
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
          enabledReviewChecks(config, state.plan),
          scope,
        ),
        ...fixTaskTargetErrors(candidate.fixTasks, userFiles),
        ...refusedCheckErrors(
          candidate.fixTasks.flatMap((task) => task.checks),
          {
            npmScriptsApproved: planApprovesNpmScripts({ config, state }),
            projectDir: workspaceDir,
            writtenFiles: candidate.fixTasks.flatMap((task) => task.suggestedFiles),
          },
        ).map((error) => error.message),
        ...unconfiguredRenderCheckErrors(
          candidate.fixTasks.flatMap((task) => task.checks),
          config.validation.render,
        ),
        ...unresolvedTestCheckErrors(candidate.fixTasks, testChecks, []),
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
      warnError(
        'Could not identify the current change, so the reviewer does not see its renders',
        err,
      );
    }
    // The renders the checks log recorded: a seat that takes images gets up to
    // four per check, else it gets a manifest and the no-vision statement.
    const reviewSeatTakesImages = seatSupportsImages({
      runner: reviewRunner,
      detected: resolveSeatImageFact({
        runner: reviewRunner,
        role: 'reviewer',
        cache: opts.modelCache,
      }),
    });
    const registry = checkRegistry({
      plan: state.plan,
      tasks: state.tasks,
      reviewChecks: enabledReviewChecks(config, state.plan),
    });
    const checkIds = [...registry.keys()];
    const renders = reviewRenders({
      ledger,
      registry,
      projectDir,
      seatSupportsImages: reviewSeatTakesImages,
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
    const writesFiles = resolveImplementerProfiles(config).defaultProfile.capabilities.writesFiles;
    const planningAnswers = reviewPlanningAnswers(state);
    const operatorInstructions = reviewOperatorInstructions(state);
    const promptScope = reviewScope;
    const messagesForReview = () =>
      state.messageQueue.filter(
        (message) =>
          message.deliveredTo?.reviewer !== undefined && !reviewedBeforeStart.has(message.id),
      );
    const preparePrompt = async (): Promise<(suffix: string) => string> => {
      throwIfAborted(opts.signal);
      const drain = await drainQueueForReview({ projectDir, sessionId, state, bus });
      state = drain.state;
      opts.setTrackedState?.(state);
      const queueText = formatDrainedMessages(messagesForReview());
      const promptPrefix = [
        plannerFeature(workspaceReadInstructions(workspaceDir), state.plannerContext),
        ...(opts.integration !== undefined ? [opts.integration] : []),
        ...(reviewChecksSection !== undefined ? [reviewChecksSection] : []),
        queueText,
      ].join('\n\n');
      if (changeFile !== undefined) {
        await writeConfinedSecureFileAsync(
          workspaceDir,
          reviewChangeFile(sessionId),
          reviewChangeText(promptScope),
        );
      }

      return (suffix) => {
        promptSuffix = suffix;
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
            baseline: { head: baseline.head, runStartChangedFiles: universe.preRunFiles },
            driftSection: driftPromptSection,
            validation: { recorded: wholeChecksLog !== undefined, evidence: wholeChecksLog },
            reviewScope: promptScope,
            queueText: promptPrefix,
            taskIds: scope.taskIds,
            criterionIds: scope.criterionIds,
            checkIds,
            plan,
            touchedNotSuggested,
            checkResults,
            consultLog,
            triageLog,
            planningAnswers,
            operatorInstructions,
            pendingInputs,
            fixCycle,
            writesFiles,
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
              ...(changeFile === undefined
                ? {
                    files: promptScope.files,
                    laterDiff: promptScope.laterDiff,
                    workspaceContext: promptScope.workspaceContext,
                  }
                : { changeFile: { path: changeFile, provenance: true } }),
              plan,
              touchedNotSuggested,
              checkResults,
              consultLog,
              triageLog,
              planningAnswers,
              operatorInstructions,
              pendingInputs,
              fixCycle,
              writesFiles,
              taskIds: scope.taskIds,
              criterionIds: scope.criterionIds,
              checkIds,
              changeCoverage: promptScope.description,
              driftReport: driftPromptSection,
              checksLog,
              renders: renders.section,
              skillsContext: opts.skillsContext,
            },
            limit,
            suffix,
            evidencePaths,
          });
          if (limit !== undefined) {
            // The prompt is rebuilt on each retry and repair, so the trim
            // warning shows once for each review.
            const trimmedBefore = (reviewInput?.dropped.length ?? 0) > 0;
            reviewInput = { size: result.size, limit, dropped: [...result.dropped] };
            if (result.dropped.length > 0 && !trimmedBefore) {
              publishWarning({
                bus,
                phase: state.phase,
                message: `Review input trimmed to fit ${getRunnerCatalogDisplayName(reviewRunner)} (${result.size.toLocaleString('en-US')} of ${limit.max.toLocaleString('en-US')} ${limit.unit}): ${result.dropped.map((drop) => `${drop.trim}: ${drop.items.join(', ')}`).join('; ')}`,
              });
            }
          }
          fullPrompt = result.prompt;
          if (result.kind === 'too-large') {
            failure = {
              kind: 'input-too-large',
              figures: { unit: result.limit.unit, size: result.size, limit: result.limit.max },
              promptSize: promptLength(fullPrompt + promptSuffix),
              changeFile: reviewChangeFile(sessionId),
              workspaceDir,
            };
            throw error('review-input-too-large', 'Review input exceeds the tool cap.');
          }
        }
        return fullPrompt;
      };
    };

    const reviewStep = { kind: 'review' as const, cycle: fixCyclesOf(state).used };
    // One continuation, one call: a retried review is the whole prompt again
    // with the operator's note on the end, never a session resume.
    let seed = opts.continuation?.take(reviewStep);
    let steerImages = seed?.steer?.images ?? [];
    const reviewImages = () =>
      imagesFromMessages([
        { images: renders.images },
        { images: steerImages },
        ...messagesForReview(),
      ]);

    const callReviewer = async (): Promise<RequestTypedResult<ReviewAnswer>> => {
      if (opts.sinks === undefined) {
        const call = await runReviewerCall({
          reviewer,
          prepareCall: async () => ({ prompt: await preparePrompt(), images: reviewImages() }),
          schema: verdictSchema,
          jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
          schemaName: 'review_answer',
          projectDir,
          workspaceDir,
          sessionId,
          bus,
          config,
          state,
          signal: opts.signal,
          ...(opts.steering !== undefined && { steering: opts.steering }),
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
        // whole deterministic prompt — spec, briefs, diff or change file, drift, evidence — with
        // the operator's note on the end. It never resumes a session.
        body: async ({ signal: callSignal, partial, steer, steerInput }) => {
          seed = steerInput === undefined ? undefined : { steer: steerInput };
          steerImages = steerInput?.images ?? [];
          const call = await runReviewerCall({
            reviewer,
            prepareCall: async () => {
              const prompt = await preparePrompt();
              return {
                prompt: (suffix) =>
                  partial === undefined && steer === undefined
                    ? prompt(suffix)
                    : composeContinuation({ basePrompt: prompt(suffix), partial, steer }),
                images: reviewImages(),
              };
            },
            schema: verdictSchema,
            jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
            schemaName: 'review_answer',
            projectDir,
            workspaceDir,
            sessionId,
            bus,
            config,
            state,
            signal: callSignal,
            ...(opts.steering !== undefined && { steering: opts.steering }),
          });
          state = call.state;
          return call.result;
        },
      });
      return loop.value;
    };

    const messagePendingReviewer = () =>
      phaseStage(state.phase) === 'review' &&
      state.messageQueue.some(isQueuedMessagePendingReviewer);
    let typed = await callReviewer();
    while (true) {
      await settleMidCallDeliveries({ projectDir, sessionId });
      state = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state, {
        keepUnsaved: true,
      });
      opts.setTrackedState?.(state);
      if (opts.signal?.aborted) return interrupted();
      if ('error' in typed) {
        failure = { kind: 'seat-protocol-error', error: typed.error };
        throw typed.error;
      }
      if (!messagePendingReviewer()) break;
      typed = await callReviewer();
    }
    const answer = typed.value;
    const { tasks, criteria, findings } = answer;
    let reviewerVerdict: ReviewVerdict = { tasks, criteria, findings };
    fixWork = { fixTasks: answer.fixTasks, rejected: answer.rejected, ask: answer.ask };
    const redInputs = blockingRedInputs(state.pendingTriage?.inputs ?? [], fixWork);
    const verification = await verifyReviewClaims({
      verdict: reviewerVerdict,
      scope,
      state,
      redInputs,
      preExistingChecks,
      projectDir,
      workspaceDir,
      sessionId,
      config,
      bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    // A render check with no attached image can only stay unverified: the
    // reviewer saw no render of it, so nothing it says may turn one into a pass.
    let unseenRenderCriteria: readonly string[] = [];
    if (renders.missingCheckIds.length > 0) {
      const forced = forceUnverifiedRenderCriteria({
        verdict: reviewerVerdict,
        renderCheckIds: renders.missingCheckIds,
        criterionCheckIds,
        verification: verification.map,
      });
      reviewerVerdict = forced.verdict;
      if (!reviewSeatTakesImages) unseenRenderCriteria = forced.forcedCriterionIds;
      if (forced.forcedCriterionIds.length > 0) {
        const forcedKeys = new Set(
          forced.forcedCriterionIds.map((id) => verificationKey('criterion', id)),
        );
        verification.entries = verification.entries.map((entry) =>
          forcedKeys.has(entry.id) ? { ...entry, status: 'unverified' as const } : entry,
        );
      }
    }
    const outcome = deriveReviewOutcome(reviewerVerdict, scope, verification.map, redInputs);
    setAside = setAsideInputs(state.pendingTriage?.inputs ?? [], fixWork);
    const record: ReviewRecord = {
      scope: opts.scope ?? 'final',
      cycle: fixCyclesOf(state).used,
      verdict: reviewerVerdict,
      outcome: outcome.kind,
      verification: verification.entries,
      ...(outcome.redInputs.length > 0 && { redInputs: outcome.redInputs }),
      ...(preExistingChecks.length > 0 && { preExistingChecks }),
      ...(unseenRenderCriteria.length > 0 && { unseenRenderCriteria: [...unseenRenderCriteria] }),
      at: nowIso(),
    };
    state = transitionAndSave({ projectDir, sessionId }, state, {
      type: 'RECORD_REVIEW',
      review: record,
    });
    persistReviewEvidence({
      wctx: { projectDir, sessionId, bus },
      state,
      review: {
        scope: scope.kind,
        ...(state.review?.afterTaskId !== undefined && { afterTaskId: state.review.afterTaskId }),
        cycle: fixCyclesOf(state).briefed,
        outcome: record.outcome,
        blocking: blockingEntries(outcome),
        ...(setAside.length > 0 && { setAside }),
        at: record.at,
      },
    });
    if (fixWork.fixTasks.length > 0 || fixWork.rejected.length > 0 || fixWork.ask !== null)
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
          blocking: blockingKeys(outcome, state.pendingTriage?.inputs ?? []),
          scope: scope.kind,
        },
      });
    verdict = { verdict: reviewerVerdict, outcome };
    reviewText = renderReviewMarkdown(
      reviewerVerdict,
      state.tasks,
      outcome,
      preExistingChecks,
      setAside,
    );
    writeSpecFile(
      { projectDir, sessionId },
      REVIEW_JSON_FILE,
      `${JSON.stringify(record)}\n`,
      metadata,
    );
    writeSpecFile({ projectDir, sessionId }, REVIEW_FILE, reviewText, metadata);
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err)) return interrupted();
    if (sessionError.isLocalSaveFailure(err)) throw err;
    const seat = requireReviewSeat(config);
    const failed = `${reviewName(reviewEvent)} failed`;
    const label =
      seat.source === 'configured'
        ? `${failed} (reviewer: ${getRunnerCatalogDisplayName(seat.runner)})`
        : failed;
    // The diagnosis is read off the error's own data, never off its wording, so
    // recovery keeps every missing section this review was refused for.
    const diagnostic = readApiContextDiagnostic(err);
    let message: string;
    let resetAt: string | undefined;
    if (typedRunnerCallErrorCode(err) === 'input-too-large') {
      const sent = promptLength(fullPrompt + promptSuffix);
      const figures = inputTooLargeFigures(typedRunnerCallErrorMessage(err) ?? '');
      failure = {
        kind: 'input-too-large',
        figures: { ...figures, size: figures.size ?? sent[figures.unit] },
        promptSize: sent,
        changeFile: reviewChangeFile(sessionId),
        workspaceDir,
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
        seat: 'review',
      });
      message = diagnosis.message;
      resetAt = diagnosis.resetsAt?.toISOString();
      failure =
        diagnosis.failure === 'call-failed'
          ? { kind: 'call-failed', code: errorKind(err) ?? REVIEW_UNAVAILABLE, message }
          : { kind: 'seat-blocked', diagnosis };
    }
    if (failure.kind !== 'seat-blocked')
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

  recordFinalReviewStatus({ projectDir, sessionId }, writeStatus);

  const blockingFindings = verdict === null ? [] : blockingEntries(verdict.outcome);
  publishReviewEvent(
    { bus, phase: state.phase },
    {
      type: 'review_completed',
      ...reviewEvent,
      verdict: verdict?.outcome.kind ?? 'no-verdict',
      ...(verdict !== null && {
        findings: {
          blocking: blockingFindings.length,
          minor: verdict.outcome.minor.length,
          outOfScope: verdict.outcome.outOfScope.length,
          ...(verdict.outcome.unverifiedCriteria.length > 0 && {
            unverifiedCriteria: verdict.outcome.unverifiedCriteria.length,
          }),
        },
      }),
      ...(blockingFindings.length > 0 && { blockingFindings }),
      ...(verdict !== null && setAside.length > 0 && { setAside }),
      duration: Date.now() - finalReviewStart,
    },
  );

  // The packet is the final review's artifact; a task-cadence review writes only
  // review.json and review.md.
  if (opts.scope !== 'task' && summaryBase !== undefined) {
    try {
      await writeReviewPacket({
        projectDir,
        workspaceDir,
        sessionId,
        summary: buildSummary({
          ...summaryBase,
          projectDir,
          sessionId,
          state,
        }),
        state,
        finalReviewStatus: writeStatus,
        modelCache: summaryBase.pricingCache ?? NULL_CACHE,
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
