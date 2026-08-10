import type { Config } from '../../core/schemas/config.js';
import {
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../core/runners/cli-tool-catalog.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { Planner, PlannerFactoryOptions } from '../planners/types.js';
import { warnStderr } from '../../lib/warn.js';
import { error } from '../../utils/error.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import { resolveConfiguredCustomRunner } from './configured-custom.js';
import { runnerConfigError } from './errors.js';
import { runnerGateFor } from './start-gate.js';
import type {
  PreparedConfig,
  RunnerGate,
  RunnerGateExpectation,
  RunnerSlot,
} from './prepared-execution.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveIntermediateRunner } from '../../core/config/accessors/intermediate-runner.js';

export type RunnerFactoryAuthority = Readonly<{
  preparedConfig: PreparedConfig;
  preparationId: string;
  gates: readonly RunnerGate[];
  slot: RunnerSlot;
}>;

export type PlannerCreationOptions = PlannerFactoryOptions &
  RunnerFactoryAuthority &
  Readonly<{ initialSessionId?: string | null | undefined }>;
export type ImplementerCreationOptions = ImplementerFactoryOptions &
  RunnerFactoryAuthority &
  Readonly<{ intermediateContextLength?: number | undefined }>;

function requireFactoryAuthority(
  config: Config,
  options: RunnerFactoryAuthority | undefined,
  role: 'planner' | 'implementer',
): RunnerFactoryAuthority {
  if (options === undefined) {
    throw error('runner-gate-mismatch', `Runner gate does not match the prepared ${role} context.`);
  }
  if (role === 'planner' && options.slot.role !== 'planner') {
    throw error('runner-gate-mismatch', 'Runner gate does not match the prepared planner context.');
  }
  if (role === 'implementer' && options.slot.role === 'planner') {
    throw error(
      'runner-gate-mismatch',
      'Runner gate does not match the prepared implementer context.',
    );
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
  if ((gate.kind !== 'shell' && gate.kind !== 'agent') || gate.kind !== kind) {
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
  runtimeUnavailable: (role: 'planner' | 'implementer') =>
    error(
      'custom-runner-runtime-unavailable',
      role === 'planner'
        ? 'Configured custom planner requires a custom runner runtime.'
        : 'Configured custom implementer requires a custom runner runtime.',
    ),
} as const;

function assertCliPlannerTool(tool: string): void {
  if (!includes(PLANNER_CLI_TOOL_IDS, tool)) {
    throw runnerConfigError.missingToolConfig(tool, 'planner');
  }
}

function assertCliImplementerTool(tool: string): void {
  if (!includes(IMPLEMENTER_CLI_TOOL_IDS, tool)) {
    throw runnerConfigError.missingToolConfig(tool, 'implementer');
  }
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
      return mod.createCliPlanner(config, initialSessionId, options);
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
  if (configured !== null) {
    const configuredKind = configured.command.contract === 'output' ? 'shell' : 'agent';
    const gate = configuredCommandGate(authority, configuredKind, configured.command.id);
    if (gate.command.kind !== 'configured-custom') {
      throw error('runner-gate-mismatch', 'Configured planner gate is invalid.');
    }
    const runtime = options.customRuntime;
    if (runtime === undefined) {
      throw customRunnerFactoryError.runtimeUnavailable('planner');
    }
    const mod = await loadConfiguredCustomPlanner();
    return mod.createConfiguredCustomPlanner(configured, runtime, gate.command.invocation);
  }

  if (config.planner.kind === 'cli') {
    assertCliPlannerTool(config.planner.tool);
  }
  const gate = runnerGateFor(
    authority.gates,
    gateExpectation({
      runner: config.planner,
      slot: authority.slot,
      preparationId: authority.preparationId,
    }),
  );
  const planner = await loadPlanner(config, options.initialSessionId, {
    ...options,
    ...(gate.kind === 'cli' && { trustedCli: { tool: gate.tool, executable: gate.executable } }),
  });
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

export async function createImplementer(
  config: Config,
  options: ImplementerCreationOptions,
): Promise<Implementer> {
  const authority = requireFactoryAuthority(config, options, 'implementer');
  const effectiveConfig = implementerConfigForAuthority(options);
  const configured = resolveConfiguredCustomRunner(effectiveConfig, 'implementer');
  if (configured !== null) {
    const configuredKind = configured.command.contract === 'output' ? 'shell' : 'agent';
    const gate = configuredCommandGate(authority, configuredKind, configured.command.id);
    if (gate.command.kind !== 'configured-custom') {
      throw error('runner-gate-mismatch', 'Configured implementer gate is invalid.');
    }
    const runtime = options.customRuntime;
    if (runtime === undefined) {
      throw customRunnerFactoryError.runtimeUnavailable('implementer');
    }
    const mod = await loadConfiguredCustomImplementer();
    return mod.createConfiguredCustomImplementer({
      runtime,
      admission: gate.command.invocation,
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
