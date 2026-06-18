import type { OutputFormat } from '../../core/schemas/enums.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { ParsedLine } from './types.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { getLineParser } from '../streaming/output-parsers.js';
import { accumulateUsage } from '../streaming/token-usage.js';
import { spawnWithShellFallback } from '../../lib/process/spawn.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { processError } from '../../lib/process/errors.js';

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

  if (opts.timeout !== undefined) {
    const parseLine = getLineParser(format);
    const liveOutputBuffer = createLineBuffer((line) => {
      const parsed = parseLine(line);
      if (parsed.text) onOutput?.(parsed.text);
    });
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
      signal,
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });

    stdout = result.text;
    usage = result.usage;
  }

  return { stdout, stderr, usage };
}
