import { describe, expect, it } from 'vitest';
import { parseMouseEvents } from './mouse.js';

describe('parseMouseEvents', () => {
  it('intercepts wheel-up events and removes them from the clean stream', () => {
    const input = `before\u001b[<0;10;20Mmiddle\u001b[<64;10;20Mafter`;
    const { events, clean } = parseMouseEvents(input);

    expect(clean).toBe(`before\u001b[<0;10;20Mmiddleafter`);
    expect(events).toEqual([
      { type: 'wheel-up', x: 10, y: 20, button: 64, shift: false, meta: false, ctrl: false },
    ]);
  });

  it('intercepts wheel-down events and removes them from the clean stream', () => {
    const { events, clean } = parseMouseEvents(`\u001b[<65;3;7Mtext`);

    expect(clean).toBe('text');
    expect(events).toEqual([
      { type: 'wheel-down', x: 3, y: 7, button: 65, shift: false, meta: false, ctrl: false },
    ]);
  });

  it('passes non-wheel SGR mouse sequences through untouched', () => {
    const press = '\u001b[<0;5;10M';
    const release = '\u001b[<0;5;10m';
    const input = `${press}text${release}`;
    const { events, clean } = parseMouseEvents(input);

    expect(events).toEqual([]);
    expect(clean).toBe(input);
  });

  it('passes non-wheel sequences with modifier bits through untouched', () => {
    const seq = '\u001b[<4;1;1M';
    const { events, clean } = parseMouseEvents(seq);

    expect(events).toEqual([]);
    expect(clean).toBe(seq);
  });

  it('intercepts wheel events with modifier bits using the masked button code', () => {
    const { events, clean } = parseMouseEvents('\u001b[<68;2;3M');
    expect(clean).toBe('');
    expect(events).toEqual([
      { type: 'wheel-up', x: 2, y: 3, button: 64, shift: true, meta: false, ctrl: false },
    ]);
  });

  it('strips unsupported extended wheel codes silently', () => {
    const { events, clean } = parseMouseEvents(`before\u001b[<66;1;2Mafter`);

    expect(clean).toBe('beforeafter');
    expect(events).toEqual([]);
  });

  it('handles mixed non-wheel, wheel, and plain text correctly', () => {
    const input = '\u001b[<0;1;1Mhello\u001b[<64;2;3Mworld\u001b[<1;4;5M';
    const { events, clean } = parseMouseEvents(input);

    expect(clean).toBe('\u001b[<0;1;1Mhelloworld\u001b[<1;4;5M');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('wheel-up');
  });
});
