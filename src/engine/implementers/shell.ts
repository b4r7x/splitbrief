import { join } from 'node:path';
import type { OutputFormat, ImplementerResult, ImplementerTokenUsage } from '../../types.js';
import type { ImplementerOptions, RetryOptions } from '../implementer-utils.js';
import { buildFullPrompt, buildFullRetryPrompt } from '../spec/formatter.js';
import { createGenEventEmitter, processImplementerOutput } from '../implementer-utils.js';
import { spawnWithStdin } from '../planners/spawn.js';
import { getLineParser, accumulateUsage } from '../output-parsers.js';
import { readFileOrEmpty } from '../../utils/fs.js';
import { toErrorMessage } from '../../utils/format.js';

interface ShellImplResult {
  text: string;
  usage: ImplementerTokenUsage | null;
}

interface SpawnShellOptions {
  command: string;
  args: string[];
  prompt: string;
  projectDir: string;
  format: OutputFormat;
  onProgress: (text: string) => void;
}

async function spawnShellImplementer(opts: SpawnShellOptions): Promise<ShellImplResult> {
  const { command, args, prompt, projectDir, format, onProgress } = opts;
  const parseLine = getLineParser(format);

  let collectedText = '';
  let rawUsage: ImplementerTokenUsage | null = null;

  const handleLine = (line: string) => {
    const parsed = parseLine(line);
    if (parsed.text) {
      collectedText += parsed.text;
      onProgress(parsed.text);
    }
    if (parsed.usage) {
      rawUsage = accumulateUsage(rawUsage, parsed.usage);
    }
  };

  try {
    await spawnWithStdin({
      command,
      args,
      cwd: projectDir,
      stdin: prompt,
      onLine: handleLine,
      notFoundMessage: `Shell implementer command not found: ${command}`,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('command not found')) throw err;
    if (err instanceof Error && !collectedText) throw err;
  }

  return { text: collectedText, usage: rawUsage };
}

async function runShellImplementer(opts: ImplementerOptions & { prompt: string }): Promise<ImplementerResult> {
  const { task, projectDir, config, prompt, onProgress, onEvent } = opts;
  const emitGenEvent = createGenEventEmitter(onEvent, config.implementer.model, task.file);

  emitGenEvent('running');

  const filePath = join(projectDir, task.file);
  const oldContent = readFileOrEmpty(filePath);

  const command = config.implementer.command!;
  const args = config.implementer.args ?? [];
  const format: OutputFormat = config.implementer.outputFormat ?? 'text';

  let implResult: ImplementerResult | undefined;
  try {
    let result: ShellImplResult;
    try {
      result = await spawnShellImplementer({ command, args, prompt, projectDir, format, onProgress });
    } catch (err) {
      if (err instanceof Error && err.message.includes('command not found')) throw err;
      return { success: false, output: '', error: toErrorMessage(err) };
    }

    const usage = result.usage;
    const processResult = await processImplementerOutput(result.text, task, projectDir, oldContent);

    if (!processResult.success) {
      return { success: false, output: result.text, error: processResult.error, usage };
    }

    emitGenEvent('done', { linesAdded: processResult.linesAdded, linesRemoved: processResult.linesRemoved, diff: processResult.diff });
    implResult = { success: true, output: result.text, usage };
    return implResult;
  } finally {
    if (!implResult?.success) emitGenEvent('failed');
  }
}

export async function implementTaskViaShell(opts: ImplementerOptions): Promise<ImplementerResult> {
  const { task, config, context } = opts;
  const prompt = buildFullPrompt(task, context, config.implementer.contextLength);
  return runShellImplementer({ ...opts, prompt });
}

export async function retryTaskViaShell(opts: RetryOptions): Promise<ImplementerResult> {
  const { task, config, context, error, attempt } = opts;
  const prompt = buildFullRetryPrompt(task, context, error, attempt, config.implementer.contextLength);
  return runShellImplementer({ ...opts, prompt });
}
