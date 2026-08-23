import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import {
  findConfiguredCustomCommand,
  inlineRunnerCommand,
} from '../../core/config/custom-commands.js';
import type { ReadinessCheck } from '../../core/readiness/types.js';
import type { Config } from '../../core/schemas/config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ActiveRunnerRole, RunnerRole } from '../../core/runners/cli-tool-catalog.js';
import {
  customRunnerSecurityPosture,
  inlineRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from './custom-trust.js';
import { inlineRunnerRefusal } from './prepare-execution.js';
import { admitCustomRunner, checkRunnerTrust } from './trust.js';

type CommandRunner = Extract<PlannerConfig | ImplementerConfig, { kind: 'shell' | 'agent' }>;

type Candidate = Readonly<{
  checkId: string;
  label: string;
  /** The admission axis: posture and inline command policy are planner-tier or implementer-tier. */
  trustRole: RunnerRole;
  /** The seat the check is about, which is what the report publishes. */
  seat: ActiveRunnerRole;
  trustLabel: string;
  runner: CommandRunner;
}>;

export interface CustomRunnerConsentPreflightInput {
  readonly config: Config;
  readonly projectDir: string;
  /** The interaction a run started the same way would have. */
  readonly interaction: 'interactive' | 'headless';
  readonly stateDir?: string | undefined;
}

function isCommandRunner(runner: PlannerConfig | ImplementerConfig): runner is CommandRunner {
  return runner.kind === 'shell' || runner.kind === 'agent';
}

function candidates(config: Config): Candidate[] {
  const found: Candidate[] = [];
  if (isCommandRunner(config.planner)) {
    found.push({
      checkId: 'runners.consent.planner',
      label: 'Planner',
      trustRole: 'planner',
      seat: 'planner',
      trustLabel: 'planner',
      runner: config.planner,
    });
  }
  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured' && isCommandRunner(reviewer.runner)) {
    found.push({
      checkId: 'runners.consent.reviewer',
      label: 'Reviewer',
      trustRole: 'planner',
      seat: 'reviewer',
      trustLabel: 'reviewer',
      runner: reviewer.runner,
    });
  }
  let profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'];
  try {
    profiles = resolveImplementerProfiles(config).profiles;
  } catch {
    // Config readiness already reports the invalid profile block.
    return found;
  }
  for (const profile of profiles) {
    if (!isCommandRunner(profile.config)) continue;
    found.push({
      checkId: `runners.consent.implementer.${profile.name}`,
      label: `Implementer profile ${profile.name}`,
      trustRole: 'implementer',
      seat: 'implementer',
      trustLabel:
        config.implementerProfiles?.profiles[profile.name] === undefined
          ? 'implementer'
          : `implementer profile ${profile.name}`,
      runner: profile.config,
    });
  }
  return found;
}

function configuredRunner(config: Config, candidate: Candidate): ConfiguredCustomRunner {
  const configured = findConfiguredCustomCommand(config, candidate.runner);
  return configured === undefined
    ? {
        source: 'inline',
        command: inlineRunnerCommand({ runner: candidate.runner, role: candidate.trustRole }),
      }
    : { source: 'configured', command: configured };
}

function refusedCheck(
  candidate: Candidate,
  interaction: 'interactive' | 'headless',
  refusal: Readonly<{ reason: string; fix: string }>,
): ReadinessCheck {
  const headless = interaction === 'headless';
  return {
    id: candidate.checkId,
    severity: headless ? 'blocker' : 'warning',
    summary: headless
      ? `${candidate.label} could not be admitted.`
      : `${candidate.label} needs a one-time confirmation before it can run.`,
    details: [
      refusal.reason,
      ...(headless
        ? []
        : ['A non-interactive run refuses it instead of prompting for that confirmation.']),
    ],
    fix: refusal.fix,
    nextAction: 'fix-config',
    metadata: { role: candidate.seat, kind: candidate.runner.kind },
  };
}

/**
 * `doctor` prepares nothing, so it used to report a `shell`/`agent` runner as a
 * trust-boundary warning and exit 0 while the run it recommends was refused by
 * admission. This replays admission's own read-only verdict — no receipt is
 * written and no session is created — so the two commands answer the same
 * question about the same machine.
 *
 * It reproduces one input `start` also takes from the command line:
 * `--allow-repo-runners` is never granted here, so a run that passes that flag
 * can be admitted where this reports a blocker. The remedy text names the flag.
 */
export async function collectCustomRunnerConsentChecks(
  input: CustomRunnerConsentPreflightInput,
): Promise<ReadinessCheck[]> {
  const found = candidates(input.config);
  if (found.length === 0) return [];
  const violations = new Set(
    checkRunnerTrust(input.config, input.projectDir).violations.map((violation) => violation.label),
  );

  const checks: ReadinessCheck[] = [];
  for (const candidate of found) {
    const runner = configuredRunner(input.config, candidate);
    if (runner.source === 'inline' && violations.has(candidate.trustLabel)) {
      checks.push(
        refusedCheck(candidate, input.interaction, {
          reason: 'Configured command is outside the current trust policy.',
          fix: 'Use a system-installed command, or pass --allow-repo-runners to run the repository-local one.',
        }),
      );
      continue;
    }
    const admission = await admitCustomRunner({
      projectDir: input.projectDir,
      runner,
      posture:
        runner.source === 'configured'
          ? customRunnerSecurityPosture(candidate.trustRole, runner.command.contract)
          : inlineRunnerSecurityPosture(candidate.trustRole, runner.command.contract),
      interaction: 'headless',
      grant: false,
      pathEnv: runner.source === 'inline' ? (process.env.PATH ?? '') : '',
      pathExt: runner.source === 'inline' ? (process.env.PATHEXT ?? '') : '',
      ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
    });
    if (admission.kind === 'admitted') {
      checks.push({
        id: candidate.checkId,
        severity: 'ok',
        summary: `${candidate.label} is authorized to run on this machine.`,
        metadata: { role: candidate.seat, kind: candidate.runner.kind },
      });
      continue;
    }
    checks.push(
      refusedCheck(
        candidate,
        input.interaction,
        inlineRunnerRefusal(admission, candidate.runner.kind),
      ),
    );
  }
  return checks;
}
