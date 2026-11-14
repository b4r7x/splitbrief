import type { TaskCompletionMethod } from '../schemas/enums.js';
import type { ReviewCompletedEvent, SectionableEvent } from './events.js';

/** What names a review stage: its scope, the brief a task review follows, and the cycles before it. */
export interface ReviewStage {
  stage: 'review';
  scope: 'final' | 'task';
  afterTaskId?: string | undefined;
  /** The run's fix cycles before this review, task reviews included: the count the stage anchor shows. */
  fixCyclesBefore: number;
  /** The final reviews of this fix cycle that came before this one: a re-run, as after a crash. */
  rerunsBefore: number;
}

export type ReviewCounts = Pick<ReviewStage, 'fixCyclesBefore' | 'rerunsBefore'>;

export type StageSummary =
  | { stage: 'plan'; feature: string; duration: number }
  | (ReviewStage & {
      outcome: 'passed' | 'passed-with-notes' | 'failed' | 'no-verdict' | 'stopped';
      findings?: ReviewCompletedEvent['findings'];
      failedCommands: string[];
      failedChecks: number;
      fixes: string[];
      duration: number;
      /** A process exit cut its call: `duration` runs only to the last thing the call reported. */
      endUnknown?: true;
    });

export type Section<TEvent extends SectionableEvent = SectionableEvent> =
  | { type: 'events'; items: TEvent[]; startIndex: number }
  | { type: 'settled-stage'; items: TEvent[]; startIndex: number; summary: StageSummary }
  | {
      type: 'completed-task';
      items: TEvent[];
      startIndex: number;
      summary: {
        /** The brief's own id, which every other surface names it by. */
        id: string;
        title: string;
        method: TaskCompletionMethod;
        retries: number;
        duration: number;
        file?: string;
        reason?: string;
      };
    }
  | { type: 'active-task'; items: TEvent[]; startIndex: number }
  | { type: 'active-review'; items: TEvent[]; startIndex: number; review: ReviewStage };

export function isSettledSection<TEvent extends SectionableEvent>(
  section: Section<TEvent>,
): section is Extract<Section<TEvent>, { type: 'completed-task' | 'settled-stage' }> {
  return section.type === 'completed-task' || section.type === 'settled-stage';
}
