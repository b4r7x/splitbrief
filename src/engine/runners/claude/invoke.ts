import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { CliSchemaInput } from '../cli-tools/contract.js';
import { spawnWithStdin } from '../../../lib/process/spawn/line-stream.js';
import type { CliAuthChannelId } from '../../../core/runners/cli-tool-catalog.js';
import { resolveCliExecutable } from '../resolve-cli-executable.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../calls/types.js';
import { runnerCallLimitWarning, runnerCallLineOutputLimit } from '../../calls/output-limit.js';
import { CLI_RAW_OUTPUT_MAX_BYTES } from '../cli-tools/process-invoke.js';
import { error } from '../../../utils/error.js';
import {
  buildClaudeIdleOptions,
  createStreamHandler,
  finishClaudeStream,
  interruptedError,
  markFailedClaudeStream,
  markInterruptedClaudeStream,
} from './stream.js';
import { buildClaudeArgs } from './args.js';
import { withCliInvocationIdentity } from '../invocation-identity.js';
import {
  claudeCredentialValues,
  defaultClaudeEnv,
  normalizeClaudeProcessOutputError,
} from './child-env.js';

let claudeCallSequence = 0;

function createClaudeCallContext(model: string | undefined): RunnerCallContext {
  return {
    callId: `claude-${++claudeCallSequence}`,
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'claude',
    ...(model !== undefined && { model }),
  };
}

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

interface ClaudeCallRunOptions {
  args: string[];
  stdin: string;
  projectDir: string;
  spawnEnv: NodeJS.ProcessEnv;
  sessionId: string | null;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onSessionInit?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  /** The runner's raw `authChannel`, kept apart from the resolved default in `authChannel`. */
  configuredAuthChannel?: CliAuthChannelId | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
}

async function runClaudeCall(
  opts: ClaudeCallRunOptions,
): Promise<{ result: RunnerCallResult; sessionId: string | null }> {
  const callContext = opts.callContext ?? createClaudeCallContext(opts.model);
  // Without a trusted executable nothing is spawned: resolution below refuses.
  const context =
    opts.executable === null || opts.executable === undefined
      ? callContext
      : withCliInvocationIdentity({
          runner: {
            kind: 'cli',
            tool: 'claude-code',
            ...(opts.configuredAuthChannel !== undefined && {
              authChannel: opts.configuredAuthChannel,
            }),
          },
          callContext,
          executable: opts.executable,
        });
  const { state, handleLine } = createStreamHandler({
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onSessionInit: opts.onSessionInit,
    onCallEvent: opts.onCallEvent,
    credentialValues: claudeCredentialValues(opts.authChannel, opts.spawnEnv),
    context,
  });
  state.sessionId = opts.sessionId;

  let trustedExecutablePath: string | undefined;
  try {
    trustedExecutablePath = (await resolveTrustedClaudeExecutable(opts.projectDir, opts.executable))
      .path;
    await spawnWithStdin({
      command: trustedExecutablePath,
      args: opts.args,
      cwd: opts.projectDir,
      env: opts.spawnEnv,
      stdin: opts.stdin,
      notFoundMessage: CLAUDE_NOT_FOUND,
      onLine: handleLine,
      onStdoutLineOverflow: (overflow) => {
        state.recorder.warning({
          warning: runnerCallLimitWarning(
            runnerCallLineOutputLimit({
              code: 'stdout_line_overflow',
              label: 'stdout line',
              lineBytes: overflow.lineBytes,
              maxLineBytes: overflow.maxLineBytes,
            }),
          ),
        });
        return undefined;
      },
      errorDetail: () => state.resultText ?? undefined,
      // Every line is consumed as it arrives and the recorder bounds what it keeps,
      // so the raw stdout volume must not tear the call down: under
      // --include-partial-messages a ~10-character text delta rides in a ~300-byte
      // envelope, and a long brief list alone passes the 1 MB retention bound.
      // The shared CLI ceiling still ends a runaway process.
      outputBudgetBytes: CLI_RAW_OUTPUT_MAX_BYTES,
      signal: opts.signal,
      idle: buildClaudeIdleOptions(state, {
        idleWarnMs: opts.idleWarnMs,
        idleKillMs: opts.idleKillMs,
      }),
    });
  } catch (err) {
    const safeError = normalizeClaudeProcessOutputError(
      err,
      trustedExecutablePath ?? opts.executable?.path,
      state.redactCredential,
    );
    markInterruptedClaudeStream(state, opts.signal);
    if (!opts.signal?.aborted) markFailedClaudeStream(state, safeError);
    throw interruptedError(opts.signal, safeError, state.redactCredential);
  }

  // The recorder holds the call's final text, not the narration that streamed live.
  const result = finishClaudeStream(state);

  return { result, sessionId: state.sessionId };
}

