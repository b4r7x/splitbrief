import type { PlannerTool, PlannerDetection, ProviderDetection } from '../../types.js';
import { createPlanner } from '../planners/factory.js';
import { detectAvailableProviders, DETECTION_TIMEOUT_MS, KNOWN_PROVIDERS } from '../providers/registry.js';
import { withTimeout } from '../../utils/with-timeout.js';
import { toErrorMessage } from '../../utils/format.js';
import { CLI_TOOLS } from '../cli-tools.js';

export type { PlannerDetection } from '../../types.js';

const DIRECT_CLI_DESCRIPTIONS: Record<'claude-code' | 'agent-sdk', string> = {
  'claude-code': 'Claude Code CLI',
  'agent-sdk': 'Anthropic Agent SDK',
};

const CLI_PLANNERS: Array<{ tool: PlannerTool; description: string }> = [
  { tool: 'claude-code', description: DIRECT_CLI_DESCRIPTIONS['claude-code'] },
  ...Object.entries(CLI_TOOLS).map(([tool, meta]) => ({
    tool: tool as PlannerTool,
    description: meta.description,
  })),
  { tool: 'agent-sdk', description: DIRECT_CLI_DESCRIPTIONS['agent-sdk'] },
];

const API_PLANNERS: { tool: PlannerTool; envKey: string; description: string }[] = [
  { tool: 'anthropic', envKey: 'ANTHROPIC_API_KEY', description: 'Anthropic API' },
  { tool: 'openrouter', envKey: 'OPENROUTER_API_KEY', description: 'OpenRouter API' },
];

const PROVIDER_PLANNERS: { tool: PlannerTool; description: string }[] = [
  { tool: 'ollama', description: 'Ollama (local)' },
  { tool: 'lm-studio', description: 'LM Studio (local)' },
  { tool: 'deepseek', description: 'DeepSeek API' },
];

function minimalConfig(tool: PlannerTool) {
  return {
    planner: { tool },
    implementer: { tool: 'ollama', model: 'test', apiBase: '', contextLength: 8192, temperature: 0.3 },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none' },
  } as const;
}

export async function detectAvailablePlanners(): Promise<PlannerDetection[]> {
  const cliResults = await Promise.all(
    CLI_PLANNERS.map(async ({ tool, description }): Promise<PlannerDetection> => {
      try {
        const planner = await createPlanner(minimalConfig(tool));
        const available = await withTimeout(planner.isAvailable(), DETECTION_TIMEOUT_MS);
        let version: string | null = null;
        if (available) {
          try {
            version = await withTimeout(planner.getVersion(), DETECTION_TIMEOUT_MS);
          } catch {}
        }
        return { tool, type: 'cli', available, version, description };
      } catch (err) {
        return { tool, type: 'cli', available: false, description, error: toErrorMessage(err) };
      }
    }),
  );

  const apiResults: PlannerDetection[] = API_PLANNERS.map(({ tool, envKey, description }) => ({
    tool,
    type: 'api' as const,
    available: !!process.env[envKey],
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
      } catch {
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

const API_IMPLEMENTER_PROVIDERS: { provider: string; envKey: string }[] = [
  { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
];

export async function detectAvailableImplementers(): Promise<ProviderDetection[]> {
  const detected = await detectAvailableProviders();
  const detectedNames = new Set(detected.map(d => d.provider));

  const apiKeyProviders: ProviderDetection[] = API_IMPLEMENTER_PROVIDERS
    .filter(p => !detectedNames.has(p.provider))
    .map(p => ({
      provider: p.provider,
      available: !!process.env[p.envKey],
      isLocal: false,
      hasKey: !!process.env[p.envKey],
    }));

  return [...detected, ...apiKeyProviders];
}
