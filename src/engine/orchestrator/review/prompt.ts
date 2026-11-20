import { join } from 'node:path';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { reviewChangeFile } from '../../../core/paths.js';
import { seatReadsChangeFile } from '../../../core/runners/capabilities.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { ReviewerConfig } from '../../../core/schemas/runner/reviewer.js';
import type { QueuedMessage } from '../../../core/schemas/workflow/queue.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs/secure.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { error } from '../../../utils/error.js';
import type { EventBus } from '../../events/types.js';
import { apiContextError } from '../../providers/api/context-diagnostic.js';
import { cliPromptLimit } from '../../runners/cli-tools/registry.js';
import { promptLength } from '../../runners/input-limit.js';
import { workspaceReadInstructions } from '../../spec/prompts/builder.js';
import { reviewChangeText } from '../../spec/prompts/review/changes.js';
import { fitReviewPrompt } from '../evidence/review-packet/fit.js';
import { publishWarning } from '../publish/notice.js';
import { drainQueueForReview } from '../queue/drain.js';
import { formatDrainedMessages, imagesFromMessages } from '../queue/prompt.js';
import { plannerFeature } from '../run/planner-callbacks-context.js';
import { buildApiReviewContext } from './api-context.js';
import type { ReviewBounds, ReviewInputs } from './inputs.js';
import type { PreparedReviewerCallInput, ReviewStatePort, SentReviewPrompt } from './types.js';

/** The recorded check runs: what each brief's checks returned, then the plan's. */
export function reviewCheckResults(state: WorkflowState): string {
  const lines: string[] = [];
  for (const task of state.tasks) {
    for (const result of task.checkResults ?? []) {
      lines.push(`- ${task.id} check ${result.id}: ${result.status}`);
    }
  }
  const recorded = new Map(
    state.tasks.flatMap((task) => task.checkResults ?? []).map((result) => [result.id, result]),
  );
  for (const check of state.plan?.checks ?? []) {
    const result = recorded.get(check.id);
    lines.push(
      `- plan check ${check.id}: ${result === undefined ? 'not recorded' : result.status}`,
    );
  }
  return lines.join('\n');
}