type ClaudePlannerStreamResult = RunnerCallResult & { sessionId?: string | null };

export interface ClaudePlannerStreamOpts {
  prompt: string;
  projectDir: string;
  sessionId: string | null;
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onSessionInit?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  /** The runner's raw `authChannel`, kept apart from the resolved default in `authChannel`. */
  configuredAuthChannel?: CliAuthChannelId | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  /** The run's global skills, which the call may read and never write. */
  skillRoots?: readonly string[] | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  schema?: CliSchemaInput | undefined;
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
    skillRoots: opts.skillRoots,
    schema: opts.schema,
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
    onSessionInit: opts.onSessionInit,
    onCallEvent: opts.onCallEvent,
    model: opts.model,
    authChannel: opts.authChannel,
    configuredAuthChannel: opts.configuredAuthChannel,
    executable: opts.executable,
    signal: opts.signal,
    callContext: opts.callContext,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
  });

  return { ...result, sessionId };
}

export interface ClaudeOneShotOpts {
  prompt: string;
  projectDir: string;
  /** A read-only call runs in the tool's plan permission mode; only a write-files escalation leaves it. */
  mode: 'plan' | 'escalate';
  onOutput: (text: string) => void;
  onSessionId?: ((id: string) => void) | undefined;
  onSessionInit?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  model?: string | undefined;
  authChannel?: CliAuthChannelId | undefined;
  /** The runner's raw `authChannel`, kept apart from the resolved default in `authChannel`. */
  configuredAuthChannel?: CliAuthChannelId | undefined;
  executable?: CliExecutableIdentity | null | undefined;
  effort?: EffortLevel | undefined;
  configuredArgs?: readonly string[] | undefined;
  /** The run's global skills, which the call may read and never write. */
  skillRoots?: readonly string[] | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  callContext?: RunnerCallContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  schema?: CliSchemaInput | undefined;
}

export async function runClaudeOneShot(opts: ClaudeOneShotOpts): Promise<RunnerCallResult> {
  const args = buildClaudeArgs({
    projectDir: opts.projectDir,
    mode: opts.mode,
    model: opts.model,
    effort: opts.effort,
    configuredArgs: opts.configuredArgs,
    skillRoots: opts.skillRoots,
    schema: opts.schema,
  });
  const spawnEnv = opts.env ?? (await defaultClaudeEnv(opts.projectDir, opts.authChannel));

  const { result } = await runClaudeCall({
    args,
    stdin: applyImageRefs(opts.prompt, opts.images),
    projectDir: opts.projectDir,
    spawnEnv,
    sessionId: null,
    onOutput: opts.onOutput,
    onSessionId: opts.onSessionId,
    onSessionInit: opts.onSessionInit,
    onCallEvent: opts.onCallEvent,
    model: opts.model,
    authChannel: opts.authChannel,
    configuredAuthChannel: opts.configuredAuthChannel,
    executable: opts.executable,
    signal: opts.signal,
    callContext: opts.callContext,
    idleWarnMs: opts.idleWarnMs,
    idleKillMs: opts.idleKillMs,
  });

  return result;
}
