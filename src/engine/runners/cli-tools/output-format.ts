import type { OutputFormat } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import { getLineParser } from '../../streaming/output-parsers.js';
import type { ParsedLine } from '../types.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';

function parsedLineToProtocolEvents(parsed: ParsedLine): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.text !== undefined && parsed.text.length > 0) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? (parsed.isResult ? 'result' : 'stdout'),
      text: parsed.text,
    });
  }
  if (parsed.usage) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? (parsed.isResult ? 'final' : 'delta'),
    });
  }
  if (parsed.sessionId) events.push({ type: 'session', nativeSessionId: parsed.sessionId });
  for (const toolUse of [...(parsed.toolUse ?? []), ...(parsed.toolUseDone ?? [])]) {
    events.push({
      type: 'tool-use',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
      ...(toolUse.output !== undefined && { output: toolUse.output }),
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({ type: 'warning', code: warning.code, message: warning.message });
  }
  if (parsed.isError) {
    events.push({
      type: 'result',
      status: 'failed',
      text: parsed.text ?? '',
      usage: parsed.usage ?? null,
      nativeSessionId: parsed.sessionId ?? null,
      error: { code: 'runner_result_error', message: parsed.text ?? 'Runner result failed' },
      partial: true,
    });
  }
  return events;
}

const textExitTerminal: CliPlannerAdapter['terminal'] = ({ events }) => {
  const explicit = events.findLast(
    (event): event is Extract<CliProtocolEvent, { type: 'result' }> => event.type === 'result',
  );
  if (explicit !== undefined) return explicit;

  let usage: TokenDelta | null = null;
  let nativeSessionId: string | null = null;
  for (const event of events) {
    if (event.type === 'usage') usage = accumulateTokenUsage(usage, event.usage, event.semantics);
    if (event.type === 'session') nativeSessionId = event.nativeSessionId;
  }
  return {
    type: 'result',
    status: 'completed',
    text: '',
    usage,
    nativeSessionId,
    error: null,
    partial: false,
  };
};

export function withOutputFormat(
  adapter: CliPlannerAdapter,
  format: OutputFormat,
): CliPlannerAdapter;
export function withOutputFormat(
  adapter: CliImplementerAdapter,
  format: OutputFormat,
): CliImplementerAdapter;
export function withOutputFormat(
  adapter: CliPlannerAdapter | CliImplementerAdapter,
  format: OutputFormat,
): CliPlannerAdapter | CliImplementerAdapter {
  const parseLine = getLineParser(format);
  return {
    ...adapter,
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: (line: string) => parsedLineToProtocolEvents(parseLine(line)),
    terminal: textExitTerminal,
  };
}
