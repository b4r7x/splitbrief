import type { OutputFormat } from '../../core/schemas/enums.js';
import { collectRunnerCallResult } from '../calls/collector.js';
import { toInvokeResult } from '../calls/projection.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import type { InvokeResult, ParsedLine } from '../runners/types.js';
import { spawnWithStdin } from '../../lib/process/spawn.js';
import { getLineParser } from './output-parsers.js';

interface SpawnAndCollectOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  format?: OutputFormat | undefined;
  parseLine?: ((line: string) => ParsedLine) | undefined;
  notFoundMessage?: string | undefined;
  onText?: ((text: string) => void) | undefined;
  onStderr?: ((chunk: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
  signal?: AbortSignal | undefined;
}

let callSequence = 0;

export async function spawnAndCollect(
  opts: SpawnAndCollectOptions,
): Promise<InvokeResult & { sessionId?: string | null }> {
  const parseLine = opts.parseLine ?? getLineParser(opts.format ?? 'text');
  const context =
    opts.callContext ??
    ({
      callId: `call-${++callSequence}`,
      role: 'implementer',
      backendKind: 'cli',
      runnerName: opts.command,
    } satisfies RunnerCallContext);

  let sessionId: string | null = null;
  const events: RunnerCallEvent[] = [];
  const emit = (event: RunnerCallEvent) => {
    events.push(event);
    opts.onCallEvent?.(event);
  };

  emit({ type: 'call_started', ts: Date.now(), ...context });

  await spawnWithStdin({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    notFoundMessage: opts.notFoundMessage,
    onStderr: opts.onStderr,
    signal: opts.signal,
    onLine(line) {
      const parsed = parseLine(line);
      if (parsed.text) {
        emit({
          type: 'call_text_delta',
          ts: Date.now(),
          ...context,
          channel: parsed.isResult ? 'result' : 'stdout',
          text: parsed.text,
        });
        opts.onText?.(parsed.text);
      }
      if (parsed.usage) {
        emit({
          type: 'call_usage',
          ts: Date.now(),
          ...context,
          usage: parsed.usage,
          semantics: parsed.isResult ? 'final' : 'delta',
        });
      }
      if (parsed.sessionId && parsed.sessionId !== sessionId) {
        sessionId = parsed.sessionId;
        emit({
          type: 'call_session_id',
          ts: Date.now(),
          ...context,
          nativeSessionId: parsed.sessionId,
        });
        opts.onSessionId?.(parsed.sessionId);
      }
      if (parsed.toolUse) {
        for (const toolUse of parsed.toolUse) {
          emit({
            type: 'call_tool_use_done',
            ts: Date.now(),
            ...context,
            channel: 'tool',
            toolUse: { id: null, name: toolUse.name, input: toolUse.input },
          });
        }
      }
      if (parsed.isError) {
        emit({
          type: 'call_error',
          ts: Date.now(),
          ...context,
          status: 'failed',
          error: { code: 'runner_result_error', message: parsed.text ?? 'Runner result failed' },
        });
      }
    },
  });

  if (!events.some((event) => event.type === 'call_error')) {
    emit({
      type: 'call_completed',
      ts: Date.now(),
      ...context,
      status: 'completed',
      usage: null,
      nativeSessionId: sessionId,
    });
  }

  const result = toInvokeResult(collectRunnerCallResult(events));
  return { ...result, sessionId };
}
