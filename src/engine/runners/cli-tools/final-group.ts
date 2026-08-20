import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import type { CliProtocolEvent } from './contract.js';

type FinalGroupResult = Extract<CliProtocolEvent, { type: 'result' }>;

/**
 * REQ-013 exact final group: only the text emitted after the last tool call is
 * the authoritative final response; earlier messages, partials, and tool-call
 * text are evidence, never content. The recorded terminal carries exactly that
 * group; the process exit stays the terminal record for this stdout-final
 * family (REQ-014 is satisfied by the exit contract).
 */
export function finalGroupTerminal(input: {
  events: readonly CliProtocolEvent[];
  includeFinalGroupText: boolean;
}): FinalGroupResult {
  const explicit = input.events.findLast(
    (event): event is FinalGroupResult => event.type === 'result',
  );
  if (explicit !== undefined) return explicit;

  let boundary = -1;
  let groupText = '';
  if (input.includeFinalGroupText) {
    for (let index = 0; index < input.events.length; index += 1) {
      if (input.events[index]?.type === 'tool-use') boundary = index;
    }
    for (let index = boundary + 1; index < input.events.length; index += 1) {
      const event = input.events[index];
      if (event?.type === 'text' && event.channel !== 'stderr') groupText += event.text;
    }
  }
  let usage: TokenDelta | null = null;
  let nativeSessionId: string | null = null;
  for (const event of input.events) {
    if (event.type === 'usage') usage = accumulateTokenUsage(usage, event.usage, event.semantics);
    if (event.type === 'session') nativeSessionId = event.nativeSessionId;
  }
  return {
    type: 'result',
    status: 'completed',
    text: groupText,
    usage,
    nativeSessionId,
    error: null,
    partial: false,
  };
}
