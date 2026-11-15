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

/** What the walk holds open between the events of the transcript. Its steps change it in place. */
export interface TranscriptWalk {
  activityBatch: RunnerActivityBatch | null;
  recovery: RecoveryFold | null;
  /** The seat switch and the correction of the open fold, which follow its Recovery row. */
  afterRecovery: Extract<TranscriptWalkStep, { kind: 'event' }>[];
  checkRun: { event: CheckEvent; globalIndex: number }[];
  /** The last event that gave a row: a prompt that restates its halt opens no fold. */
  lastRowEvent: EngineEvent | null;
  /** The header on screen: a restart on the same worker does not repeat it. */
  openHeader: EngineEventOf<'task_started'> | null;
  restatedPrompt: EngineEventOf<'recovery_prompted'> | null;
  settledContext: { settledSection?: SettledTranscriptSection };
}

/** What the steps of the walk read: the passes over the whole transcript that run before it. */
export interface TranscriptWalkReads {
  /** The Recovery row of each automatic recovery, at the event that opens it. */
  readonly recoveries: ReadonlyMap<EngineEvent, RecoveryFold>;
  /** The seat switches that an automatic recovery made. */
  readonly switches: ReadonlySet<EngineEvent>;
  /** The events that show no row. */
  readonly hidden: ReadonlySet<EngineEvent>;
  /** The kept-workspace notice that still shows; every other one shows no row. */
  readonly workspaceNotice: EngineEventOf<'warning'> | undefined;
  /** The activity of each call that has ended. */
  readonly endedActivity: ReadonlySet<EngineEvent>;
}

/** One section as its events read it. */
export interface WalkSection {
  readonly section: Section<EngineEvent>;
  readonly review: ReviewStage | undefined;
  /** The header of a settled brief, which its settled row states. */
  readonly started: EngineEventOf<'task_started'> | undefined;
  /** The last header of each brief: an earlier one on another worker reads as history. */
  readonly latestHeaders: ReadonlyMap<string, EngineEventOf<'task_started'>>;
}
