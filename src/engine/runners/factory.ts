import type { Config } from '../../core/schemas/config.js';
import {
  CLI_COMPILER_EVIDENCE,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  type PlannerTierRole,
  type ActiveRunnerRole,
} from '../../core/runners/cli-tool-catalog.js';
import { semanticConfiguredArgViolations } from './arg-vector-preflight.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { Planner, PlannerFactoryOptions } from '../planners/types.js';
import type { Reviewer } from '../reviewers/types.js';
import { warnStderr } from '../../lib/warn.js';
import { error } from '../../utils/error.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';
import type { ConfiguredCustomRunner } from './custom-trust.js';
import type { AdmittedCustomRunnerInvocation } from './custom-launchability.js';
import type { CustomRunnerRuntimePort } from './types.js';
import { runnerConfigError } from './errors.js';
import { runnerGateFor, type CliStartGate } from './start-gate.js';
import { installRunCompiler } from './compiler-seam.js';
import type {
  PreparedConfig,
  RunnerGate,
  RunnerGateExpectation,
  RunnerSlot,
} from './prepared-execution.js';
import { runnerRoleForSlot, type RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveIntermediateRunner } from '../../core/config/accessors/intermediate-runner.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';

export type RunnerFactoryAuthority = Readonly<{
  preparedConfig: PreparedConfig;
  preparationId: string;
  gates: readonly RunnerGate[];
  slot: RunnerSlot;
}>;

export type PlannerCreationOptions = PlannerFactoryOptions &
  RunnerFactoryAuthority &
  Readonly<{
    initialSessionId?: string | null | undefined;
    /**
     * The run's project root. The remembered detection evidence a compiler
     * claim reuses is written per project, so a construction that omits it
     * pays for a fresh runtime probe instead of reading another project's
     * record.
     */
    projectDir?: string | undefined;
  }>;
type ReviewerCreationOptions = PlannerFactoryOptions & RunnerFactoryAuthority;
export type ImplementerCreationOptions = ImplementerFactoryOptions &
  RunnerFactoryAuthority &
  Readonly<{ intermediateContextLength?: number | undefined }>;

/**
 * The implementer factory also fills the escalation seat, so it accepts both
 * implementer slots. The planner and reviewer seats are exact: a context
 * admitted for one never constructs the other.
 */
function slotServesFactoryRole(slot: RunnerSlot, role: ActiveRunnerRole): boolean {
  if (role === 'implementer') return runnerRoleForSlot(slot) === 'implementer';
  return slot.role === role;
}

function requireFactoryAuthority(
  config: Config,
  options: RunnerFactoryAuthority | undefined,
  role: ActiveRunnerRole,
): RunnerFactoryAuthority {
  if (options === undefined) {
    throw error('runner-gate-mismatch', `Runner gate does not match the prepared ${role} context.`);
  }
  if (!slotServesFactoryRole(options.slot, role)) {
    throw error('runner-gate-mismatch', `Runner gate does not match the prepared ${role} context.`);
  }
  if (config !== options.preparedConfig) {
    throw error(
      'runner-gate-mismatch',
      `Runner gate does not match the exact prepared ${role} configuration.`,
    );
  }
  return options;
}

function implementerConfigForAuthority(authority: ImplementerCreationOptions): Config {
  const config = authority.preparedConfig;
  const slot = authority.slot;
  if (slot.role === 'intermediate') {
    const resolved = resolveIntermediateRunner(config, {
      ...(authority.intermediateContextLength !== undefined && {
        contextLength: authority.intermediateContextLength,
      }),
    });
    if (resolved === null) {
      throw error('runner-gate-mismatch', 'Prepared intermediate runner is unavailable.');
    }
    const intermediateConfig = { ...config, implementer: resolved.runner };
    delete intermediateConfig.implementerProfiles;
    return intermediateConfig;
  }

  const profile = resolveImplementerProfiles(config).profiles.find(
    (candidate) => candidate.name === slot.profile,
  );
  if (profile === undefined) {
    throw error(
      'runner-gate-mismatch',
      `Prepared implementer profile "${slot.profile}" is unavailable.`,
    );
  }
  if (config.implementerProfiles === undefined) return config;
  return {
    ...config,
    implementer: profile.config,
    implementerProfiles: {
      ...config.implementerProfiles,
      default: profile.name,
    },
  };
}

