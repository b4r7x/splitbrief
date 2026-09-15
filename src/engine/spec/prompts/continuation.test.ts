import { describe, it, expect } from 'vitest';
import { composeContinuation, continuationBlock } from './continuation.js';

describe('composeContinuation', () => {
  it('keeps the whole base prompt and trails the continuation after it', () => {
    const prompt = composeContinuation({
      basePrompt: 'Write spec.md for the feature.',
      partial: 'half a spec',
      steer: 'add an auth section',
    });

    expect(prompt.startsWith('Write spec.md for the feature.')).toBe(true);
    expect(prompt).toContain('half a spec');
    expect(prompt).toContain('add an auth section');
    expect(prompt.indexOf('half a spec')).toBeGreaterThan(prompt.indexOf('Write spec.md'));
  });

  it('defaults the steer when the operator continued without words', () => {
    const prompt = composeContinuation({ basePrompt: 'BASE', partial: 'some output' });

    expect(prompt).toContain('continue from where you left off');
  });

  it('carries the seat-specific extra between the partial and the steer', () => {
    const prompt = composeContinuation({
      basePrompt: 'BASE',
      partial: 'some output',
      extra: 'These declared files already changed since the task started: src/a.ts',
      steer: 'finish it',
    });

    expect(prompt.indexOf('src/a.ts')).toBeGreaterThan(prompt.indexOf('some output'));
    expect(prompt.indexOf('finish it')).toBeGreaterThan(prompt.indexOf('src/a.ts'));
  });

  it('trims a partial that has outgrown its usefulness, keeping the tail', () => {
    const partial = `${'x'.repeat(20_000)}THE-LAST-THING-IT-WROTE`;
    const prompt = composeContinuation({ basePrompt: 'BASE', partial });

    expect(prompt).toContain('THE-LAST-THING-IT-WROTE');
    expect(prompt.length).toBeLessThan(partial.length);
  });
});

describe('continuationBlock', () => {
  it('reports only the steer when the call was cut before it produced anything', () => {
    const block = continuationBlock({ steer: 'use the smaller model' });

    expect(block).toContain('interrupted before this call');
    expect(block).toContain('use the smaller model');
    expect(block).not.toContain('Partial output');
  });

  it('reports the partial when the attempt left one behind', () => {
    const block = continuationBlock({ partial: 'half a spec', steer: 'finish' });

    expect(block).toContain('Partial output so far');
    expect(block).toContain('half a spec');
  });
});
