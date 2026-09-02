import { describe, expect, it } from 'vitest';
import { createSocketLineBuffer } from './line-buffer.js';

function collect(maxLineBytes: number) {
  const lines: string[] = [];
  const overflows: number[] = [];
  const buffer = createSocketLineBuffer({
    maxLineBytes,
    onLine: (line) => lines.push(line),
    onOverflow: (bytes) => overflows.push(bytes),
  });
  return { buffer, lines, overflows };
}

describe('createSocketLineBuffer', () => {
  it('emits complete lines and keeps the trailing partial buffered', () => {
    const { buffer, lines } = collect(1024);
    buffer.push(Buffer.from('one\ntw'));
    expect(lines).toEqual(['one']);
    expect(buffer.bufferedBytes()).toBe(2);

    buffer.push(Buffer.from('o\nthree\n'));
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(buffer.bufferedBytes()).toBe(0);
  });

  it('strips a trailing carriage return', () => {
    const { buffer, lines } = collect(1024);
    buffer.push(Buffer.from('crlf\r\n'));
    expect(lines).toEqual(['crlf']);
  });

  it('emits empty lines for blank frames', () => {
    const { buffer, lines } = collect(1024);
    buffer.push(Buffer.from('\n\n'));
    expect(lines).toEqual(['', '']);
  });

  it('reports overflow once and drops the oversized line, then resumes', () => {
    const { buffer, lines, overflows } = collect(4);
    buffer.push(Buffer.from('abcdefgh'));
    expect(overflows).toEqual([5]);
    buffer.push(Buffer.from('ijkl\n'));
    expect(overflows).toEqual([5]);
    expect(lines).toEqual([]);

    buffer.push(Buffer.from('ok\n'));
    expect(lines).toEqual(['ok']);
    expect(overflows).toEqual([5]);
  });

  it('does not split multibyte characters across chunk boundaries', () => {
    const { buffer, lines } = collect(1024);
    const payload = Buffer.from('héllo\n');
    buffer.push(payload.subarray(0, 2));
    buffer.push(payload.subarray(2));
    expect(lines).toEqual(['héllo']);
  });
});
