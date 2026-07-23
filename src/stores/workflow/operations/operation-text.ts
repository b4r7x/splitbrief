import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';

export function durationBetween(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

export function cleanOptionalOperationText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = cleanOperationText(value);
  return clean.length === 0 ? undefined : clean;
}

export function cleanOperationReason(value: string | null): string | null {
  if (value === null) return null;
  return cleanOperationText(value);
}

export function cleanOperationText(value: string): string {
  return sanitizeTerminalDisplayText(value);
}
