import type { Config } from '../../core/schemas/config.js';
import type { Implementer, ImplementerFactoryOptions } from '../implementers/types.js';
import type { Planner } from '../planners/types.js';
import { warnStderr } from '../../lib/warn.js';
import { assertNever } from '../../utils/type-guards.js';

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
const loadCliImplementer = lazy(() => import('../implementers/cli.js'));
const loadApiImplementer = lazy(() => import('../implementers/api.js'));
const loadShellImplementer = lazy(() => import('../implementers/shell.js'));
const loadAgentImplementer = lazy(() => import('../implementers/agent.js'));
const loadAgentSdkImplementer = lazy(() => import('../implementers/agent-sdk.js'));

async function loadPlanner(config: Config, initialSessionId?: string | null): Promise<Planner> {
  const kind = config.planner.kind;
  switch (kind) {
    case 'cli': {
      if (config.planner.tool === 'claude-code') {
        const mod = await loadClaudeCodePlanner();
        return mod.createClaudeCodePlanner({
          model: config.planner.model,
          initialSessionId,
          effort: config.planner.effort,
          timeout: config.planner.timeout,
          idleWarnMs: config.planner.idleWarnMs,
          idleKillMs: config.planner.idleKillMs,
        });
      }
      const mod = await loadCliPlanner();
      return mod.createCliPlanner(config, initialSessionId);
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
): Promise<Planner> {
  const planner = await loadPlanner(config, initialSessionId);
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
  const kind = config.implementer.kind;
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
