import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { accumulateUsage, toTokenDelta } from '../streaming/token-usage.js';
import { createChangeDetector, type ChangeDetector } from '../change-detection.js';
import {
  createSessionAttemptCallContext,
  createSessionResumeState,
  runWithResumeFallback,
} from '../session-expiry.js';
import { error } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';
import { isRecord } from '../../utils/type-guards.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../calls/status.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallStatus,
} from '../calls/types.js';

export const PLANNER_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const PLANNER_PERMISSION_MODE = 'plan' as const;
export const IMPLEMENTER_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;

type RunnerCallFailureStatus = Exclude<RunnerCallStatus, 'completed'>;

interface SdkBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  text?: string;
}

interface SdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: SdkBlock[] };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  terminal_reason?: string | null;
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
    effort?: EffortLevel | undefined;
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

interface SdkToolUse {
  id: string | null;
  name: string;
  input: Record<string, unknown>;
}

function extractToolUses(message: SdkMessage): SdkToolUse[] {
  const blocks = message.message?.content;
  if (!blocks) return [];
  const tools: SdkToolUse[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    tools.push({
      id: block.id ?? block.tool_use_id ?? null,
      name: block.name,
      input: isRecord(block.input) ? block.input : {},
    });
  }
  return tools;
}

function extractResultText(message: SdkMessage): string {
  if (typeof message.result === 'string') return message.result;
  return extractTextFromBlocks(message.message?.content);
}

type StreamResult = RunnerCallResult & { sessionId?: string | null };

export interface ProcessStreamOptions {
  stream: AsyncIterable<SdkMessage>;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
}

let sdkCallSequence = 0;

function createSdkCallContext(opts: {
  permissionMode: string;
  model?: string | undefined;
}): RunnerCallContext {
  return {
    callId: `agent-sdk-${++sdkCallSequence}`,
    role: opts.permissionMode === PLANNER_PERMISSION_MODE ? 'planner' : 'implementer',
    backendKind: 'agent-sdk',
    runnerName: 'Agent SDK',
    ...(opts.model !== undefined && { model: opts.model }),
  };
}

function isSdkResultFailure(message: SdkMessage): boolean {
  if (message.type !== 'result') return false;
  if (message.is_error === true) return true;
  return message.subtype !== undefined && message.subtype !== 'success';
}

function sdkFailureStatus(message: SdkMessage): RunnerCallFailureStatus {
  if (
    message.terminal_reason === 'aborted_streaming' ||
    message.terminal_reason === 'aborted_tools'
  ) {
    return 'aborted';
  }
  if (message.subtype === 'error_max_turns') return 'truncated';
  return 'failed';
}

function sdkResultErrorMessage(message: SdkMessage): string {
  if (message.errors && message.errors.length > 0) return message.errors.join('\n');
  const resultText = extractResultText(message);
  if (resultText) return resultText;
  if (message.subtype) return `Agent SDK result subtype ${message.subtype}`;
  return 'Agent SDK result failed';
}

function throwForSdkCallFailure(result: RunnerCallResult): never {
  throw error('runner-call-failed', `Agent SDK runner call ${result.status}`, {
    callId: result.callId,
    status: result.status,
    output: result.text,
    nativeSessionId: result.nativeSessionId,
    partial: result.partial,
    error: result.error,
  });
}

export async function processStream(opts: ProcessStreamOptions): Promise<StreamResult> {
  const { stream, onOutput, onSessionId, onCallEvent, signal } = opts;
  const context = opts.callContext ?? createSdkCallContext({ permissionMode: 'acceptEdits' });
  const recorder = createRunnerCallRecorder({ context, onEvent: onCallEvent });
  let collectedText = '';
  let usage: Pick<TokenDelta, 'inputTokens' | 'outputTokens'> | null = null;
  let sessionId: string | null = null;
  let sawAssistantText = false;

  try {
    throwIfAborted(signal);
    for await (const message of stream) {
      throwIfAborted(signal);
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        sessionId = message.session_id;
        onSessionId?.(message.session_id);
        recorder.sessionId({ nativeSessionId: message.session_id });
      }

      if (message.type === 'assistant') {
        for (const toolUse of extractToolUses(message)) {
          recorder.toolUseDone({ toolUse });
        }
        const text = extractAssistantText(message);
        if (text) {
          collectedText += text;
          sawAssistantText = true;
          recorder.text({ channel: 'assistant', text });
          onOutput(text);
          throwIfAborted(signal);
        }
      }

      if (message.type === 'result') {
        if (message.session_id) {
          sessionId = message.session_id;
          onSessionId?.(message.session_id);
          recorder.sessionId({ nativeSessionId: message.session_id });
        }
        const delta = toTokenDelta(message.usage);
        if (delta) {
          usage = accumulateUsage(usage, delta);
          recorder.usage({ usage: delta, semantics: 'final' });
        }
        if (isSdkResultFailure(message)) {
          recorder.finishFailed({
            status: sdkFailureStatus(message),
            error: {
              code: message.subtype ?? 'sdk_result_error',
              message: sdkResultErrorMessage(message),
            },
            usage,
            nativeSessionId: sessionId,
          });
          continue;
        }
        const resultText = extractResultText(message);
        if (resultText) {
          if (!sawAssistantText) {
            recorder.text({ channel: 'result', text: resultText });
          }
          collectedText = resultText;
        }
        recorder.finishCompleted({ usage, nativeSessionId: sessionId });
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(signal),
        error: {
          code: 'runner_interrupted',
          message: signal.reason instanceof Error ? signal.reason.message : 'Agent SDK interrupted',
        },
        nativeSessionId: sessionId,
      });
    } else if (!recorder.hasTerminal()) {
      recorder.finishFailed({
        status: 'failed',
        error: runnerCallErrorFromUnknown(err, 'agent_sdk_stream_error'),
        usage,
        nativeSessionId: sessionId,
      });
    }
    recorder.finalResult();
    throw err;
  }

  const result = recorder.finalResult();
  if (result.status !== 'completed') throwForSdkCallFailure(result);

  return { ...result, text: collectedText, sessionId };
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
  permissionMode?: 'acceptEdits' | 'plan' | undefined;
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
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  onSessionExpired?: ((previousId: string) => void) | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface AgentSdkBackend {
  invoke(opts: AgentSdkInvokeOpts): Promise<RunnerCallResult>;
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
      onCallEvent,
      onSessionExpired,
      effort,
      images,
      signal,
      callContext,
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
      const baseCallContext = callContext ?? createSdkCallContext({ permissionMode, model });

      const runQuery = async (resumeId: string | undefined, attempt: number) => {
        throwIfAborted(signal);
        const forwardedAbort = createForwardedAbortController(signal);
        const options: SdkQueryOptions['options'] = {
          allowedTools: opts.allowedTools,
          permissionMode,
          model,
          cwd: projectDir,
        };
        if (resumeId) options.resume = resumeId;
        if (effort) options.effort = effort;
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
            onCallEvent,
            callContext: createSessionAttemptCallContext(baseCallContext, attempt),
            signal,
          });
        } finally {
          forwardedAbort.cleanup();
        }
      };

      const priorId = session.getResumeId();
      const result = await runWithResumeFallback(
        session,
        (resumeId, attempt) => runQuery(resumeId, attempt),
        () => {
          if (priorId) onSessionExpired?.(priorId);
        },
      );
      return result;
    },
  };

  if (opts.detectChanges) {
    backend.detectChanges = createChangeDetector('Agent SDK');
  }

  return backend;
}
