import { accumulateUsage } from '../streaming/output-parsers.js';

export interface SdkBlock {
  type: string;
  text?: string;
}

export interface SdkMessage {
  type: string;
  content: SdkBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface SdkQueryOptions {
  prompt: string;
  options: {
    allowedTools: string[];
    permissionMode: string;
    model: string;
    cwd: string;
  };
}

export interface SdkClient {
  query: (opts: SdkQueryOptions) => AsyncIterable<SdkMessage>;
}

export async function loadSdk(): Promise<SdkClient> {
  try {
    // @ts-expect-error optional dependency
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new Error(
      'Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    );
  }
}

export function extractTextFromMessage(message: SdkMessage): string {
  if (!message?.content) return '';
  return message.content
    .filter((block: SdkBlock) => block.type === 'text')
    .map((block: SdkBlock) => block.text)
    .join('');
}

export interface StreamResult {
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
      if (message.usage) {
        const delta = {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
        };
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
