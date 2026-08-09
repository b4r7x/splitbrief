import type {
  ReadinessCheck,
  ReadinessCounts,
  ReadinessNextAction,
  ReadinessReport,
  ReadinessSection,
} from './types.js';
import { CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';
import {
  cliReadinessCheckId,
  type ReadinessNextActionKind,
  type ReadinessStatus,
} from '../schemas/readiness.js';

const EMPTY_COUNTS: ReadinessCounts = {
  ok: 0,
  info: 0,
  warning: 0,
  blocker: 0,
};

const NEXT_ACTION_LABELS: Record<
  ReadinessNextActionKind,
  { label: string; command?: string | undefined }
> = {
  continue: { label: 'Continue' },
  'run-init': { label: 'Run init', command: 'splitbrief init' },
  'fix-config': { label: 'Fix config' },
  'prepare-runner': { label: 'Set up the configured runner' },
  'clean-or-isolate-repo': { label: 'Clean or isolate repo' },
  'raise-context': { label: 'Raise context' },
  'set-budget': { label: 'Set budget' },
  exit: { label: 'Exit' },
};

const NEXT_ACTION_PRIORITY: ReadinessNextActionKind[] = [
  'fix-config',
  'run-init',
  'prepare-runner',
  'clean-or-isolate-repo',
  'raise-context',
  'set-budget',
  'continue',
  'exit',
];

const CLI_READINESS_CHECK_IDS: ReadonlySet<string> = new Set(
  CLI_TOOL_IDS.map((tool) => cliReadinessCheckId(tool)),
);

export function flattenReadinessChecks(sections: ReadinessSection[]): ReadinessCheck[] {
  return sections.flatMap((section) => section.checks);
}

/**
 * Readiness checks for configured CLI runners whose probe did not reach
 * `ready`. Only a `ready` probe yields a trusted start gate, so a run started
 * with any of these has no trusted executable identity and the orchestrator
 * refuses it at init. Start must refuse here instead — even when the check is
 * only a warning — and each check already carries the tool's remediation.
 */
export function ungatedCliReadinessChecks(report: ReadinessReport): ReadinessCheck[] {
  return flattenReadinessChecks(report.sections).filter(
    (check) => CLI_READINESS_CHECK_IDS.has(check.id) && check.metadata?.status !== 'ready',
  );
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

export function selectNextAction(
  checks: ReadinessCheck[],
  status: ReadinessStatus,
): ReadinessNextAction {
  if (status !== 'blocked') {
    return {
      kind: 'continue',
      label: NEXT_ACTION_LABELS.continue.label,
      reason: defaultReason('continue', status),
    };
  }

  const actionableChecks = checks.filter(
    (check) => check.severity === 'blocker' && check.nextAction !== undefined,
  );
  const selectedKind =
    NEXT_ACTION_PRIORITY.find((kind) =>
      actionableChecks.some((check) => check.nextAction === kind),
    ) ?? 'exit';

  const selectedCheck = actionableChecks.find((check) => check.nextAction === selectedKind);
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
