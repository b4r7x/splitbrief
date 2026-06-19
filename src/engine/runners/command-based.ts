import type { OutputFormat } from '../../core/schemas/enums.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ParsedLine } from './types.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import { toTokenDelta } from '../calls/projection.js';
import { runnerCallInterruptedStatus } from '../calls/status.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { getLineParser } from '../streaming/output-parsers.js';
import { accumulateUsage } from '../streaming/token-usage.js';
import { spawnWithShellFallback } from '../../lib/process/spawn.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { processError } from '../../lib/process/errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';

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

function collectParsedOutput(
  output: string,
  parseLine: (line: string) => ParsedLine,
): { text: string; usage: TokenDelta | null } {
  let text = '';
  let usage: TokenDelta | null = null;
  for (const line of output.split('\n')) {
    const parsed = parseLine(line);
    if (parsed.text) text += parsed.text;
    if (parsed.usage) usage = accumulateUsage(usage, parsed.usage);
  }
  return { text, usage };
}

function substitutePromptPlaceholder(
  command: string,
  args: string[],
  prompt: string,
): { command: string; args: string[]; useStdin: boolean } {
  const commandHasPlaceholder = command.includes('{prompt}');
  const argsHavePlaceholder = args.some((a) => a.includes('{prompt}'));

  if (!commandHasPlaceholder && !argsHavePlaceholder) {
    return { command, args, useStdin: true };
  }

  return {
    command: commandHasPlaceholder ? command.replaceAll('{prompt}', () => prompt) : command,
    args: argsHavePlaceholder ? args.map((a) => a.replaceAll('{prompt}', () => prompt)) : args,
    useStdin: false,
  };
}

export async function invokeCommandBasedRunner(
  opts: CommandBasedOptions & {
    prompt: string;
    projectDir: string;
    onOutput?: ((chunk: string) => void) | undefined;
    onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
    callContext?: RunnerCallContext | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<CommandBasedResult> {
  const { prompt, projectDir, onOutput, signal } = opts;
  const rawArgs = opts.args ?? [];
  const format: OutputFormat = opts.outputFormat ?? 'text';

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
    const liveOutputBuffer = createLineBuffer((line) => {
      const parsed = parseLine(line);
      if (parsed.text) {
        recorder.text({ channel: parsed.isResult ? 'result' : 'stdout', text: parsed.text });
        onOutput?.(parsed.text);
      }
      if (parsed.usage) {
        recorder.usage({
          usage: parsed.usage,
          semantics: parsed.isResult ? 'final' : 'delta',
        });
      }
      if (parsed.isError) {
        recorder.finishFailed({
          status: 'failed',
          error: {
            code: 'runner_result_error',
            message: parsed.text ?? 'Runner result failed',
          },
        });
      }
    });
    try {
      const result = await spawnWithShellFallback({
        command: finalCommand,
        args: finalArgs,
        cwd: projectDir,
        env: opts.env,
        timeout: opts.timeout,
        onProgress: (chunk) => liveOutputBuffer.push(chunk),
        stdinInput: useStdin ? prompt : undefined,
        notFoundMessage: opts.notFoundMessage,
        signal,
      });
      liveOutputBuffer.flush();

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

      const parsedOutput = collectParsedOutput(result.output, parseLine);
      stdout = parsedOutput.text;
      usage = parsedOutput.usage;
      stderr = result.stderr;
      if (!recorder.hasTerminal()) recorder.finishCompleted();
      callResult = recorder.finalResult();
    } catch (err) {
      liveOutputBuffer.flush();
      if (!recorder.hasTerminal()) {
        recorder.finishFailed({
          status: signal?.aborted ? runnerCallInterruptedStatus(signal) : 'failed',
          error: { code: 'command_failed', message: toErrorMessage(err) },
        });
      }
      throw err;
    }
  } else {
    const result = await spawnAndCollect({
      command: finalCommand,
      args: finalArgs,
      cwd: projectDir,
      env: opts.env,
      stdin: useStdin ? prompt : undefined,
      format,
      notFoundMessage: opts.notFoundMessage,
      onText: onOutput,
      onCallEvent: opts.onCallEvent,
      callContext: context,
      signal,
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });

    stdout = result.text;
    usage = toTokenDelta(result.usage);
    callResult = result;
  }

  return { stdout, stderr, usage, callResult };
}
