import { randomUUID } from 'node:crypto';
import {
  resolveRunnerConfigContext,
  type RunnerConfig,
  type RunnerConfigSlot,
} from '../../core/config/accessors/runner-config.js';
import { resolveIntermediateRunner } from '../../core/config/accessors/intermediate-runner.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import {
  findConfiguredCustomCommand,
  inlineRunnerCommand,
} from '../../core/config/custom-commands.js';
import { applyRunnerPreparationChecks, collectReadiness } from '../../core/readiness/collect.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../core/schemas/config.js';
import { cliAuthRemediation } from '../../core/schemas/readiness.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { prepareNewSession, type SessionOwnershipReceipt } from '../../core/sessions/prepare.js';
import { reactivateExistingSession } from '../../core/sessions/lifecycle.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { runnerDiscoveryContextKey, detectRunnerEvidence } from '../detection/detect.js';
import { getProvider } from '../providers/registry.js';
import { resolveApiKeyOverride } from '../providers/client/api-key.js';
import { isAgentSdkAvailable } from './agent-sdk/availability.js';
import { collectArgVectorPreflightChecks } from './arg-vector-preflight.js';
import {
  CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT,
  prepareCustomRunnerAdmission,
} from './custom-admission.js';
import {
  customRunnerSecurityPosture,
  inlineRunnerSecurityPosture,
  type ConfiguredCustomRunner,
} from './custom-trust.js';
import { probeRunnerAvailability, type RunnerAvailabilityRole } from './probe-availability.js';
import { resolveCliRunnerAuth } from './sandbox-env.js';
import { admitFreshCliStart } from './start-gate.js';
import { checkRunnerTrust } from './trust.js';
import { resolveCliExecutableAliases } from './resolve-cli-executable.js';
import type { CustomRunnerAdmissionPolicy } from './types.js';
import {
  parsePreparedConfig,
  type PreparationOutcome,
  type PreparedExecutionSession,
  type RunnerGate,
} from './prepared-execution.js';
import { assertNever } from '../../utils/type-guards.js';
import { error, matches } from '../../utils/error.js';
import { isAbortError, throwIfAborted } from '../../utils/abort.js';

type CommonPreparationPolicy = CustomRunnerAdmissionPolicy &
  Readonly<{
    unverifiedAuth: 'denied' | 'disclosed' | 'allowed';
    allowHooks: boolean;
  }>;

export type PreparationPolicy =
  | (CommonPreparationPolicy & Readonly<{ purpose: 'new-workflow' | 'spec' }>)
  | (CommonPreparationPolicy & Readonly<{ purpose: 'resume' }>);

type PrepareExecutionCommon = Readonly<{
  feature: string;
  effectiveConfig: Config;
  signal: AbortSignal;
  plannerContext?: string | undefined;
  resumeState?: WorkflowState | undefined;
  worktreeName?: string | undefined;
  deps?: Partial<PrepareExecutionDependencies> | undefined;
}>;

type NewPrepareExecutionInput = PrepareExecutionCommon &
  Readonly<{
    projectDir: string;
    policy: Extract<PreparationPolicy, { purpose: 'new-workflow' | 'spec' }>;
    existingSession?: never;
    candidate?: SessionOwnershipReceipt | undefined;
  }>;

type ResumePrepareExecutionInput = PrepareExecutionCommon &
  Readonly<{
    policy: Extract<PreparationPolicy, { purpose: 'resume' }>;
    existingSession: SessionRef;
    projectDir?: never;
    candidate?: never;
  }>;

export type PrepareExecutionInput = NewPrepareExecutionInput | ResumePrepareExecutionInput;

type RunnerCandidate = Readonly<{
  slot: RunnerConfigSlot;
  runner: RunnerConfig;
  trustLabel: string;
}>;

type CandidateEnumeration = Readonly<{
  candidates: readonly RunnerCandidate[];
  checks: readonly ReadinessCheck[];
}>;

type SlotEvaluation =
  | Readonly<{
      kind: 'admitted';
      check: ReadinessCheck;
      gate: RunnerGate;
      trustPersisted?: boolean | undefined;
    }>
  | Readonly<{ kind: 'blocked'; check: ReadinessCheck }>;

type PreparationContext = Readonly<{
  projectDir: string;
  config: Config;
  policy: PreparationPolicy;
  preparationId: string;
  signal: AbortSignal;
  nativeTrustViolations: ReadonlySet<string>;
  deps: PrepareExecutionDependencies;
}>;

