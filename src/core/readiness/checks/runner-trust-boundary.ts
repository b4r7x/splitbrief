import type { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../config/accessors/reviewer-runner.js';
import { resolveApproveLevel } from '../../config/runtime/resolve.js';
import {
  CLI_TOOL_CATALOG,
  type CliPlannerTier2FullEscalationTrust,
  type RunnerTrustMetadata,
} from '../../runners/cli-tool-catalog.js';
import { runnerRoleForActiveRole, type ActiveRunnerRole } from '../../runners/seat-roles.js';
import { getRunnerTrustMeta } from '../../runners/trust.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import {
  DEFAULT_REDACTION_MARKER,
  isCredentialEnvironmentName,
  redactSecrets,
} from '../../../utils/redact.js';
import { formatRunner } from './runner-label.js';

export function buildRunnerTrustBoundaryChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
  interaction: 'interactive' | 'headless' | undefined,
): ReadinessCheck[] {
  const approve = resolveApproveLevel(config);
  // A headless run has nobody at the plan card, so it approves the card unattended.
  const planAutoApproved = approve === 'none' || interaction === 'headless';

  const checks: ReadinessCheck[] = [];
  checks.push(
    ...runnerTrustBoundaryCheck({
      id: 'runners.planner.trust-boundary',
      role: 'planner',
      label: `Planner ${formatRunner(config.planner)}`,
      trust: getRunnerTrustMeta('planner', config.planner),
      ...(config.planner.kind === 'cli' && {
        plannerTier2FullEscalation:
          CLI_TOOL_CATALOG[config.planner.tool].plannerTier2FullEscalation,
      }),
      runner: config.planner,
      approve,
      planAutoApproved,
    }),
  );

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    checks.push(
      ...runnerTrustBoundaryCheck({
        id: 'runners.reviewer.trust-boundary',
        role: 'reviewer',
        label: `Reviewer ${formatRunner(reviewer.runner)}`,
        trust: getRunnerTrustMeta(runnerRoleForActiveRole('reviewer'), reviewer.runner),
        runner: reviewer.runner,
        approve,
        planAutoApproved,
      }),
    );
  }

  for (const profile of profiles) {
    checks.push(
      ...runnerTrustBoundaryCheck({
        id: 'runners.implementer.trust-boundary',
        role: 'implementer',
        label: profile.isDefault
          ? `Default implementer ${formatRunner(profile.config)}`
          : `Implementer profile ${profile.name} ${formatRunner(profile.config)}`,
        profile: profile.name,
        trust: getRunnerTrustMeta('implementer', profile.config),
        runner: profile.config,
        approve,
        planAutoApproved,
      }),
    );
  }

  return checks;
}

/**
 * The command a project config names is the whole disclosure, so it is printed
 * verbatim — control-stripped first so it cannot repaint the report or hide a
 * credential from the redactor, then redacted so a key written into argv is
 * not republished by `doctor --json`.
 */
function declaredCommandDetails(runner: Config['planner'] | Config['implementer']): string[] {
  if (runner.kind !== 'shell' && runner.kind !== 'agent') return [];
  const argv = runner.args ?? [];
  return [
    `Command: ${safeCommandText(runner.command)}`,
    `Arguments: ${argv.length === 0 ? '(none)' : redactedArgv(argv)}`,
  ];
}

function safeCommandText(value: string): string {
  return redactSecrets(stripTerminalControls(value));
}

/**
 * `redactSecrets` only sees one argv element at a time, so it cannot tell that
 * the value after `--token` is the token. Anything following a credential-named
 * flag is withheld regardless of shape.
 */
function redactedArgv(argv: readonly string[]): string {
  return argv
    .map((value, index) => {
      const flag = argv[index - 1];
      return flag !== undefined && isCredentialEnvironmentName(flag.replace(/^-+/, ''))
        ? DEFAULT_REDACTION_MARKER
        : safeCommandText(value);
    })
    .join(' ');
}

