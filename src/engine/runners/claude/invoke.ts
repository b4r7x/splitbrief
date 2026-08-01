import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { spawnWithStdin } from '../../../lib/process/spawn/line-stream.js';
import { createSanitizedChildEnv } from '../../../lib/process/spawn/lifecycle.js';
import { processError } from '../../../lib/process/errors.js';
import type { CliAuthChannelId } from '../../../core/runners/cli-tool-catalog.js';
import { resolveCliExecutable, sanitizedRuntimePath } from '../resolve-cli-executable.js';
import { sandboxCredentialValues } from '../sandbox-env.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import { runnerCallLineOutputLimit } from '../../calls/output-limit.js';
import { error } from '../../../utils/error.js';
import {
  buildClaudeIdleOptions,
  createStreamHandler,
  finishClaudeOutputLimit,
  finishClaudeStream,
  interruptedError,
  markFailedClaudeStream,
  markInterruptedClaudeStream,
} from './stream.js';

const CLAUDE_NOT_FOUND = 'Claude Code CLI not found. Install it from https://claude.ai/code';

let claudeCallSequence = 0;

function createClaudeCallContext(opts: {
  role: RunnerCallContext['role'];
  model?: string | undefined;
}): RunnerCallContext {
  return {
    callId: `claude-${++claudeCallSequence}`,
    role: opts.role,
    backendKind: 'cli',
    runnerName: 'claude',
    ...(opts.model !== undefined && { model: opts.model }),
  };
}

interface BuildArgsOpts {
  sessionId?: string | null;
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  permissionMode?: 'acceptEdits' | undefined;
}

async function defaultClaudeEnv(
  projectDir: string,
  authChannel: CliAuthChannelId | undefined,
): Promise<NodeJS.ProcessEnv> {
  const preserveKeys = authChannel === 'api-key' ? ['ANTHROPIC_API_KEY'] : [];
  const env = createSanitizedChildEnv(process.env, preserveKeys);
  env.PATH = await sanitizedRuntimePath(projectDir);
  return env;
}

function claudeCredentialValues(
  authChannel: CliAuthChannelId | undefined,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const apiKey = authChannel === 'api-key' ? env.ANTHROPIC_API_KEY : undefined;
  return [...(apiKey === undefined ? [] : [apiKey]), ...sandboxCredentialValues(env)];
}

function redactClaudeExecutablePath(value: string, executablePath: string): string {
  if (executablePath.length === 0 || !value.includes(executablePath)) return value;
  return value.split(executablePath).join('claude');
}

function normalizeClaudeProcessOutputError(
  err: unknown,
  executablePath: string | undefined,
  redactCredential?: (value: string) => string,
): unknown {
  if (!processError.isExitCode(err)) return err;

  const knownPaths = [err.data.command, executablePath].filter(
    (path, index, paths): path is string =>
      typeof path === 'string' && path.length > 0 && paths.indexOf(path) === index,
  );
  const redact = (value: string): string =>
    redactCredential?.(
      knownPaths.reduce((current, path) => redactClaudeExecutablePath(current, path), value),
    ) ?? value;
  const stderr = redact(err.data.stderr);
  const output = redact(err.data.output);
  const detailPrefix = ` exited with code ${err.data.code}`;
  const detailStart = err.message.indexOf(detailPrefix);
  const originalDetail =
    detailStart < 0
      ? undefined
      : err.message.slice(detailStart + detailPrefix.length).replace(/^: /, '');

  return processError.exitCode({
    command: 'claude',
    ...(err.data.label !== undefined && { label: redact(err.data.label) }),
    code: err.data.code,
    stderr,
    output,
    ...(originalDetail !== undefined && { detail: redact(originalDetail) }),
  });
}

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
  return resolveCliExecutable('claude', projectDir, executable);
}

function applyImageRefs(prompt: string, images: Attachment[] | undefined): string {
  if (!images || images.length === 0) return prompt;
  const refs = images.map((img) => `[image attachment: ${img.path}]`).join('\n');
  return `${refs}\n\n${prompt}`;
}

