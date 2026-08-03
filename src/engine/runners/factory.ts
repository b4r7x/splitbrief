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
  initialSessionId?: string | null,
  options?: PlannerFactoryOptions,
): Promise<Planner> {
  const configured = resolveConfiguredCustomRunner(config, 'planner');
  if (configured !== null) {
    const runtime = options?.customRuntime;
    if (runtime === undefined) {
      throw customRunnerFactoryError.runtimeUnavailable('planner');
    }
    const mod = await loadConfiguredCustomPlanner();
    return mod.createConfiguredCustomPlanner(configured, runtime);
  }

  if (config.planner.kind === 'cli') {
    assertCliPlannerTool(config.planner.tool);
  }
  const planner = await loadPlanner(config, initialSessionId, options);
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
  options?: ImplementerFactoryOptions,
): Promise<Implementer> {
  const configured = resolveConfiguredCustomRunner(config, 'implementer');
  if (configured !== null) {
    const runtime = options?.customRuntime;
    if (runtime === undefined) {
      throw customRunnerFactoryError.runtimeUnavailable('implementer');
    }
    const mod = await loadConfiguredCustomImplementer();
    return mod.createConfiguredCustomImplementer({
      runner: configured,
      runtime,
      factoryOptions: options,
    });
  }

  const kind = config.implementer.kind;
  if (kind === 'cli') {
    assertCliImplementerTool(config.implementer.tool);
  }
  if (config.implementer.temperature !== undefined && kind !== 'api') {
    warnStderr(
      `implementer-temperature: dropped (${kind} backend does not accept sampling temperature)`,
    );
  }
  switch (kind) {
    case 'cli': {
      const mod = await loadCliImplementer();
      return mod.createCliImplementer(config.implementer, options);
    }
    case 'api': {
      const mod = await loadApiImplementer();
      return mod.createApiImplementer(config, options);
    }
    case 'shell': {
      const mod = await loadShellImplementer();
      return mod.createShellImplementer(config, options);
    }
    case 'agent': {
      const mod = await loadAgentImplementer();
      return mod.createAgentImplementer(config, options);
    }
    case 'agent-sdk': {
      const mod = await loadAgentSdkImplementer();
      return mod.createAgentSdkImplementer(config, options);
    }
    default:
      return assertNever(kind);
  }
}