function trustBoundarySummary(
  opts: Readonly<{
    label: string;
    approvalAutomationActive: boolean;
    autoAllowFlags: boolean;
    tier2FullEscalationWritesFiles: boolean;
  }>,
): string {
  if (opts.tier2FullEscalationWritesFiles) {
    const automationActive = opts.approvalAutomationActive || opts.autoAllowFlags;
    return `${opts.label} can execute commands and may write files during tier-2 full escalation${automationActive ? ' with approval automation active' : ''}.`;
  }
  if (opts.approvalAutomationActive) {
    return `${opts.label} can execute commands while approval automation is active.`;
  }
  if (opts.autoAllowFlags) {
    return `${opts.label} can execute commands and uses auto/allow runner flags.`;
  }
  return `${opts.label} can execute commands on this machine.`;
}

// This warning describes what the configured runner is able to do, which does
// not change with the approval level. Suppressing it under a stricter approval
// setting made the most cautious configuration the quietest report.
function runnerTrustBoundaryCheck(opts: {
  id: string;
  role: ActiveRunnerRole;
  label: string;
  profile?: string | undefined;
  trust: RunnerTrustMetadata;
  plannerTier2FullEscalation?: CliPlannerTier2FullEscalationTrust | undefined;
  runner: Config['planner'] | Config['implementer'];
  approve: string;
  planAutoApproved: boolean;
}): ReadinessCheck[] {
  if (!opts.trust.executesLocalCommand && opts.trust.autoAllowFlags.length === 0) return [];

  const details = [
    ...declaredCommandDetails(opts.runner),
    `Plan approval: ${opts.approve}.`,
    'Only a write to a protected path asks.',
    'SPLITBRIEF approval gates review the plan and declared/promoted file writes; they do not sandbox shell commands or network access inside external runners.',
  ];
  if (opts.planAutoApproved) {
    details.push('Approval automation: plan approval is auto-approved.');
  }
  if (opts.trust.autoAllowFlags.length > 0) {
    details.push(`Runner auto/allow flags: ${opts.trust.autoAllowFlags.join(', ')}`);
  }
  if (opts.trust.mayWriteFilesDirectly) {
    details.push('Runner may write project files directly.');
  }
  if (opts.plannerTier2FullEscalation !== undefined) {
    details.push(
      'Ordinary planning does not write project files directly.',
      'Tier-2 full escalation may write project files directly after implementer failure.',
    );
    if (opts.plannerTier2FullEscalation.autoAllowFlags.length > 0) {
      details.push(
        `Tier-2 runner auto/allow flags: ${opts.plannerTier2FullEscalation.autoAllowFlags.join(', ')}`,
      );
    }
  }

  return [
    {
      id: opts.id,
      severity: 'warning',
      summary: trustBoundarySummary({
        label: opts.label,
        approvalAutomationActive: opts.planAutoApproved,
        autoAllowFlags:
          opts.trust.autoAllowFlags.length > 0 ||
          (opts.plannerTier2FullEscalation?.autoAllowFlags.length ?? 0) > 0,
        tier2FullEscalationWritesFiles:
          opts.plannerTier2FullEscalation?.mayWriteFilesDirectly === true,
      }),
      details,
      metadata: {
        role: opts.role,
        ...(opts.profile !== undefined && { profile: opts.profile }),
        kind: opts.runner.kind,
        approve: opts.approve,
        executesLocalCommand: opts.trust.executesLocalCommand,
        mayUseNetwork: opts.trust.mayUseNetwork,
        mayWriteFilesDirectly: opts.trust.mayWriteFilesDirectly,
        autoAllowFlags: [...opts.trust.autoAllowFlags],
        ...(opts.plannerTier2FullEscalation !== undefined && {
          plannerTier2FullEscalation: {
            mayWriteFilesDirectly: opts.plannerTier2FullEscalation.mayWriteFilesDirectly,
            automaticApproval: opts.plannerTier2FullEscalation.autoAllowFlags.length > 0,
            autoAllowFlags: [...opts.plannerTier2FullEscalation.autoAllowFlags],
          },
        }),
      },
    },
  ];
}
