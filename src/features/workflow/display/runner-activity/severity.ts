import { assertNever } from '../../../../utils/type-guards.js';
import type {
  RunnerActivityDisplayInput,
  RunnerActivitySeverity,
  RunnerActivityLedgerTone,
} from './types.js';

export function runnerActivitySeverity(
  input: RunnerActivityDisplayInput,
  opts: { interrupted: boolean },
): RunnerActivitySeverity {
  if (opts.interrupted) return 'warning';
  if (input.kind === 'error') return 'error';
  if (input.kind === 'warning') return 'warning';

  switch (input.stage) {
    case 'failed':
    case 'timeout':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return 'error';
    case 'warning':
    case 'aborted':
      return 'warning';
    case 'started':
    case 'updated':
    case 'completed':
      return 'info';
    default:
      return assertNever(input.stage);
  }
}

export function severityTone(severity: RunnerActivitySeverity): RunnerActivityLedgerTone {
  switch (severity) {
    case 'info':
      return 'info';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return assertNever(severity);
  }
}

export function valueTone(
  stage: RunnerActivityDisplayInput['stage'],
  severity: RunnerActivitySeverity,
): RunnerActivityLedgerTone {
  if (severity !== 'info') return severity;
  switch (stage) {
    case 'completed':
      return 'textDim';
    case 'started':
    case 'updated':
      return 'textDim';
    case 'warning':
    case 'aborted':
      return 'warning';
    case 'failed':
    case 'timeout':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return 'error';
    default:
      return assertNever(stage);
  }
}
