import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeScrollOffset, truncate } from '../src/ui/picker-utils.js';

describe('computeScrollOffset', () => {
  it('returns 0 when all items fit in window', () => {
    assert.equal(computeScrollOffset(2, 10, 5), 0);
  });

  it('returns 0 when cursor is near the top', () => {
    assert.equal(computeScrollOffset(0, 5, 20), 0);
  });

  it('centers cursor in the middle of a long list', () => {
    const offset = computeScrollOffset(10, 5, 20);
    assert.ok(offset >= 7 && offset <= 9);
  });

  it('clamps to end when cursor is near the bottom', () => {
    assert.equal(computeScrollOffset(19, 5, 20), 15);
  });

  it('handles window size of 1', () => {
    assert.equal(computeScrollOffset(3, 1, 10), 3);
  });
});

describe('truncate', () => {
  it('returns string as-is when shorter than max', () => {
    assert.equal(truncate('hello', 10), 'hello');
  });

  it('truncates with ellipsis when longer', () => {
    assert.equal(truncate('hello world', 8), 'hello w\u2026');
  });

  it('handles exact length', () => {
    assert.equal(truncate('hello', 5), 'hello');
  });

  it('returns empty string when max is 0', () => {
    assert.equal(truncate('hello', 0), '');
  });

  it('returns empty string when max is negative', () => {
    assert.equal(truncate('hello', -1), '');
  });

  it('handles empty string', () => {
    assert.equal(truncate('', 5), '');
  });
});
