import type { EngineEventOf } from '../../../../engine/events/types.js';
import type { ModelCacheAccessor } from '../../../../engine/providers/model/resolution.js';
import type { ActivityDisplayValueFit } from '../activity-text.js';

export type RunnerActivityLedgerTone = 'info' | 'success' | 'warning' | 'error' | 'textDim';
export type RunnerActivitySeverity = 'info' | 'warning' | 'error';

export interface RunnerActivityDisplayInput {
  activityId?: string | undefined;
  stage: EngineEventOf<'runner_call_activity'>['stage'];
  kind: Exclude<EngineEventOf<'runner_call_activity'>['kind'], 'session'>;
  label: string;
  target?: string | undefined;
  description?: string | undefined;
  moreLines?: number | undefined;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
  rawAvailable?: boolean | undefined;
  redacted?: boolean | undefined;
  role?: EngineEventOf<'runner_call_activity'>['role'] | undefined;
  phase?: EngineEventOf<'runner_call_activity'>['phase'] | undefined;
  runnerName?: string | undefined;
  model?: string | undefined;
  backendKind?: EngineEventOf<'runner_call_activity'>['backendKind'] | undefined;
  /** Raw model ids a fallback or refusal warning named, when its frame carried them. */
  originalModel?: string | undefined;
  fallbackModel?: string | undefined;
}

export interface RunnerActivityDisplayOptions {
  /**
   * The catalog the row resolves raw warning model ids against. Production
   * leaves it unset and reads the live model cache; tests pin their own
   * accessor so a resolution case never depends on a machine's own catalogs.
   */
  cache?: ModelCacheAccessor | undefined;
}

export interface RunnerActivityLedgerItem {
  visibleKey: string;
  groupingKey: string;
  label: RunnerActivityLedgerLabel;
  groupLabel: string;
  value: string;
  tone: RunnerActivityLedgerTone;
  valueTone: RunnerActivityLedgerTone;
  fitMode: ActivityDisplayValueFit;
  severity: RunnerActivitySeverity;
  rawMarker: string | null;
  diagnosticPreview: string | null;
}

export type RunnerActivityLedgerLabel =
  | 'RUN'
  | 'READ'
  | 'EDIT'
  | 'FIND'
  | 'CALL'
  | 'PLAN'
  | 'AGENT'
  | 'ART'
  | 'WARN'
  | 'ERR'
  | 'STOP'
  | 'LIST';
