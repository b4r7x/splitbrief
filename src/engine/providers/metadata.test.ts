import { describe, it, expect } from 'vitest';
import { formatContextLength } from '../../utils/format.js';
import { formatPrice } from './metadata.js';

describe('formatContextLength', () => {
  it('returns empty string for undefined', () => {
    expect(formatContextLength(undefined)).toBe('');
  });

  it('returns empty string for 0', () => {
    expect(formatContextLength(0)).toBe('');
  });

  it('formats small context as K', () => {
    expect(formatContextLength(8000)).toBe('8K');
  });

  it('formats standard context as K', () => {
    expect(formatContextLength(128000)).toBe('128K');
  });

  it('formats million as 1M', () => {
    expect(formatContextLength(1000000)).toBe('1M');
  });

  it('formats non-round millions with decimal', () => {
    expect(formatContextLength(1048576)).toBe('1.0M');
  });

  it('formats 2 million as 2M', () => {
    expect(formatContextLength(2000000)).toBe('2M');
  });

  it('formats 1.5 million with decimal', () => {
    expect(formatContextLength(1500000)).toBe('1.5M');
  });
});

describe('formatPrice', () => {
  it('returns empty string for undefined', () => {
    expect(formatPrice(undefined)).toBe('');
  });

  it('returns FREE for 0', () => {
    expect(formatPrice(0)).toBe('FREE');
  });

  it('formats standard price with 2 decimals', () => {
    expect(formatPrice(2.5)).toBe('$2.5/1M');
  });

  it('formats small price with 4 decimals', () => {
    expect(formatPrice(0.001)).toBe('$0.0010/1M');
  });

  it('formats sub-dollar price with 2 decimals', () => {
    expect(formatPrice(0.15)).toBe('$0.15/1M');
  });

  it('formats integer price without decimals', () => {
    expect(formatPrice(5)).toBe('$5/1M');
  });

  it('formats large price with decimals', () => {
    expect(formatPrice(15.5)).toBe('$15.5/1M');
  });

  it('formats 75 as integer', () => {
    expect(formatPrice(75)).toBe('$75/1M');
  });
});
