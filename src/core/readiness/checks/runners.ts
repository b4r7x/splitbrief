import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../config/accessors/runner-config.js';
import { resolveApproveLevel, resolveMode } from '../../config/runtime/resolve.js';
import { isAutomaticModel } from '../../providers/automatic-model.js';
import {
  CLI_TOOL_CATALOG,
  type CliToolId,
  type RunnerTrustMetadata,
} from '../../runners/cli-tool-catalog.js';
import type { Config } from '../../schemas/config.js';
import {
  cliReadinessCheckId,
  type CliReadinessResult,
  type ReadinessDiagnosticStateId,
  type ReadinessModelSelection,
} from '../../schemas/readiness.js';
import { getRunnerTrustMeta, RUNNER_IDLE_KILL_MS } from '../../schemas/runner-fields.js';
import type { ReadinessCheck } from '../types.js';
import { formatRoleLabel } from '../../phase-display.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

const REDACTED_EXECUTABLE_PATH = '[redacted executable path]';

/**
 * Readiness keeps the trusted identity for the start gate, but diagnostics are
 * public output (including `doctor --json`). Never publish the identity path.
 */
function diagnosticExecutablePath(result: CliReadinessResult): string | null {
  return result.executable === null ? null : REDACTED_EXECUTABLE_PATH;
}

function modelSelection(
  runner: Config['planner'] | Config['implementer'],
): ReadinessModelSelection {
  if (isAutomaticModel(runner.model, getRunnerDisplayName(runner))) return 'auto';
  return runner.model === undefined ? 'unset' : 'explicit';
}

// A CLI runner in automatic mode has no resolved model — the harness picks it —
// so report the configured intent rather than leaving it indistinguishable from
// an unset model.
function formatRunner(runner: Config['planner'] | Config['implementer']): string {
  const displayName = getRunnerDisplayName(runner);
  const model = getRunnerModelName(runner);
  if (model) return `${displayName} (${model})`;
  return modelSelection(runner) === 'auto' ? `${displayName} (auto)` : displayName;
}

export function buildRunnerChecks(
  config: Config,
  cliReadiness: readonly CliReadinessResult[] = [],
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const configuredCliTools = new Set<CliToolId>();
  if (config.planner.kind === 'cli') configuredCliTools.add(config.planner.tool);
  checks.push(runnerCheck('planner', config.planner));

  try {
    const resolved = resolveImplementerProfiles(config);
    const defaultProfile = resolved.defaultProfile;
    checks.push({
      id: 'runners.implementer.default',
      severity: 'info',
      summary: `Default implementer ${formatRunner(defaultProfile.config)} via profile ${defaultProfile.name}.`,
      details: [
        `Profiles: ${resolved.profiles.map((profile) => profile.name).join(', ')}`,
        `Cost tier: ${defaultProfile.costTier}`,
        `Write mode: ${defaultProfile.capabilities.writesFiles}`,
      ],
      metadata: {
        defaultProfile: defaultProfile.name,
        profileCount: resolved.profiles.length,
        costTier: defaultProfile.costTier,
        writeMode: defaultProfile.capabilities.writesFiles,
      },
    });
    checks.push(...buildImplementerProfileMetadataChecks(config, resolved.profiles));
    checks.push(...buildRunnerTrustBoundaryChecks(config, resolved.profiles));
    checks.push(...buildWatchdogTimeoutChecks(config, resolved.profiles));
    for (const profile of resolved.profiles) {
      if (profile.config.kind === 'cli') configuredCliTools.add(profile.config.tool);
    }
  } catch (err) {
    checks.push({
      id: 'runners.implementer.profiles-invalid',
      severity: 'blocker',
      summary: toErrorMessage(err),
      fix: 'Fix implementerProfiles.default or remove the broken profile setting.',
      nextAction: 'fix-config',
    });
  }

  checks.push(availabilityCheck());
  checks.push(...configuredCliReadinessChecks(configuredCliTools, cliReadiness));

  return checks;
}

function availabilityCheck(): ReadinessCheck {
  return {
    id: 'runners.availability',
    severity: 'info',
    summary: 'Provider availability was not probed.',
    details: [
      'CLI installation, trust, compatibility, and authentication use the selected runner readiness results.',
      'Readiness makes no provider or network availability claim.',
    ],
  };
}

function configuredCliReadinessChecks(
  configuredTools: ReadonlySet<CliToolId>,
  results: readonly CliReadinessResult[],
): ReadinessCheck[] {
  const resultsByTool = new Map(results.map((result) => [result.tool, result]));
  return [...configuredTools].map((tool) => {
    const result = resultsByTool.get(tool);
    return result ? cliReadinessCheck(result) : missingCliReadinessCheck(tool);
  });
}

