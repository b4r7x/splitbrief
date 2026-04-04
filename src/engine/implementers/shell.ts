import type { Config, OutputFormat, ImplementerTokenUsage } from '../../types.js';
import type { ImplementerOptions, RetryOptions } from './base.js';
import type { ImplementerBackend } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase } from './base.js';
import { buildFullPrompt, buildFullRetryPrompt } from '../spec/formatter.js';
import { spawnWithStdin } from '../planners/spawn.js';
import { getLineParser, accumulateUsage } from '../output-parsers.js';

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

export function createShellImplementer(config: Config): ImplementerBackend {
  return createImplementerBase({
    name: 'shell',
    pricingKey: 'shell',
    extractsCode: true,

    async invoke(opts: InvokeOpts) {
      const { prompt, projectDir, config: cfg, onProgress } = opts;
      const command = cfg.implementer.command!;
      const args = cfg.implementer.args ?? [];
      const format: OutputFormat = cfg.implementer.outputFormat ?? 'text';

      const result = await spawnShellImplementer({ command, args, prompt, projectDir, format, onProgress });
      return { text: result.text, usage: result.usage };
    },

    buildPrompt(opts: ImplementerOptions) {
      return buildFullPrompt(opts.task, opts.context, opts.config.implementer.contextLength);
    },

    buildRetryPrompt(opts: RetryOptions) {
      return buildFullRetryPrompt(opts.task, opts.context, opts.error, opts.attempt, opts.config.implementer.contextLength);
    },

    shouldThrow(err: unknown) {
      return err instanceof Error && err.message.includes('command not found');
    },

    async isAvailable() {
      return true;
    },
  });
}

