const IMPLEMENTER_PHASES: ReadonlySet<string> = new Set(['implementing', 'validating-task']);

export function phaseRole(phase: string): 'planner' | 'implementer' {
  if (IMPLEMENTER_PHASES.has(phase)) return 'implementer';
  return 'planner';
}