function missingCliReadinessCheck(tool: CliToolId): ReadinessCheck {
  const descriptor = CLI_TOOL_CATALOG[tool];
  return {
    id: cliReadinessCheckId(tool),
    severity: 'blocker',
    summary: `${descriptor.displayName} has no current readiness probe result.`,
    fix: `Run runner readiness for ${tool}, then start again.`,
    metadata: {
      tool,
      status: 'unverified',
      installation: 'not-checked',
      trust: 'not-checked',
      compatibility: 'not-checked',
      auth: 'not-checked',
      executablePath: null,
    },
  };
}

function cliReadinessDiagnosticState(
  result: CliReadinessResult,
): ReadinessDiagnosticStateId | undefined {
  switch (result.status) {
    case 'unavailable':
      return 'missing-binary';
    case 'untrusted':
      return 'untrusted-path';
    case 'incompatible':
      return 'incompatible-version';
    case 'unauthenticated':
      return 'unauthenticated';
    case 'unverified':
      return result.auth === 'unknown' ? 'auth-unknown' : undefined;
    default:
      return undefined;
  }
}

function cliReadinessCheck(result: CliReadinessResult): ReadinessCheck {
  const descriptor = CLI_TOOL_CATALOG[result.tool];
  const severity =
    result.status === 'ready' ? 'ok' : result.status === 'unverified' ? 'warning' : 'blocker';
  const diagnosticState = cliReadinessDiagnosticState(result);
  return {
    id: result.checkId,
    severity,
    summary:
      result.status === 'ready'
        ? result.auth === 'not-required'
          ? `${descriptor.displayName} is installed, trusted, compatible, and does not require authentication.`
          : `${descriptor.displayName} is installed, trusted, compatible, and authenticated.`
        : `${descriptor.displayName} readiness is ${result.status}.`,
    ...(result.remediation !== null && { fix: result.remediation }),
    ...(diagnosticState !== undefined && { diagnosticState }),
    metadata: {
      tool: result.tool,
      status: result.status,
      installation: result.installation,
      trust: result.trust,
      installedVersion: result.installedVersion,
      testedVersion: result.testedVersion,
      compatibility: result.compatibility,
      auth: result.auth,
      executablePath: diagnosticExecutablePath(result),
      probedAt: result.probedAt,
    },
  };
}

function buildRunnerTrustBoundaryChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
): ReadinessCheck[] {
  const mode = resolveMode({ config });
  const approve = resolveApproveLevel({ mode, configApprove: config.workflow.approve });
  const specPlanAutoApproved = approve === 'none';
  const fileWriteApprovalDisabled = config.approval?.enabled === false;

  const checks: ReadinessCheck[] = [];
  checks.push(
    ...runnerTrustBoundaryCheck({
      id: 'runners.planner.trust-boundary',
      role: 'planner',
      label: `Planner ${formatRunner(config.planner)}`,
      trust: getRunnerTrustMeta('planner', config.planner),
      kind: config.planner.kind,
      approve,
      specPlanAutoApproved,
      fileWriteApprovalDisabled,
    }),
  );

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
        kind: profile.config.kind,
        approve,
        specPlanAutoApproved,
        fileWriteApprovalDisabled,
      }),
    );
  }

  return checks;
}

function runnerTrustBoundaryCheck(opts: {
  id: string;
  role: 'planner' | 'implementer';
  label: string;
  profile?: string | undefined;
  trust: RunnerTrustMetadata;
  kind: Config['planner']['kind'];
  approve: string;
  specPlanAutoApproved: boolean;
  fileWriteApprovalDisabled: boolean;
}): ReadinessCheck[] {
  if (!opts.trust.executesLocalCommand && opts.trust.autoAllowFlags.length === 0) return [];

  const approvalAutomationActive = opts.specPlanAutoApproved || opts.fileWriteApprovalDisabled;
  const autoAllowCommandRunner =
    opts.trust.executesLocalCommand && opts.trust.autoAllowFlags.length > 0;
  if (!approvalAutomationActive && !autoAllowCommandRunner) return [];

  const automation = [
    opts.specPlanAutoApproved ? 'spec/plan approval is auto-approved' : null,
    opts.fileWriteApprovalDisabled ? 'file-write approval prompts are disabled' : null,
  ].filter((entry): entry is string => entry !== null);
  const details = [
    `Spec/plan approval level: ${opts.approve}.`,
    `File-write approval prompts: ${opts.fileWriteApprovalDisabled ? 'disabled' : 'enabled'}.`,
    'SPLITBRIEF approval gates review spec/plan documents and declared/promoted file writes; they do not sandbox shell commands or network access inside external runners.',
  ];
  if (automation.length > 0) {
    details.push(`Approval automation: ${automation.join('; ')}.`);
  }
  if (opts.trust.autoAllowFlags.length > 0) {
    details.push(`Runner auto/allow flags: ${opts.trust.autoAllowFlags.join(', ')}`);
  }
  if (opts.trust.mayWriteFilesDirectly) {
    details.push('Runner may write project files directly.');
  }

  return [
    {
      id: opts.id,
      severity: 'warning',
      summary: approvalAutomationActive
        ? `${opts.label} can execute commands while approval automation is active.`
        : `${opts.label} can execute commands and uses auto/allow runner flags.`,
      details,
      metadata: {
        role: opts.role,
        ...(opts.profile !== undefined && { profile: opts.profile }),
        kind: opts.kind,
        approve: opts.approve,
        executesLocalCommand: opts.trust.executesLocalCommand,
        mayUseNetwork: opts.trust.mayUseNetwork,
        mayWriteFilesDirectly: opts.trust.mayWriteFilesDirectly,
        autoAllowFlags: [...opts.trust.autoAllowFlags],
        fileWriteApprovalEnabled: !opts.fileWriteApprovalDisabled,
      },
    },
  ];
}

function buildWatchdogTimeoutChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  checks.push(
    ...watchdogTimeoutCheck({
      id: 'runners.planner.timeout-disables-watchdog',
      label: `Planner ${formatRunner(config.planner)}`,
      runner: config.planner,
    }),
  );

  for (const profile of profiles) {
    checks.push(
      ...watchdogTimeoutCheck({
        id: 'runners.implementer.timeout-disables-watchdog',
        label: profile.isDefault
          ? `Default implementer ${formatRunner(profile.config)}`
          : `Implementer profile ${profile.name} ${formatRunner(profile.config)}`,
        runner: profile.config,
      }),
    );
  }

  return checks;
}

function watchdogTimeoutCheck(opts: {
  id: string;
  label: string;
  runner: Config['planner'] | Config['implementer'];
}): ReadinessCheck[] {
  if (opts.runner.kind === 'api') return [];

  const { timeout, idleKillMs } = opts.runner;
  if (timeout === undefined) return [];

  const effectiveIdleKillMs = idleKillMs ?? RUNNER_IDLE_KILL_MS;
  if (timeout > effectiveIdleKillMs) return [];

  return [
    {
      id: opts.id,
      severity: 'warning',
      summary: `${opts.label} timeout (${timeout}ms) is at or below the idle-kill threshold (${effectiveIdleKillMs}ms); the watchdog kill-and-retry never gets a chance to fire.`,
      details: [
        `Configured timeout: ${timeout}ms.`,
        `Effective idle-kill threshold: ${effectiveIdleKillMs}ms.`,
        'Raise timeout above the idle-kill threshold, or remove it, to let a stalled call be killed and retried instead of failing outright.',
      ],
      metadata: {
        timeout,
        idleKillMs: effectiveIdleKillMs,
      },
    },
  ];
}

function buildImplementerProfileMetadataChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
): ReadinessCheck[] {
  const configuredProfiles = config.implementerProfiles?.profiles;
  if (!configuredProfiles) return [];

  return profiles.flatMap((profile) => {
    const configured = configuredProfiles[profile.name];
    if (!configured) return [];

    const checks: ReadinessCheck[] = [];
    if (configured.costTier === undefined) {
      checks.push({
        id: 'runners.implementer.profile-cost-tier-missing',
        severity: 'info',
        summary: `Implementer profile ${profile.name} has no costTier; routing treats it as unknown.`,
        metadata: { profile: profile.name, costTier: null },
      });
    }

    if (configured.capabilities?.writesFiles === undefined) {
      checks.push({
        id: 'runners.implementer.profile-writes-files-inferred',
        severity: 'info',
        summary: `Implementer profile ${profile.name} write mode inferred from runner kind.`,
        details: [`Write mode: ${profile.capabilities.writesFiles}`],
        metadata: { profile: profile.name, writesFiles: profile.capabilities.writesFiles },
      });
    }

    return checks;
  });
}

function runnerCheck(
  role: 'planner' | 'implementer',
  runner: Config['planner'] | Config['implementer'],
): ReadinessCheck {
  return {
    id: `runners.${role}.configured`,
    severity: 'ok',
    summary: `${formatRoleLabel(role)} ${formatRunner(runner)} configured.`,
    metadata: {
      role,
      kind: runner.kind,
      name: getRunnerDisplayName(runner),
      model: getRunnerModelName(runner) ?? null,
      modelSelection: modelSelection(runner),
      contextLength: runner.contextLength ?? null,
    },
  };
}
