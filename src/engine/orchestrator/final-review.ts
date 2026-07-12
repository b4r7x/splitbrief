import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { EventBus } from '../events/types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { Config } from '../../core/schemas/config.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, REVIEW_FILE, TASKS_FILE, isInternalGitStatusPath } from '../../core/paths.js';
import {
  getCurrentDiff,
  getCurrentChangedFiles,
  getCommittedFilesSince,
  getDiffSince,
  getRunStartHead,
} from '../../lib/git.js';
import { userVisibleChangedFiles } from './changed-files-baseline.js';
import { uniqueInOrder } from '../../utils/collections.js';
import { labelError } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { isAbortError } from '../../utils/abort.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';
import { recordFinalReviewEvidence } from './evidence/reporting.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger.js';
import { analyzeBriefDrift } from './drift/analyze.js';
import { writeDriftReport } from './drift/io.js';
import { formatDriftReportForPrompt, publishDriftReport } from './drift/format.js';

import type { Planner } from '../planners/types.js';
import { buildSummary, type SummaryBase } from './summary.js';
import { publishError, publishPlannerStatus, publishWarningFromError } from './events.js';
import { transitionAndSave } from './state-ops.js';
import { runPlannerReview } from './planner-review.js';
import { createSnapshot } from '../snapshots/create.js';
import { recordRunSnapshot } from '../snapshots/run.js';
import { hashTaskBrief } from '../brief-hash.js';
import { writeReviewPacket } from './evidence/review-packet/write.js';
import { formatTasks } from '../spec/formatter.js';
import { drainQueue, formatDrainedMessages } from './queue.js';
import { withContinuationLoop } from './continuation.js';
import { composeSteeredPrompt } from '../implementers/types.js';
import { RUN_COMMIT_MESSAGE_PREFIX } from './task/commit.js';

export type FinalReviewResult = { summary: Summary; state: WorkflowState };

type RunBaselineUniverse = { diff: string; changedFiles: string[] };

// Per-task commits move the run's changes out of the working tree, so a raw
// `git status`/`git diff` universe is empty and omits them. Diffing against the
// run-start HEAD (newest commit not authored by this run) plus untracked-file
// contents recovers the run-attributed universe; with no run commits the
// run-start HEAD is the current HEAD and this collapses to the working-tree diff.
async function resolveRunBaselineUniverse(projectDir: string): Promise<RunBaselineUniverse> {
  const runStartHead = await getRunStartHead(projectDir, RUN_COMMIT_MESSAGE_PREFIX);
  const status = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  if (runStartHead === null) {
    return {
      diff: await getCurrentDiff(projectDir, isInternalGitStatusPath),
      changedFiles: status,
    };
  }
  const committed = userVisibleChangedFiles(await getCommittedFilesSince(projectDir, runStartHead));
  return {
    diff: await getDiffSince(projectDir, runStartHead, isInternalGitStatusPath),
    changedFiles: uniqueInOrder([...committed, ...status]),
  };
}

