import { describe, expect, it } from 'vitest';
import { createLineBuffer } from './line-buffer.js';

describe('createLineBuffer', () => {
  const harness = (maxLineBytes: number) => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const unterminated: number[] = [];
    const buffer = createLineBuffer(
      (line) => {
        lines.push(line);
      },
      {
        maxLineBytes,
        onOverflow: (overflow) => {
          overflows.push(overflow.lineBytes);
        },
        onUnterminated: (overflow) => {
          unterminated.push(overflow.lineBytes);
        },
      },
    );
    return { buffer, lines, overflows, unterminated };
  };
  it('emits complete newline-delimited lines and buffers the trailing partial line', () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => {
      lines.push(line);
    });

    buffer.push('alpha\nbeta\npar');
    expect(lines).toEqual(['alpha', 'beta']);

    buffer.push('tial\n');
    expect(lines).toEqual(['alpha', 'beta', 'partial']);
  });

  it('flushes any remaining buffered content', () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => {
      lines.push(line);
    });

    buffer.push('no-newline');
    buffer.flush();

    expect(lines).toEqual(['no-newline']);
  });

  it('reports an oversized line and keeps processing subsequent lines', () => {
    const lines: string[] = [];
    const overflows: Array<{ lineBytes: number; maxLineBytes: number; truncated: true }> = [];
    const buffer = createLineBuffer(
      (line) => {
        lines.push(line);
      },
      {
        maxLineBytes: 8,
        onOverflow: (overflow) => {
          overflows.push({
            lineBytes: overflow.lineBytes,
            maxLineBytes: overflow.maxLineBytes,
            truncated: overflow.truncated,
          });
        },
      },
    );

    buffer.push(`${'x'.repeat(20)}\nshort\n`);

    expect(overflows).toEqual([{ lineBytes: 20, maxLineBytes: 8, truncated: true }]);
    expect(lines).toEqual(['short']);
  });

  it('recovers after an oversized line that spans multiple chunks', () => {
    const { buffer, lines, overflows } = harness(8);

    buffer.push('x'.repeat(20));
    buffer.push('y'.repeat(20));
    buffer.push('zzz\nok\n');

    expect(overflows).toHaveLength(1);
    expect(lines).toEqual(['ok']);
  });

  it('reports and discards every oversized line within a single chunk', () => {
    const { buffer, lines, overflows } = harness(8);

    buffer.push('aaaaaaaaaa\nbbbbbbbbbb\nok\n');

    expect(overflows).toEqual([10, 10]);
    expect(lines).toEqual(['ok']);
  });

  it('discards an oversized trailing partial line after safe complete lines', () => {
    const { buffer, lines, overflows } = harness(8);

    buffer.push(`ok\n${'x'.repeat(20)}`);
    buffer.flush();

    expect(overflows).toEqual([20]);
    expect(lines).toEqual(['ok']);
  });

  it('does not carry skip state after flushing an oversized partial line', () => {
    const { buffer, lines, overflows } = harness(8);

    buffer.push('x'.repeat(20));
    buffer.flush();
    buffer.push('ok\n');

    expect(overflows).toEqual([20]);
    expect(lines).toEqual(['ok']);
  });

  it('reports an unterminated capped tail without emitting the partial line', () => {
    const { buffer, lines, unterminated } = harness(8);

    buffer.push('1234');
    buffer.push('5678');
    buffer.flush();

    expect(lines).toEqual([]);
    expect(unterminated).toEqual([8]);
  });

  it('counts a UTF-8 code point split across chunks once', () => {
    const { buffer, lines, overflows } = harness(4);

    buffer.push('\ud83d');
    buffer.push('\ude00\n');

    expect(overflows).toEqual([]);
    expect(lines).toEqual(['😀']);
  });

  it('returns the first callback signal from a chunk or flush and stops delivering lines', () => {
    const lineSignal = { state: 'line' };
    const overflowSignal = { state: 'overflow' };
    const seen: string[] = [];
    const buffer = createLineBuffer(
      (line) => {
        seen.push(line);
        return line === 'stop' ? lineSignal : undefined;
      },
      {
        maxLineBytes: 8,
        onOverflow: () => overflowSignal,
      },
    );

    expect(buffer.push('ok\nstop\nlater\n')).toBe(lineSignal);
    expect(seen).toEqual(['ok', 'stop']);
    expect(buffer.push('x'.repeat(20))).toBe(overflowSignal);
    expect(buffer.flush()).toBeUndefined();
  });

  it('stops at an overflow signal instead of delivering the rest of the chunk', () => {
    const overflowSignal = { state: 'overflow' };
    const seen: string[] = [];
    const buffer = createLineBuffer(
      (line) => {
        seen.push(line);
        return undefined;
      },
      { maxLineBytes: 8, onOverflow: () => overflowSignal },
    );

    expect(buffer.push(`ok\n${'x'.repeat(20)}\nlater\n`)).toBe(overflowSignal);
    expect(seen).toEqual(['ok']);
  });
});
