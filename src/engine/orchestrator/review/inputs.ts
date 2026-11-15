import { join } from 'node:path';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import {
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  sessionDir,
  EVIDENCE_FILE,
  SESSION_LOG_FILE,
  DRIFT_REPORT_FILE,
} from '../../../core/paths.js';
import { reviewScopeFor } from '../../../core/review/scope.js';
import { seatSupportsImages } from '../../../core/runners/capabilities.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { ReviewerConfig } from '../../../core/schemas/runner/reviewer.js';
import { type WorkflowState, fixCyclesOf } from '../../../core/schemas/workflow/state.js';
import { readSpecFileOrEmpty } from '../../../core/sessions/spec-files.js';
import { warnError } from '../../../lib/warn.js';
import type { EventBus } from '../../events/types.js';
import { resolveSeatImageFact } from '../../providers/model/resolution.js';
import type { ModelCacheAccessor } from '../../providers/model/runtime-snapshot.js';
import { formatTasks } from '../../spec/formatter.js';
import { triageLines } from '../../spec/prompts/review/changes.js';
import type { ReviewTouchedNotSuggested } from '../../spec/prompts/review/types.js';
import { deserializeChangedFilesBaseline } from '../changed-files-baseline.js';
import { analyzeBriefDrift } from '../drift/analyze.js';
import { publishDriftReport, formatDriftReportForPrompt } from '../drift/format.js';
import { writeDriftReport } from '../drift/io.js';
import { currentCandidateId } from '../evidence/record-checks.js';
import { readPacketEvents } from '../evidence/review-packet/artifacts.js';
import {
  renderWholeChecksLog,
  renderChecksLogForPrompt,
} from '../evidence/review-packet/checks-log.js';
import { resolveRunReviewScope } from '../evidence/review-packet/run-scope.js';
import { resolveRunUniverse, runUserFiles } from '../evidence/review-packet/sections-io.js';
import { buildChecks } from '../evidence/review-packet/sections.js';
import { runBaseOf } from '../isolation/run-base/tree.js';
import { touchedNotSuggestedFiles } from '../task/commit.js';
import { enabledReviewChecks, checkRegistry } from '../validation/checks/runner.js';
import type { BaseGate } from '../validation/base-gate.js';
import { buildStageContext } from '../validation/run.js';
import { runReviewChecks } from './checks/run-all.js';
import { reviewPlanData, reviewOperatorInstructions } from './plan.js';
import { reviewCheckResults, reviewConsultLog, reviewPlanningAnswers } from './prompt.js';
import { reviewRenders } from './renders.js';
import { finalReviewError, type ReviewStatePort } from './types.js';

export type ReviewBounds = Awaited<ReturnType<typeof resolveReviewBounds>>;
export type ReviewInputs = Awaited<ReturnType<typeof collectReviewInputs>>;

/**
 * What the review judges: the run-start baseline, the run changes since it with their diff, the
 * files the user changed before the run, and the scope of the verdict. A state with no run-start
 * baseline fails the review instead of guessing the run boundary.
 */