type PrepareExecutionDependencies = Readonly<{
  collectReadiness: typeof collectReadiness;
  collectArgVectorPreflightChecks: typeof collectArgVectorPreflightChecks;
  probeRunnerAvailability: typeof probeRunnerAvailability;
  detectRunnerEvidence: typeof detectRunnerEvidence;
  prepareCustomRunnerAdmission: typeof prepareCustomRunnerAdmission;
  isAgentSdkAvailable: typeof isAgentSdkAvailable;
  resolveCliExecutableAliases: typeof resolveCliExecutableAliases;
  prepareNewSession: typeof prepareNewSession;
  reactivateExistingSession: typeof reactivateExistingSession;
  newPreparationId: () => string;
}>;

const DEFAULT_DEPENDENCIES: PrepareExecutionDependencies = {
  collectReadiness,
  collectArgVectorPreflightChecks,
  probeRunnerAvailability,
  detectRunnerEvidence,
  prepareCustomRunnerAdmission,
  isAgentSdkAvailable,
  resolveCliExecutableAliases,
  prepareNewSession,
  reactivateExistingSession,
  newPreparationId: randomUUID,
};

function persistedTrustAbortError(): Error {
  return error(
    CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT,
    'Runner trust was saved before preparation cancellation completed.',
  );
}

function throwIfPreparationAborted(signal: AbortSignal, trustPersisted: boolean): void {
  if (signal.aborted && trustPersisted) throw persistedTrustAbortError();
  throwIfAborted(signal);
}

function slotId(slot: RunnerConfigSlot): string {
  switch (slot.role) {
    case 'planner':
      return 'planner';
    case 'implementer':
      return `implementer.${slot.profile}`;
    case 'intermediate':
      return 'intermediate';
    default:
      return assertNever(slot);
  }
}

function slotLabel(slot: RunnerConfigSlot): string {
  switch (slot.role) {
    case 'planner':
      return 'Planner';
    case 'implementer':
      return `Implementer profile ${slot.profile}`;
    case 'intermediate':
      return 'Intermediate runner';
    default:
      return assertNever(slot);
  }
}

function admittedCheck(slot: RunnerConfigSlot, kind: RunnerConfig['kind']): ReadinessCheck {
  return {
    id: `runners.preparation.${slotId(slot)}`,
    severity: 'ok',
    summary: `${slotLabel(slot)} passed fresh runner admission.`,
    metadata: { role: slot.role, kind },
  };
}

function blockedCheck(
  slot: RunnerConfigSlot,
  kind: RunnerConfig['kind'],
  reason: string,
  fix = 'Review the configured runner, then retry.',
): ReadinessCheck {
  return {
    id: `runners.preparation.${slotId(slot)}`,
    severity: 'blocker',
    summary: `${slotLabel(slot)} could not be admitted.`,
    details: [reason],
    fix,
    nextAction: 'fix-config',
    metadata: { role: slot.role, kind },
  };
}

function runnerCandidates(
  config: Config,
  purpose: PreparationPolicy['purpose'],
): CandidateEnumeration {
  const plannerContext = resolveRunnerConfigContext({ role: 'planner', runner: config.planner });
  const candidates: RunnerCandidate[] = [
    { slot: plannerContext.slot, runner: config.planner, trustLabel: 'planner' },
  ];
  if (purpose === 'spec') return { candidates, checks: [] };

  for (const profile of resolveImplementerProfiles(config).profiles) {
    const context = resolveRunnerConfigContext({
      role: 'implementer',
      profile: profile.name,
      runner: profile.config,
    });
    candidates.push({
      slot: context.slot,
      runner: profile.config,
      trustLabel:
        config.implementerProfiles?.profiles[profile.name] === undefined
          ? 'implementer'
          : `implementer profile ${profile.name}`,
    });
  }

  if (
    config.escalation?.enabled !== false &&
    config.escalation?.intermediateProvider !== undefined
  ) {
    const resolved = resolveIntermediateRunner(config);
    if (resolved === null) {
      return {
        candidates,
        checks: [
          {
            id: 'runners.preparation.intermediate',
            severity: 'blocker',
            summary: 'Intermediate runner could not be resolved.',
            fix: 'Fix escalation.intermediateProvider and intermediateModel, then retry.',
            nextAction: 'fix-config',
            metadata: { role: 'intermediate', kind: 'api' },
          },
        ],
      };
    }
    const context = resolveRunnerConfigContext({ role: 'intermediate', runner: resolved.runner });
    candidates.push({ slot: context.slot, runner: resolved.runner, trustLabel: 'intermediate' });
  }

  return { candidates, checks: [] };
}

