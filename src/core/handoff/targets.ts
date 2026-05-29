import { validateSafeIdentifier } from '../../utils/validate-identifier.js';

export type HandoffTarget = 'spec-kit' | 'agents-md' | 'claude-code' | 'copilot-issue';

export const HANDOFF_TARGETS: readonly HandoffTarget[] = [
  'spec-kit',
  'agents-md',
  'claude-code',
  'copilot-issue',
];

export function parseHandoffTarget(value: string): HandoffTarget | null {
  return HANDOFF_TARGETS.find((target) => target === value) ?? null;
}

export function validateHandoffTargetName(
  target: string,
): { ok: true } | { ok: false; reason: string } {
  return validateSafeIdentifier(target);
}
