import type { InvokeResult } from './types.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { effortToAnthropicBudget } from '../../core/schemas/enums.js';
import { accumulateUsage, toTokenDelta } from '../streaming/token-utils.js';
import { createChangeDetector, type ChangeDetector } from '../change-detection.js';
import { createSessionResumeState, runWithResumeFallback } from '../session-expiry.js';
import { error } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';

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
  message?: { content?: SdkBlock[] };
  result?: string;
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
    env?: Record<string, string | undefined>;
    thinking?: { type: 'enabled'; budgetTokens: number } | undefined;
    abortController?: AbortController | undefined;
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
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    if (isModuleNotFoundError(err)) {
      throw error(
        'agent-sdk-not-installed',
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
  } catch {
    /* SDK not installed — treat as unavailable */
    return false;
  }
}

function extractTextFromBlocks(blocks: SdkBlock[] | undefined): string {
  if (!blocks) return '';
  return blocks
    .filter((block: SdkBlock) => block.type === 'text' && typeof block.text === 'string')
    .map((block: SdkBlock) => block.text)
    .join('');
}

function extractAssistantText(message: SdkMessage): string {
  return extractTextFromBlocks(message.message?.content);
}

function extractResultText(message: SdkMessage): string {
  if (typeof message.result === 'string') return message.result;
  return extractTextFromBlocks(message.message?.content);
}

interface StreamResult {
  text: string;
  usage: Pick<TokenDelta, 'inputTokens' | 'outputTokens'> | null;
  sessionId: string | null;
}

export interface ProcessStreamOptions {
  stream: AsyncIterable<SdkMessage>;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export async function processStream(opts: ProcessStreamOptions): Promise<StreamResult> {
  const { stream, onOutput, onSessionId, signal } = opts;
  let collectedText = '';
  let usage: Pick<TokenDelta, 'inputTokens' | 'outputTokens'> | null = null;
  let sessionId: string | null = null;

  for await (const message of stream) {
    throwIfAborted(signal);
    if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
      sessionId = message.session_id;
      onSessionId?.(message.session_id);
    }

    if (message.type === 'assistant') {
      const text = extractAssistantText(message);
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
      const resultText = extractResultText(message);
      if (resultText) {
        collectedText = resultText;
      }
    }
  }

  return { text: collectedText, usage, sessionId };
}

function createForwardedAbortController(signal: AbortSignal | undefined): {
  controller?: AbortController;
  cleanup: () => void;
} {
  if (!signal) return { cleanup: () => {} };
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener('abort', abort),
  };
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
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface AgentSdkBackend {
  invoke(opts: AgentSdkInvokeOpts): Promise<InvokeResult>;
  detectChanges?: ChangeDetector;
}

function buildPromptWithImages(prompt: string, images: Attachment[] | undefined): string {
  if (!images || images.length === 0) return prompt;
  // Agent SDK exposes Read tool to planners; surface attachment paths so the
  // model loads them itself. Vision arrives via the Read tool result rather
  // than inline content blocks (the SDK string `prompt` is the supported entry).
  const refs = images.map((img) => `[image attachment: ${img.path}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

export function createAgentSdkBackend(opts: AgentSdkBackendOpts): AgentSdkBackend {
  const permissionMode = opts.permissionMode ?? 'acceptEdits';
  // SDK keys session files by cwd; passing a mismatched cwd silently starts a fresh session.
  const session = createSessionResumeState();
  session.capture(opts.initialSessionId ?? null);

  const backend: AgentSdkBackend = {
    async invoke({
      prompt,
      projectDir,
      model,
      onOutput,
      onSessionId,
      onSessionExpired,
      effort,
      images,
      signal,
      env,
    }) {
      throwIfAborted(signal);
      const { query } = await loadSdk();

      const apiKey = opts.apiKey;
      const captureSession = (id: string) => {
        session.capture(id);
        onSessionId?.(id);
      };
      const finalPrompt = buildPromptWithImages(prompt, images);

      const runQuery = async (resumeId: string | undefined) => {
        throwIfAborted(signal);
        const forwardedAbort = createForwardedAbortController(signal);
        const options: SdkQueryOptions['options'] = {
          allowedTools: opts.allowedTools,
          permissionMode,
          model,
          cwd: projectDir,
        };
        if (resumeId) options.resume = resumeId;
        if (effort)
          options.thinking = { type: 'enabled', budgetTokens: effortToAnthropicBudget(effort) };
        // Set `options.env` for two reasons: `env` carries the sandbox HOME/XDG/cache
        // redirect (opts.sandboxEnv) that isolates a staged direct-implementer run, and
        // `apiKey` scopes ANTHROPIC_API_KEY to this SDK call so concurrent workflows with
        // different keys don't race. Omit `env` entirely only when neither is set, so the
        // SDK inherits process.env as usual.
        if (env || apiKey) {
          options.env = {
            ...(env ?? process.env),
            ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
          };
        }
        if (forwardedAbort.controller) options.abortController = forwardedAbort.controller;
        try {
          return await processStream({
            stream: query({ prompt: finalPrompt, options }),
            onOutput,
            onSessionId: captureSession,
            signal,
          });
        } finally {
          forwardedAbort.cleanup();
        }
      };

      const priorId = session.getResumeId();
      const result = await runWithResumeFallback(
        session,
        (resumeId) => runQuery(resumeId),
        () => {
          if (priorId) onSessionExpired?.(priorId);
        },
      );
      return { text: result.text, usage: result.usage };
    },
  };

  if (opts.detectChanges) {
    backend.detectChanges = createChangeDetector('Agent SDK');
  }

  return backend;
}
