import type { PlannerTool } from '../types.js';
import { createPlanner } from './planners/factory.js';

export interface PlannerDetection {
  tool: PlannerTool;
  available: boolean;
  version?: string | null;
  error?: string;
}

export interface ImplementerDetection {
  provider: string;
  available: boolean;
  models?: string[];
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function detectAvailablePlanners(): Promise<PlannerDetection[]> {
  const results = await Promise.all(
    KNOWN_PLANNER_TOOLS.map(async (tool): Promise<PlannerDetection> => {
      try {
        const backend = await createPlanner(minimalConfig(tool));
        const available = await withTimeout(backend.isAvailable(), 5000);
        let version: string | null = null;
        if (available) {
          try {
            version = await withTimeout(backend.getVersion(), 5000);
          } catch {
            // version detection is non-fatal
          }
        }
        return { tool, available, version };
      } catch (err) {
        return { tool, available: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return results;
}

const IMPLEMENTER_CHECKS = [
  {
    provider: 'ollama',
    url: 'http://localhost:11434/api/tags',
    parse: (data: any) => (data.models ?? []).map((m: any) => m.name as string),
  },
  {
    provider: 'lm-studio',
    url: 'http://localhost:1234/v1/models',
    parse: (data: any) => (data.data ?? []).map((m: any) => m.id as string),
  },
];

export async function detectAvailableImplementers(): Promise<ImplementerDetection[]> {
  const results = await Promise.all(
    IMPLEMENTER_CHECKS.map(async ({ provider, url, parse }): Promise<ImplementerDetection> => {
      try {
        const res = await withTimeout(fetch(url), 5000);
        if (!res.ok) return { provider, available: false };
        const data = await res.json();
        const models = parse(data);
        return { provider, available: models.length > 0, models };
      } catch {
        return { provider, available: false };
      }
    }),
  );
  return results;
}
