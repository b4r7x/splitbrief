import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import type { InvokeResult } from './base.js';
import { loadSdk, processStream, isAgentSdkAvailable } from '../agent-sdk.js';
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
    invokePlan: invoke,
    invokeEscalate: invoke,

    isAvailable: isAgentSdkAvailable,

    async getVersion() {
      return null;
    },

    escalateHintSuccess: (r) => r.text.length > 0,
  });
}
