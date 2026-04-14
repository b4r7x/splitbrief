import type { InvokeResult, OutputFormat, ParsedLine, TokenDelta } from '../../types.js';
import { spawnWithStdin } from '../../utils/process.js';
import { accumulateUsage, getLineParser } from './output-parsers.js';

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

export async function spawnAndCollect(opts: SpawnAndCollectOptions): Promise<InvokeResult & { sessionId?: string | null }> {
  const parseLine = opts.parseLine ?? getLineParser(opts.format ?? 'text');

  let collectedText = '';
  let usage: TokenDelta | null = null;
  let sessionId: string | null = null;

  await spawnWithStdin({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    stdin: opts.stdin,
    notFoundMessage: opts.notFoundMessage ?? `Command not found: ${opts.command}`,
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
