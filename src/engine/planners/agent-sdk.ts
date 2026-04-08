import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import type { InvokeResult } from './base.js';
import { loadSdk, processStream } from '../agent-sdk/shared.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/models.js';

async function runQuery(
  prompt: string,
  projectDir: string,
  opts: {
    model: string;
    allowedTools: string[];
    permissionMode: string;
    onOutput: (text: string) => void;
  },
): Promise<InvokeResult> {
  const { model, allowedTools, permissionMode, onOutput } = opts;
  const { query } = await loadSdk();

  return processStream(
    query({ prompt, options: { allowedTools, permissionMode, model, cwd: projectDir } }),
    onOutput,
  );
}

// Update when new model versions are released; overridable via config.planner.model
const DEFAULT_MODEL = DEFAULT_AGENT_SDK_MODEL;
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];

export function createAgentSdkPlanner(model?: string): Planner {

  const effectiveModel = model ?? DEFAULT_MODEL;

  async function invoke(prompt: string, projectDir: string, onOutput: (text: string) => void): Promise<InvokeResult> {
    return runQuery(prompt, projectDir, {
      model: effectiveModel, allowedTools: ALLOWED_TOOLS, permissionMode: 'acceptEdits', onOutput,
    });
  }

  return createPlannerBase({
    name: 'agent-sdk',
    pricingKey: 'agent-sdk',
    conversational: true,

    invokePlan: invoke,
    invokeEscalate: invoke,

    async isAvailable() {
      if (!process.env.ANTHROPIC_API_KEY) return false;
      try {
        await loadSdk();
        return true;
      } catch {
        return false;
      }
    },

    async getVersion() {
      return null;
    },

    escalateHintSuccess: (r) => r.text.length > 0,
  });
}
