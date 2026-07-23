import type { EngineEventOf } from '../../../engine/events/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import { cleanOperationText } from './operation-text.js';
import type { OperationWarningGroup, OperationWarningSeverity } from './state.js';

const MAX_WARNINGS = 20;

export function appendWarning(
  warnings: readonly OperationWarningGroup[],
  warning: EngineEventOf<'runner_call_warning'>['warning'],
  ts: number,
): readonly OperationWarningGroup[] {
  const latestMessage = cleanOperationText(warning.message);
  if (latestMessage.length === 0) return warnings;
  const code = cleanOperationText(warning.code);
  const source = cleanOperationText(warning.source);
  const warningKey = operationWarningGroupKey({
    fingerprint: warning.fingerprint,
    code,
    source,
    surface: warning.surface,
  });

  const existingIndex = warnings.findIndex((item) => operationWarningGroupKey(item) === warningKey);
  if (existingIndex === -1) {
    return [
      ...warnings,
      {
        code,
        severity: warning.severity,
        source,
        surface: warning.surface,
        fingerprint: warning.fingerprint,
        count: 1,
        firstTs: ts,
        lastTs: ts,
        latestMessage,
      },
    ].slice(-MAX_WARNINGS);
  }

  const existing = warnings[existingIndex];
  if (existing === undefined) return warnings;
  return warnings.map((item, index) =>
    index === existingIndex
      ? {
          ...item,
          severity: maxWarningSeverity(item.severity, warning.severity),
          count: item.count + 1,
          lastTs: ts,
          latestMessage,
        }
      : item,
  );
}

export function showsWarningOnPrimarySurface(
  warning: EngineEventOf<'runner_call_warning'>['warning'],
): boolean {
  switch (warning.surface) {
    case 'activity':
    case 'status':
    case 'transcript':
      return true;
    case 'debug':
    case 'hidden':
      return false;
    default:
      return assertNever(warning.surface);
  }
}

function operationWarningGroupKey(
  warning: Pick<OperationWarningGroup, 'fingerprint' | 'code' | 'source' | 'surface'>,
): string {
  return `${warning.fingerprint}\0${warning.code}\0${warning.source}\0${warning.surface}`;
}

function maxWarningSeverity(
  current: OperationWarningSeverity,
  next: OperationWarningSeverity,
): OperationWarningSeverity {
  return warningSeverityRank(next) > warningSeverityRank(current) ? next : current;
}

function warningSeverityRank(severity: OperationWarningSeverity): number {
  switch (severity) {
    case 'debug':
      return 0;
    case 'info':
      return 1;
    case 'warning':
      return 2;
    case 'error':
      return 3;
    default:
      return assertNever(severity);
  }
}
