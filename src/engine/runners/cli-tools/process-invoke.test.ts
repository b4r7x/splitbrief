import { describe, expect, it } from 'vitest';
import type { CliProtocolEvent } from './contract.js';
import { finalGroupTerminal } from './final-group.js';
import { createProtocolEventLog } from './process-invoke.js';

const MAX_BYTES = 1_000;

const text = (value: string): CliProtocolEvent => ({
  type: 'text',
  channel: 'assistant',
  text: value,
});

const textBytes = (events: readonly CliProtocolEvent[]): number =>
  events.reduce((sum, event) => sum + (event.type === 'text' ? event.text.length : 0), 0);

describe('createProtocolEventLog', () => {
  it('drops text from the middle of a long call and keeps its head, its final group and its usage total', () => {
    const log = createProtocolEventLog(MAX_BYTES);
    log.push({ type: 'session', nativeSessionId: 'session-1' });
    log.push(text('first message'));
    for (let turn = 0; turn < 100; turn += 1) {
      log.push(text(`narration ${turn} ${'x'.repeat(90)}`));
      log.push({ type: 'tool-use', id: `t${turn}`, name: 'read', input: { path: 'a.ts' } });
      log.push({
        type: 'usage',
        usage: { inputTokens: 3, outputTokens: 2 },
        semantics: 'delta',
      });
    }
    log.push(text('final answer'));

    const events = log.events();
    const terminal = finalGroupTerminal({ events, includeFinalGroupText: true });

    expect(textBytes(events)).toBeLessThanOrEqual(MAX_BYTES);
    expect(events.find((event) => event.type === 'text')).toEqual(text('first message'));
    expect(
      events.some((event) => event.type === 'text' && event.text.startsWith('narration 50 ')),
    ).toBe(false);
    expect(terminal).toMatchObject({
      status: 'completed',
      text: 'final answer',
      usage: { inputTokens: 300, outputTokens: 200 },
      nativeSessionId: 'session-1',
    });
  });

  it('keeps a result event that more output follows', () => {
    const log = createProtocolEventLog(MAX_BYTES);
    log.push(text('h'.repeat(MAX_BYTES / 2)));
    log.push({
      type: 'result',
      status: 'completed',
      text: 'final answer',
      usage: null,
      nativeSessionId: null,
      error: null,
      partial: false,
    });
    for (let index = 0; index < 20; index += 1) log.push(text('y'.repeat(100)));

    const terminal = finalGroupTerminal({ events: log.events(), includeFinalGroupText: true });

    expect(textBytes(log.events())).toBeLessThanOrEqual(MAX_BYTES);
    expect(terminal.text).toBe('final answer');
  });
});
