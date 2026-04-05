import type { PlannerTool } from '../types.js';
import { createPlanner } from './planners/factory.js';
import { detectAvailableProviders, withTimeout, DETECTION_TIMEOUT_MS } from './providers/registry.js';
import type { ProviderDetection } from './providers/types.js';
import { toErrorMessage } from '../utils/format.js';

export interface PlannerDetection {
  tool: PlannerTool;
  type: 'cli' | 'api' | 'shell';
  available: boolean;
  version?: string | null;
  description?: string;
  error?: string;
}

const KNOWN_CLI_TOOLS: PlannerTool[] = ['claude-code', 'codex', 'opencode', 'aider', 'agent-sdk'];

const CLI_DESCRIPTIONS: Record<string, string> = {
  'claude-code': 'Claude Code CLI',
  'codex': 'OpenAI Codex CLI',
  'opencode': 'OpenCode CLI',
  'aider': 'Aider CLI',
  'agent-sdk': 'Anthropic Agent SDK',
};

const API_PLANNERS: { tool: PlannerTool; envKey: string; description: string }[] = [
  { tool: 'anthropic', envKey: 'ANTHROPIC_API_KEY', description: 'Anthropic API' },
  { tool: 'openrouter', envKey: 'OPENROUTER_API_KEY', description: 'OpenRouter API' },
];

function minimalConfig(tool: PlannerTool) {
  return {
    planner: { tool },
    implementer: { provider: 'ollama', model: 'test', apiBase: '', contextLength: 8192, temperature: 0.3 },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitPerTask: true },
  } as const;
}

export async function detectAvailablePlanners(): Promise<PlannerDetection[]> {
  const cliResults = await Promise.all(
    KNOWN_CLI_TOOLS.map(async (tool): Promise<PlannerDetection> => {
      try {
        const planner = await createPlanner(minimalConfig(tool));
        const available = await withTimeout(planner.isAvailable(), DETECTION_TIMEOUT_MS);
        let version: string | null = null;
        if (available) {
          try {
            version = await withTimeout(planner.getVersion(), DETECTION_TIMEOUT_MS);
          } catch {}
        }
        return { tool, type: 'cli', available, version, description: CLI_DESCRIPTIONS[tool] };
      } catch (err) {
        return { tool, type: 'cli', available: false, description: CLI_DESCRIPTIONS[tool], error: toErrorMessage(err) };
      }
    }),
  );

  const apiResults: PlannerDetection[] = API_PLANNERS.map(({ tool, envKey, description }) => ({
    tool,
    type: 'api' as const,
    available: !!process.env[envKey],
    description,
  }));

  const shellResult: PlannerDetection = {
    tool: 'shell',
    type: 'shell',
    available: true,
    description: 'Custom command',
  };

  return [...cliResults, ...apiResults, shellResult];
}

export async function detectAvailableImplementers(): Promise<ProviderDetection[]> {
  return detectAvailableProviders();
}
