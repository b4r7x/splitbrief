import {
  type RunnerConfig,
  runnerRoleForSlot,
} from '../../../core/config/accessors/runner-config.js';
import { findConfiguredCustomCommand } from '../../../core/config/custom-commands/catalog.js';
import { inlineRunnerCommand } from '../../../core/config/custom-commands/schema.js';
import type { prepareCustomRunnerAdmission } from '../custom/admission.js';
import {
  type ConfiguredCustomRunner,
  customRunnerSecurityPosture,
  inlineRunnerSecurityPosture,
} from '../custom/posture.js';
import { throwIfPreparationAborted } from './abort-guard.js';
import { type RunnerCandidate, blockedCheck, admittedCheck } from './runner-candidates.js';
import type { PreparationPolicy, PreparationContext, SlotEvaluation } from './types.js';

const RUNNER_GRANT_FIX =
  'Run SPLITBRIEF in a terminal and confirm the runner disclosure, or pass --allow-repo-runners to grant it for this run only.';

const CHANGED_RUNNER_GRANT_FIX =
  'Run SPLITBRIEF in a terminal and confirm the changed executable, or pass --allow-repo-runners to grant it for this run only.';

const REPO_LOCAL_RUNNER_REASON = 'Configured command is outside the current trust policy.';

/**
 * A repo-local command runs only under the grant; a receipt cannot bind files the checkout changes.
 * `doctor` takes no grant, so its refusal names the run that does.
 */
export const REPO_LOCAL_RUNNER_REFUSAL = {
  reason: REPO_LOCAL_RUNNER_REASON,
  fix: 'Use a system-installed command, or start or continue the run from the command line with --allow-repo-runners.',
} as const;

/** The command that grants a repo-local command, named for the command the user ran. */
export const REPO_LOCAL_RUNNER_FIX: Readonly<Record<PreparationPolicy['purpose'], string>> = {
  'new-workflow':
    'Use a system-installed command, or start the run from the command line with `splitbrief start --allow-repo-runners`.',
  resume:
    'Use a system-installed command, or continue the run from the command line with `splitbrief continue --allow-repo-runners`.',
  spec: 'Use a system-installed command, or run `splitbrief spec --allow-repo-runners`.',
  review: 'Use a system-installed command, or run `splitbrief review --allow-repo-runners`.',
};

const RUNNER_KIND_WITH_ARTICLE = { shell: 'a shell', agent: 'an agent' } as const;

/**
 * A refused runner is usually untrusted, but it can also be absent or
 * changed. Naming which one is the difference between an actionable block and
 * a config the reader keeps re-reading.
 */
export function customRunnerRefusal(
  admission: Awaited<ReturnType<typeof prepareCustomRunnerAdmission>>,
  kind: 'shell' | 'agent',
): Readonly<{ reason: string; fix: string }> {
  const status = admission.kind === 'denied' ? admission.status : 'untrusted';
  const declared = `Project config declares ${RUNNER_KIND_WITH_ARTICLE[kind]} runner command`;
  switch (status) {
    case 'missing':
      return {
        reason: `${declared} that does not exist on this machine.`,
        fix: 'Install the command or correct its path in .splitbrief/config.yaml, then retry.',
      };
    case 'non-executable':
      return {
        reason: `${declared} that is not executable.`,
        fix: 'Make the command executable or correct its path in .splitbrief/config.yaml, then retry.',
      };
    case 'drifted':
      return {
        reason: `The ${kind} runner executable changed since this machine trusted it.`,
        fix: CHANGED_RUNNER_GRANT_FIX,
      };
    default:
      return {
        reason: `${declared} that this machine has not trusted.`,
        fix: RUNNER_GRANT_FIX,
      };
  }
}

/**
 * Every `shell`/`agent` runner reaches execution through an owner-only trust
 * receipt, whether it is a `customCommands` entry or an inline declaration.
 * `.splitbrief/config.yaml` travels with a clone, so a command named there is
 * the repository author's proposal until this project's owner confirms it.
 */
export async function evaluateCommand(
  candidate: RunnerCandidate &
    Readonly<{ runner: Extract<RunnerConfig, { kind: 'shell' | 'agent' }> }>,
  context: PreparationContext,
): Promise<SlotEvaluation> {
  const role = runnerRoleForSlot(candidate.slot);
  const configured = findConfiguredCustomCommand(context.config, candidate.runner);
  if (
    configured === undefined &&
    context.nativeTrustViolations.has(candidate.trustLabel) &&
    !context.policy.allowRepoRunners
  ) {
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        REPO_LOCAL_RUNNER_REASON,
        REPO_LOCAL_RUNNER_FIX[context.policy.purpose],
      ),
    };
  }

  const runner: ConfiguredCustomRunner =
    configured === undefined
      ? { source: 'inline', command: inlineRunnerCommand({ runner: candidate.runner, role }) }
      : { source: 'configured', command: configured };
  const admission = await context.deps.prepareCustomRunnerAdmission({
    projectDir: context.projectDir,
    runner,
    posture:
      runner.source === 'configured'
        ? customRunnerSecurityPosture(role, runner.command.contract)
        : inlineRunnerSecurityPosture(role, runner.command.contract),
    phase: role === 'planner' ? 'planning' : 'implementing',
    interaction: context.policy.interaction,
    allowRepoRunners: context.policy.allowRepoRunners,
    signal: context.signal,
    // An inline runner is spawned by name against this process's PATH, so
    // admission must identify the executable the same lookup would reach.
    ...(runner.source === 'inline' && {
      authorizationPathEnv: process.env.PATH ?? '',
      authorizationPathExt: process.env.PATHEXT ?? '',
    }),
    ...(context.policy.stateDir !== undefined && { stateDir: context.policy.stateDir }),
    ...(context.policy.onTieredApproval !== undefined && {
      onTieredApproval: context.policy.onTieredApproval,
    }),
  });
  throwIfPreparationAborted(
    context.signal,
    admission.kind === 'admitted' && admission.trustPersisted,
  );
  if (admission.kind !== 'admitted') {
    const refusal = customRunnerRefusal(admission, candidate.runner.kind);
    return {
      kind: 'blocked',
      check: blockedCheck(candidate.slot, candidate.runner.kind, refusal.reason, refusal.fix),
    };
  }
  return {
    kind: 'admitted',
    check: admittedCheck(candidate.slot, candidate.runner.kind),
    gate: {
      kind: candidate.runner.kind,
      slot: candidate.slot,
      preparationId: context.preparationId,
      command:
        runner.source === 'configured'
          ? { kind: 'configured-custom', invocation: admission.invocation }
          : { kind: 'validated-config' },
    },
    trustPersisted: admission.trustPersisted,
  };
}
