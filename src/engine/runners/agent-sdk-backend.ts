import { z } from 'zod';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { accumulateUsage, toTokenDelta } from '../streaming/token-usage.js';
import { reconcileFinalText } from '../streaming/final-text.js';
import { createChangeDetector, type ChangeDetector } from '../change-detection.js';
import {
  createSessionAttemptCallContext,
  createSessionResumeState,
  isSessionExpiredError,
  runWithResumeFallback,
  sessionResumeMismatchError,
} from '../session-expiry.js';
import { error } from '../../utils/error.js';
import { throwIfAborted } from '../../utils/abort.js';
import { isRecord } from '../../utils/type-guards.js';
import { processError } from '../../lib/process/errors.js';
import { RUNNER_IDLE_KILL_MS, RUNNER_IDLE_WARN_MS } from '../../core/schemas/runner-fields.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../calls/recorder.js';
import {
  runnerCallErrorFromUnknown,
  runnerCallIdleTimeoutError,
  runnerCallInterruptedStatus,
} from '../calls/status.js';
import { runnerCallUnknownUpstreamPreview } from '../calls/unknown-upstream.js';
import { createRunnerAttemptCallbackBuffer } from '../calls/callback-buffer.js';
import {
  createRunnerCallDeltaLimiter,
  finishRunnerCallOutputLimit,
  type RunnerCallDeltaLimitResult,
} from '../calls/output-limit.js';
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

const SdkTextBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

const SdkToolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  name: z.string(),
  input: z.unknown().optional(),
});

const SdkSystemMessageSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
});

const SdkAssistantMessageSchema = z.looseObject({
  type: z.literal('assistant'),
  message: z
    .looseObject({
      content: z.array(z.unknown()).optional(),
    })
    .optional(),
});

const SdkResultMessageSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  errors: z.array(z.string()).optional(),
  terminal_reason: z.string().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number(),
      output_tokens: z.number(),
    })
    .optional(),
});

// Partial messages (includePartialMessages: true) exist so the idle watchdog
// sees genuine stream liveness during long tool-less turns; they carry no
// extractable output, so the stream loop has no handler for them.
const SdkStreamEventMessageSchema = z.looseObject({
  type: z.literal('stream_event'),
});

const SdkMessageSchema = z.discriminatedUnion('type', [
  SdkSystemMessageSchema,
  SdkAssistantMessageSchema,
  SdkResultMessageSchema,
  SdkStreamEventMessageSchema,
]);

type SdkMessage = z.infer<typeof SdkMessageSchema>;

interface SdkQueryOptions {
  prompt: string;
  options: {
    allowedTools: string[];
    permissionMode: string;
    model: string;
    cwd: string;
    includePartialMessages: boolean;
    resume?: string | undefined;
    env?: Record<string, string | undefined>;
    effort?: EffortLevel | undefined;
    abortController: AbortController;
  };
}

