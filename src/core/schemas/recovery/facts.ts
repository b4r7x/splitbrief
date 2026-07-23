import type { RecoveryFact } from './schemas.js';

export function recoveryFactString(
  facts: Record<string, RecoveryFact> | undefined,
  key: string,
): string | undefined {
  const value = facts?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function recoveryFactNumber(
  facts: Record<string, RecoveryFact> | undefined,
  key: string,
): number | undefined {
  const value = facts?.[key];
  return typeof value === 'number' ? value : undefined;
}

export function recoveryFactBoolean(
  facts: Record<string, RecoveryFact> | undefined,
  key: string,
): boolean | undefined {
  const value = facts?.[key];
  return typeof value === 'boolean' ? value : undefined;
}
