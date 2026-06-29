import { describe, expect, it } from 'vitest';
import { OSC52_MAX_BASE64, osc52Sequence, wrapForMultiplexer } from './osc52.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ST = `${ESC}\\`;

function base64Payload(seq: string): string {
  const prefix = `${ESC}]52;c;`;
  if (!seq.startsWith(prefix)) throw new Error(`no OSC 52 prefix in ${JSON.stringify(seq)}`);
  const body = seq.slice(prefix.length);
  if (body.endsWith(ST)) return body.slice(0, -ST.length);
  if (body.endsWith(BEL)) return body.slice(0, -BEL.length);
  return body;
}

describe('osc52Sequence', () => {
  it('wraps base64 in an OSC 52 clipboard envelope terminated by BEL', () => {
    const seq = osc52Sequence('hello');
    expect(seq).toBe(`${ESC}]52;c;${Buffer.from('hello').toString('base64')}${BEL}`);
  });

  it('uses the ST terminator for kitty to avoid the bell', () => {
    const seq = osc52Sequence('hello', { kitty: true });
    expect(seq.endsWith(ST)).toBe(true);
    expect(seq.includes(BEL)).toBe(false);
  });

  it('produces a base64 payload free of ESC, BEL, and ST even for adversarial input', () => {
    const malicious = `${ESC}]52;c;evil${BEL}${ST}drop tables`;
    const payload = base64Payload(osc52Sequence(malicious));
    expect(payload).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(payload.includes(ESC)).toBe(false);
    expect(payload.includes(BEL)).toBe(false);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(malicious);
  });

  it('caps the base64 budget at 100000', () => {
    expect(OSC52_MAX_BASE64).toBe(100_000);
  });
});

describe('wrapForMultiplexer', () => {
  it('passes the sequence through unchanged outside a multiplexer', () => {
    const seq = osc52Sequence('hi');
    expect(wrapForMultiplexer(seq, 'none')).toBe(seq);
  });

  it('wraps in a tmux DCS passthrough and doubles inner ESC bytes', () => {
    const seq = osc52Sequence('hi');
    const wrapped = wrapForMultiplexer(seq, 'tmux');
    expect(wrapped.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(wrapped.endsWith(ST)).toBe(true);
    expect(wrapped).toContain(seq.replaceAll(ESC, ESC + ESC));
  });

  it('wraps in a screen DCS passthrough without doubling', () => {
    const seq = osc52Sequence('hi');
    expect(wrapForMultiplexer(seq, 'screen')).toBe(`${ESC}P${seq}${ST}`);
  });
});
