import type {
  ReadinessCheck,
  ReadinessCounts,
  ReadinessNextAction,
  ReadinessNextActionKind,
  ReadinessSection,
  ReadinessStatus,
} from './types.js';

const EMPTY_COUNTS: ReadinessCounts = {
  ok: 0,
  info: 0,
  warning: 0,
  blocker: 0,
};

const NEXT_ACTION_LABELS: Record<ReadinessNextActionKind, { label: string; command?: string | undefined }> = {
  continue: { label: 'Continue' },
  'run-init': { label: 'Run init', command: 'diptych init' },
  'fix-config': { label: 'Fix config' },
  'clean-or-isolate-repo': { label: 'Clean or isolate repo' },
  'raise-context': { label: 'Raise context' },
  'set-budget': { label: 'Set budget' },
  exit: { label: 'Exit' },
};

const NEXT_ACTION_PRIORITY: ReadinessNextActionKind[] = [
  'fix-config',
  'run-init',
  'clean-or-isolate-repo',
  'raise-context',
  'set-budget',
  'continue',
  'exit',
];

export function flattenReadinessChecks(sections: ReadinessSection[]): ReadinessCheck[] {
  return sections.flatMap(section => section.checks);
}

export function countReadinessChecks(checks: ReadinessCheck[]): ReadinessCounts {
  const counts: ReadinessCounts = { ...EMPTY_COUNTS };
  for (const check of checks) {
    counts[check.severity] += 1;
  }
  return counts;
}

export function aggregateReadinessStatus(counts: ReadinessCounts): ReadinessStatus {
  if (counts.blocker > 0) return 'blocked';
  if (counts.warning > 0) return 'ready-with-warnings';
  return 'ready';
}

export function selectNextAction(checks: ReadinessCheck[], status: ReadinessStatus): ReadinessNextAction {
  const actionableChecks = checks.filter(check => check.nextAction !== undefined);
  const selectedKind = NEXT_ACTION_PRIORITY.find(kind =>
    actionableChecks.some(check => check.nextAction === kind),
  ) ?? (status === 'blocked' ? 'exit' : 'continue');

  const selectedCheck = actionableChecks.find(check => check.nextAction === selectedKind);
  const label = NEXT_ACTION_LABELS[selectedKind];
  return {
    kind: selectedKind,
    label: label.label,
    reason: selectedCheck?.summary ?? defaultReason(selectedKind, status),
    ...(label.command !== undefined && { command: label.command }),
  };
}

function defaultReason(kind: ReadinessNextActionKind, status: ReadinessStatus): string {
  if (kind === 'continue') {
    return status === 'ready' ? 'No readiness blockers found.' : 'Only warnings were found.';
  }
  if (kind === 'exit') return 'A readiness blocker must be resolved before starting.';
  return 'Review readiness report.';
}
