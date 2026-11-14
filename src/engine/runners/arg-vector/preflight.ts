import {
  type ResolvedImplementerProfile,
  resolveImplementerProfiles,
} from '../../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { formatSlotLabel } from '../../../core/crew/identity.js';
import type { ReadinessCheck } from '../../../core/readiness/types.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import { semanticConfiguredArgViolations } from './authority.js';
import { checkRunnerArgVector } from './check.js';
import { type PreflightRunner, emittedArgVectors } from './flags.js';
import { defaultRunHelp } from './help-command.js';

export interface ArgVectorPreflightCheckInput {
  config: Config;
  projectDir: string;
  /** The seats this run reaches; a seat the run never calls is not preflighted. */
  roles: readonly ActiveRunnerRole[];
  /** Only this tool's seats, as a run's re-check of one tool needs; every CLI seat when absent. */
  tool?: CliToolId | undefined;
  /** The release readiness admitted per tool, so the vector is the one dispatch would build. */
  installedVersions?: Readonly<Partial<Record<CliToolId, string>>> | undefined;
  runHelp?: (tool: CliToolId, argv: readonly string[]) => Promise<string | null>;
  signal?: AbortSignal | undefined;
}

export async function collectArgVectorPreflightChecks(
  input: ArgVectorPreflightCheckInput,
): Promise<ReadinessCheck[]> {
  const runHelp = input.runHelp ?? defaultRunHelp(input.projectDir, input.signal);
  const runners: PreflightRunner[] = [];
  if (input.roles.includes('planner') && input.config.planner.kind === 'cli') {
    runners.push({
      tool: input.config.planner.tool,
      role: 'planner',
      seat: formatSlotLabel({ role: 'planner' }),
      model: input.config.planner.model,
      args: input.config.planner.args,
      effort: input.config.planner.effort,
      variant: input.config.planner.variant,
      installedVersion: input.installedVersions?.[input.config.planner.tool],
    });
  }
  if (input.roles.includes('implementer')) {
    let profiles: ResolvedImplementerProfile[] = [];
    try {
      profiles = resolveImplementerProfiles(input.config).profiles;
    } catch {
      profiles = [];
    }
    for (const profile of profiles) {
      if (profile.config.kind === 'cli') {
        runners.push({
          tool: profile.config.tool,
          role: 'implementer',
          seat: formatSlotLabel({ role: 'implementer', profile: profile.name }),
          model: profile.config.model,
          args: profile.config.args,
          effort: profile.config.effort,
          variant: profile.config.variant,
          installedVersion: input.installedVersions?.[profile.config.tool],
        });
      }
    }
  }
  if (input.roles.includes('reviewer')) {
    const reviewer = resolveReviewerRunner(input.config);
    if (reviewer.source === 'configured' && reviewer.runner.kind === 'cli') {
      runners.push({
        tool: reviewer.runner.tool,
        role: 'reviewer',
        seat: formatSlotLabel({ role: 'reviewer' }),
        model: reviewer.runner.model,
        args: reviewer.runner.args,
        effort: reviewer.runner.effort,
        variant: reviewer.runner.variant,
        installedVersion: input.installedVersions?.[reviewer.runner.tool],
      });
    }
  }
  const checks: ReadinessCheck[] = [];
  for (const runner of runners) {
    if (input.tool !== undefined && runner.tool !== input.tool) continue;
    checks.push(await buildPreflightCheck(runner, input.projectDir, runHelp));
  }
  return checks;
}

async function buildPreflightCheck(
  runner: PreflightRunner,
  projectDir: string,
  runHelp: (tool: CliToolId, argv: readonly string[]) => Promise<string | null>,
): Promise<ReadinessCheck> {
  const semantic = semanticConfiguredArgViolations(runner.args ?? []);
  if (semantic.length > 0) return semanticOverrideCheck(runner, semantic);
  const vectors = emittedArgVectors(runner, projectDir);
  const conflicts = vectors.flatMap(({ validation }) =>
    validation.valid ? [] : validation.conflicts,
  );
  if (conflicts.length > 0) return semanticOverrideCheck(runner, [...new Set(conflicts)]);
  const argVectors = vectors.map(({ argv }) => argv);
  const unsupported = new Set<string>();
  const deprecated = new Set<string>();
  let compared = false;
  for (const argv of argVectors) {
    const helpText = await runHelp(runner.tool, argv);
    if (helpText === null) continue;
    compared = true;
    const outcome = checkRunnerArgVector({ argv, helpText });
    if (outcome.ok) continue;
    for (const flag of outcome.unsupported) unsupported.add(flag);
    for (const flag of outcome.deprecated) deprecated.add(flag);
  }
  const descriptor = CLI_TOOL_CATALOG[runner.tool];
  const id = argVectorCheckId(runner.tool, runner.role);
  if (unsupported.size === 0 && deprecated.size === 0) {
    return {
      id,
      severity: 'ok',
      summary: compared
        ? `${descriptor.displayName} supports the options ${runner.seat} uses.`
        : `${descriptor.displayName} options for ${runner.seat} are configured.`,
      metadata: {
        tool: runner.tool,
        role: runner.role,
        checked: compared ? 'help' : 'unavailable',
      },
    };
  }
  if (unsupported.size > 0) {
    return {
      id,
      severity: 'blocker',
      summary: `${descriptor.displayName} does not support options ${runner.seat} uses: ${[...unsupported].join(', ')}.`,
      details: [
        `The installed tool's help does not list these options; the first call would fail.`,
      ],
      fix: 'Upgrade the installed binary, or remove the unsupported flags from the runner configuration.',
      nextAction: 'fix-config',
      metadata: {
        tool: runner.tool,
        role: runner.role,
        unsupported: [...unsupported],
        deprecated: [...deprecated],
      },
    };
  }
  return {
    id,
    severity: 'warning',
    summary: `${descriptor.displayName} is retiring options ${runner.seat} uses: ${[...deprecated].join(', ')}.`,
    fix: `Update ${descriptor.displayName}, or remove these options from .splitbrief/config.yaml.`,
    metadata: {
      tool: runner.tool,
      role: runner.role,
      unsupported: [],
      deprecated: [...deprecated],
    },
  };
}

function argVectorCheckId(tool: CliToolId, role: ActiveRunnerRole): string {
  return `runners.cli.${tool}.arg-vector.${role}`;
}

/**
 * A configured arg vector that overrides authority-bearing semantics refuses
 * before any help probe or task spawn (REQ-018): the rejection is the check,
 * and no subprocess runs for the runner.
 */
function semanticOverrideCheck(
  runner: PreflightRunner,
  violations: readonly string[],
): ReadinessCheck {
  const descriptor = CLI_TOOL_CATALOG[runner.tool];
  return {
    id: argVectorCheckId(runner.tool, runner.role),
    severity: 'blocker',
    summary: `${runner.seat} options for ${descriptor.displayName} override settings SPLITBRIEF owns: ${violations.join(', ')}.`,
    details: [
      'SPLITBRIEF sets seat permissions, workspace access, session selection, and input and output formats. Custom options cannot replace these settings.',
    ],
    fix: 'Remove the authority-bearing flags from the runner configuration.',
    nextAction: 'fix-config',
    metadata: {
      tool: runner.tool,
      role: runner.role,
      semantic: [...violations],
      unsupported: [],
      deprecated: [],
    },
  };
}
