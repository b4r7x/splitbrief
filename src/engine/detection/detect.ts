import type { Config } from '../../core/schemas/config.js';
import type { PlannerDetection, ProviderDetection } from '../../core/types/config-options.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import { createDefaultConfig } from '../../core/config/load/load.js';
import { createPlanner } from '../runners/factory.js';
import { detectAvailableProviders, KNOWN_PROVIDERS } from '../providers/registry.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { hasApiKey, PROVIDER_CATALOG } from '../../core/providers/catalog.js';
import { isPlannerToolId, type PlannerToolId, type ProviderId } from '../../core/schemas/enums.js';
import { typedEntries } from '../../utils/type-guards.js';

function providerDescription(id: ProviderId): string {
  const info = PROVIDER_CATALOG[id];
  return info.isLocal ? `${info.displayName} (local)` : `${info.displayName} API`;
}

const CLI_PLANNERS: Array<{ tool: PlannerToolId; description: string }> = typedEntries(
  CLI_TOOLS,
).map(([tool, meta]) => ({ tool, description: meta.description }));

const API_PLANNERS: { tool: PlannerToolId; description: string }[] = [
  { tool: 'anthropic', description: providerDescription('anthropic') },
];

const API_PLANNER_TOOLS = new Set(API_PLANNERS.map(({ tool }) => tool));

const PROVIDER_PLANNERS: { tool: PlannerToolId; description: string }[] = Object.keys(
  KNOWN_PROVIDERS,
)
  .filter(isPlannerToolId)
  .filter((id) => !API_PLANNER_TOOLS.has(id))
  .map((id) => ({ tool: id, description: providerDescription(id) }));

function minimalConfig(tool: PlannerToolId): Config {
  const defaults = createDefaultConfig();
  return {
    ...defaults,
    planner: buildRunnerConfig('planner', { tool }),
  };
}

function mapProviderDetectionsToPlannerDetections(cached: ProviderDetection[]): PlannerDetection[] {
  return PROVIDER_PLANNERS.map(({ tool, description }) => {
    const detected = cached.find((d) => d.provider === tool);
    return {
      tool,
      type: 'api' as const,
      available: detected?.available ?? false,
      description,
      ...(detected?.error ? { error: detected.error } : {}),
    };
  });
}

async function probeProviders(): Promise<PlannerDetection[]> {
  try {
    return mapProviderDetectionsToPlannerDetections(await detectAvailableProviders());
  } catch (error) {
    warnError('detectAvailableProviders', error);
    return mapProviderDetectionsToPlannerDetections([]);
  }
}

interface DetectPlannersOptions {
  providerResults?: ProviderDetection[];
}

export async function detectAvailablePlanners(
  opts: DetectPlannersOptions = {},
): Promise<PlannerDetection[]> {
  const cliResults = await Promise.all(
    CLI_PLANNERS.map(async ({ tool, description }): Promise<PlannerDetection> => {
      try {
        const planner = await createPlanner(minimalConfig(tool));
        const available = await withTimeout(planner.isAvailable(), DETECTION_TIMEOUT_MS);
        let version: string | undefined;
        let error: string | undefined;
        if (available) {
          try {
            version = (await withTimeout(planner.getVersion(), DETECTION_TIMEOUT_MS)) ?? undefined;
          } catch (err) {
            error = `Version probe failed: ${toErrorMessage(err)}`;
            warnError(`planner.getVersion(${tool})`, err);
          }
        }
        return {
          tool,
          type: 'cli',
          available,
          description,
          ...(version ? { version } : {}),
          ...(error ? { error } : {}),
        };
      } catch (err) {
        return { tool, type: 'cli', available: false, description, error: toErrorMessage(err) };
      }
    }),
  );

  const apiResults: PlannerDetection[] = API_PLANNERS.map(({ tool, description }) => ({
    tool,
    type: 'api' as const,
    available: hasApiKey(tool),
    description,
  }));

  const providerResults = opts.providerResults
    ? mapProviderDetectionsToPlannerDetections(opts.providerResults)
    : await probeProviders();

  const shellResult: PlannerDetection = {
    tool: 'shell',
    type: 'shell',
    available: true,
    description: 'Custom command',
  };

  return [...cliResults, ...apiResults, ...providerResults, shellResult];
}

export interface DetectAllResult {
  planners: PlannerDetection[];
  implementers: ProviderDetection[];
}

export async function detectAll(): Promise<DetectAllResult> {
  const providerResults = await detectAvailableProviders();
  const planners = await detectAvailablePlanners({ providerResults });
  return { planners, implementers: providerResults };
}
