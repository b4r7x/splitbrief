import { describe, expect, it } from 'vitest';
import { createLineBuffer } from './line-buffer.js';

describe('createLineBuffer', () => {
  it('emits complete newline-delimited lines and buffers the trailing partial line', () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer.push('alpha\nbeta\npar');
    expect(lines).toEqual(['alpha', 'beta']);

    buffer.push('tial\n');
    expect(lines).toEqual(['alpha', 'beta', 'partial']);
  });

  it('flushes any remaining buffered content', () => {
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer.push('no-newline');
    buffer.flush();

    expect(lines).toEqual(['no-newline']);
  });

  it('reports an oversized line and keeps processing subsequent lines', () => {
    const lines: string[] = [];
    const overflows: Array<{ lineBytes: number; maxLineBytes: number; truncated: true }> = [];
    const buffer = createLineBuffer((line) => lines.push(line), {
      maxLineBytes: 8,
      onOverflow: (overflow) =>
        overflows.push({
          lineBytes: overflow.lineBytes,
          maxLineBytes: overflow.maxLineBytes,
          truncated: overflow.truncated,
        }),
    });

    buffer.push(`${'x'.repeat(20)}\nshort\n`);

    expect(overflows).toEqual([{ lineBytes: 20, maxLineBytes: 8, truncated: true }]);
    expect(lines).toEqual(['short']);
  });

  it('recovers after an oversized line that spans multiple chunks', () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const buffer = createLineBuffer((line) => lines.push(line), {
      maxLineBytes: 8,
      onOverflow: (overflow) => overflows.push(overflow.lineBytes),
    });

    buffer.push('x'.repeat(20));
    buffer.push('y'.repeat(20));
    buffer.push('zzz\nok\n');

    expect(overflows).toHaveLength(1);
    expect(lines).toEqual(['ok']);
  });

  it('reports and discards every oversized line within a single chunk', () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const buffer = createLineBuffer((line) => lines.push(line), {
      maxLineBytes: 8,
      onOverflow: (overflow) => overflows.push(overflow.lineBytes),
    });

    buffer.push('aaaaaaaaaa\nbbbbbbbbbb\nok\n');

    expect(overflows).toEqual([10, 10]);
    expect(lines).toEqual(['ok']);
  });

  it('reports overflow once per oversized line rather than per chunk', () => {
    const overflows: number[] = [];
    const buffer = createLineBuffer(() => {}, {
      maxLineBytes: 4,
      onOverflow: (overflow) => overflows.push(overflow.lineBytes),
    });

    buffer.push('aaaaa');
    buffer.push('bbbbb');
    buffer.push('ccccc\n');

    expect(overflows).toHaveLength(1);
  });
});