function buildClaudeArgs(opts: BuildArgsOpts): string[] {
  const { sessionId, model, effort, permissionMode } = opts;
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (sessionId) args.push('--session-id', sessionId);
  return args;
}

type ClaudePlannerStreamResult = RunnerCallResult & { sessionId?: string | null };

export interface ClaudePlannerStreamOpts {
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
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export async function runClaudePlannerStream(
  opts: ClaudePlannerStreamOpts,
): Promise<ClaudePlannerStreamResult> {
  const {
    prompt,
    projectDir,
    sessionId,
    onOutput,
    onSessionId,
    onQuestion,
    onCallEvent,
    model,
    authChannel,
    env,
    executable,
    effort,
    images,
    signal,
    callContext,
  } = opts;
  const args = buildClaudeArgs({ sessionId, model, effort });
  const spawnEnv = env ?? (await defaultClaudeEnv(projectDir, authChannel));

  const context = callContext ?? createClaudeCallContext({ role: 'planner', model });
  const { state, handleLine } = createStreamHandler({
    onOutput,
    onSessionId,
    onQuestion,
    onCallEvent,
    credentialValues: claudeCredentialValues(authChannel, spawnEnv),
    context,
  });
  state.sessionId = sessionId;

  let trustedExecutablePath: string | undefined;
  try {
    trustedExecutablePath = (await resolveTrustedClaudeExecutable(projectDir, executable)).path;
    await spawnWithStdin({
      command: trustedExecutablePath,
      args,
      cwd: projectDir,
      env: spawnEnv,
      stdin: applyImageRefs(prompt, images),
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
      signal,
      idle: buildClaudeIdleOptions(state, opts),
    });
  } catch (err) {
    const safeError = normalizeClaudeProcessOutputError(
      err,
      trustedExecutablePath ?? executable?.path,
      state.redactCredential,
    );
    markInterruptedClaudeStream(state, signal);
    if (!signal?.aborted) markFailedClaudeStream(state, safeError);
    throw interruptedError(signal, safeError, state.redactCredential);
  }

  const result = finishClaudeStream(state);

  return { ...result, text: state.text, sessionId: state.sessionId };
}

export interface ClaudeOneShotOpts {
  prompt: string;
  projectDir: string;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  effort?: EffortLevel | undefined;
  permissionMode?: 'acceptEdits' | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<RunnerCallResult> {
  const {
    prompt,
    projectDir,
    onOutput,
    onSessionId,
    onCallEvent,
    model,
    authChannel,
    executable,
    effort,
    permissionMode,
    signal,
    callContext,
    env,
  } = opts;
  const spawnEnv = env ?? (await defaultClaudeEnv(projectDir, authChannel));
  const context =
    callContext ??
    createClaudeCallContext({
      role: permissionMode === 'acceptEdits' ? 'implementer' : 'planner',
      model,
    });
  const { state, handleLine } = createStreamHandler({
    onOutput,
    onSessionId,
    onCallEvent,
    credentialValues: claudeCredentialValues(authChannel, spawnEnv),
    context,
  });
  const args = buildClaudeArgs({ model, effort, permissionMode });

  let trustedExecutablePath: string | undefined;
  try {
    trustedExecutablePath = (await resolveTrustedClaudeExecutable(projectDir, executable)).path;
    await spawnWithStdin({
      command: trustedExecutablePath,
      args,
      cwd: projectDir,
      env: spawnEnv,
      stdin: prompt,
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
      signal,
      idle: buildClaudeIdleOptions(state, opts),
    });
  } catch (err) {
    const safeError = normalizeClaudeProcessOutputError(
      err,
      trustedExecutablePath ?? executable?.path,
      state.redactCredential,
    );
    markInterruptedClaudeStream(state, signal);
    if (!signal?.aborted) markFailedClaudeStream(state, safeError);
    throw interruptedError(signal, safeError, state.redactCredential);
  }

  const result = finishClaudeStream(state);

  return { ...result, text: state.text };
}
