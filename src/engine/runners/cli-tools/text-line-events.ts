import type { ParsedLine } from '../types.js';
import type { CliProtocolEvent } from './contract.js';

/**
 * The one event mapping for adapters backed by `parseTextLine`. Its usage line
 * (`Tokens: N sent, M received`) is a running total, so the sample replaces the
 * accumulator (`final`) instead of adding to it.
 */
export function textLineEvents(parsed: ParsedLine): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.text !== undefined && parsed.text.length > 0) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? 'stdout',
      text: parsed.text,
    });
  }
  if (parsed.usage !== undefined) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? 'final',
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({ type: 'warning', code: warning.code, message: warning.message });
  }
  return events;
}
