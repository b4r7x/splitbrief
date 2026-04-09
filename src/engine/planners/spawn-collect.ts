import type { PlannerTokenUsage } from '../../types.js';
import { spawnWithStdin } from '../../utils/process.js';
import { accumulateUsage } from '../streaming/output-parsers.js';

interface ParsedLine {
  text?: string | undefined;
  usage?: PlannerTokenUsage | undefined;
}

interface SpawnAndCollectOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string | undefined;
  notFoundMessage: string;
  parseLine: (line: string) => ParsedLine;
  onOutput: (text: string) => void;
  onStderr?: ((chunk: string) => void) | undefined;
}

export async function spawnAndCollect(opts: SpawnAndCollectOptions): Promise<{ text: string; usage: PlannerTokenUsage | null }> {
  let collectedText = '';
  let usage: PlannerTokenUsage | null = null;

  await spawnWithStdin({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    stdin: opts.stdin,
    notFoundMessage: opts.notFoundMessage,
    onStderr: opts.onStderr,
    onLine(line) {
      const parsed = opts.parseLine(line);
      if (parsed.text) {
        collectedText += parsed.text;
        opts.onOutput(parsed.text);
      }
      if (parsed.usage) {
        usage = accumulateUsage(usage, parsed.usage);
      }
    },
  });

  return { text: collectedText, usage };
}