function gateExpectation(
  input: Readonly<{
    runner: RunnerConfig;
    slot: RunnerSlot;
    preparationId: string;
  }>,
): RunnerGateExpectation {
  const base = { slot: input.slot, preparationId: input.preparationId };
  switch (input.runner.kind) {
    case 'cli':
      return { ...base, kind: 'cli', tool: input.runner.tool };
    case 'api':
      return {
        ...base,
        kind: 'api',
        provider: input.runner.provider,
        endpointOrigin: new URL(input.runner.apiBase).origin,
      };
    case 'agent-sdk':
      return { ...base, kind: 'agent-sdk', provider: 'anthropic' };
    case 'shell':
      return { ...base, kind: 'shell', command: { kind: 'validated-config' } };
    case 'agent':
      return { ...base, kind: 'agent', command: { kind: 'validated-config' } };
    default:
      return assertNever(input.runner);
  }
}

function configuredCommandGate(
  authority: RunnerFactoryAuthority,
  kind: 'shell' | 'agent',
  definitionId: string,
): Extract<RunnerGate, { kind: 'shell' | 'agent' }> {
  const expected = {
    slot: authority.slot,
    preparationId: authority.preparationId,
    command: { kind: 'configured-custom' as const, definitionId },
  };
  const gate = runnerGateFor(
    authority.gates,
    kind === 'shell' ? { ...expected, kind: 'shell' } : { ...expected, kind: 'agent' },
  );
  if (gate.kind !== kind) {
    throw error('runner-gate-mismatch', 'Configured runner gate is invalid.');
  }
  return gate;
}

function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= load());
}

const loadClaudeCodePlanner = lazy(() => import('../planners/claude-code.js'));
const loadCliPlanner = lazy(() => import('../planners/cli.js'));
const loadApiPlanner = lazy(() => import('../planners/api.js'));
const loadShellPlanner = lazy(() => import('../planners/shell.js'));
const loadAgentPlanner = lazy(() => import('../planners/agent.js'));
const loadAgentSdkPlanner = lazy(() => import('../planners/agent-sdk.js'));
const loadConfiguredCustomPlanner = lazy(() => import('../planners/command-invoke.js'));
const loadCliImplementer = lazy(() => import('../implementers/cli.js'));
const loadApiImplementer = lazy(() => import('../implementers/api.js'));
const loadShellImplementer = lazy(() => import('../implementers/shell.js'));
const loadAgentImplementer = lazy(() => import('../implementers/agent.js'));
const loadAgentSdkImplementer = lazy(() => import('../implementers/agent-sdk.js'));
const loadConfiguredCustomImplementer = lazy(() => import('../implementers/command-invoke.js'));

export const customRunnerFactoryError = {
  runtimeUnavailable: (role: ActiveRunnerRole) =>
    error(
      'custom-runner-runtime-unavailable',
      `Configured custom ${role} requires a custom runner runtime.`,
    ),
} as const;

function resolveConfiguredCustomGate(
  options: Readonly<{
    authority: RunnerFactoryAuthority;
    configured: ConfiguredCustomRunner;
    customRuntime: CustomRunnerRuntimePort | undefined;
    role: ActiveRunnerRole;
  }>,
): Readonly<{ runtime: CustomRunnerRuntimePort; invocation: AdmittedCustomRunnerInvocation }> {
  const { authority, configured, customRuntime, role } = options;
  const kind = configured.command.contract === 'output' ? 'shell' : 'agent';
  const gate = configuredCommandGate(authority, kind, configured.command.id);
  if (gate.command.kind !== 'configured-custom') {
    throw error('runner-gate-mismatch', `Configured ${role} gate is invalid.`);
  }
  if (customRuntime === undefined) {
    throw customRunnerFactoryError.runtimeUnavailable(role);
  }
  return { runtime: customRuntime, invocation: gate.command.invocation };
}

function assertCliPlannerTool(tool: string, seat: PlannerTierRole): void {
  if (!includes(PLANNER_CLI_TOOL_IDS, tool)) {
    throw runnerConfigError.missingToolConfig(tool, seat);
  }
}

function assertCliImplementerTool(tool: string): void {
  if (!includes(IMPLEMENTER_CLI_TOOL_IDS, tool)) {
    throw runnerConfigError.missingToolConfig(tool, 'implementer');
  }
}

/**
 * One admission path (REQ-016, REQ-018, REQ-047): every planner construction
 * crosses this decision before any adapter exists, so no backend can bypass
 * capability admission. A CLI row the compiler catalog marks unsupported — on
 * the planner seat only, since a reviewer compiles nothing — or a configured
 * argument vector that overrides authority SPLITBRIEF owns, is a typed
 * zero-dispatch refusal; an admitted CLI tool is bound to its prepared start
 * gate, which the adapter revalidates immediately before every spawn.
 */
