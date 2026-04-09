import type { Config, PlannerTool, PlannerDetection, ProviderDetection } from '../../types.js';
import { buildPlannerConfig } from '../../core/config/planner-config.js';
import { createPlanner } from '../planners/factory.js';
import { detectAvailableProviders, DETECTION_TIMEOUT_MS, KNOWN_PROVIDERS } from '../provider-clients/registry.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { toErrorMessage } from '../../utils/format.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { hasApiKey, PROVIDER_CATALOG, type ProviderId } from '../../core/providers/catalog.js';

function providerDescription(id: ProviderId): string {
  const info = PROVIDER_CATALOG[id];
  return info.isLocal ? `${info.displayName} (local)` : `${info.displayName} API`;
}

const CLI_PLANNERS: Array<{ tool: PlannerTool; description: string }> = [
  ...Object.entries(CLI_TOOLS).map(([tool, meta]) => ({
    tool: tool as PlannerTool,
    description: meta.description,
  })),
  // agent-sdk is not a CLI_TOOL but is detected via the planner factory
  { tool: 'agent-sdk', description: PROVIDER_CATALOG['agent-sdk'].displayName },
];

const API_PLANNERS: { tool: PlannerTool; description: string }[] = [
  { tool: 'anthropic', description: providerDescription('anthropic') },
];

const PROVIDER_PLANNERS: { tool: PlannerTool; description: string }[] = (
  Object.keys(KNOWN_PROVIDERS) as ProviderId[]
).map(id => ({ tool: id, description: providerDescription(id) }));

function minimalConfig(tool: PlannerTool): Config {
  return {
    planner: buildPlannerConfig(tool),
    implementer: { kind: 'api', tool: 'ollama', model: 'test', apiBase: '', contextLength: 8192, temperature: 0.3 },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none' },
  };
}

export async function detectAvailablePlanners(): Promise<PlannerDetection[]> {
  const cliResults = await Promise.all(
    CLI_PLANNERS.map(async ({ tool, description }): Promise<PlannerDetection> => {
      try {
        const planner = await createPlanner(minimalConfig(tool));
        const available = await withTimeout(planner.isAvailable(), DETECTION_TIMEOUT_MS);
        let version: string | undefined;
        if (available) {
          try {
            version = await withTimeout(planner.getVersion(), DETECTION_TIMEOUT_MS) ?? undefined;
          } catch { /* version detection failed — non-critical */ }
        }
        return { tool, type: 'cli', available, version, description };
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

  const providerResults = await Promise.all(
    PROVIDER_PLANNERS.map(async ({ tool, description }): Promise<PlannerDetection> => {
      const factory = KNOWN_PROVIDERS[tool];
      if (!factory) return { tool, type: 'api', available: false, description };
      try {
        const provider = factory();
        const models = await withTimeout(provider.listModels(), DETECTION_TIMEOUT_MS);
        return { tool, type: 'api', available: models.length > 0, description };
      } catch { /* provider unreachable — mark unavailable */
        return { tool, type: 'api', available: false, description };
      }
    }),
  );

  const shellResult: PlannerDetection = {
    tool: 'shell',
    type: 'shell',
    available: true,
    description: 'Custom command',
  };

  return [...cliResults, ...apiResults, ...providerResults, shellResult];
}

const API_IMPLEMENTER_PROVIDERS = ['anthropic'] as const satisfies readonly ProviderId[];

export async function detectAvailableImplementers(): Promise<ProviderDetection[]> {
  const detected = await detectAvailableProviders();
  const detectedNames = new Set<ProviderId>(detected.map(d => d.provider));

  const apiKeyProviders: ProviderDetection[] = API_IMPLEMENTER_PROVIDERS
    .filter(provider => !detectedNames.has(provider))
    .map(provider => {
      const key = hasApiKey(provider);
      return {
        provider,
        available: key,
        isLocal: false,
        hasKey: key,
      };
    });

  return [...detected, ...apiKeyProviders];
}
