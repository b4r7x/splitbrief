import type { PlannerTool } from '../types.js';
import { createPlanner } from './planners/factory.js';
import { detectAvailableProviders, withTimeout, DETECTION_TIMEOUT_MS } from './providers/registry.js';
import type { ProviderDetection } from './providers/types.js';
import { toErrorMessage } from '../utils/format.js';

export interface PlannerDetection {
  tool: PlannerTool;
  available: boolean;
  version?: string | null;
  error?: string;
}

const KNOWN_PLANNER_TOOLS: PlannerTool[] = ['claude-code', 'codex', 'opencode', 'aider', 'agent-sdk'];

function minimalConfig(tool: PlannerTool) {
  return {
    planner: { tool },
    implementer: { provider: 'ollama', model: 'test', apiBase: '', contextLength: 8192, temperature: 0.3 },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitPerTask: true },
  } as const;
}

export async function detectAvailablePlanners(): Promise<PlannerDetection[]> {
  const results = await Promise.all(
    KNOWN_PLANNER_TOOLS.map(async (tool): Promise<PlannerDetection> => {
      try {
        const planner = await createPlanner(minimalConfig(tool));
        const available = await withTimeout(planner.isAvailable(), DETECTION_TIMEOUT_MS);
        let version: string | null = null;
        if (available) {
          try {
            version = await withTimeout(planner.getVersion(), DETECTION_TIMEOUT_MS);
          } catch {}
        }
        return { tool, available, version };
      } catch (err) {
        return { tool, available: false, error: toErrorMessage(err) };
      }
    }),
  );
  return results;
}

export async function detectAvailableImplementers(): Promise<ProviderDetection[]> {
  return detectAvailableProviders();
}
