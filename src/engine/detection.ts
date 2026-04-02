import type { PlannerTool } from '../types.js';
import { createPlanner } from './planners/factory.js';
import { DEFAULT_BASES } from './providers.js';
import { toErrorMessage } from '../utils/format.js';

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

const DETECTION_TIMEOUT_MS = 5000;
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
        const available = await withTimeout(backend.isAvailable(), DETECTION_TIMEOUT_MS);
        let version: string | null = null;
        if (available) {
          try {
            version = await withTimeout(backend.getVersion(), DETECTION_TIMEOUT_MS);
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

interface OllamaTagsResponse {
  models?: { name: string }[];
}

interface LmStudioListResponse {
  data?: { id: string }[];
}

const IMPLEMENTER_CHECKS = [
  {
    provider: 'ollama',
    url: DEFAULT_BASES.ollama.baseURL.replace('/v1', '/api/tags'),
    parse: (data: unknown) => {
      const d = data as OllamaTagsResponse;
      return (d.models ?? []).map((m) => m.name);
    },
  },
  {
    provider: 'lm-studio',
    url: `${DEFAULT_BASES['lm-studio'].baseURL}/models`,
    parse: (data: unknown) => {
      const d = data as LmStudioListResponse;
      return (d.data ?? []).map((m) => m.id);
    },
  },
];

export async function detectAvailableImplementers(): Promise<ImplementerDetection[]> {
  const results = await Promise.all(
    IMPLEMENTER_CHECKS.map(async ({ provider, url, parse }): Promise<ImplementerDetection> => {
      try {
        const data = await withTimeout(
          fetch(url).then(res => {
            if (!res.ok) throw new Error('not ok');
            return res.json();
          }),
          DETECTION_TIMEOUT_MS,
        );
        const models = parse(data);
        return { provider, available: models.length > 0, models };
      } catch {
        return { provider, available: false };
      }
    }),
  );
  return results;
}
