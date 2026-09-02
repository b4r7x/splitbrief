import {
  runnerRoleForSlot,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import { findConfiguredCustomCommand } from '../../../core/config/custom-command-catalog.js';
import { inlineRunnerCommand } from '../../../core/config/custom-commands.js';
import {
  CLI_TOOL_CATALOG,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import { cliAuthRemediation } from '../../../core/schemas/readiness.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { assertNever } from '../../../utils/type-guards.js';
import { runnerDiscoveryContextKey } from '../../detection/runner-evidence.js';
import { getProvider } from '../../providers/registry.js';
import type { prepareCustomRunnerAdmission } from '../custom-admission.js';
import {
  customRunnerSecurityPosture,
  inlineRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from '../custom-trust.js';
import { resolveCliRunnerAuth } from '../sandbox-env.js';
import { admitFreshCliStart, type FreshCliStartGateResult } from '../start-gate.js';
import { throwIfPreparationAborted } from './abort-guard.js';
import { admittedCheck, blockedCheck, type RunnerCandidate } from './runner-candidates.js';
import type { PreparationContext, SlotEvaluation } from './types.js';

const UNVERIFIED_AUTH_FIX =
  'Stored credentials prove presence, not a working session, so a headless start stays fail-closed. Pass --allow-unverified-auth to start anyway, or run interactively where unverified auth is disclosed.';

function cliAdmissionFix(
  reason: Extract<FreshCliStartGateResult, { kind: 'denied' }>['reason'],
  tool: CliToolId,
  authChannel: CliAuthChannelId,
): string | undefined {
  if (reason.kind === 'authentication') return cliAuthRemediation({ tool, authChannel });
  if (reason.kind === 'authentication-unverified') return UNVERIFIED_AUTH_FIX;
  if (reason.kind === 'installation') {
    const descriptor = CLI_TOOL_CATALOG[tool];
    return `Install ${descriptor.displayName} (${descriptor.compatibility.installUrl}), then retry.`;
  }
  return undefined;
}

async function evaluateCli(
  candidate: RunnerCandidate & Readonly<{ runner: Extract<RunnerConfig, { kind: 'cli' }> }>,
  context: PreparationContext,
): Promise<SlotEvaluation> {
  const authChannel = resolveCliRunnerAuth(candidate.runner).id;
  const discoveryContext = {
    role: runnerRoleForSlot(candidate.slot),
    kind: 'cli' as const,
    id: candidate.runner.tool,
    ...(candidate.runner.model !== undefined && { model: candidate.runner.model }),
    authChannel,
    credentialPresent: false,
    configGeneration: context.preparationId,
  };
  const expectedContextKey = runnerDiscoveryContextKey(discoveryContext);
  const evidence = await context.deps.detectRunnerEvidence({
    context: discoveryContext,
    projectDir: context.projectDir,
    signal: context.signal,
  });
  throwIfAborted(context.signal);
  const admission = admitFreshCliStart({
    tool: candidate.runner.tool,
    evidence,
    expectedContextKey,
    expectedSelectionId: candidate.runner.model ?? 'unselected',
    interaction: context.policy.interaction,
    unverifiedAuth: context.policy.unverifiedAuth,
  });
  if (admission.kind === 'disclosure-required') {
    return {
      kind: 'blocked',
      check: blockedCheck(candidate.slot, candidate.runner.kind, 'Authentication needs review.'),
    };
  }
  if (admission.kind === 'denied') {
    // The start gate is the last place a wrong credential is still free. A
    // generic "review the runner" here sends the user back to a config that
    // looks correct; readiness already knows which credential is missing. An
    // unverified denial is policy, not a broken credential, so its fix must
    // name the escape hatch the policy itself provides.
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        `Fresh CLI evidence denied admission: ${admission.reason.kind}.`,
        cliAdmissionFix(admission.reason, candidate.runner.tool, authChannel),
      ),
    };
  }
  return {
    kind: 'admitted',
    check: admittedCheck(candidate.slot, candidate.runner.kind),
    gate: {
      kind: 'cli',
      slot: candidate.slot,
      preparationId: context.preparationId,
      tool: candidate.runner.tool,
      executable: admission.gate.executable,
    },
  };
}

function evaluateApi(
  candidate: RunnerCandidate & Readonly<{ runner: Extract<RunnerConfig, { kind: 'api' }> }>,
  context: PreparationContext,
): SlotEvaluation {
  try {
    const provider = getProvider(candidate.runner.provider, {
      apiBase: candidate.runner.apiBase,
      ...(candidate.runner.apiKey !== undefined && { apiKey: candidate.runner.apiKey }),
    });
    if (!provider.isLocal && provider.apiKey().length === 0) {
      return {
        kind: 'blocked',
        check: blockedCheck(
          candidate.slot,
          candidate.runner.kind,
          'Provider credentials are missing.',
        ),
      };
    }
    return {
      kind: 'admitted',
      check: admittedCheck(candidate.slot, candidate.runner.kind),
      gate: {
        kind: 'api',
        slot: candidate.slot,
        preparationId: context.preparationId,
        provider: candidate.runner.provider,
        endpointOrigin: new URL(provider.baseURL).origin,
      },
    };
  } catch {
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        'Provider credentials or endpoint policy are invalid.',
      ),
    };
  }
}

