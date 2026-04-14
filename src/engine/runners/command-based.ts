import type { OutputFormat } from '../../core/types/schemas/enums.js';
import type { TokenDelta } from '../../core/types/summary.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { spawnWithShellFallback } from '../../utils/process.js';
import { CommandTimeoutError, CommandNotFoundError } from '../../utils/process-errors.js';
import { extractCode } from '../parsers/response-extractor.js';

export interface CommandBasedOptions {
  command: string;
  args?: string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  /** If true, parse stdout for code blocks. If false, use detectChanges callback */
  extractsCode: boolean;
  /** Callback to detect changes when extractsCode is false */
  detectChanges?: (() => Promise<boolean>) | undefined;
  /** If true, substitute {prompt} placeholder in command/args. If false, use stdin */
  supportPromptPlaceholder?: boolean | undefined;
  /** Timeout in ms. If set, uses spawnWithShellFallback instead of spawnAndCollect */
  timeout?: number | undefined;
  notFoundMessage?: string | undefined;
}

export interface CommandBasedResult {
  /** Extracted code (when extractsCode: true) */
  code?: string;
  /** Whether changes were detected (when extractsCode: false) */
  hasChanges?: boolean;
  stdout: string;
  stderr: string;
  /** Token usage forwarded from the parser (when available) */
  usage?: TokenDelta | null;
}

function substitutePromptPlaceholder(
  command: string,
  args: string[],
  prompt: string,
): { command: string; args: string[]; useStdin: boolean } {
  const commandHasPlaceholder = command.includes('{prompt}');
  const argsHavePlaceholder = args.some(a => a.includes('{prompt}'));

  if (!commandHasPlaceholder && !argsHavePlaceholder) {
    return { command, args, useStdin: true };
  }

  return {
    command: commandHasPlaceholder ? command.replace('{prompt}', prompt) : command,
    args: argsHavePlaceholder ? args.map(a => a.replace('{prompt}', prompt)) : args,
    useStdin: false,
  };
}

export async function invokeCommandBasedRunner(
  opts: CommandBasedOptions,
  prompt: string,
  projectDir: string,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<CommandBasedResult> {
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

  const notFoundMessage = opts.notFoundMessage ?? `Command not found: ${opts.command}`;
  let stdout: string;
  let stderr = '';
  let usage: TokenDelta | null = null;

  if (opts.timeout !== undefined) {
    const result = await spawnWithShellFallback({
      command: finalCommand,
      args: finalArgs,
      cwd: projectDir,
      timeout: opts.timeout,
      onProgress: onOutput ?? (() => {}),
      stdinInput: useStdin ? prompt : undefined,
      notFoundMessage,
      signal,
    });

    if (result.timedOut) {
      throw new CommandTimeoutError(
        `Command timed out after ${Math.round(opts.timeout / 1000)}s`,
        result.output,
      );
    }

    if (result.code === 127) {
      throw new CommandNotFoundError(notFoundMessage);
    }

    stdout = result.output;
    stderr = result.stderr;
  } else {
    const result = await spawnAndCollect({
      command: finalCommand,
      args: finalArgs,
      cwd: projectDir,
      stdin: useStdin ? prompt : undefined,
      format,
      notFoundMessage,
      onText: onOutput,
      signal,
      onStderr: chunk => {
        stderr += chunk;
      },
    });

    stdout = result.text;
    usage = result.usage;
  }

  if (opts.extractsCode) {
    const extracted = extractCode(stdout);
    if ('code' in extracted) {
      return { code: extracted.code, stdout, stderr, usage };
    }
    return { stdout, stderr, usage };
  }

  if (opts.detectChanges) {
    const hasChanges = await opts.detectChanges();
    return { hasChanges, stdout, stderr, usage };
  }

  return { stdout, stderr, usage };
}
