import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens, formatCost, formatTime } from '../src/utils/format.js';

describe('formatTokens', () => {
  it('formats small numbers as-is', () => {
    assert.equal(formatTokens(500), '500');
  });

  it('formats thousands with K suffix', () => {
    assert.equal(formatTokens(1500), '1.5K');
  });

  it('formats millions with M suffix', () => {
    assert.equal(formatTokens(1_500_000), '1.5M');
  });

  it('formats zero', () => {
    assert.equal(formatTokens(0), '0');
  });
});

describe('formatCost', () => {
  it('formats zero as $0.00', () => {
    assert.equal(formatCost(0), '$0.00');
  });

  it('formats dollars with two decimal places', () => {
    assert.equal(formatCost(42.5), '$42.50');
  });

  it('rounds sub-cent amounts to $0.00', () => {
    assert.equal(formatCost(0.001), '$0.00');
  });
});

describe('formatTime', () => {
  it('formats seconds only', () => {
    assert.equal(formatTime(5000), '5s');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatTime(65000), '1m 5s');
  });

  it('formats hours, minutes, and seconds', () => {
    assert.equal(formatTime(3665000), '1h 1m 5s');
  });

  it('formats zero milliseconds', () => {
    assert.equal(formatTime(0), '0s');
  });
});