export function reviewConsultLog(state: WorkflowState): string {
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

export function reviewPlanningAnswers(state: WorkflowState): string {
  return (state.userAnswers ?? [])
    .map((answer) => `- ${answer.reply} → ${answer.answer}`)
    .join('\n');
}

/** The messages delivered to the reviewer since this review started. */
export function messagesForReview(
  state: WorkflowState,
  reviewedBeforeStart: ReadonlySet<string>,
): QueuedMessage[] {
  return state.messageQueue.filter(
    (message) =>
      message.deliveredTo?.reviewer !== undefined && !reviewedBeforeStart.has(message.id),
  );
}

/** The fixed input of the review prompt: the seat, the sections before the packet, its sources. */
export type ReviewPromptContext = Readonly<{
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  bus: EventBus;
  signal: AbortSignal | undefined;
  live: ReviewStatePort;
  setTrackedState: ((state: WorkflowState) => void) | undefined;
  runner: ReviewerConfig;
  cadence: 'final' | 'task';
  bounds: ReviewBounds;
  inputs: ReviewInputs;
  integration: string | undefined;
  skillsContext: string | undefined;
  /** The ids of the messages the reviewer already had when this review started. */
  reviewedBeforeStart: ReadonlySet<string>;
  /** Each build of the prompt is written here. */
  sent: SentReviewPrompt;
}>;

/**
 * One attempt of the review call: the queue drained for the reviewer, the change file a seat
 * reads, the images, and the prompt, built once the seat's suffix is known.
 */
export async function prepareReviewCall(
  context: ReviewPromptContext,
  steerImages: readonly Attachment[],
): Promise<PreparedReviewerCallInput> {
  const { projectDir, workspaceDir, sessionId, bus, live, runner, bounds, sent } = context;
  const { reviewScope, scope } = bounds;
  const {
    spec,
    taskBriefs,
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
    checkIds,
    renders,
  } = context.inputs;
  throwIfAborted(context.signal);
  const drain = await drainQueueForReview({ projectDir, sessionId, state: live.get(), bus });
  live.set(drain.state);
  context.setTrackedState?.(drain.state);
  const queueText = formatDrainedMessages(
    messagesForReview(live.get(), context.reviewedBeforeStart),
  );
  const promptPrefix = [
    plannerFeature(workspaceReadInstructions(workspaceDir), live.get().plannerContext),
    ...(context.integration !== undefined ? [context.integration] : []),
    ...(context.inputs.reviewChecksSection !== undefined
      ? [context.inputs.reviewChecksSection]
      : []),
    queueText,
  ].join('\n\n');
  // `.splitbrief/` in the run workspace is never a run change.
  const changeFile = seatReadsChangeFile(runner)
    ? join(workspaceDir, reviewChangeFile(sessionId))
    : undefined;
  if (changeFile !== undefined) {
    await writeConfinedSecureFileAsync(
      workspaceDir,
      reviewChangeFile(sessionId),
      reviewChangeText(reviewScope),
    );
  }
  const limit = runner.kind === 'cli' ? cliPromptLimit('planner', runner.tool) : undefined;

  const prompt = (suffix: string): string => {
    sent.suffix = suffix;
    const state = live.get();
    // An API seat reads no file of its own, so it is dispatched only once the
    // packet it is handed carries every required source, whole and untruncated.
    if (runner.kind === 'api') {
      sent.text = apiReviewPrompt(context, state, promptPrefix);
      return sent.text;
    }
    const result = fitReviewPrompt({
      prefix: promptPrefix,
      prompt: {
        spec,
        taskBriefs,
        reviewKind: context.cadence,
        ...(changeFile === undefined
          ? {
              files: reviewScope.files,
              laterDiff: reviewScope.laterDiff,
              workspaceContext: reviewScope.workspaceContext,
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
        changeCoverage: reviewScope.description,
        driftReport: context.inputs.driftPromptSection,
        checksLog: context.inputs.checksLog,
        renders: renders.section,
        skillsContext: context.skillsContext,
      },
      limit,
      suffix,
      evidencePaths: context.inputs.evidencePaths,
    });
    if (limit !== undefined) {
      // The prompt is rebuilt on each retry and repair, so the trim
      // warning shows once for each review.
      const trimmedBefore = (sent.reviewInput?.dropped.length ?? 0) > 0;
      sent.reviewInput = { size: result.size, limit, dropped: [...result.dropped] };
      if (result.dropped.length > 0 && !trimmedBefore) {
        publishWarning({
          bus,
          phase: state.phase,
          message: `Review input trimmed to fit ${getRunnerCatalogDisplayName(runner)}`,
        });
      }
    }
    sent.text = result.prompt;
    if (result.kind === 'too-large') {
      sent.tooLarge = {
        kind: 'input-too-large',
        figures: { unit: result.limit.unit, size: result.size, limit: result.limit.max },
        promptSize: promptLength(sent.text + sent.suffix),
        changeFile: reviewChangeFile(sessionId),
        workspaceDir,
      };
      throw error('review-input-too-large', 'Review input exceeds the tool cap.');
    }
    return sent.text;
  };

  return {
    prompt,
    images: imagesFromMessages([
      { images: renders.images },
      { images: steerImages },
      ...messagesForReview(live.get(), context.reviewedBeforeStart),
    ]),
  };
}

function apiReviewPrompt(
  context: ReviewPromptContext,
  state: WorkflowState,
  promptPrefix: string,
): string {
  const { runner, bounds, inputs } = context;
  const { universe, reviewScope, scope } = bounds;
  const packet = buildApiReviewContext({
    feature: state.feature,
    spec: inputs.spec,
    taskBriefs: inputs.taskBriefs,
    reviewKind: context.cadence,
    fullDiff: universe.fullDiff,
    changedFiles: universe.changedFiles,
    baseline: { head: bounds.baseline.head, runStartChangedFiles: universe.preRunFiles },
    driftSection: inputs.driftPromptSection,
    validation: {
      recorded: inputs.wholeChecksLog !== undefined,
      evidence: inputs.wholeChecksLog,
    },
    reviewScope,
    queueText: promptPrefix,
    taskIds: scope.taskIds,
    criterionIds: scope.criterionIds,
    checkIds: inputs.checkIds,
    plan: inputs.plan,
    touchedNotSuggested: inputs.touchedNotSuggested,
    checkResults: inputs.checkResults,
    consultLog: inputs.consultLog,
    triageLog: inputs.triageLog,
    planningAnswers: inputs.planningAnswers,
    operatorInstructions: inputs.operatorInstructions,
    pendingInputs: inputs.pendingInputs,
    fixCycle: inputs.fixCycle,
    writesFiles: inputs.writesFiles,
    ...(inputs.renders.section !== undefined && { renders: inputs.renders.section }),
    ...(context.skillsContext !== undefined && { skillsContext: context.skillsContext }),
    ...(runner.contextLength !== undefined && { contextLength: runner.contextLength }),
    ...(runner.model !== undefined && { model: runner.model }),
  });
  if (packet.kind === 'insufficient-context') {
    throw apiContextError({
      code: 'insufficient-context',
      seat: 'review',
      cause: packet.cause,
      missingSections: [...packet.missingSections],
      ...(runner.model !== undefined && { model: runner.model }),
      requiredTokens: packet.requiredTokens,
      availableTokens: packet.availableTokens,
    });
  }
  return packet.text;
}
