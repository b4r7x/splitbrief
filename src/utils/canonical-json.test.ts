import { describe, expect, it } from 'vitest';
import { canonicalJSON } from './canonical-json.js';

describe('canonicalJSON', () => {
  it('passes through number primitive', () => {
    expect(canonicalJSON(42)).toBe('42');
  });

  it('passes through string primitive', () => {
    expect(canonicalJSON('hello')).toBe('"hello"');
  });

  it('passes through null', () => {
    expect(canonicalJSON(null)).toBe('null');
  });

  it('passes through boolean', () => {
    expect(canonicalJSON(true)).toBe('true');
    expect(canonicalJSON(false)).toBe('false');
  });

  it('sorts object keys lexicographically', () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJSON({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('produces equal output regardless of insertion order', () => {
    const result1 = canonicalJSON({ b: 1, a: 2 });
    const result2 = canonicalJSON({ a: 2, b: 1 });
    expect(result1).toBe(result2);
  });

  it('sorts nested object keys', () => {
    expect(canonicalJSON({ z: { d: 1, c: 2 } })).toBe('{"z":{"c":2,"d":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
  });

  it('sorts keys in objects inside arrays', () => {
    expect(canonicalJSON([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('omits undefined values from objects', () => {
    expect(canonicalJSON({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('throws TypeError for NaN', () => {
    expect(() => canonicalJSON(Number.NaN)).toThrow(TypeError);
  });

  it('throws TypeError for Infinity', () => {
    expect(() => canonicalJSON(Infinity)).toThrow(TypeError);
    expect(() => canonicalJSON(-Infinity)).toThrow(TypeError);
  });

  it('throws TypeError for undefined at top level', () => {
    expect(() => canonicalJSON(undefined)).toThrow(TypeError);
  });

  it('throws TypeError for function', () => {
    expect(() => canonicalJSON(() => {})).toThrow(TypeError);
  });

  it('throws TypeError for symbol', () => {
    expect(() => canonicalJSON(Symbol('x'))).toThrow(TypeError);
  });

  it('is stable: same input produces identical string on repeated calls', () => {
    const value = { z: [1, 2], a: { b: 3 } };
    expect(canonicalJSON(value)).toBe(canonicalJSON(value));
  });
});
