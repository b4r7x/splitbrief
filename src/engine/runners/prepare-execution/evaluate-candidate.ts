import {
  runnerRoleForSlot,
  type RunnerConfig,
} from '../../../core/config/accessors/runner-config.js';
import { contentIdentityId } from '../../../core/config/accessors/content-identity.js';
import { findConfiguredCustomCommand } from '../../../core/config/custom-command-catalog.js';
import { inlineRunnerCommand } from '../../../core/config/custom-commands.js';
import {
  CLI_TOOL_CATALOG,
  type CliAuthChannelId,
  type CliToolId,
} from '../../../core/runners/cli-tool-catalog.js';
import { admitCliAuthChannel } from '../../../core/runners/cli-auth-selection.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { cliAuthRemediation } from '../../../core/schemas/readiness.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
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
import { readHostModelSelection } from '../host-model-selection.js';
import { resolveCliRunnerAuth } from '../sandbox-env.js';
import { admitFreshCliStart, type FreshCliStartGateResult } from '../start-gate.js';
import { throwIfPreparationAborted } from './abort-guard.js';
import {
  admittedCheck,
  blockedCheck,
  warningCheck,
  type PreparationWarning,
  type RunnerCandidate,
} from './runner-candidates.js';
import type { PreparationContext, SlotEvaluation } from './types.js';

const UNVERIFIED_AUTH_FIX =
  'Stored credentials prove presence, not a working session, so a headless start stays fail-closed. Pass --allow-unverified-auth to start anyway, or run interactively where unverified auth is disclosed.';

const READINESS_RETRY_DELAY_MS = 1500;

const RUN_THE_STATUS_COMMAND = 'Run it once yourself, then continue again.';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function cliAdmissionFix(
  reason: Extract<FreshCliStartGateResult, { kind: 'denied' }>['reason'],
  tool: CliToolId,
  authChannel: CliAuthChannelId,
): string | undefined {
  if (reason.kind === 'authentication') {
    return `${cliAuthRemediation({ tool, authChannel })} ${RUN_THE_STATUS_COMMAND}`;
  }
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
    // The observation names the configuration being checked, not this
    // preparation: two concurrent preparations of the same config ask the
    // runner one question. The receipt below is still minted per preparation.
    configGeneration: contentIdentityId('config', context.config),
  };
  const expectedContextKey = runnerDiscoveryContextKey(discoveryContext);
  const detect = (): Promise<RunnerEvidence> =>
    context.deps.detectRunnerEvidence({
      context: discoveryContext,
      projectDir: context.projectDir,
      signal: context.signal,
    });
  const admit = (fresh: RunnerEvidence): FreshCliStartGateResult =>
    admitFreshCliStart({
      tool: candidate.runner.tool,
      evidence: fresh,
      expectedContextKey,
      expectedSelectionId: candidate.runner.model ?? 'unselected',
      interaction: context.policy.interaction,
      unverifiedAuth: context.policy.unverifiedAuth,
    });
  let evidence = await detect();
  throwIfAborted(context.signal);
  let admission = admit(evidence);
  const warnings: PreparationWarning[] = [];
  // A session channel's auth fact is whatever the tool's own status command
  // answered a moment ago, and that command is cold on the first call of a
  // continue: it can report no session for a host that has one. One denial is
  // not evidence enough to refuse the seat the run is resuming.
  if (
    admission.kind === 'denied' &&
    admission.reason.kind === 'authentication' &&
    authChannel === 'session'
  ) {
    await wait(READINESS_RETRY_DELAY_MS, context.signal);
    throwIfAborted(context.signal);
    evidence = await detect();
    throwIfAborted(context.signal);
    admission = admit(evidence);
    warnings.push({
      code: 'readiness_probe_retried',
      message: `${candidate.runner.tool} reported no session on the first probe and one ${READINESS_RETRY_DELAY_MS}ms later; the seat was admitted on the second.`,
    });
  }
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
  // The invocation gate binds no installed version yet, so an explicit method
  // the matrix cannot enforce is refused here, before the planner spends a token.
  const authAdmission = admitCliAuthChannel({
    tool: candidate.runner.tool,
    platform: process.platform,
    installedVersion: undefined,
    authChannel: candidate.runner.authChannel,
  });
  if (authAdmission.kind === 'refused') {
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        authAdmission.message,
        'Remove auth_channel from this runner in .splitbrief/config.yaml, then retry.',
      ),
    };
  }
  // `auto` is the operator's intent, not a model: the tool would resolve it
  // from its own config, which the run's record and its argv cannot see. Read
  // that selection here and name it, so every surface says what actually ran.
  const details: string[] = [];
  let effectiveModel: string | undefined;
  const configuredModel = candidate.runner.model;
  const declaredAuto =
    configuredModel !== undefined && isAutomaticModel(configuredModel, candidate.runner.tool);
  if (declaredAuto || configuredModel === undefined) {
    const selection = await readHostModelSelection(
      candidate.runner.tool,
      process.env,
      evidence.catalog.kind === 'success' ? evidence.catalog.value : undefined,
    );
    if (selection !== null) {
      effectiveModel = selection.model;
      details.push(`model: auto → ${selection.model} (from ${selection.source})`);
    } else if (declaredAuto) {
      // A seat that named no model never asked for one, so the tool's own
      // default is the answer it wanted; only a declared `auto` is left unmet.
      warnings.push({
        code: 'host_model_selection_unreadable',
        message: `model: auto — ${candidate.runner.tool} has no readable model selection; the tool's own default applies.`,
      });
    }
  }
  return {
    kind: 'admitted',
    check:
      warnings.length > 0
        ? warningCheck(candidate.slot, candidate.runner.kind, warnings, details)
        : admittedCheck(candidate.slot, candidate.runner.kind, details),
    gate: {
      kind: 'cli',
      slot: candidate.slot,
      preparationId: context.preparationId,
      tool: candidate.runner.tool,
      executable: admission.gate.executable,
      installedVersion: admission.gate.installedVersion,
      ...(effectiveModel !== undefined && { effectiveModel }),
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
