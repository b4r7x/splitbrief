import type { ClarificationQuestion } from '../../../../core/schemas/question.js';
import type { RunRecord } from '../../../../core/sessions/run/record.js';
import { openRoundQuestions } from '../../at-rest.js';
import { closedTranscriptBlock, type ClosedBlockInput } from '../../closed/block.js';
import { unansweredQuestionsRowBlock } from '../event-rows/answered-questions.js';
import type { ConversationRowBlock } from '../types.js';
import { calloutRowsBlock } from './callout.js';
import { sectionSpacerBlock } from './compose.js';

/**
 * The blocks below the run's own events, each after a blank row: the closed run's ledger, the round
 * still open, and a draft that could not be saved.
 */
export function transcriptTail(input: {
  closedBlock: Omit<ClosedBlockInput, 'width' | 'viewportRows'> | null;
  closedRun: boolean;
  /** The planner's round is in the panel above the composer. */
  plannerAsking: boolean;
  atRestRecord: RunRecord | undefined;
  viewQuestions: readonly ClarificationQuestion[] | null;
  draftRefusal: string | null;
  width: number;
  viewportRows: number;
}): ConversationRowBlock[] {
  const { closedBlock, atRestRecord, viewQuestions, draftRefusal, width } = input;
  // The closed run's ledger is the tail of its own transcript: one scroller, the verdict below the
  // last event the run wrote.
  const closed =
    closedBlock === null
      ? null
      : closedTranscriptBlock({ ...closedBlock, width, viewportRows: input.viewportRows });
  // A round Esc closed stays on screen until the reply answers it; an open run at rest shows the
  // round it waits at. Neither repeats a question the panel is showing.
  const round = unansweredQuestionsRowBlock({
    keyPrefix: 'open-round',
    questions:
      input.closedRun || input.plannerAsking
        ? []
        : atRestRecord === undefined
          ? (viewQuestions ?? [])
          : openRoundQuestions(atRestRecord, viewQuestions),
    width,
  });
  // A draft that could not be saved is named below the run's own events, so a re-read of the run's
  // history, which replaces those events, never erases the cause and the file.
  const draft =
    draftRefusal === null
      ? null
      : calloutRowsBlock({
          keyPrefix: 'draft-not-saved',
          label: 'Warning',
          value: draftRefusal,
          width,
          severity: 'warning',
        });
  return [closed, round, draft].flatMap((block) =>
    block === null ? [] : [sectionSpacerBlock(block.key), block],
  );
}
