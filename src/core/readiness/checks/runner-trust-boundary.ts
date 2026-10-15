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
import type { ReadinessCheck, SeatNamer } from '../types.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import {
  DEFAULT_REDACTION_MARKER,
  isCredentialEnvironmentName,
  redactSecrets,
} from '../../../utils/redact.js';
import { planApprovalCopy } from './plan-approval.js';

export function buildRunnerTrustBoundaryChecks({
  config,
  profiles,
  interaction,
  nameSeat,
}: {
  config: Config;
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'];
  interaction: 'interactive' | 'headless' | undefined;
  nameSeat: SeatNamer;
}): ReadinessCheck[] {
  const approve = resolveApproveLevel(config);
  const approval = planApprovalCopy(config, interaction);

  const checks: ReadinessCheck[] = [];
  checks.push(
    ...runnerTrustBoundaryCheck({
      id: 'runners.planner.trust-boundary',
      role: 'planner',
      label: `PLAN ${nameSeat(config.planner, 'planner')}`,
      trust: getRunnerTrustMeta('planner', config.planner),
      ...(config.planner.kind === 'cli' && {
        plannerTier2FullEscalation:
          CLI_TOOL_CATALOG[config.planner.tool].plannerTier2FullEscalation,
      }),
      runner: config.planner,
      approve,
      approval,
    }),
  );

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    checks.push(
      ...runnerTrustBoundaryCheck({
        id: 'runners.reviewer.trust-boundary',
        role: 'reviewer',
        label: `REVIEW ${nameSeat(reviewer.runner, 'reviewer')}`,
        trust: getRunnerTrustMeta(runnerRoleForActiveRole('reviewer'), reviewer.runner),
        runner: reviewer.runner,
        approve,
        approval,
      }),
    );
  }

  for (const profile of profiles) {
    checks.push(
      ...runnerTrustBoundaryCheck({
        id: 'runners.implementer.trust-boundary',
        role: 'implementer',
        label: profile.isDefault
          ? `BUILD ${nameSeat(profile.config, 'implementer')}`
          : `BUILD ${profile.name} ${nameSeat(profile.config, 'implementer')}`,
        profile: profile.name,
        trust: getRunnerTrustMeta('implementer', profile.config),
        runner: profile.config,
        approve,
        approval,
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
  approval: ReturnType<typeof planApprovalCopy>;
}): ReadinessCheck[] {
  if (!opts.trust.executesLocalCommand && opts.trust.autoAllowFlags.length === 0) return [];

  const details = [
    ...declaredCommandDetails(opts.runner),
    opts.approval.summary,
    ...(opts.approval.details ?? []),
    'Writes to protected files ask for confirmation.',
    'Plan approval and file confirmations do not restrict the commands or network access of your coding tools.',
  ];
  if (opts.trust.autoAllowFlags.length > 0) {
    details.push(`Tool permission flags: ${opts.trust.autoAllowFlags.join(', ')}`);
  }
  if (opts.trust.mayWriteFilesDirectly) {
    details.push('This tool can edit files in the run workspace.');
  }
  if (opts.plannerTier2FullEscalation !== undefined) {
    details.push(
      'Ordinary planning does not edit project files.',
      'If BUILD cannot finish a task, PLAN may take over and edit files in the run workspace.',
    );
    if (opts.plannerTier2FullEscalation.autoAllowFlags.length > 0) {
      details.push(
        `Permission flags when PLAN takes over: ${opts.plannerTier2FullEscalation.autoAllowFlags.join(', ')}`,
      );
    }
  }

  return [
    {
      id: opts.id,
      severity: 'warning',
      summary: `${opts.label} can run commands on this machine${opts.plannerTier2FullEscalation?.mayWriteFilesDirectly === true ? ' and may edit files if BUILD needs help' : ''}.`,
      details,
      fix: `Use coding tools you trust. To change this seat, open Settings > Crew > ${opts.role === 'planner' ? 'PLAN' : opts.role === 'reviewer' ? 'REVIEW' : 'BUILD'}.`,
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