export async function runFinalReviewPhase(
  opts: {
    projectDir: string;
    sessionId: string;
    config: Config;
    callbacks: OrchestratorCallbacks;
    bus: EventBus;
    state: WorkflowState;
    planner: Planner;
    metadata?: SpecMetadata | null;
    signal?: AbortSignal | undefined;
    sinks?: WorkflowSinks | undefined;
  },
  summaryBase: SummaryBase,
  taskBreakdowns: TaskTokenUsage[],
  phaseTimings?: Record<string, number>,
): Promise<FinalReviewResult> {
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, bus, planner, metadata } = opts;

  // On resume the state is already persisted in 'final-review' (a previously failed
  // gate); only dispatch ALL_DONE from 'implementing' on a fresh forward run.
  if (state.phase === 'implementing') {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'ALL_DONE' });
  }

  if (config.snapshots?.auto?.preFinalReview === true) {
    try {
      const result = await createSnapshot({
        projectDir,
        sessionId,
        phase: 'manual',
        name: 'pre-final-review',
        bus,
        eventPhase: state.phase,
      });
      await recordRunSnapshot(projectDir, sessionId, result.manifest, 'pre-final-review');
    } catch (err) {
      publishWarningFromError(
        { bus: bus, phase: state.phase },
        'auto-snapshot (pre-final-review) failed',
        err,
      );
    }
  }

  const finalReviewStart = Date.now();
  const interruptedSummary = (): FinalReviewResult => {
    if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;
    publishPlannerStatus(bus, state, 'done', {
      duration: Date.now() - finalReviewStart,
      summary: 'Final review aborted',
    });
    return {
      summary: buildSummary({
        ...summaryBase,
        projectDir,
        sessionId,
        state,
        taskBreakdowns,
        ...(phaseTimings && { phaseTimings }),
      }),
      state,
    };
  };
  if (opts.signal?.aborted) return interruptedSummary();
  publishPlannerStatus(bus, state, 'running');
  bus.publish({ type: 'all_tasks_done', ts: Date.now(), phase: state.phase });

  const MAX_DIFF_CHARS = 100_000;

  let reviewStatus: 'written' | 'failed' = 'written';
  try {
    const universe = await resolveRunBaselineUniverse(projectDir);
    let diff = universe.diff;
    if (diff.length > MAX_DIFF_CHARS) {
      const omitted = diff.length - MAX_DIFF_CHARS;
      diff =
        diff.slice(0, MAX_DIFF_CHARS) +
        `\n\n[... diff truncated, ${omitted} characters omitted ...]`;
    }
    const spec = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
    const taskBriefs =
      readSpecFileOrEmpty({ projectDir, sessionId }, TASKS_FILE) || formatTasks(state.tasks);

    let driftPromptSection: string | undefined;
    try {
      const ledger = readEvidenceLedger({ projectDir, sessionId });
      const driftReport = analyzeBriefDrift({
        tasks: state.tasks,
        changedFiles: universe.changedFiles,
        diff,
        ledger,
        briefHash: hashTaskBrief(state.tasks),
        preRunChangedFiles: state.changedFilesBaseline
          ? Object.keys(state.changedFilesBaseline.fingerprints)
          : null,
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

    const basePrompt = buildFinalReviewPrompt({
      spec,
      taskBriefs,
      diff,
      driftReport: driftPromptSection,
    });
    const fullPrompt = queueText ? queueText + basePrompt : basePrompt;

    if (opts.sinks) {
      const loop = await withContinuationLoop<{ state: WorkflowState; text: string }>({
        ctx: {
          projectDir,
          sessionId,
          callbacks,
          bus,
          signal: opts.signal,
          sinks: opts.sinks,
        },
        state,
        onStateChange: (s) => {
          state = s;
        },
        body: ({ signal: callSignal, continuationPrompt, steer }) =>
          runPlannerReview({
            planner,
            prompt: composeSteeredPrompt(continuationPrompt ?? fullPrompt, steer),
            projectDir,
            sessionId,
            bus,
            state,
            metadata,
            writeTo: REVIEW_FILE,
            signal: callSignal,
          }),
      });
      state = loop.value.state;
    } else {
      const review = await runPlannerReview({
        planner,
        prompt: fullPrompt,
        projectDir,
        sessionId,
        bus,
        state,
        metadata,
        writeTo: REVIEW_FILE,
        signal: opts.signal,
      });
      state = review.state;
    }
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err)) return interruptedSummary();
    publishError({ bus: bus, phase: state.phase, message: labelError('Final review failed', err) });
    reviewStatus = 'failed';
  }
  if (opts.signal?.aborted) return interruptedSummary();

  try {
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    if (ledger) {
      writeEvidenceLedger(
        { projectDir, sessionId },
        recordFinalReviewEvidence({ ledger, status: reviewStatus }),
      );
    }
  } catch (err) {
    warnError('Failed to record final review evidence', err);
  }

  if (phaseTimings) phaseTimings.review = Date.now() - finalReviewStart;

  if (reviewStatus === 'failed') {
    publishPlannerStatus(bus, state, 'done', {
      duration: Date.now() - finalReviewStart,
      summary: 'Final review failed',
    });
  } else {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'REVIEW_DONE' });
    publishPlannerStatus(bus, state, 'done', { duration: Date.now() - finalReviewStart });
    bus.publish({ type: 'workflow_complete', ts: Date.now(), phase: state.phase });
  }

  const summaryOpts = {
    ...summaryBase,
    projectDir,
    sessionId,
    state,
    taskBreakdowns,
    ...(phaseTimings && { phaseTimings }),
  };

  const preSummary = buildSummary(summaryOpts);
  try {
    await writeReviewPacket({
      projectDir,
      sessionId,
      summary: preSummary,
      state,
      finalReviewStatus: reviewStatus,
    });
  } catch (err) {
    publishWarningFromError(
      { bus: bus, phase: state.phase },
      'Review packet generation failed',
      err,
    );
  }

  const summary = buildSummary(summaryOpts);
  if (reviewStatus !== 'failed') callbacks.onComplete(summary);
  return { summary, state };
}