async function evaluateCli(
  candidate: RunnerCandidate & Readonly<{ runner: Extract<RunnerConfig, { kind: 'cli' }> }>,
  context: PreparationContext,
): Promise<SlotEvaluation> {
  const authChannel = resolveCliRunnerAuth(candidate.runner).id;
  const discoveryContext = {
    role: candidate.slot.role === 'planner' ? ('planner' as const) : ('implementer' as const),
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
    // looks correct; readiness already knows which credential is missing.
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        `Fresh CLI evidence denied admission: ${admission.reason.kind}.`,
        admission.reason.kind === 'authentication'
          ? cliAuthRemediation({ tool: candidate.runner.tool, authChannel })
          : undefined,
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

async function evaluateAgentSdk(
  candidate: RunnerCandidate & Readonly<{ runner: Extract<RunnerConfig, { kind: 'agent-sdk' }> }>,
  context: PreparationContext,
): Promise<SlotEvaluation> {
  let apiKey: string | undefined;
  try {
    apiKey = resolveApiKeyOverride(candidate.runner.apiKey) ?? process.env.ANTHROPIC_API_KEY;
  } catch {
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        'Agent SDK credentials are invalid.',
      ),
    };
  }
  if (apiKey === undefined || !(await context.deps.isAgentSdkAvailable(apiKey))) {
    throwIfAborted(context.signal);
    return {
      kind: 'blocked',
      check: blockedCheck(
        candidate.slot,
        candidate.runner.kind,
        'Agent SDK credentials or installation are unavailable.',
      ),
    };
  }
  throwIfAborted(context.signal);
  return {
    kind: 'admitted',
    check: admittedCheck(candidate.slot, candidate.runner.kind),
    gate: {
      kind: 'agent-sdk',
      slot: candidate.slot,
      preparationId: context.preparationId,
      provider: 'anthropic',
    },
  };
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
  const role = candidate.slot.role === 'planner' ? ('planner' as const) : ('implementer' as const);
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

async function evaluateCandidate(
  candidate: RunnerCandidate,
  context: PreparationContext,
): Promise<SlotEvaluation> {
  switch (candidate.runner.kind) {
    case 'cli':
      return evaluateCli({ ...candidate, runner: candidate.runner }, context);
    case 'api':
      return evaluateApi({ ...candidate, runner: candidate.runner }, context);
    case 'agent-sdk':
      return evaluateAgentSdk({ ...candidate, runner: candidate.runner }, context);
    case 'shell':
    case 'agent':
      return evaluateCommand({ ...candidate, runner: candidate.runner }, context);
    default:
      return assertNever(candidate.runner);
  }
}

async function revalidateCliGates(
  gates: readonly RunnerGate[],
  context: PreparationContext,
): Promise<ReadinessCheck[]> {
  const blockers: ReadinessCheck[] = [];
  for (const gate of gates) {
    if (gate.kind !== 'cli') continue;
    try {
      await context.deps.resolveCliExecutableAliases({
        commands: CLI_TOOL_CATALOG[gate.tool].executableAliases,
        projectDir: context.projectDir,
        trust: gate.executable,
      });
      throwIfAborted(context.signal);
    } catch (cause) {
      if (context.signal.aborted || isAbortError(cause)) throw cause;
      blockers.push(
        blockedCheck(gate.slot, gate.kind, 'CLI executable identity changed after admission.'),
      );
    }
  }
  return blockers;
}

/** A spec run never calls the implementer, so its reachability cannot gate one. */
function availabilityRoles(
  purpose: PreparationPolicy['purpose'],
): readonly RunnerAvailabilityRole[] {
  return purpose === 'spec' ? ['planner'] : ['planner', 'implementer'];
}

export async function prepareExecution(input: PrepareExecutionInput): Promise<PreparationOutcome> {
  let report: ReadinessReport | undefined;
  try {
    throwIfAborted(input.signal);
    const resume = 'existingSession' in input;
    const projectDir = resume ? input.existingSession.projectDir : input.projectDir;
    const config = parsePreparedConfig(input.effectiveConfig);
    const deps = { ...DEFAULT_DEPENDENCIES, ...input.deps };
    const preparationId = deps.newPreparationId();
    const collected = await deps.collectReadiness({
      projectDir,
      config,
      cliReadiness: [],
      probeRunnerAvailability: (probe) =>
        deps.probeRunnerAvailability({
          ...probe,
          roles: availabilityRoles(input.policy.purpose),
          signal: input.signal,
        }),
      ...(resume && { resumeSession: input.existingSession }),
    });
    throwIfAborted(input.signal);
    // collectReadiness is given no probe results, so it emits a placeholder
    // blocker per configured CLI. This function supersedes those with its own
    // per-candidate verdicts below, so they are stripped before the status is read.
    report = applyRunnerPreparationChecks(collected.report, []);
    if (report.status === 'blocked') return { kind: 'blocked', report };

    const enumeration = runnerCandidates(config, input.policy.purpose);
    if (enumeration.checks.length > 0) {
      report = applyRunnerPreparationChecks(report, enumeration.checks);
      return { kind: 'blocked', report };
    }

    const nativeTrustViolations = new Set(
      checkRunnerTrust(config, projectDir).violations.map((violation) => violation.label),
    );
    const context: PreparationContext = {
      projectDir,
      config,
      policy: input.policy,
      preparationId,
      signal: input.signal,
      nativeTrustViolations,
      deps,
    };
    const evaluations: SlotEvaluation[] = [];
    let trustPersisted = false;
    for (const candidate of enumeration.candidates) {
      let evaluation: SlotEvaluation;
      try {
        evaluation = await evaluateCandidate(candidate, context);
      } catch (cause) {
        if (input.signal.aborted && trustPersisted) throw persistedTrustAbortError();
        throw cause;
      }
      evaluations.push(evaluation);
      if (evaluation.kind === 'admitted' && evaluation.trustPersisted === true) {
        trustPersisted = true;
      }
      throwIfPreparationAborted(input.signal, trustPersisted);
    }
    report = applyRunnerPreparationChecks(
      report,
      evaluations.map((evaluation) => evaluation.check),
    );
    if (evaluations.some((evaluation) => evaluation.kind === 'blocked')) {
      return { kind: 'blocked', report };
    }

    const gates = evaluations.flatMap((evaluation) =>
      evaluation.kind === 'admitted' ? [evaluation.gate] : [],
    );
    let revalidationBlockers: ReadinessCheck[];
    try {
      revalidationBlockers = await revalidateCliGates(gates, context);
    } catch (cause) {
      if (input.signal.aborted && trustPersisted) throw persistedTrustAbortError();
      throw cause;
    }
    throwIfPreparationAborted(input.signal, trustPersisted);
    if (revalidationBlockers.length > 0) {
      const blockedIds = new Set(revalidationBlockers.map((check) => check.id));
      report = applyRunnerPreparationChecks(collected.report, [
        ...evaluations
          .map((evaluation) => evaluation.check)
          .filter((check) => !blockedIds.has(check.id)),
        ...revalidationBlockers,
      ]);
      return { kind: 'blocked', report };
    }

    // The preflight runs a real binary, so it waits for the trust ladder above
    // to name one. It still lands before any planning is paid for.
    const argVectorChecks = await deps.collectArgVectorPreflightChecks({
      config,
      projectDir,
      includeImplementers: input.policy.purpose !== 'spec',
    });
    throwIfPreparationAborted(input.signal, trustPersisted);
    report = applyRunnerPreparationChecks(report, argVectorChecks);
    if (report.status === 'blocked') return { kind: 'blocked', report };

    let session: PreparedExecutionSession;
    if (resume) {
      throwIfPreparationAborted(input.signal, trustPersisted);
      const active = deps.reactivateExistingSession(input.existingSession);
      session = { kind: 'existing', ref: input.existingSession, active };
    } else {
      throwIfPreparationAborted(input.signal, trustPersisted);
      const preparedSession = deps.prepareNewSession({
        projectDir,
        feature: input.feature,
        config,
        report,
        signal: input.signal,
        ...(input.candidate !== undefined && { candidate: input.candidate }),
      });
      if (preparedSession.kind === 'aborted') {
        if (trustPersisted) throw persistedTrustAbortError();
        return { kind: 'aborted' };
      }
      session = { kind: 'new', ...preparedSession.session };
    }

    return {
      kind: 'prepared',
      execution: {
        purpose: input.policy.purpose,
        config,
        preparationId,
        report,
        gates,
        session,
        runtime: {
          feature: input.feature,
          ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
          ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
          allowRepoRunners: input.policy.allowRepoRunners,
          allowHooks: input.policy.allowHooks,
          ...(input.worktreeName !== undefined && { worktreeName: input.worktreeName }),
        },
      },
    };
  } catch (cause) {
    if (matches(CUSTOM_RUNNER_TRUST_PERSISTED_AFTER_ABORT)(cause)) {
      return {
        kind: 'failed',
        ...(report !== undefined && { report }),
        error: cause,
      };
    }
    if (input.signal.aborted || isAbortError(cause)) return { kind: 'aborted' };
    return {
      kind: 'failed',
      ...(report !== undefined && { report }),
      error:
        cause instanceof Error
          ? cause
          : error('runner-preparation-failed', 'Runner preparation failed.'),
    };
  }
}
