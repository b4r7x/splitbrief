import type { Config } from '../../core/schemas/config.js';
import {
  CLI_COMPILER_EVIDENCE,
  CLI_TOOL_CATALOG,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../core/runners/cli-tool-catalog.js';
import type { PlannerTierRole, ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import { semanticConfiguredArgViolations } from './arg-vector-preflight.js';
import { warnStderr } from '../../lib/warn.js';
import { error } from '../../utils/error.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import type { ConfiguredCustomRunner } from './custom-trust.js';
import type { AdmittedCustomRunnerInvocation } from './custom-launchability.js';
import type { CustomRunnerRuntimePort } from './types.js';
import { runnerConfigError } from './errors.js';
import { runnerGateFor, type CliStartGate } from './start-gate.js';
import type {
  PreparedConfig,
  RunnerGate,
  RunnerGateExpectation,
  RunnerSlot,
} from './prepared-execution.js';
import { runnerRoleForSlot, type RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveIntermediateRunner } from '../../core/config/accessors/intermediate-runner.js';

export type RunnerFactoryAuthority = Readonly<{
  preparedConfig: PreparedConfig;
  preparationId: string;
  gates: readonly RunnerGate[];
  slot: RunnerSlot;
}>;

/**
 * The implementer factory also fills the escalation seat, so it accepts both
 * implementer slots. The planner and reviewer seats are exact: a context
 * admitted for one never constructs the other.
 */
function slotServesFactoryRole(slot: RunnerSlot, role: ActiveRunnerRole): boolean {
  if (role === 'implementer') return runnerRoleForSlot(slot) === 'implementer';
  return slot.role === role;
}

export function requireFactoryAuthority(
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

export function implementerConfigForAuthority(
  authority: RunnerFactoryAuthority &
    Readonly<{
      slot: Extract<RunnerSlot, { role: 'implementer' | 'intermediate' }>;
      intermediateContextLength?: number | undefined;
    }>,
): Config {
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

export function gateExpectation(
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

export const customRunnerFactoryError = {
  runtimeUnavailable: (role: ActiveRunnerRole) =>
    error(
      'custom-runner-runtime-unavailable',
      `Configured custom ${role} requires a custom runner runtime.`,
    ),
} as const;

export function resolveConfiguredCustomGate(
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

export function assertCliImplementerTool(tool: string): void {
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
export function admitPlannerBackend(
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

/**
 * `variant` is a named effort preset the tool takes on its own command line, so
 * only a backend whose declared effort channel IS that flag can deliver one.
 */
function deliversVariant(runner: RunnerConfig): boolean {
  return runner.kind === 'cli' && CLI_TOOL_CATALOG[runner.tool].effortChannel === 'variant';
}

/**
 * Generation fields the schema accepts on every runner but only some backends
 * can carry. `supportsEffort` is the constructed adapter's own answer; the
 * implementer seat passes none, so it reports no effort drop.
 */
export function warnDroppedRunnerFields(
  input: Readonly<{
    runner: RunnerConfig;
    seat: ActiveRunnerRole;
    supportsEffort?: boolean | undefined;
  }>,
): void {
  const { runner, seat } = input;
  if (runner.effort && input.supportsEffort === false) {
    warnStderr(`${seat}-effort: dropped (${runner.kind} backend has no reasoning control)`);
  }
  if (runner.variant !== undefined && !deliversVariant(runner)) {
    warnStderr(`${seat}-variant: dropped (${runner.kind} backend has no named effort preset)`);
  }
  if (runner.temperature !== undefined && runner.kind !== 'api') {
    warnStderr(
      `${seat}-temperature: dropped (${runner.kind} backend does not accept sampling temperature)`,
    );
  }
}
