import type { InvokeResult } from '../types.js';
import { accumulateUsage } from './streaming/output-parsers.js';
import { toTokenDelta } from './streaming/token-utils.js';
import { createChangeDetector } from './implementers/base.js';

export const PLANNER_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Write'] as const;
export const IMPLEMENTER_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;

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

export async function loadSdk(): Promise<SdkClient> {
  try {
    // @ts-expect-error optional dependency
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch { /* optional peer dep missing — rethrow with install instructions */
    throw new Error(
      'Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    );
  }
}

export async function isAgentSdkAvailable(): Promise<boolean> {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  try {
    await loadSdk();
    return true;
  } catch { /* SDK not installed — treat as unavailable */
    return false;
  }
}

function extractTextFromMessage(message: SdkMessage): string {
  if (!message?.content) return '';
  return message.content
    .filter((block: SdkBlock) => block.type === 'text')
    .map((block: SdkBlock) => block.text)
    .join('');
}

interface StreamResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export async function processStream(
  stream: AsyncIterable<SdkMessage>,
  onOutput: (text: string) => void,
): Promise<StreamResult> {
  let collectedText = '';
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  for await (const message of stream) {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);
      if (text) {
        collectedText += text;
        onOutput(text);
      }
    }

    if (message.type === 'result') {
      const delta = toTokenDelta(message.usage);
      if (delta) {
        usage = accumulateUsage(usage, delta);
      }
      const resultText = extractTextFromMessage(message);
      if (resultText) {
        collectedText = resultText;
      }
    }
  }

  return { text: collectedText, usage };
}

export interface AgentSdkBackendOpts {
  allowedTools: string[];
  permissionMode?: 'acceptEdits' | undefined;
  detectChanges?: boolean | undefined;
}

export interface AgentSdkInvokeOpts {
  prompt: string;
  projectDir: string;
  model: string;
  onOutput: (text: string) => void;
}

export interface AgentSdkBackend {
  invoke(opts: AgentSdkInvokeOpts): Promise<InvokeResult>;
  detectChanges?: (projectDir: string) => Promise<{ changed: boolean; output: string }>;
}

export function createAgentSdkBackend(opts: AgentSdkBackendOpts): AgentSdkBackend {
  const permissionMode = opts.permissionMode ?? 'acceptEdits';

  const backend: AgentSdkBackend = {
    async invoke({ prompt, projectDir, model, onOutput }) {
      const { query } = await loadSdk();
      return processStream(
        query({ prompt, options: { allowedTools: opts.allowedTools, permissionMode, model, cwd: projectDir } }),
        onOutput,
      );
    },
  };

  if (opts.detectChanges) {
    backend.detectChanges = createChangeDetector('Agent SDK');
  }

  return backend;
}