export async function resolveReviewBounds(input: {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  state: WorkflowState;
  cadence: 'final' | 'task';
}) {
  const { projectDir, workspaceDir, sessionId, state } = input;
  const baseline = state.changedFilesBaseline;
  if (baseline?.runStartChangedFiles === undefined) throw finalReviewError.missingRunBaseline();
  const universe = await resolveRunUniverse({
    workspaceDir,
    baseline,
    runBase: runBaseOf({ projectDir, sessionId }, state),
  });
  const userFiles = runUserFiles(universe);
  const reviewScope = await resolveRunReviewScope({
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
  const scope = reviewScopeFor(state, input.cadence);
  return { baseline, universe, userFiles, reviewScope, scope };
}

/**
 * The sources of the review prompt, read once for each review: the project gate's run, the spec
 * and the briefs, the checks log, the drift report, the renders of the current candidate, and
 * the plan, check and triage lines. A source that cannot be read warns and stays out of the
 * prompt.
 */
export async function collectReviewInputs(input: {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  bus: EventBus;
  signal: AbortSignal | undefined;
  live: ReviewStatePort;
  setTrackedState: ((state: WorkflowState) => void) | undefined;
  bounds: ReviewBounds;
  runner: ReviewerConfig;
  modelCache: ModelCacheAccessor | undefined;
  reviewChecks: { baseGate: BaseGate | undefined } | undefined;
}) {
  const { projectDir, workspaceDir, sessionId, config, bus, live, bounds, runner } = input;
  let reviewChecksSection: string | undefined;
  // A review that only re-answers its question on the same candidate keeps the checks it ran.
  let preExistingChecks = live.get().review?.preExistingChecks ?? [];
  if (input.reviewChecks !== undefined) {
    const checks = await runReviewChecks({
      projectDir,
      workspaceDir,
      sessionId,
      config,
      bus,
      state: live.get(),
      baseGate: input.reviewChecks.baseGate,
      signal: input.signal,
    });
    live.set(checks.state);
    input.setTrackedState?.(checks.state);
    reviewChecksSection = checks.section;
    preExistingChecks = checks.preExistingChecks;
  }
  const state = live.get();
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
      if (runner.kind === 'api') {
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
      changedFiles: bounds.reviewScope.provenance.promotedFiles,
      ledger,
      briefHash: hashTaskBrief(state.tasks),
      preRunChangedFiles: bounds.universe.preRunFiles,
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
  const plan = reviewPlanData(state);
  const { seatTakesImages, checkIds, renders } = await collectReviewRenders({
    projectDir,
    workspaceDir,
    config,
    runner,
    modelCache: input.modelCache,
    baseline: bounds.baseline,
    ledger,
    state,
  });
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
  return {
    reviewChecksSection,
    preExistingChecks,
    spec,
    taskBriefs,
    evidencePaths,
    checksLog,
    wholeChecksLog,
    driftPromptSection,
    testChecks,
    plan,
    seatTakesImages,
    checkIds,
    renders,
    touchedNotSuggested,
    checkResults: reviewCheckResults(state),
    consultLog: reviewConsultLog(state),
    triageLog: triageLines(state.triage ?? []),
    pendingInputs: state.pendingTriage?.inputs ?? [],
    fixCycle: fixCyclesOf(state).used + 1,
    writesFiles: resolveImplementerProfiles(config).defaultProfile.capabilities.writesFiles,
    planningAnswers: reviewPlanningAnswers(state),
    operatorInstructions: reviewOperatorInstructions(state),
  };
}

async function collectReviewRenders(input: {
  projectDir: string;
  workspaceDir: string;
  config: Config;
  runner: ReviewerConfig;
  modelCache: ModelCacheAccessor | undefined;
  baseline: ReviewBounds['baseline'];
  ledger: EvidenceLedger | null;
  state: WorkflowState;
}) {
  const { projectDir, workspaceDir, config, runner, ledger, state } = input;
  // The reviewer judges only the current candidate: an artifact from an earlier
  // candidate can never stand in for a render this run did not produce.
  let reviewCandidateId: string | undefined;
  try {
    reviewCandidateId = await currentCandidateId(
      workspaceDir,
      deserializeChangedFilesBaseline(input.baseline),
    );
  } catch (err) {
    warnError(
      'Could not identify the current change, so the reviewer does not see its renders',
      err,
    );
  }
  // The renders the checks log recorded: a seat that takes images gets up to
  // four per check, else it gets a manifest and the no-vision statement.
  const seatTakesImages = seatSupportsImages({
    runner,
    detected: resolveSeatImageFact({
      runner,
      role: 'reviewer',
      cache: input.modelCache,
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
    seatSupportsImages: seatTakesImages,
    currentCandidateId: reviewCandidateId,
  });
  return { seatTakesImages, checkIds, renders };
}
