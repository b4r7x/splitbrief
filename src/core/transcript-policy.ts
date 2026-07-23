import type { RecoveryFact } from './schemas/recovery/schemas.js';
import type { WorkflowState } from './schemas/workflow.js';
import { stripTerminalControls } from '../utils/display-text.js';

export const TRANSCRIPT_OMITTED_MESSAGE = '[transcript omitted]';

export function consoleWorkflowFeature(opts: {
  feature: string;
  persistTranscript: boolean;
}): string {
  const feature = opts.persistTranscript ? opts.feature : TRANSCRIPT_OMITTED_MESSAGE;
  return stripTerminalControls(feature);
}

export function projectWorkflowStateForTranscriptPolicy(
  state: WorkflowState,
  opts: { persistTranscript: boolean },
): WorkflowState {
  if (opts.persistTranscript) return state;
  const {
    changedFilesBaseline: _changedFilesBaseline,
    external: _external,
    pendingRecovery,
    plannerSessionId,
    rewindPending,
    ...base
  } = state;

  return {
    ...base,
    feature: TRANSCRIPT_OMITTED_MESSAGE,
    ...(plannerSessionId !== undefined && {
      plannerSessionId: plannerSessionId === null ? null : TRANSCRIPT_OMITTED_MESSAGE,
    }),
    tasks: state.tasks.map(projectTaskForTranscriptPolicy),
    messageQueue: state.messageQueue.map(projectQueuedMessageForTranscriptPolicy),
    ...(pendingRecovery !== undefined && {
      pendingRecovery: {
        ...pendingRecovery,
        ...(pendingRecovery.taskTitle !== undefined && {
          taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
        }),
        files: pendingRecovery.files.map(omittedText),
        message: TRANSCRIPT_OMITTED_MESSAGE,
        details: pendingRecovery.details.map(omittedText),
        ...(pendingRecovery.facts !== undefined && {
          facts: projectRecoveryFactsForTranscriptPolicy(pendingRecovery.facts),
        }),
      },
    }),
    ...(rewindPending !== undefined && {
      rewindPending: {
        ...rewindPending,
        ...(rewindPending.comment !== undefined && { comment: TRANSCRIPT_OMITTED_MESSAGE }),
      },
    }),
  };
}

type WorkflowTask = WorkflowState['tasks'][number];
type WorkflowQueuedMessage = WorkflowState['messageQueue'][number];

function projectTaskForTranscriptPolicy(task: WorkflowTask): WorkflowTask {
  return {
    ...task,
    title: TRANSCRIPT_OMITTED_MESSAGE,
    file: TRANSCRIPT_OMITTED_MESSAGE,
    description: TRANSCRIPT_OMITTED_MESSAGE,
    ...(task.signature !== undefined && { signature: TRANSCRIPT_OMITTED_MESSAGE }),
    ...(task.currentCode !== undefined && { currentCode: TRANSCRIPT_OMITTED_MESSAGE }),
    tests: task.tests.map(omittedText),
    constraints: task.constraints.map(omittedText),
    ...(task.pattern !== undefined && { pattern: TRANSCRIPT_OMITTED_MESSAGE }),
    typeDefs: TRANSCRIPT_OMITTED_MESSAGE,
    implementationSteps: task.implementationSteps.map(omittedText),
    ...(task.scope !== undefined && {
      scope: {
        ...(task.scope.inBounds !== undefined && {
          inBounds: task.scope.inBounds.map(omittedText),
        }),
        ...(task.scope.outOfBounds !== undefined && {
          outOfBounds: task.scope.outOfBounds.map(omittedText),
        }),
        ...(task.scope.approvedOutOfBounds !== undefined && {
          approvedOutOfBounds: task.scope.approvedOutOfBounds.map(omittedText),
        }),
      },
    }),
    ...(task.escalation !== undefined && { escalation: task.escalation.map(omittedText) }),
    ...(task.evidence !== undefined && { evidence: task.evidence.map(omittedText) }),
  };
}

function projectQueuedMessageForTranscriptPolicy(
  message: WorkflowQueuedMessage,
): WorkflowQueuedMessage {
  return {
    ...message,
    text: TRANSCRIPT_OMITTED_MESSAGE,
    ...(message.question !== undefined && { question: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectRecoveryFactsForTranscriptPolicy(
  facts: Record<string, RecoveryFact>,
): Record<string, RecoveryFact> {
  return Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [
      key,
      typeof value === 'string' ? TRANSCRIPT_OMITTED_MESSAGE : value,
    ]),
  );
}

function omittedText(): string {
  return TRANSCRIPT_OMITTED_MESSAGE;
}
