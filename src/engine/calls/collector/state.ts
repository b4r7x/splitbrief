import {
  RUNNER_CALL_WARNING_MAX_ITEMS,
  runnerCallItemLimit,
  runnerCallLimitWarning,
  type createRunnerCallDeltaLimiter,
  type RunnerCallOutputLimit,
} from '../output-limit.js';
import {
  appendStderrPreview,
  stderrDiagnosticWarning,
  stderrLooksWarningLike,
} from '../stderr-diagnostics.js';
import type {
  RunnerCallContext,
  RunnerCallUsage,
  RunnerCallResult,
  RunnerCallWarning,
  RunnerCallError,
  RunnerCallStatus,
} from '../types.js';
import { normalizeRunnerCallWarning } from '../warnings.js';

export interface RunnerCallCollectionState {
  context: RunnerCallContext | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  text: string;
  usage: RunnerCallUsage | null;
  nativeSessionId: string | null;
  structured?: unknown;
  toolUses: RunnerCallResult['toolUses'];
  artifacts: RunnerCallResult['artifacts'];
  warnings: RunnerCallWarning[];
  error: RunnerCallError | null;
  partial: boolean | null;
  terminalStatus: RunnerCallStatus | null;
  emittedLimitWarningCodes: Set<string>;
  stderrLimiter: ReturnType<typeof createRunnerCallDeltaLimiter>;
  stderrPreview: string;
  stderrWarningEmitted: boolean;
  artifactCount: number;
  warningCount: number;
  unknownUpstreamCount: number;
}

export function appendWarning(
  state: RunnerCallCollectionState,
  warning: Parameters<typeof normalizeRunnerCallWarning>[0],
): void {
  const isLimitWarning =
    warning.source === 'system' &&
    warning.code.startsWith('runner_call_') &&
    warning.code.endsWith('_limit');
  if (state.warningCount >= RUNNER_CALL_WARNING_MAX_ITEMS && !isLimitWarning) {
    noteLimit(
      state,
      runnerCallItemLimit({
        code: 'runner_call_warning_count_limit',
        label: 'warnings',
        maxItems: RUNNER_CALL_WARNING_MAX_ITEMS,
      }),
    );
    return;
  }
  const normalized = normalizeRunnerCallWarning(warning);
  if (normalized.source === 'stderr') state.stderrWarningEmitted = true;
  if (!isLimitWarning) state.warningCount += 1;
  state.warnings.push(normalized);
}

export function noteLimit(state: RunnerCallCollectionState, limit: RunnerCallOutputLimit): void {
  if (state.emittedLimitWarningCodes.has(limit.code)) return;
  state.emittedLimitWarningCodes.add(limit.code);
  appendWarning(state, runnerCallLimitWarning(limit));
}

export function applyStderrEvent(state: RunnerCallCollectionState, text: string): void {
  const accepted = state.stderrLimiter.accept(text);
  if (accepted.text.length > 0) {
    state.stderrPreview = appendStderrPreview(state.stderrPreview, accepted.text);
    if (stderrLooksWarningLike(accepted.text)) {
      emitStderrDiagnosticWarning(state, 'stderr_diagnostic', accepted.text);
    }
  }
  if (accepted.limit !== null) noteLimit(state, accepted.limit);
}

function emitStderrDiagnosticWarning(
  state: RunnerCallCollectionState,
  code: string,
  message: string,
): void {
  if (state.stderrWarningEmitted) return;
  state.stderrWarningEmitted = true;
  appendWarning(state, stderrDiagnosticWarning(code, message));
}

export function emitStderrFailureWarning(state: RunnerCallCollectionState): void {
  if (state.stderrPreview.trim().length === 0) return;
  emitStderrDiagnosticWarning(state, 'stderr_on_failure', state.stderrPreview);
}
