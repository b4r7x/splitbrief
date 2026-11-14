import type { Attachment } from '../../../core/schemas/attachment.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { lineageKeyFor, briefCorrections } from '../../../core/state/lineage.js';
import { transition } from '../../../core/state/machine.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { imagesFromMessages } from '../queue/prompt.js';
import { mutateState } from './commit.js';
import { stateOpsError } from './errors.js';
import { rebaseOnPersistedWorkflowState, readStateHead } from './head.js';

export function recordBriefCorrection(
  ref: SessionRef,
  state: WorkflowState,
  taskId: TaskId,
  text: string,
  images: readonly Attachment[] = [],
): WorkflowState {
  const current = rebaseOnPersistedWorkflowState(ref, state);
  const priorImages = current.lineages?.[lineageKeyFor(current, taskId)]?.correctionImages ?? [];
  if (
    briefCorrections(current, taskId).includes(text) &&
    images.every((image) => priorImages.some((prior) => prior.id === image.id))
  )
    return current;
  return mutateState({
    ref,
    state: current,
    operation: 'transition',
    options: undefined,
    rederivable: false,
    mergeQueue: false,
    derive: briefCorrectionStep(taskId, text, images),
  });
}

/** Records a correction and its images on the brief's lineage once; the retried brief reads them. */
export function briefCorrectionStep(
  taskId: TaskId,
  text: string,
  images: readonly Attachment[],
): (state: WorkflowState) => WorkflowState {
  return (base) => {
    const corrected = briefCorrections(base, taskId).includes(text)
      ? base
      : transition(base, { type: 'RECORD_CORRECTION', taskId, text });
    if (images.length === 0) return corrected;
    const key = lineageKeyFor(base, taskId);
    return {
      ...corrected,
      lineages: Object.fromEntries(
        Object.entries(corrected.lineages ?? {}).map(([id, lineage]) => [
          id,
          id === key
            ? {
                ...lineage,
                correctionImages: imagesFromMessages([
                  { images: lineage.correctionImages ?? [] },
                  { images },
                ]),
              }
            : lineage,
        ]),
      ),
    };
  };
}

export function recordResumeUserMessage(
  ref: SessionRef,
  message: Pick<
    NonNullable<WorkflowState['resumeUserMessages']>[number],
    'ts' | 'phase' | 'displayText'
  > & {
    text: string;
    answerIndex?: number;
  },
): void {
  if (message.text === message.displayText) return;
  const head = readStateHead(ref);
  if (head === null) {
    throw stateOpsError.invalidHead('Attached user text requires saved workflow state.');
  }
  const { text, answerIndex, ...identity } = message;
  const saved = answerIndex === undefined ? { ...identity, text } : { ...identity, answerIndex };
  mutateState({
    ref,
    state: head.state,
    operation: 'transition',
    options: { expectedRevision: head.state.stateRevision },
    rederivable: false,
    mergeQueue: false,
    derive: (state) => ({
      ...state,
      resumeUserMessages: [...(state.resumeUserMessages ?? []), saved],
    }),
  });
}

export function pruneResumeUserMessages(
  ref: SessionRef,
  messages: NonNullable<WorkflowState['resumeUserMessages']>,
): void {
  if (messages.length === 0) return;
  const head = readStateHead(ref);
  if (head === null)
    throw stateOpsError.invalidHead('Compacted user text requires saved workflow state.');
  mutateState({
    ref,
    state: head.state,
    operation: 'transition',
    options: { expectedRevision: head.state.stateRevision },
    rederivable: false,
    mergeQueue: false,
    derive: (state) => {
      const removals = messages.map((message) => JSON.stringify(message));
      return {
        ...state,
        resumeUserMessages: (state.resumeUserMessages ?? []).filter((message) => {
          const index = removals.indexOf(JSON.stringify(message));
          if (index === -1) return true;
          removals.splice(index, 1);
          return false;
        }),
      };
    },
  });
}
