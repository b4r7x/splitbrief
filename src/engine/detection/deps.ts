import type { Config } from '../../core/schemas/config.js';
import { readActiveRunnerLens } from '../../core/config/accessors/active-runner.js';
import { contentIdentityId } from '../../core/config/accessors/content-identity.js';
import { crewCliTools } from '../../core/crew/seats.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import {
  projectRunnerDiscoveryContext,
  type RunnerDiscoveryContext,
} from '../../core/config/accessors/runner-discovery-context.js';
import { isApiProviderId, type ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import {
  CLI_TOOL_IDS,
  defaultCliAuthChannel,
  NATIVE_CLI_CATALOG_TOOL_IDS,
  type CliAuthChannelId,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import { includes } from '../../utils/type-guards.js';
import { detectAll } from './detect.js';
import { runnerDiscoveryContextKey } from './runner-evidence.js';
import {
  cloneConfiguredProviderOutcome,
  configuredProviderConnection,
  type ConfiguredProviderConnection,
  type ConfiguredProviderOutcome,
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
  readonly reviewer: RunnerDiscoveryContext;
}

interface ConfiguredProviderProbe {
  /** Every seat that publishes this one request's result under its own identity. */
  readonly connections: readonly ConfiguredProviderConnection[];
  readonly provider: ApiProviderId;
  /** Closure-local values only. Never return, publish, or serialize these. */
  readonly overrides: ProviderOverrides;
}

export type ProductionDetectionDeps = DetectionDeps &
  Readonly<{ sourceContexts: ResolvedDetectionSourceContexts }>;

function activeRunnerContexts(config: Config): ActiveRunnerContexts {
  return {
    planner: projectRunnerDiscoveryContext({ config, role: 'planner' }),
    implementer: projectRunnerDiscoveryContext({ config, role: 'implementer' }),
    reviewer: projectRunnerDiscoveryContext({ config, role: 'reviewer' }),
  };
}

function apiProbeForSeat(
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
    connections: [configuredProviderConnection(input.context, runner.provider)],
    provider: runner.provider,
    // An unset credential stays unset: an empty string is a configured
    // keyless connection, which a local provider rejects as a bad reference.
    overrides: {
      apiBase: runner.apiBase,
      ...(runner.apiKey === undefined ? {} : { apiKey: runner.apiKey }),
    },
  };
}

/**
 * One request per distinct seat connection. A configured reviewer is its own
 * connection and gets its own probe. When no reviewer is configured the review
 * seat runs on the planner's connection: it publishes its own seat-exact
 * outcome from the planner's single request instead of asking the same
 * endpoint twice.
 */
function configuredProviderProbes(
  input: Readonly<{ config: Config; contexts: ActiveRunnerContexts }>,
): readonly ConfiguredProviderProbe[] {
  const seatProbe = (role: ActiveRunnerRole): ConfiguredProviderProbe | null =>
    apiProbeForSeat({ config: input.config, role, context: input.contexts[role] });
  const planner = seatProbe('planner');
  const implementer = seatProbe('implementer');
  const reviewer = seatProbe('reviewer');
  const reviewerSharesPlanner = resolveReviewerRunner(input.config).source === 'planner';

  const probes: ConfiguredProviderProbe[] = [];
  if (planner !== null) {
    probes.push(
      reviewerSharesPlanner && reviewer !== null
        ? { ...planner, connections: [...planner.connections, ...reviewer.connections] }
        : planner,
    );
  }
  if (implementer !== null) probes.push(implementer);
  if (reviewer !== null && !reviewerSharesPlanner) probes.push(reviewer);
  return probes;
}

function configuredProviderDetection(
  probes: readonly ConfiguredProviderProbe[],
): (
  input: Readonly<{ signal?: AbortSignal | undefined }>,
) => Promise<readonly ConfiguredProviderOutcome[]> {
  return async ({ signal }) => {
    const results = await Promise.all(
      probes.map(async (probe) => ({
        probe,
        outcome: await detectProviderCatalog({
          provider: probe.provider,
          configOverrides: probe.overrides,
          signal,
        }),
      })),
    );
    return results.flatMap(({ probe, outcome }) =>
      probe.connections.map((connection) =>
        cloneConfiguredProviderOutcome({ connection, outcome }),
      ),
    );
  };
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
 * One context per catalog-capable tool: a model listing belongs to the
 * executable and the user's credentials, not to the seat that will use it. A
 * tool an active runner already uses contributes that runner's real context
 * (planner first); every other tool gets a synthesized complete context on
 * its default channel, with no model and no credential domain. Execution
 * stays behind the same admission gates — an unresolvable executable or
 * incompatible version never spawns a probe.
 */
function catalogDiscoveryContexts(
  contexts: ActiveRunnerContexts,
): readonly RunnerDiscoveryContext[] {
  return NATIVE_CLI_CATALOG_TOOL_IDS.map((tool): RunnerDiscoveryContext => {
    const active = [contexts.planner, contexts.implementer].find(
      (context) => context.kind === 'cli' && context.id === tool,
    );
    if (active !== undefined) return active;
    return {
      role: 'implementer',
      kind: 'cli',
      id: tool,
      authChannel: defaultCliAuthChannel(tool).id,
      credentialPresent: false,
      configGeneration: contexts.implementer.configGeneration,
    };
  });
}

function sourceContext(
  input: Readonly<{
    contexts: ActiveRunnerContexts;
    projectDir: string;
    source: keyof DetectionSourceContexts;
  }>,
): string {
  const { planner, implementer, reviewer } = input.contexts;
  const seats = [planner, implementer, reviewer] as const;
  // The salts key pre-change disk snapshots out of the lanes: readiness gained
  // all-admitted-tools auth probing, cliModels moved from role-scoped to
  // per-tool catalog contexts, and every lane gained the review seat — a stale
  // TTL-valid snapshot from before any of those must never hydrate into the
  // new semantics.
  const sourceLabel =
    input.source === 'readiness'
      ? 'readiness:all-tools'
      : input.source === 'cliModels'
        ? 'cliModels:per-tool'
        : input.source;
  return detectionContextKey({
    platform: process.platform,
    runner: [sourceLabel, ...seats.map((seat) => `${seat.kind}:${seat.id}`)].join(':'),
    authChannel: seats.map((seat) => seat.authChannel ?? 'none').join(':'),
    endpointOrigin: seats.map((seat) => seat.endpointOrigin ?? 'none').join(':'),
    credentialDomain: seats.map(runnerDiscoveryContextKey).join(':'),
    // The path enters the key as a digest: a folder named `my-local-app` is a
    // project name, not the private identifier the cache's key scan refuses.
    configGeneration: [
      contentIdentityId('project', input.projectDir),
      ...seats.map((seat) => seat.configGeneration),
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
        crewTools: crewCliTools(input.config),
        refresh: mode,
        signal,
      }),
    sourceContexts: {
      readiness: sourceContext({ contexts, projectDir: input.projectDir, source: 'readiness' }),
      modelsDev: sourceContext({ contexts, projectDir: input.projectDir, source: 'modelsDev' }),
      cliModels: sourceContext({ contexts, projectDir: input.projectDir, source: 'cliModels' }),
      configuredProviders: providerProbes.flatMap((probe) => probe.connections),
    },
  };
}