interface SdkClient {
  query: (opts: SdkQueryOptions) => AsyncIterable<unknown>;
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

function extractTextFromBlocks(
  blocks: readonly unknown[] | undefined,
  recorder: RunnerCallRecorder,
): string {
  if (!blocks) return '';
  const texts: string[] = [];
  for (const block of blocks) {
    const parsed = SdkTextBlockSchema.safeParse(block);
    if (parsed.success) {
      texts.push(parsed.data.text);
      continue;
    }
    if (blockType(block) === 'text') recordInvalidSdkPayload(recorder, block, parsed.error.issues);
  }
  return texts.join('');
}

function extractAssistantText(
  message: Extract<SdkMessage, { type: 'assistant' }>,
  recorder: RunnerCallRecorder,
): string {
  return extractTextFromBlocks(message.message?.content, recorder);
}

interface SdkToolUse {
  id: string | null;
  name: string;
  input: Record<string, unknown>;
}

function extractToolUses(
  message: Extract<SdkMessage, { type: 'assistant' }>,
  recorder: RunnerCallRecorder,
): SdkToolUse[] {
  const blocks = message.message?.content;
  if (!blocks) return [];
  const tools: SdkToolUse[] = [];
  for (const block of blocks) {
    const parsed = SdkToolUseBlockSchema.safeParse(block);
    if (!parsed.success) {
      if (blockType(block) === 'tool_use')
        recordInvalidSdkPayload(recorder, block, parsed.error.issues);
      continue;
    }
    const data = parsed.data;
    tools.push({
      id: data.id ?? data.tool_use_id ?? null,
      name: data.name,
      input: isRecord(data.input) ? data.input : {},
    });
  }
  return tools;
}

function extractResultText(message: Extract<SdkMessage, { type: 'result' }>): string {
  if (typeof message.result === 'string') return message.result;
  return '';
}

type StreamResult = RunnerCallResult & { sessionId?: string | null };

export interface ProcessStreamOptions {
  stream: AsyncIterable<unknown>;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
  forwardedAbortController?: AbortController | undefined;
  // Defaults are applied here in processStream, the single defaulting site —
  // callers pass configured overrides through raw.
  idle?: { warnMs?: number | undefined; killMs?: number | undefined } | undefined;
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

function isSdkResultFailure(message: Extract<SdkMessage, { type: 'result' }>): boolean {
  if (message.type !== 'result') return false;
  if (message.is_error === true) return true;
  return message.subtype !== undefined && message.subtype !== 'success';
}

function sdkFailureStatus(
  message: Extract<SdkMessage, { type: 'result' }>,
): RunnerCallFailureStatus {
  if (
    message.terminal_reason === 'aborted_streaming' ||
    message.terminal_reason === 'aborted_tools'
  ) {
    return 'aborted';
  }
  if (message.subtype === 'error_max_turns') return 'truncated';
  return 'failed';
}

function sdkResultErrorMessage(message: Extract<SdkMessage, { type: 'result' }>): string {
  if (message.errors && message.errors.length > 0) return message.errors.join('\n');
  const resultText = extractResultText(message);
  if (resultText) return resultText;
  if (message.subtype) return `Agent SDK result subtype ${message.subtype}`;
  return 'Agent SDK result failed';
}

function throwForSdkCallFailure(result: RunnerCallResult): never {
  const detail = result.error?.message;
  const message =
    detail && detail.length > 0
      ? `Agent SDK runner call ${result.status}: ${detail}`
      : `Agent SDK runner call ${result.status}`;
  throw error('runner-call-failed', message, {
    callId: result.callId,
    status: result.status,
    output: result.text,
    nativeSessionId: result.nativeSessionId,
    partial: result.partial,
    error: result.error,
  });
}

function parseSdkMessage(raw: unknown, recorder: RunnerCallRecorder): SdkMessage | null {
  const parsed = SdkMessageSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  recordInvalidSdkPayload(recorder, raw, parsed.error.issues);
  return null;
}

function recordInvalidSdkPayload(
  recorder: RunnerCallRecorder,
  payload: unknown,
  issues: Parameters<typeof runnerCallUnknownUpstreamPreview>[0]['issues'],
): void {
  const upstreamType = blockType(payload);
  recorder.unknownUpstream({
    rawPreview: runnerCallUnknownUpstreamPreview({
      label: 'Invalid Agent SDK stream message',
      value: payload,
      issues,
    }),
    backendMetadata: {
      backendKind: recorder.context.backendKind,
      source: 'agent-sdk',
      parser: 'sdk_message',
      ...(upstreamType !== undefined && { upstreamType }),
    },
  });
}

function blockType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined;
}

interface IdleWatchdog {
  readonly killed: Promise<never>;
  reset: () => void;
  stop: () => void;
}

function createIdleWatchdog(opts: {
  recorder: RunnerCallRecorder;
  onKill: (err: Error) => void;
  warnMs: number;
  killMs: number;
}): IdleWatchdog {
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  let rejectKilled: (err: Error) => void = () => {};
  const killed = new Promise<never>((_resolve, reject) => {
    rejectKilled = reject;
  });

  function arm(): void {
    warnTimer = setTimeout(() => {
      stalled = true;
      opts.recorder.stalled({ silentMs: opts.warnMs });
    }, opts.warnMs);
    killTimer = setTimeout(() => {
      const idleError = processError.idleTimeout({
        command: opts.recorder.context.runnerName ?? 'Agent SDK',
        idleMs: opts.killMs,
      });
      rejectKilled(idleError);
      opts.onKill(idleError);
    }, opts.killMs);
  }

  function stop(): void {
    clearTimeout(warnTimer);
    clearTimeout(killTimer);
  }

  function reset(): void {
    stop();
    if (stalled) {
      stalled = false;
      opts.recorder.stallCleared();
    }
    arm();
  }

  arm();

  return { killed, reset, stop };
}

export async function processStream(opts: ProcessStreamOptions): Promise<StreamResult> {
  const { stream, onOutput, onSessionId, onCallEvent, signal, forwardedAbortController } = opts;
  const context = opts.callContext ?? createSdkCallContext({ permissionMode: 'acceptEdits' });
  const recorder = createRunnerCallRecorder({ context, onEvent: onCallEvent });
  let collectedText = '';
  let usage: Pick<TokenDelta, 'inputTokens' | 'outputTokens'> | null = null;
  let sessionId: string | null = null;
  const textLimiter = createRunnerCallDeltaLimiter({
    code: 'agent_sdk_output_text_limit',
    label: 'Agent SDK output text',
  });
  let outputLimit: RunnerCallDeltaLimitResult['limit'] = null;

  function captureStreamSessionId(nextSessionId: string): void {
    if (sessionId === nextSessionId) return;
    sessionId = nextSessionId;
    onSessionId?.(nextSessionId);
    recorder.sessionId({ nativeSessionId: nextSessionId });
  }

  const watchdog = createIdleWatchdog({
    recorder,
    onKill: (idleError) => forwardedAbortController?.abort(idleError),
    warnMs: opts.idle?.warnMs ?? RUNNER_IDLE_WARN_MS,
    killMs: opts.idle?.killMs ?? RUNNER_IDLE_KILL_MS,
  });

  let iterator: AsyncIterator<unknown> | undefined;
  let iteratorDone = false;

  try {
    throwIfAborted(signal);
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const nextResult = iterator.next();
      nextResult.catch(() => {});
      const next = await Promise.race([nextResult, watchdog.killed]);
      watchdog.reset();
      if (next.done) {
        iteratorDone = true;
        break;
      }
      const rawMessage = next.value;
      throwIfAborted(signal);
      const message = parseSdkMessage(rawMessage, recorder);
      if (message === null) continue;
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        captureStreamSessionId(message.session_id);
      }

      if (message.type === 'assistant') {
        for (const toolUse of extractToolUses(message, recorder)) {
          recorder.toolUseDone({ toolUse });
        }
        const text = extractAssistantText(message, recorder);
        if (text) {
          const accepted = textLimiter.accept(text);
          if (accepted.text.length > 0) {
            collectedText += accepted.text;
            recorder.text({ channel: 'assistant', text: accepted.text });
            onOutput(accepted.text);
          }
          if (accepted.limit !== null) {
            outputLimit = accepted.limit;
            finishRunnerCallOutputLimit(recorder, outputLimit, {
              usage,
              nativeSessionId: sessionId,
            });
            break;
          }
          throwIfAborted(signal);
        }
      }

      if (message.type === 'result') {
        if (message.session_id) {
          captureStreamSessionId(message.session_id);
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
          const reconciliation = reconcileFinalText(collectedText, resultText);
          const accepted =
            reconciliation.kind === 'none'
              ? ({ text: '', limit: null } satisfies RunnerCallDeltaLimitResult)
              : textLimiter.accept(reconciliation.text);
          if (reconciliation.kind === 'full') {
            if (accepted.text.length > 0) {
              recorder.text({ channel: 'result', text: accepted.text, semantics: 'final' });
              onOutput(accepted.text);
            }
          } else if (reconciliation.kind === 'suffix') {
            if (accepted.text.length > 0) {
              recorder.text({ channel: 'assistant', text: accepted.text });
              onOutput(accepted.text);
            }
          } else if (reconciliation.kind === 'replace') {
            if (accepted.text.length > 0) {
              recorder.text({ channel: 'result', text: accepted.text, semantics: 'final' });
            }
          }
          if (reconciliation.kind === 'full' || reconciliation.kind === 'replace') {
            collectedText = accepted.text;
          } else if (reconciliation.kind === 'suffix') {
            collectedText += accepted.text;
          }
          if (accepted.limit !== null) {
            outputLimit = accepted.limit;
            finishRunnerCallOutputLimit(recorder, outputLimit, {
              usage,
              nativeSessionId: sessionId,
            });
            break;
          }
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
        error: processError.isIdleTimeout(err)
          ? runnerCallIdleTimeoutError(err)
          : runnerCallErrorFromUnknown(err, 'agent_sdk_stream_error'),
        usage,
        nativeSessionId: sessionId,
      });
    }
    recorder.finalResult();
    throw err;
  } finally {
    if (iterator && !iteratorDone) iterator.return?.().catch(() => {});
    watchdog.stop();
  }

  const result = recorder.finalResult();
  if (result.status !== 'completed') throwForSdkCallFailure(result);

  return { ...result, text: collectedText, sessionId };
}

