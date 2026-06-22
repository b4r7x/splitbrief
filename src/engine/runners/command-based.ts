import type { OutputFormat } from '../../core/schemas/enums.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import { toTokenDelta } from '../calls/projection.js';
import { runnerCallInterruptedStatus } from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { getLineParser } from '../streaming/output-parsers.js';
import { createParsedLineRecorder } from '../streaming/parsed-line-recorder.js';
import { createRunnerCallStderrBuffer } from '../streaming/stderr-lines.js';
import { createBoundedOutput } from '../../lib/process/bounded-output.js';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  spawnWithShellFallback,
} from '../../lib/process/spawn.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { processError } from '../../lib/process/errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error } from '../../utils/error.js';
import { finishRunnerCallOutputLimit, runnerCallLineOutputLimit } from '../calls/output-limit.js';

const PROMPT_PLACEHOLDER = '{prompt}';

export interface CommandBasedOptions {
  command: string;
  args?: string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  supportPromptPlaceholder?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeout?: number | undefined;
  notFoundMessage?: string | undefined;
}

export interface CommandBasedResult {
  stdout: string;
  stderr: string;
  usage?: TokenDelta | null;
  callResult: RunnerCallResult;
}

let commandCallSequence = 0;

function rejectPromptPlaceholderCommand(command: string): void {
  if (!command.includes(PROMPT_PLACEHOLDER)) return;

  throw error(
    'runner-command-prompt-placeholder',
    'Runner command must not contain {prompt}; pass the prompt through stdin or args instead.',
    { command },
  );
}

function createCommandCallContext(opts: {
  command: string;
  callContext?: RunnerCallContext | undefined;
}): RunnerCallContext {
  return (
    opts.callContext ?? {
      callId: `command-${++commandCallSequence}`,
      role: 'planner',
      backendKind: 'shell',
      runnerName: opts.command,
    }
  );
}

function substitutePromptPlaceholder(
  command: string,
  args: string[],
  prompt: string,
): { command: string; args: string[]; useStdin: boolean } {
  const argsHavePlaceholder = args.some((a) => a.includes(PROMPT_PLACEHOLDER));

  if (!argsHavePlaceholder) {
    return { command, args, useStdin: true };
  }

  return {
    command,
    args: args.map((a) => a.replaceAll(PROMPT_PLACEHOLDER, () => prompt)),
    useStdin: false,
  };
}

export async function invokeCommandBasedRunner(
  opts: CommandBasedOptions & {
    prompt: string;
    projectDir: string;
    onOutput?: ((chunk: string) => void) | undefined;
    onSessionId?: ((id: string) => void) | undefined;
    onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
    callContext?: RunnerCallContext | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<CommandBasedResult> {
  const { prompt, projectDir, onOutput, signal } = opts;
  const rawArgs = opts.args ?? [];
  const format: OutputFormat = opts.outputFormat ?? 'text';

  rejectPromptPlaceholderCommand(opts.command);

  let finalCommand = opts.command;
  let finalArgs = rawArgs;
  let useStdin = true;

  if (opts.supportPromptPlaceholder) {
    const substituted = substitutePromptPlaceholder(opts.command, rawArgs, prompt);
    finalCommand = substituted.command;
    finalArgs = substituted.args;
    useStdin = substituted.useStdin;
  }

  let stdout: string;
  let stderr = '';
  let usage: TokenDelta | null = null;
  let callResult: RunnerCallResult;
  const context = createCommandCallContext({
    command: finalCommand,
    callContext: opts.callContext,
  });

  if (opts.timeout !== undefined) {
    const parseLine = getLineParser(format);
    const recorder = createRunnerCallRecorder({ context, onEvent: opts.onCallEvent });
    const parsedRecorder = createParsedLineRecorder({
      recorder,
      onText: onOutput,
      onSessionId: opts.onSessionId,
    });
    const stderrBuffer = createRunnerCallStderrBuffer(recorder);
    const liveOutputBuffer = createLineBuffer(
      (line) => {
        parsedRecorder.apply(parseLine(line));
      },
      {
        maxLineBytes: DEFAULT_PROCESS_LINE_MAX_BYTES,
        onOverflow: (overflow) => {
          finishRunnerCallOutputLimit(
            recorder,
            runnerCallLineOutputLimit({
              code: 'stdout_line_overflow',
              label: 'stdout line',
              lineBytes: overflow.lineBytes,
              maxLineBytes: overflow.maxLineBytes,
            }),
            {
              usage: parsedRecorder.usage,
              nativeSessionId: parsedRecorder.sessionId,
            },
          );
        },
      },
    );
    try {
      const result = await spawnWithShellFallback({
        command: finalCommand,
        args: finalArgs,
        cwd: projectDir,
        env: opts.env,
        timeout: opts.timeout,
        onProgress: (chunk) => liveOutputBuffer.push(chunk),
        onStderr: (chunk) => stderrBuffer.push(chunk),
        stdinInput: useStdin ? prompt : undefined,
        notFoundMessage: opts.notFoundMessage,
        signal,
      });
      liveOutputBuffer.flush();
      stderrBuffer.flush();

      if (result.timedOut) {
        recorder.finishFailed({
          status: 'timeout',
          error: {
            code: 'command_timeout',
            message: `Command timed out after ${opts.timeout}ms`,
          },
        });
        throw processError.timeout({
          command: 'Command',
          label: 'Command',
          timeoutMs: opts.timeout,
          output: result.output,
        });
      }

      stdout = parsedRecorder.text;
      usage = parsedRecorder.usage;
      stderr = result.stderr;
      if (!recorder.hasTerminal()) recorder.finishCompleted();
      callResult = recorder.finalResult();
    } catch (err) {
      liveOutputBuffer.flush();
      stderrBuffer.flush();
      if (!recorder.hasTerminal()) {
        recorder.finishFailed({
          status: signal?.aborted ? runnerCallInterruptedStatus(signal) : 'failed',
          error: { code: 'command_failed', message: toErrorMessage(err) },
        });
      }
      throw err;
    }
  } else {
    const stderrOutput = createBoundedOutput({
      maxBytes: DEFAULT_PROCESS_STDERR_MAX_BYTES,
      policy: 'tail',
    });
    const result = await spawnAndCollect({
      command: finalCommand,
      args: finalArgs,
      cwd: projectDir,
      env: opts.env,
      stdin: useStdin ? prompt : undefined,
      format,
      notFoundMessage: opts.notFoundMessage,
      onText: onOutput,
      onSessionId: opts.onSessionId,
      onCallEvent: opts.onCallEvent,
      callContext: context,
      signal,
      onStderr: (chunk) => {
        stderrOutput.append(chunk);
      },
    });

    stdout = result.text;
    stderr = stderrOutput.snapshot().text;
    usage = toTokenDelta(result.usage);
    callResult = result;
  }

  return { stdout, stderr, usage, callResult };
}
