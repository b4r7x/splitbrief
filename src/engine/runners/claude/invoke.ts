import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { spawnWithStdin } from '../../../lib/process/spawn/line-stream.js';
import type { CliAuthChannelId } from '../../../core/runners/cli-tool-catalog.js';
import { resolveCliExecutable } from '../resolve-cli-executable.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import {
  finishRunnerCallOutputLimit,
  runnerCallLineOutputLimit,
} from '../../calls/output-limit.js';
import { error } from '../../../utils/error.js';
import {
  buildClaudeIdleOptions,
  createStreamHandler,
  finishClaudeOutputLimit,
  finishClaudeStream,
  interruptedError,
  markFailedClaudeStream,
  markInterruptedClaudeStream,
  throwForClaudeCallFailure,
} from './stream.js';
import { buildClaudeArgs } from './args.js';
import {
  claudeCredentialValues,
  defaultClaudeEnv,
  normalizeClaudeProcessOutputError,
} from './child-env.js';
import {
  type ClaudeEnvelopeCallOptions,
  claimClaudeDispatch,
  prepareClaudeEnvelopeCall,
} from './envelope-guard.js';

const CLAUDE_NOT_FOUND = 'Claude Code CLI not found. Install it from https://claude.ai/code';

async function resolveTrustedClaudeExecutable(
  projectDir: string,
  executable: CliExecutableIdentity | null | undefined,
): Promise<CliExecutableIdentity> {
  if (executable === null || executable === undefined) {
    throw error(
      'cli-executable-untrusted',
      'Claude Code CLI has no trusted readiness identity; run readiness checks again before execution.',
      { tool: 'claude-code' },
    );
  }
  return resolveCliExecutable({ command: 'claude', projectDir, trust: executable });
}

function applyImageRefs(prompt: string, images: Attachment[] | undefined): string {
  if (!images || images.length === 0) return prompt;
  const refs = images.map((img) => `[image attachment: ${img.path}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

interface ClaudeCallRunOptions extends ClaudeEnvelopeCallOptions {
  args: string[];
  stdin: string;
  projectDir: string;
  spawnEnv: NodeJS.ProcessEnv;
  sessionId: string | null;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

async function runClaudeCall(
  opts: ClaudeCallRunOptions,
): Promise<{ result: RunnerCallResult; sessionId: string | null }> {
  const { context, attemptId, guard } = prepareClaudeEnvelopeCall({
    callContext: opts.callContext,
    model: opts.model,
    role: 'planner',
    signal: opts.signal,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
    ledger: opts.ledger,
    attemptId: opts.attemptId,
    envelope: opts.envelope,
  });
  const { state, handleLine } = createStreamHandler({
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onQuestion: opts.onQuestion,
    onCallEvent: (event) => {
      guard.onEvent(event);
      opts.onCallEvent?.(event);
    },
    credentialValues: claudeCredentialValues(opts.authChannel, opts.spawnEnv),
    context,
  });
  state.sessionId = opts.sessionId;

  let trustedExecutablePath: string | undefined;
  try {
    trustedExecutablePath = (await resolveTrustedClaudeExecutable(opts.projectDir, opts.executable))
      .path;
    if (opts.ledger !== undefined) {
      claimClaudeDispatch(state, opts.ledger, attemptId);
    }
    await spawnWithStdin({
      command: trustedExecutablePath,
      args: opts.args,
      cwd: opts.projectDir,
      env: opts.spawnEnv,
      stdin: opts.stdin,
      notFoundMessage: CLAUDE_NOT_FOUND,
      onLine: handleLine,
      onStdoutLineOverflow: (overflow) => {
        finishClaudeOutputLimit(
          state,
          runnerCallLineOutputLimit({
            code: 'stdout_line_overflow',
            label: 'stdout line',
            lineBytes: overflow.lineBytes,
            maxLineBytes: overflow.maxLineBytes,
          }),
        );
      },
      errorDetail: () => state.resultText ?? undefined,
      signal: guard.signal,
      idle: buildClaudeIdleOptions(state, {
        idleWarnMs: guard.idleWarnMs,
        idleKillMs: guard.idleKillMs,
      }),
      outputBudgetBytes: guard.outputBudgetBytes,
      outputMaxBytes: guard.outputMaxBytes,
    });
  } catch (err) {
    const safeError = normalizeClaudeProcessOutputError(
      err,
      trustedExecutablePath ?? opts.executable?.path,
      state.redactCredential,
    );
    const limit = guard.limit();
    if (limit !== null) {
      finishRunnerCallOutputLimit(state.recorder, limit, {
        usage: state.usage,
        nativeSessionId: state.sessionId,
      });
      throwForClaudeCallFailure(state.recorder.finalResult());
    }
    markInterruptedClaudeStream(state, guard.signal);
    if (!guard.signal?.aborted) markFailedClaudeStream(state, safeError);
    throw interruptedError(opts.signal, safeError, state.redactCredential);
  } finally {
    guard.cleanup();
  }

  const result = finishClaudeStream(state);

  return { result: { ...result, text: state.text }, sessionId: state.sessionId };
}

type ClaudePlannerStreamResult = RunnerCallResult & { sessionId?: string | null };

export interface ClaudePlannerStreamOpts extends ClaudeEnvelopeCallOptions {
  prompt: string;
  projectDir: string;
  sessionId: string | null;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onQuestion?: ((questions: ClarificationQuestion[]) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export async function runClaudePlannerStream(
  opts: ClaudePlannerStreamOpts,
): Promise<ClaudePlannerStreamResult> {
  const args = buildClaudeArgs({
    projectDir: opts.projectDir,
    mode: 'plan',
    sessionId: opts.sessionId,
    model: opts.model,
    effort: opts.effort,
    configuredArgs: opts.configuredArgs,
  });
  const spawnEnv = opts.env ?? (await defaultClaudeEnv(opts.projectDir, opts.authChannel));

  const { result, sessionId } = await runClaudeCall({
    args,
    stdin: applyImageRefs(opts.prompt, opts.images),
    projectDir: opts.projectDir,
    spawnEnv,
    sessionId: opts.sessionId,
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onQuestion: opts.onQuestion,
    onCallEvent: opts.onCallEvent,
    model: opts.model,
    authChannel: opts.authChannel,
    executable: opts.executable,
    signal: opts.signal,
    callContext: opts.callContext,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
    ledger: opts.ledger,
    attemptId: opts.attemptId,
    envelope: opts.envelope,
  });

  return { ...result, sessionId };
}

export interface ClaudeOneShotOpts extends ClaudeEnvelopeCallOptions {
  prompt: string;
  projectDir: string;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<RunnerCallResult> {
  const args = buildClaudeArgs({
    projectDir: opts.projectDir,
    mode: 'escalate',
    model: opts.model,
    effort: opts.effort,
    configuredArgs: opts.configuredArgs,
  });
  const spawnEnv = opts.env ?? (await defaultClaudeEnv(opts.projectDir, opts.authChannel));

  const { result } = await runClaudeCall({
    args,
    stdin: opts.prompt,
    projectDir: opts.projectDir,
    spawnEnv,
    sessionId: null,
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onCallEvent: opts.onCallEvent,
    model: opts.model,
    authChannel: opts.authChannel,
    executable: opts.executable,
    signal: opts.signal,
    callContext: opts.callContext,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
    ledger: opts.ledger,
    attemptId: opts.attemptId,
    envelope: opts.envelope,
  });

  return result;
}
