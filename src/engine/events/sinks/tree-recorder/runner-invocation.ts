import type { EngineEventOf } from '../../types.js';
import type { AgentInvocationPayload } from '../../../../core/sessions/tree/payloads.js';

export const MAX_RUNNER_TREE_WARNING_CODES = 64;

interface RunnerWarningSummary {
  count: number;
  codes: Set<string>;
}

export type RunnerInvocationState = {
  recordRunnerWarning: (event: EngineEventOf<'runner_call_warning'>) => void;
  runnerWarningFields: (
    callId: string,
  ) => Pick<AgentInvocationPayload, 'warningCount' | 'warningCodes'>;
  clearRunnerWarnings: (callId: string) => void;
};

export function createRunnerInvocationState(): RunnerInvocationState {
  const runnerWarnings = new Map<string, RunnerWarningSummary>();

  function recordRunnerWarningCode(codes: Set<string>, code: string): void {
    if (codes.has(code)) return;
    if (codes.size < MAX_RUNNER_TREE_WARNING_CODES) {
      codes.add(code);
      return;
    }

    let largest: string | undefined;
    for (const existing of codes) {
      if (largest === undefined || existing > largest) largest = existing;
    }
    if (largest !== undefined && code < largest) {
      codes.delete(largest);
      codes.add(code);
    }
  }

  return {
    recordRunnerWarning(event) {
      const existing = runnerWarnings.get(event.callId) ?? { count: 0, codes: new Set<string>() };
      existing.count += 1;
      recordRunnerWarningCode(existing.codes, event.warning.code);
      runnerWarnings.set(event.callId, existing);
    },
    runnerWarningFields(callId) {
      const summary = runnerWarnings.get(callId);
      if (summary === undefined || summary.count === 0) return {};
      return {
        warningCount: summary.count,
        warningCodes: Array.from(summary.codes).sort().slice(0, MAX_RUNNER_TREE_WARNING_CODES),
      };
    },
    clearRunnerWarnings(callId) {
      runnerWarnings.delete(callId);
    },
  };
}

export function runnerStartedPayload(
  event: EngineEventOf<'runner_call_started'>,
): AgentInvocationPayload {
  return {
    callId: event.callId,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    role: event.role,
    backendKind: event.backendKind,
    tool: event.runnerName ?? event.backendKind,
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
    phase: event.phase,
    status: 'started',
    startedAt: event.ts,
  };
}

export function runnerTerminalPayload(
  event: EngineEventOf<'runner_call_completed'> | EngineEventOf<'runner_call_error'>,
  warnings: Pick<AgentInvocationPayload, 'warningCount' | 'warningCodes'>,
): AgentInvocationPayload {
  return {
    callId: event.callId,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    role: event.role,
    backendKind: event.backendKind,
    tool: event.runnerName ?? event.backendKind,
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
    phase: event.phase,
    status: event.status,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    durationMs: event.durationMs,
    usage: event.usage,
    partial: event.partial,
    ...warnings,
    ...(event.type === 'runner_call_error' && { errorCode: event.error.code }),
  };
}
