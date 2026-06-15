import { validateSafeIdentifier } from '../../utils/validate-identifier.js';

export type HandoffTarget = 'spec-kit' | 'agents-md' | 'claude-code' | 'copilot-issue';

export const HANDOFF_TARGETS: readonly HandoffTarget[] = [
  'spec-kit',
  'agents-md',
  'claude-code',
  'copilot-issue',
];

const HANDOFF_TARGET_ALIASES: Record<string, HandoffTarget> = { speckit: 'spec-kit' };

export function normalizeHandoffTarget(value: string): string {
  return HANDOFF_TARGET_ALIASES[value] ?? value;
}

export function parseHandoffTarget(value: string): HandoffTarget | null {
  const normalized = normalizeHandoffTarget(value);
  return HANDOFF_TARGETS.find((target) => target === normalized) ?? null;
}

export function validateHandoffTargetName(
  target: string,
): { ok: true } | { ok: false; reason: string } {
  return validateSafeIdentifier(target);
}
