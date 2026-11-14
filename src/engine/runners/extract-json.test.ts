import { describe, expect, it } from 'vitest';
import { extractLastJsonObject } from './extract-json.js';

describe('extractLastJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractLastJsonObject('{"a":1}')).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reads a fenced block', () => {
    expect(extractLastJsonObject('Here:\n```json\n{"a":1}\n```')).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
  });

  it('reads an object that ends prose', () => {
    expect(extractLastJsonObject('Here it is: {"a":1}')).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('takes the last of several fenced blocks', () => {
    expect(extractLastJsonObject('```json\n{"a":1}\n```\n```json\n{"a":2}\n```')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('reads a bare object that follows a fence holding no object', () => {
    expect(extractLastJsonObject('Run this:\n```\nnpm test\n```\n{"a":1}')).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
  });

  it('takes a bare object that ends after a fenced example', () => {
    expect(extractLastJsonObject('```json\n{"a":1}\n```\nFinal: {"a":2}')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('takes a fenced object that ends after a bare one', () => {
    expect(extractLastJsonObject('Example {"a":1}, answer:\n```json\n{"a":2}\n```')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('ignores braces inside a code fence', () => {
    expect(
      extractLastJsonObject('{"a":1}\n```ts\nconst f = () => { return 1; };\n```\nDone.'),
    ).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reports a last object that opens like JSON and does not parse as invalid', () => {
    expect(extractLastJsonObject('{"a":1} then {"a":2,}')).toEqual({ kind: 'invalid' });
  });

  it('reads the answer after a stray brace in prose', () => {
    expect(
      extractLastJsonObject(
        'The guard opens with `if (x) {` in foo.ts.\n\n{"answer":"ok","count":3}',
      ),
    ).toEqual({ kind: 'ok', value: { answer: 'ok', count: 3 } });
  });

  it('reads a fenced answer that prose with braces follows', () => {
    expect(
      extractLastJsonObject('```json\n{"a":1}\n```\nThe object {above} is the answer.'),
    ).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reports an object that does not parse as invalid', () => {
    expect(extractLastJsonObject('Here: {"a":2,}')).toEqual({ kind: 'invalid' });
  });

  it('rejects two adjacent objects', () => {
    expect(extractLastJsonObject('{"a":1}\n{"a":2}')).toEqual({ kind: 'ambiguous' });
  });

  it('takes the last object when prose separates them', () => {
    expect(extractLastJsonObject('{"a":1} and then {"a":2}')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('finds no object in plain prose', () => {
    expect(extractLastJsonObject('no json here')).toEqual({ kind: 'none' });
  });

  it('reports a truncated object as truncated', () => {
    expect(extractLastJsonObject('{"a":')).toEqual({ kind: 'truncated' });
  });

  it('reports an answer cut inside a literal or a number as truncated', () => {
    for (const input of ['{"a":tr', '{"a":nul', '{"a":1.', '{"a":-', '{"a":1.5e+']) {
      expect(extractLastJsonObject(input)).toEqual({ kind: 'truncated' });
    }
  });

  it('finds no object in an answer cut before its first key ends', () => {
    expect(extractLastJsonObject('{"pla')).toEqual({ kind: 'none' });
  });

  it('never reads an inner object out of a truncated answer', () => {
    expect(extractLastJsonObject('{"plan":{"summary":"x"},"tasks":[{"id":"T001"}')).toEqual({
      kind: 'truncated',
    });
  });

  it('reports an answer truncated after a complete example as truncated', () => {
    expect(extractLastJsonObject('Example {"a":1}. Answer: {"a":2,"b":{"c":3}')).toEqual({
      kind: 'truncated',
    });
  });

  it('keeps the answer when prose mentions an unclosed key', () => {
    for (const input of [
      '{"a":1}\n\nNote: I dropped the key {"b" from the old shape.',
      'The old shape started with {"plan" and changed.\n\n{"a":1}',
      '```json\n{"a":1}\n```\nIt replaces {"old',
      '{"a":1}\n\nI dropped {"b": entirely',
      '{"a":1}\n\nIt replaces {"old": shape.',
      '{"a":1}\n\nThe old key was {"b": removed',
    ]) {
      expect(extractLastJsonObject(input)).toEqual({ kind: 'ok', value: { a: 1 } });
    }
  });

  it('skips an unclosed brace in prose', () => {
    expect(extractLastJsonObject('The block { never closes. {"a":1}')).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
    expect(extractLastJsonObject('Note: `if (x) {` opens a block.')).toEqual({ kind: 'none' });
  });

  it('keeps braces that sit inside a string', () => {
    expect(extractLastJsonObject('{"s":"}{"}')).toEqual({ kind: 'ok', value: { s: '}{' } });
  });

  it('ignores quotes in prose', () => {
    expect(extractLastJsonObject('say "hi" then {"a":1}')).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('rejects a top-level array', () => {
    expect(extractLastJsonObject('[1,2]')).toEqual({ kind: 'none' });
  });

  it('never reports an empty object for a failing input', () => {
    for (const input of ['{"a":1}\n{"a":2}', 'no json here', '{"a":', '[1,2]']) {
      expect(extractLastJsonObject(input)).not.toEqual({ kind: 'ok', value: {} });
    }
  });
});
