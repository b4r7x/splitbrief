import type { ReviewStage, Section } from '../../../../core/sections/types.js';
import type { EngineEventOf, EngineEvent } from '../../../../engine/events/types.js';

export type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;
export type CheckEvent = EngineEventOf<'full_suite'>;

export interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
  lastEvent: RunnerActivityEvent;
}

/** The halt, the action a person chose, the reset it made and the outcome it reached. */
type RecoveryFoldEvents = {
  firstIndex: number;
  issueId: string;
  prompted?: EngineEventOf<'recovery_prompted'>;
  selected?: EngineEventOf<'recovery_action_selected'>;
  reset?: EngineEventOf<'task_reset'>;
  resolved?: EngineEventOf<'recovery_resolved'>;
  seatSwitch?: EngineEventOf<'seat_switched'>;
  haltAlreadyShown?: true;
};

export type RecoveryFold = RecoveryFoldEvents &
  (
    | { automaticSwitch?: undefined; diagnostics?: undefined }
    | {
        automaticSwitch: EngineEventOf<'seat_switched'>;
        prompted: EngineEventOf<'recovery_prompted'>;
        diagnostics: readonly string[];
      }
  );

export type SettledTranscriptSection = Extract<
  Section<EngineEvent>,
  { type: 'completed-task' | 'settled-stage' }
>;

export type TranscriptWalkStep =
  | { kind: 'settled'; section: SettledTranscriptSection }
  | { kind: 'review-heading'; startIndex: number; review: ReviewStage; items: EngineEvent[] }
  | { kind: 'settled-end'; section: SettledTranscriptSection }
  | ((
      | { kind: 'activity-batch'; batch: RunnerActivityBatch; callEnded: boolean }
      | { kind: 'check-group'; firstIndex: number; checks: CheckEvent[]; open: boolean }
      | { kind: 'recovery'; recovery: RecoveryFold }
      | {
          kind: 'event';
          event: EngineEvent;
          globalIndex: number;
          causeInRecovery?: boolean;
          historicalTaskHeader?: true;
        }
    ) & { settledSection?: SettledTranscriptSection });