function admitPlannerBackend(
  input: Readonly<{
    config: Config;
    authority: RunnerFactoryAuthority;
    seat: PlannerTierRole;
  }>,
): Readonly<{ trustedCli?: CliStartGate | undefined }> {
  const runner = input.config.planner;
  if (runner.kind === 'cli') {
    assertCliPlannerTool(runner.tool, input.seat);
    const evidence = CLI_COMPILER_EVIDENCE[runner.tool];
    if (input.seat === 'planner' && evidence.state === 'unsupported') {
      throw plannerCapabilityRefusal({
        seat: input.seat,
        backend: runner.tool,
        reason: evidence.unsupportedReason ?? 'no compiler conformance row exists',
        missing: ['backend'],
      });
    }
    const violations = semanticConfiguredArgViolations(runner.args ?? []);
    if (violations.length > 0) {
      throw plannerCapabilityRefusal({
        seat: input.seat,
        backend: runner.tool,
        reason: `the configured arguments override authority SPLITBRIEF owns: ${violations.join(', ')}`,
        missing: ['configuration'],
      });
    }
  }
  const gate = runnerGateFor(
    input.authority.gates,
    gateExpectation({
      runner,
      slot: input.authority.slot,
      preparationId: input.authority.preparationId,
    }),
  );
  return gate.kind === 'cli'
    ? { trustedCli: { tool: gate.tool, executable: gate.executable } }
    : {};
}

/**
 * The compilation clause belongs to the planner seat alone: the reviewer holds
 * a read-only seat that compiles no Task Brief, so its refusal names the seat
 * and states only the cause.
 */
function plannerCapabilityRefusal(
  input: Readonly<{
    seat: PlannerTierRole;
    backend: string;
    reason: string;
    missing: readonly string[];
  }>,
): never {
  throw error(
    'task_compiler_capability_unsupported',
    input.seat === 'reviewer'
      ? `The ${input.backend} reviewer is not admitted: ${input.reason}`
      : `The ${input.backend} planner is not admitted for Task Brief compilation in V1: ${input.reason}`,
    { backend: input.backend, missing: [...input.missing] },
  );
}

async function loadPlanner(
  config: Config,
  initialSessionId?: string | null,
  options?: PlannerFactoryOptions,
): Promise<Planner> {
  const kind = config.planner.kind;
  switch (kind) {
    case 'cli': {
      if (config.planner.tool === 'claude-code') {
        const mod = await loadClaudeCodePlanner();
        return mod.createClaudeCodePlanner({
          authChannel: config.planner.authChannel,
          trustedCli: options?.trustedCli,
          model: config.planner.model,
          initialSessionId,
          effort: config.planner.effort,
          args: config.planner.args,
          timeout: config.planner.timeout,
          idleWarnMs: config.planner.idleWarnMs,
          idleKillMs: config.planner.idleKillMs,
        });
      }
      const mod = await loadCliPlanner();
      return mod.createCliPlanner({ config, initialSessionId, ...options });
    }
    case 'api': {
      const mod = await loadApiPlanner();
      return mod.createApiPlanner(config);
    }
    case 'shell': {
      const mod = await loadShellPlanner();
      return mod.createShellPlanner(config);
    }
    case 'agent': {
      const mod = await loadAgentPlanner();
      return mod.createAgentPlanner(config);
    }
    case 'agent-sdk': {
      const mod = await loadAgentSdkPlanner();
      return mod.createAgentSdkPlanner({
        model: config.planner.model,
        apiKey: config.planner.apiKey,
        initialSessionId,
        effort: config.planner.effort,
        timeout: config.planner.timeout,
        idleWarnMs: config.planner.idleWarnMs,
        idleKillMs: config.planner.idleKillMs,
      });
    }
    default:
      return assertNever(kind);
  }
}

export async function createPlanner(
  config: Config,
  options: PlannerCreationOptions,
): Promise<Planner> {
  const authority = requireFactoryAuthority(config, options, 'planner');
  const configured = resolveConfiguredCustomRunner(config, 'planner');
  let planner: Planner;
  let trustedCli: CliStartGate | undefined;

  if (configured !== null) {
    const { runtime, invocation } = resolveConfiguredCustomGate({
      authority,
      configured,
      customRuntime: options.customRuntime,
      role: 'planner',
    });
    const mod = await loadConfiguredCustomPlanner();
    planner = mod.createConfiguredCustomPlanner(configured, runtime, invocation);
  } else {
    const admission = admitPlannerBackend({ config, authority, seat: 'planner' });
    trustedCli = admission.trustedCli;
    planner = await loadPlanner(config, options.initialSessionId, {
      ...options,
      ...(admission.trustedCli !== undefined && { trustedCli: admission.trustedCli }),
    });
  }

  await installRunCompiler({ planner, config, projectDir: options.projectDir, trustedCli });
  if (config.planner.effort && !planner.capabilities.supportsEffort) {
    warnStderr(`planner-effort: dropped (${config.planner.kind} backend has no reasoning control)`);
  }
  if (config.planner.temperature !== undefined && config.planner.kind !== 'api') {
    warnStderr(
      `planner-temperature: dropped (${config.planner.kind} backend does not accept sampling temperature)`,
    );
  }
  return planner;
}

