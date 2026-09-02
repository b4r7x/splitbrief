import type { Config } from '../../core/schemas/config.js';
import { readActiveRunnerLens } from '../../core/config/accessors/active-runner.js';
import {
  projectRunnerDiscoveryContext,
  type RunnerDiscoveryContext,
} from '../../core/config/accessors/runner-discovery-context.js';
import { isApiProviderId } from '../../core/providers/api-provider-catalog.js';
import {
  CLI_TOOL_IDS,
  defaultCliAuthChannel,
  NATIVE_CLI_CATALOG_TOOL_IDS,
  type CliAuthChannelId,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import type { RunnerRole, ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import { includes } from '../../utils/type-guards.js';
import { detectAll } from './detect.js';
import { runnerDiscoveryContextKey } from './runner-evidence.js';
import type {
  ConfiguredProviderConnection,
  ConfiguredProviderOutcome,
} from './provider-outcomes.js';
import { detectionContextKey } from './types.js';
import type {
  DetectionDeps,
  DetectionSourceContexts,
  ResolvedDetectionSourceContexts,
} from './service.js';
import { fetchModelsDevCatalogWithCache } from '../providers/models-dev.js';
import { discoverAllCliTools } from '../providers/discovery.js';
import { detectProviderCatalog } from '../providers/catalog-detection.js';
import type { ProviderOverrides } from '../providers/types.js';

interface ActiveRunnerContexts {
  readonly planner: RunnerDiscoveryContext;
  readonly implementer: RunnerDiscoveryContext;
}

interface ConfiguredProviderProbe {
  readonly connection: ConfiguredProviderConnection;
  /** Closure-local values only. Never return, publish, or serialize these. */
  readonly overrides: ProviderOverrides;
}

export type ProductionDetectionDeps = DetectionDeps &
  Readonly<{ sourceContexts: ResolvedDetectionSourceContexts }>;

function activeRunnerContexts(config: Config): ActiveRunnerContexts {
  return {
    planner: projectRunnerDiscoveryContext({ config, role: 'planner' }),
    implementer: projectRunnerDiscoveryContext({ config, role: 'implementer' }),
  };
}

function connectionFor(
  context: RunnerDiscoveryContext,
  provider: ConfiguredProviderConnection['provider'],
): ConfiguredProviderConnection {
  return {
    role: context.role,
    provider,
    contextKey: runnerDiscoveryContextKey(context),
  };
}

function apiProbeForRole(
  input: Readonly<{
    config: Config;
    role: ActiveRunnerRole;
    context: RunnerDiscoveryContext;
  }>,
): ConfiguredProviderProbe | null {
  // Deliberately read the active lens independently from the context
  // projection. The raw values stay in this closure and never become context
  // or cache data.
  const runner = readActiveRunnerLens({ config: input.config, role: input.role }).runner;
  if (runner.kind !== 'api' || !isApiProviderId(runner.provider)) return null;
  return {
    connection: connectionFor(input.context, runner.provider),
    overrides: { apiBase: runner.apiBase, apiKey: runner.apiKey ?? '' },
  };
}

function configuredProviderProbes(
  input: Readonly<{ config: Config; contexts: ActiveRunnerContexts }>,
): readonly ConfiguredProviderProbe[] {
  const roles: readonly RunnerRole[] = ['planner', 'implementer'];
  return roles
    .map((role) => apiProbeForRole({ config: input.config, role, context: input.contexts[role] }))
    .filter((probe): probe is ConfiguredProviderProbe => probe !== null);
}

function configuredProviderDetection(
  probes: readonly ConfiguredProviderProbe[],
): (
  input: Readonly<{ signal?: AbortSignal | undefined }>,
) => Promise<readonly ConfiguredProviderOutcome[]> {
  return ({ signal }) =>
    Promise.all(
      probes.map(async (probe) => ({
        connection: probe.connection,
        outcome: await detectProviderCatalog({
          provider: probe.connection.provider,
          configOverrides: probe.overrides,
          signal,
        }),
      })),
    );
}

/**
 * Every admitted CLI is probed on the channel a fresh config would name for it,
 * so the status a not-yet-selected tool shows is the status of the selection the
 * picker would actually write; an active runner context overrides only its own
 * tool with the channel the config resolved for it. Only defined channels are
 * inserted — an explicitly undefined entry would withhold auth probing.
 */
function admittedCliAuthChannels(
  contexts: ActiveRunnerContexts,
): Partial<Record<CliToolId, CliAuthChannelId>> {
  const channels: Partial<Record<CliToolId, CliAuthChannelId>> = {};
  for (const id of CLI_TOOL_IDS) channels[id] = defaultCliAuthChannel(id).id;
  for (const context of [contexts.planner, contexts.implementer]) {
    if (
      context.kind === 'cli' &&
      context.authChannel !== undefined &&
      includes(CLI_TOOL_IDS, context.id)
    ) {
      channels[context.id] = context.authChannel;
    }
  }
  return channels;
}

/**
 * The native-catalog lane probes every admitted catalog-capable tool, not just
 * the active roles' tools: each role keeps its real context for its own tool
 * and gains synthesized complete contexts (default channel, no model, no
 * credential domain) for the rest, so non-selected tools still surface their
 * provider/model space. Execution stays behind the same admission gates —
 * an unresolvable executable or incompatible version never spawns a probe.
 */
function catalogDiscoveryContexts(
  contexts: ActiveRunnerContexts,
): readonly RunnerDiscoveryContext[] {
  const result: RunnerDiscoveryContext[] = [contexts.planner, contexts.implementer];
  for (const role of ['planner', 'implementer'] as const) {
    const active = contexts[role];
    for (const tool of NATIVE_CLI_CATALOG_TOOL_IDS) {
      if (active.kind === 'cli' && active.id === tool) continue;
      result.push({
        role,
        kind: 'cli',
        id: tool,
        authChannel: defaultCliAuthChannel(tool).id,
        credentialPresent: false,
        configGeneration: active.configGeneration,
      });
    }
  }
  return result;
}

function sourceContext(
  input: Readonly<{
    contexts: ActiveRunnerContexts;
    projectDir: string;
    source: keyof DetectionSourceContexts;
  }>,
): string {
  const { planner, implementer } = input.contexts;
  // The ':all-tools' salts key pre-widening disk snapshots out of the lanes:
  // readiness gained all-admitted-tools auth probing, cliModels gained
  // all-admitted-tools catalog contexts; a stale TTL-valid snapshot from
  // before either widening must never hydrate into the new semantics.
  const sourceLabel =
    input.source === 'readiness'
      ? 'readiness:all-tools'
      : input.source === 'cliModels'
        ? 'cliModels:all-tools'
        : input.source;
  return detectionContextKey({
    platform: process.platform,
    runner: `${sourceLabel}:${planner.kind}:${planner.id}:${implementer.kind}:${implementer.id}`,
    authChannel: `${planner.authChannel ?? 'none'}:${implementer.authChannel ?? 'none'}`,
    endpointOrigin: `${planner.endpointOrigin ?? 'none'}:${implementer.endpointOrigin ?? 'none'}`,
    credentialDomain: [
      runnerDiscoveryContextKey(planner),
      runnerDiscoveryContextKey(implementer),
    ].join(':'),
    configGeneration: [
      input.projectDir,
      planner.configGeneration,
      implementer.configGeneration,
    ].join(':'),
  });
}

export function createProductionDetectionDeps(
  input: Readonly<{ config: Config; projectDir: string }>,
): ProductionDetectionDeps {
  const contexts = activeRunnerContexts(input.config);
  const providerProbes = configuredProviderProbes({ config: input.config, contexts });
  return {
    detectAll: ({ signal }) =>
      detectAll({
        authChannels: admittedCliAuthChannels(contexts),
        detectConfiguredProviderOutcomes: configuredProviderDetection(providerProbes),
        signal,
      }),
    fetchModelsDevCatalog: ({ mode, signal }) => fetchModelsDevCatalogWithCache({ mode, signal }),
    discoverAllCliTools: ({ mode, signal }) =>
      discoverAllCliTools({
        contexts: catalogDiscoveryContexts(contexts),
        projectDir: input.projectDir,
        refresh: mode,
        signal,
      }),
    sourceContexts: {
      readiness: sourceContext({ contexts, projectDir: input.projectDir, source: 'readiness' }),
      modelsDev: sourceContext({ contexts, projectDir: input.projectDir, source: 'modelsDev' }),
      cliModels: sourceContext({ contexts, projectDir: input.projectDir, source: 'cliModels' }),
    },
  };
}
