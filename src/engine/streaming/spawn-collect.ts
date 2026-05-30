import type { OutputFormat } from '../../core/schemas/enums.js';
import type { InvokeResult, ParsedLine } from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { spawnWithStdin } from '../../lib/process/spawn.js';
import { getLineParser } from './output-parsers.js';
import { accumulateUsage } from './token-utils.js';

interface SpawnAndCollectOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string | undefined;
  format?: OutputFormat | undefined;
  parseLine?: ((line: string) => ParsedLine) | undefined;
  notFoundMessage?: string | undefined;
  onText?: ((text: string) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export async function spawnAndCollect(
  opts: SpawnAndCollectOptions,
): Promise<InvokeResult & { sessionId?: string | null }> {
  const parseLine = opts.parseLine ?? getLineParser(opts.format ?? 'text');

  let collectedText = '';
  let usage: TokenDelta | null = null;
  let sessionId: string | null = null;

  await spawnWithStdin({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    stdin: opts.stdin,
    notFoundMessage: opts.notFoundMessage,
    onStderr: opts.onStderr,
    signal: opts.signal,
    onLine(line) {
      const parsed = parseLine(line);
      if (parsed.text) {
        collectedText += parsed.text;
        opts.onText?.(parsed.text);
      }
      if (parsed.usage) {
        usage = accumulateUsage(usage, parsed.usage);
      }
      if (parsed.sessionId && parsed.sessionId !== sessionId) {
        sessionId = parsed.sessionId;
        opts.onSessionId?.(parsed.sessionId);
      }
    },
  });

  return { text: collectedText, usage, sessionId };
}
