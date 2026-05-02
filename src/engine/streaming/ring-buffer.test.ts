import { describe, it, expect } from 'vitest';
import { createRingBuffer } from './ring-buffer.js';

describe('createRingBuffer', () => {
  it('pushes and retrieves lines in order', () => {
    const buf = createRingBuffer(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.lines()).toEqual(['a', 'b', 'c']);
  });

  it('wraps correctly when push exceeds capacity', () => {
    const buf = createRingBuffer(3);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    buf.push('d');
    buf.push('e');
    expect(buf.lines()).toEqual(['c', 'd', 'e']);
  });

  it('returns all lines in order when exactly at capacity', () => {
    const buf = createRingBuffer(3);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.lines()).toEqual(['a', 'b', 'c']);
  });

  it('wraps oldest lines out beyond capacity', () => {
    const buf = createRingBuffer(3);
    buf.push('x');
    buf.push('y');
    buf.push('z');
    buf.push('w');
    expect(buf.lines()).toEqual(['y', 'z', 'w']);
  });

  it('clears the buffer', () => {
    const buf = createRingBuffer(5);
    buf.push('a');
    buf.push('b');
    buf.clear();
    expect(buf.lines()).toEqual([]);
  });

  it('works after clear', () => {
    const buf = createRingBuffer(3);
    buf.push('a');
    buf.push('b');
    buf.clear();
    buf.push('c');
    buf.push('d');
    expect(buf.lines()).toEqual(['c', 'd']);
  });

  it('uses default capacity of 5', () => {
    const buf = createRingBuffer();
    buf.push('1');
    buf.push('2');
    buf.push('3');
    buf.push('4');
    buf.push('5');
    buf.push('6');
    expect(buf.lines()).toEqual(['2', '3', '4', '5', '6']);
  });
});