/**
 * The review seat: one read-only call against the reviewer runner, which is the
 * planner when no `reviewer:` block is configured. It loads through the planner
 * backends but never carries the Task Brief compiler — a reviewer compiles
 * nothing.
 */
export async function createReviewer(
  config: Config,
  options: ReviewerCreationOptions,
): Promise<Reviewer> {
  const authority = requireFactoryAuthority(config, options, 'reviewer');
  const runner = resolveReviewerRunner(config).runner;
  const configured = resolveConfiguredCustomRunner(config, 'reviewer');
  let reviewer: Planner;

  if (configured !== null) {
    const { runtime, invocation } = resolveConfiguredCustomGate({
      authority,
      configured,
      customRuntime: options.customRuntime,
      role: 'reviewer',
    });
    const mod = await loadConfiguredCustomPlanner();
    reviewer = mod.createConfiguredCustomPlanner(configured, runtime, invocation);
  } else {
    // `loadPlanner` reads `config.planner` by contract, so the review seat reaches
    // the planner backends as a config whose planner slot holds the reviewer.
    const reviewerConfig: Config = { ...config, planner: runner };
    const admission = admitPlannerBackend({ config: reviewerConfig, authority, seat: 'reviewer' });
    reviewer = await loadPlanner(reviewerConfig, null, {
      ...options,
      ...(admission.trustedCli !== undefined && { trustedCli: admission.trustedCli }),
    });
  }

  if (runner.effort && !reviewer.capabilities.supportsEffort) {
    warnStderr(`reviewer-effort: dropped (${runner.kind} backend has no reasoning control)`);
  }
  if (runner.temperature !== undefined && runner.kind !== 'api') {
    warnStderr(
      `reviewer-temperature: dropped (${runner.kind} backend does not accept sampling temperature)`,
    );
  }
  return reviewer;
}

export async function createImplementer(
  config: Config,
  options: ImplementerCreationOptions,
): Promise<Implementer> {
  const authority = requireFactoryAuthority(config, options, 'implementer');
  const effectiveConfig = implementerConfigForAuthority(options);
  const configured = resolveConfiguredCustomRunner(effectiveConfig, 'implementer');
  if (configured !== null) {
    const { runtime, invocation } = resolveConfiguredCustomGate({
      authority,
      configured,
      customRuntime: options.customRuntime,
      role: 'implementer',
    });
    const mod = await loadConfiguredCustomImplementer();
    return mod.createConfiguredCustomImplementer({
      runtime,
      admission: invocation,
      factoryOptions: options,
    });
  }

  const kind = effectiveConfig.implementer.kind;
  if (kind === 'cli') {
    assertCliImplementerTool(effectiveConfig.implementer.tool);
  }
  if (effectiveConfig.implementer.temperature !== undefined && kind !== 'api') {
    warnStderr(
      `implementer-temperature: dropped (${kind} backend does not accept sampling temperature)`,
    );
  }
  const gate = runnerGateFor(
    authority.gates,
    gateExpectation({
      runner: effectiveConfig.implementer,
      slot: authority.slot,
      preparationId: authority.preparationId,
    }),
  );
  const adapterOptions: ImplementerFactoryOptions = {
    ...options,
    ...(gate.kind === 'cli' && { trustedCli: { tool: gate.tool, executable: gate.executable } }),
  };
  switch (kind) {
    case 'cli': {
      const mod = await loadCliImplementer();
      return mod.createCliImplementer(effectiveConfig.implementer, adapterOptions);
    }
    case 'api': {
      const mod = await loadApiImplementer();
      return mod.createApiImplementer(effectiveConfig, adapterOptions);
    }
    case 'shell': {
      const mod = await loadShellImplementer();
      return mod.createShellImplementer(effectiveConfig, adapterOptions);
    }
    case 'agent': {
      const mod = await loadAgentImplementer();
      return mod.createAgentImplementer(effectiveConfig, adapterOptions);
    }
    case 'agent-sdk': {
      const mod = await loadAgentSdkImplementer();
      return mod.createAgentSdkImplementer(effectiveConfig, adapterOptions);
    }
    default:
      return assertNever(kind);
  }
}
