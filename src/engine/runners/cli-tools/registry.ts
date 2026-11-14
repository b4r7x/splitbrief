import {
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { RunnerRole } from '../../../core/runners/seat-roles.js';
import type { PlannerCliToolId, ImplementerCliToolId } from '../../../core/schemas/enums.js';
import { includes } from '../../../utils/type-guards.js';
import { runnerConfigError } from '../errors.js';
import type { PromptLimit } from '../input-limit.js';
import { antigravityImplementerAdapter, antigravityPlannerAdapter } from './antigravity/adapter.js';
import { claudeCodeImplementerAdapter, claudeCodePlannerAdapter } from './claude-code/adapter.js';
import { codexImplementerAdapter, codexPlannerAdapter } from './codex/adapter.js';
import {
  commandCodeImplementerAdapter,
  commandCodePlannerAdapter,
} from './command-code/adapter.js';
import { copilotImplementerAdapter, copilotPlannerAdapter } from './copilot/adapter.js';
import { cursorImplementerAdapter, cursorPlannerAdapter } from './cursor/adapter.js';
import { kiloImplementerAdapter, kiloPlannerAdapter } from './kilo-code.js';
import { opencodeImplementerAdapter, opencodePlannerAdapter } from './opencode/adapter.js';
import type { CliImplementerAdapter, CliPlannerAdapter } from './contract.js';
import type {
  CliDeclaredProbeContract,
  CliProbeContract,
  CliVersionProbe,
} from './probe/contract.js';
import { parseVersion } from './probe/version.js';
import { declaredAuthProbe } from './probe/auth.js';
import { frozenProbeContract } from './probe/declared.js';
import { declaredCatalogProbe } from './probe/catalog.js';

function declaredProbe(
  adapter: CliPlannerAdapter | CliImplementerAdapter,
): CliDeclaredProbeContract {
  const tool = adapter.descriptor.id;
  const command = adapter.descriptor.command;
  const version: CliVersionProbe = {
    ...adapter.probe.version,
    kind: 'version',
    parse: (output) => parseVersion(tool, command, output),
  };
  return {
    kind: 'declared',
    version,
    auth: declaredAuthProbe(tool, command),
    catalog: declaredCatalogProbe(tool),
  };
}

function withDeclaredPlannerProbe(adapter: CliPlannerAdapter): CliPlannerAdapter {
  const declared = declaredProbe(adapter);
  return Object.freeze({
    ...adapter,
    probe: frozenProbeContract(adapter.probe, declared),
  });
}

function withDeclaredImplementerProbe(adapter: CliImplementerAdapter): CliImplementerAdapter {
  const declared = declaredProbe(adapter);
  return Object.freeze({
    ...adapter,
    probe: frozenProbeContract(adapter.probe, declared),
  });
}

function assembleImplementerAdapters(): Record<ImplementerCliToolId, CliImplementerAdapter> {
  const adapters = {
    'claude-code': withDeclaredImplementerProbe(claudeCodeImplementerAdapter),
    codex: withDeclaredImplementerProbe(codexImplementerAdapter),
    opencode: withDeclaredImplementerProbe(opencodeImplementerAdapter),
    copilot: withDeclaredImplementerProbe(copilotImplementerAdapter),
    'kilo-code': withDeclaredImplementerProbe(kiloImplementerAdapter),
    cursor: withDeclaredImplementerProbe(cursorImplementerAdapter),
    'command-code': withDeclaredImplementerProbe(commandCodeImplementerAdapter),
    antigravity: withDeclaredImplementerProbe(antigravityImplementerAdapter),
  } satisfies Record<ImplementerCliToolId, CliImplementerAdapter>;

  return Object.freeze(adapters);
}

function assemblePlannerAdapters(): Record<PlannerCliToolId, CliPlannerAdapter> {
  return Object.freeze({
    'claude-code': withDeclaredPlannerProbe(claudeCodePlannerAdapter),
    codex: withDeclaredPlannerProbe(codexPlannerAdapter),
    opencode: withDeclaredPlannerProbe(opencodePlannerAdapter),
    copilot: withDeclaredPlannerProbe(copilotPlannerAdapter),
    'kilo-code': withDeclaredPlannerProbe(kiloPlannerAdapter),
    cursor: withDeclaredPlannerProbe(cursorPlannerAdapter),
    'command-code': withDeclaredPlannerProbe(commandCodePlannerAdapter),
    antigravity: withDeclaredPlannerProbe(antigravityPlannerAdapter),
  });
}

export const CLI_PLANNER_ADAPTERS = assemblePlannerAdapters();
export const CLI_IMPLEMENTER_ADAPTERS = assembleImplementerAdapters();

export function lookupCliPlannerAdapter(toolId: string): CliPlannerAdapter {
  if (!includes(PLANNER_CLI_TOOL_IDS, toolId)) {
    throw runnerConfigError.missingToolConfig(toolId, 'planner');
  }
  return CLI_PLANNER_ADAPTERS[toolId];
}

export function lookupCliImplementerAdapter(toolId: string): CliImplementerAdapter {
  if (!includes(IMPLEMENTER_CLI_TOOL_IDS, toolId)) {
    throw runnerConfigError.missingToolConfig(toolId, 'implementer');
  }
  return CLI_IMPLEMENTER_ADAPTERS[toolId];
}

/** The prompt limit a CLI tool declares for a seat role; undefined for a tool without one. */
export function cliPromptLimit(
  role: 'planner' | 'implementer',
  toolId: string,
): PromptLimit | undefined {
  if (role === 'implementer') {
    return includes(IMPLEMENTER_CLI_TOOL_IDS, toolId)
      ? CLI_IMPLEMENTER_ADAPTERS[toolId].promptLimit
      : undefined;
  }
  return includes(PLANNER_CLI_TOOL_IDS, toolId)
    ? CLI_PLANNER_ADAPTERS[toolId].promptLimit
    : undefined;
}

/** Returns the admitted role-bound probe without exposing any probe output. */
export function lookupCliReadinessProbe(
  input: Readonly<{
    tool: CliToolId;
    role: RunnerRole;
  }>,
): CliProbeContract {
  return input.role === 'planner'
    ? lookupCliPlannerAdapter(input.tool).probe
    : lookupCliImplementerAdapter(input.tool).probe;
}

/**
 * Catalog admission is allowed only for the immutable declared probe instance
 * owned by the selected production adapter. This is intentionally identity
 * based: a structurally similar caller-supplied contract is not evidence.
 */
export function isCanonicalCliDeclaredProbe(
  input: Readonly<{
    tool: CliToolId;
    role?: RunnerRole | undefined;
    probe: CliDeclaredProbeContract;
  }>,
): boolean {
  const declared =
    input.role === 'planner'
      ? [CLI_PLANNER_ADAPTERS[input.tool].probe.declared]
      : input.role === 'implementer'
        ? [CLI_IMPLEMENTER_ADAPTERS[input.tool].probe.declared]
        : [
            CLI_PLANNER_ADAPTERS[input.tool].probe.declared,
            CLI_IMPLEMENTER_ADAPTERS[input.tool].probe.declared,
          ];
  return declared.some((candidate) => candidate === input.probe);
}
