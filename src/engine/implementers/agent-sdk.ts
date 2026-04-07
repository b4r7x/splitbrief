import type { Config } from '../../types.js';
import type { ImplementerOptions, RetryOptions, InvokeOpts } from './base.js';
import type { ImplementerBackend } from './types.js';
import { createImplementerBase } from './base.js';
import { buildFullPrompt, buildFullRetryPrompt } from '../spec/formatter.js';
import { getGit } from '../../utils/git.js';

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

async function getChangedFiles(projectDir: string): Promise<string[]> {
  const git = getGit(projectDir);
  const status = await git.status();
  return [
    ...status.modified,
    ...status.not_added,
    ...status.created,
    ...status.deleted,
  ];
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

export function createAgentSdkImplementer(config: Config): ImplementerBackend {
  const effectiveModel = config.implementer.model || DEFAULT_MODEL;

  return createImplementerBase({
    name: 'agent-sdk',
    pricingKey: 'agent-sdk',
    extractsCode: false,

    buildPrompt(opts: ImplementerOptions) {
      return buildFullPrompt(opts.task, opts.context, opts.config.implementer.contextLength);
    },

    buildRetryPrompt(opts: RetryOptions) {
      return buildFullRetryPrompt(opts.task, opts.context, opts.error, opts.attempt, opts.config.implementer.contextLength);
    },

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, onProgress } = opts;
      const model = opts.config.implementer.model || effectiveModel;
      const { query } = await loadSdk();

      let collectedText = '';
      let usage: { inputTokens: number; outputTokens: number } | null = null;

      for await (const message of query({
        prompt,
        options: {
          allowedTools: ALLOWED_TOOLS,
          permissionMode: 'acceptEdits',
          model,
          cwd: projectDir,
        },
      })) {
        if (message.type === 'assistant') {
          const text = extractTextFromMessage(message);
          if (text) {
            collectedText += text;
            onProgress(text);
          }
        }

        if (message.type === 'result') {
          if (message.usage) {
            const newUsage = {
              inputTokens: message.usage.input_tokens ?? 0,
              outputTokens: message.usage.output_tokens ?? 0,
            };
            if (usage) {
              usage.inputTokens += newUsage.inputTokens;
              usage.outputTokens += newUsage.outputTokens;
            } else {
              usage = newUsage;
            }
          }
          const resultText = extractTextFromMessage(message);
          if (resultText) {
            collectedText = resultText;
          }
        }
      }

      return { text: collectedText, usage };
    },

    async detectChanges(projectDir: string) {
      const changedFiles = await getChangedFiles(projectDir);
      if (changedFiles.length === 0) {
        return { changed: false, output: 'Agent SDK implementer exited without changing any files' };
      }
      return { changed: true, output: '' };
    },

    async isAvailable() {
      if (!process.env.ANTHROPIC_API_KEY) return false;
      try {
        await loadSdk();
        return true;
      } catch {
        return false;
      }
    },
  });
}
