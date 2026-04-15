import type { InvokeResult } from '../types.js';
import { accumulateUsage } from './streaming/output-parsers.js';
import { toTokenDelta } from './streaming/token-utils.js';
import { createChangeDetector } from './implementers/utils.js';

export const PLANNER_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Write'] as const;
export const IMPLEMENTER_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;

interface SdkBlock {
  type: string;
  text?: string;
}

interface SdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  content?: SdkBlock[];
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
    resume?: string | undefined;
  };
}

interface SdkClient {
  query: (opts: SdkQueryOptions) => AsyncIterable<SdkMessage>;
}

export function isModuleNotFoundError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = 'code' in err ? err.code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const msg = ('message' in err ? String(err.message) : '') ?? '';
  return /Cannot find (?:package|module)|Could not resolve/.test(msg);
}

export async function loadSdk(): Promise<SdkClient> {
  try {
    // @ts-expect-error - optional peer dependency not in tsconfig when not installed
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    if (isModuleNotFoundError(err)) {
      throw new Error(
        'Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
      );
    }
    throw err;
  }
}

export async function isAgentSdkAvailable(apiKey?: string): Promise<boolean> {
  if (!process.env.ANTHROPIC_API_KEY && !apiKey) return false;
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
  sessionId: string | null;
}

export async function processStream(
  stream: AsyncIterable<SdkMessage>,
  onOutput: (text: string) => void,
  onSessionId?: (id: string) => void,
): Promise<StreamResult> {
  let collectedText = '';
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  let sessionId: string | null = null;

  for await (const message of stream) {
    if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
      sessionId = message.session_id;
      onSessionId?.(message.session_id);
    }

    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);
      if (text) {
        collectedText += text;
        onOutput(text);
      }
    }

    if (message.type === 'result') {
      if (message.session_id) {
        sessionId = message.session_id;
        onSessionId?.(message.session_id);
      }
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

  return { text: collectedText, usage, sessionId };
}

export interface AgentSdkBackendOpts {
  allowedTools: string[];
  permissionMode?: 'acceptEdits' | undefined;
  detectChanges?: boolean | undefined;
  apiKey?: string | undefined;
  initialSessionId?: string | null | undefined;
}

export interface AgentSdkInvokeOpts {
  prompt: string;
  projectDir: string;
  model: string;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onSessionExpired?: ((previousId: string) => void) | undefined;
}

export interface AgentSdkBackend {
  invoke(opts: AgentSdkInvokeOpts): Promise<InvokeResult>;
  detectChanges?: (projectDir: string, before: string[]) => Promise<{ changed: boolean; output: string }>;
}

const SESSION_RESUME_FAILED_PATTERNS = [
  'session not found',
  'session_not_found',
  'invalid session',
  'expired session',
  'no such session',
  'could not resume',
];

function isSessionResumeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return SESSION_RESUME_FAILED_PATTERNS.some(p => msg.includes(p));
}

export function createAgentSdkBackend(opts: AgentSdkBackendOpts): AgentSdkBackend {
  const permissionMode = opts.permissionMode ?? 'acceptEdits';
  // The SDK records session files at ~/.claude/projects/<encoded-cwd>/<id>.jsonl. If the SDK is
  // called with a different cwd than the run that produced the id, resume silently yields a
  // fresh session. Pin cwd to the projectDir passed into invoke() to keep this consistent.
  let currentSessionId: string | null = opts.initialSessionId ?? null;

  const backend: AgentSdkBackend = {
    async invoke({ prompt, projectDir, model, onOutput, onSessionId, onSessionExpired }) {
      const { query } = await loadSdk();

      // If an explicit apiKey is configured and the env var is not yet set, apply it for this call.
      // The Agent SDK `query()` does not accept an apiKey option directly, so env mutation is
      // necessary. This is not safe under concurrent invocations — only one workflow runs at a time.
      const savedKey = process.env['ANTHROPIC_API_KEY'];
      const apiKey = opts.apiKey;
      if (apiKey && !savedKey) process.env['ANTHROPIC_API_KEY'] = apiKey;

      const captureSession = (id: string) => { currentSessionId = id; onSessionId?.(id); };

      const runQuery = async (resumeId: string | null) => {
        const options: SdkQueryOptions['options'] = {
          allowedTools: opts.allowedTools, permissionMode, model, cwd: projectDir,
        };
        if (resumeId) options.resume = resumeId;
        return processStream(query({ prompt, options }), onOutput, captureSession);
      };

      try {
        try {
          const result = await runQuery(currentSessionId);
          return { text: result.text, usage: result.usage };
        } catch (err) {
          if (currentSessionId && isSessionResumeError(err)) {
            const expiredId = currentSessionId;
            currentSessionId = null;
            onSessionExpired?.(expiredId);
            const retry = await runQuery(null);
            return { text: retry.text, usage: retry.usage };
          }
          throw err;
        }
      } finally {
        if (apiKey && !savedKey) delete process.env['ANTHROPIC_API_KEY'];
      }
    },
  };

  if (opts.detectChanges) {
    backend.detectChanges = createChangeDetector('Agent SDK');
  }

  return backend;
}
