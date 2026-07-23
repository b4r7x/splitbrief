import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { spawnWithStdin } from '../../../lib/process/spawn/line-stream.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import { runnerCallLineOutputLimit } from '../../calls/output-limit.js';
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
    effort,
    images,
    signal,
    callContext,
  } = opts;
  const args = buildClaudeArgs({ sessionId, model, effort });

  const context = callContext ?? createClaudeCallContext({ role: 'planner', model });
  const { state, handleLine } = createStreamHandler({
    onOutput,
    onSessionId,
    onQuestion,
    onCallEvent,
    context,
  });
  state.sessionId = sessionId;

  try {
    await spawnWithStdin({
      command: 'claude',
      args,
      cwd: projectDir,
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
    markInterruptedClaudeStream(state, signal);
    if (!signal?.aborted) markFailedClaudeStream(state, err);
    throw interruptedError(signal, err);
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
    effort,
    permissionMode,
    signal,
    callContext,
    env,
  } = opts;
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
    context,
  });
  const args = buildClaudeArgs({ model, effort, permissionMode });

  try {
    await spawnWithStdin({
      command: 'claude',
      args,
      cwd: projectDir,
      env,
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
    markInterruptedClaudeStream(state, signal);
    if (!signal?.aborted) markFailedClaudeStream(state, err);
    throw interruptedError(signal, err);
  }

  const result = finishClaudeStream(state);

  return { ...result, text: state.text };
}