const INLINE_RUNNER_GRANT_FIX =
  'Run SPLITBRIEF in a terminal and confirm the runner disclosure, or pass --allow-repo-runners to grant it for this run only.';

/**
 * A refused inline runner is usually untrusted, but it can also be absent or
 * changed. Naming which one is the difference between an actionable block and
 * a config the reader keeps re-reading.
 */
export function inlineRunnerRefusal(
  admission: Awaited<ReturnType<typeof prepareCustomRunnerAdmission>>,
  kind: 'shell' | 'agent',
): Readonly<{ reason: string; fix: string }> {
  const status = admission.kind === 'denied' ? admission.status : 'untrusted';
  switch (status) {
    case 'missing':
      return {
        reason: `Project config declares a ${kind} runner command that does not exist on this machine.`,
        fix: 'Install the command or correct its path in .splitbrief/config.yaml, then retry.',
      };
    case 'non-executable':
      return {
        reason: `Project config declares a ${kind} runner command that is not executable.`,
        fix: 'Make the command executable or correct its path in .splitbrief/config.yaml, then retry.',
      };
    case 'drifted':
      return {
        reason: `The ${kind} runner executable changed since this machine trusted it.`,
        fix: INLINE_RUNNER_GRANT_FIX,
      };
    default:
      return {
        reason: `Project config declares a ${kind} runner command that this machine has not trusted.`,
        fix: INLINE_RUNNER_GRANT_FIX,
      };
  }
}

/**
 * Every `shell`/`agent` runner reaches execution through an owner-only trust
 * receipt, whether it is a `customCommands` entry or an inline declaration.
 * `.splitbrief/config.yaml` travels with a clone, so a command named there is
 * the repository author's proposal until this project's owner confirms it.
 */
async function evaluateCommand(
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
        'Configured command is outside the current trust policy.',
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
    if (runner.source === 'configured') {
      return {
        kind: 'blocked',
        check: blockedCheck(
          candidate.slot,
          candidate.runner.kind,
          'Configured custom runner admission was denied.',
        ),
      };
    }
    const refusal = inlineRunnerRefusal(admission, candidate.runner.kind);
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

export async function evaluateCandidate(
  candidate: RunnerCandidate,
  context: PreparationContext,
): Promise<SlotEvaluation> {
  switch (candidate.runner.kind) {
    case 'cli':
      return evaluateCli({ ...candidate, runner: candidate.runner }, context);
    case 'api':
      return evaluateApi({ ...candidate, runner: candidate.runner }, context);
    case 'shell':
    case 'agent':
      return evaluateCommand({ ...candidate, runner: candidate.runner }, context);
    default:
      return assertNever(candidate.runner);
  }
}
