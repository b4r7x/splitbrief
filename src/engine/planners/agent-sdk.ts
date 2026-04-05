import type { PlannerTokenUsage } from '../../types.js';
import type { PlannerBackend } from './types.js';
import { createPlannerBase } from './base.js';
import type { InvokeResult } from './base.js';
import { accumulateUsage } from '../output-parsers.js';

interface SdkBlock {
  type: string;
  text?: string;
}

interface SdkMessage {
  type: string;
  content: SdkBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface SdkQueryOptions {
  prompt: string;
  options: {
    allowedTools: string[];
    permissionMode: string;
    model: string;
    cwd: string;
  };
}

interface SdkClient {
  query: (opts: SdkQueryOptions) => AsyncIterable<SdkMessage>;
}

async function loadSdk(): Promise<SdkClient> {
  try {
    // @ts-expect-error optional dependency
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new Error(
      'Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    );
  }
}

function extractTextFromMessage(message: SdkMessage): string {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block: SdkBlock) => block.type === 'text')
      .map((block: SdkBlock) => block.text)
      .join('');
  }
  return '';
}

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

  let collectedText = '';
  let usage: PlannerTokenUsage | null = null;

  for await (const message of query({
    prompt,
    options: {
      allowedTools,
      permissionMode,
      model,
      cwd: projectDir,
    },
  })) {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);
      if (text) {
        collectedText += text;
        onOutput(text);
      }
    }

    if (message.type === 'result') {
      if (message.usage) {
        usage = accumulateUsage(usage, {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
        });
      }
      const resultText = extractTextFromMessage(message);
      if (resultText) {
        collectedText = resultText;
      }
    }
  }

  return { text: collectedText, usage };
}

// Update when new model versions are released; overridable via config.planner.model
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];

export function createAgentSdkPlanner(model?: string): PlannerBackend {

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