function createForwardedAbortController(signal: AbortSignal | undefined): {
  controller: AbortController;
  cleanup: () => void;
} {
  throwIfAborted(signal);
  const controller = new AbortController();
  if (signal === undefined) return { controller, cleanup: () => {} };
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
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
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
      const finalPrompt = buildPromptWithImages(prompt, images);
      const baseCallContext = callContext ?? createSdkCallContext({ permissionMode, model });

      const runQuery = async (resumeId: string | undefined, attempt: number) => {
        throwIfAborted(signal);
        const forwardedAbort = createForwardedAbortController(signal);
        const callbackBuffer =
          resumeId === undefined
            ? null
            : createRunnerAttemptCallbackBuffer({ onOutput, onSessionId, onCallEvent });
        const attemptCallbacks = callbackBuffer?.callbacks ?? {
          onOutput,
          onSessionId,
          onCallEvent,
        };
        let unexpectedResumeSessionId: string | null = null;
        const captureSession = (id: string) => {
          if (resumeId !== undefined && id !== resumeId) {
            unexpectedResumeSessionId = id;
            return;
          }
          session.capture(id);
          attemptCallbacks.onSessionId?.(id);
        };
        const options: SdkQueryOptions['options'] = {
          allowedTools: opts.allowedTools,
          permissionMode,
          model,
          cwd: projectDir,
          includePartialMessages: true,
          abortController: forwardedAbort.controller,
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
        try {
          const result = await processStream({
            stream: query({ prompt: finalPrompt, options }),
            onOutput: attemptCallbacks.onOutput,
            onSessionId: captureSession,
            onCallEvent: attemptCallbacks.onCallEvent,
            callContext: createSessionAttemptCallContext(baseCallContext, attempt),
            signal,
            forwardedAbortController: forwardedAbort.controller,
            idle: { warnMs: opts.idleWarnMs, killMs: opts.idleKillMs },
          });
          const returnedSessionId = result.sessionId ?? unexpectedResumeSessionId;
          if (
            resumeId !== undefined &&
            returnedSessionId !== null &&
            returnedSessionId !== resumeId
          ) {
            throw sessionResumeMismatchError(resumeId, returnedSessionId);
          }
          callbackBuffer?.flush();
          return result;
        } catch (err) {
          if (resumeId === undefined || !isSessionExpiredError(err)) callbackBuffer?.flush();
          throw err;
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
