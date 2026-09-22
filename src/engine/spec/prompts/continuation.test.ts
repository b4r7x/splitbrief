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
  it('reports the absence of earlier output and the steer, claiming no interruption', () => {
    const block = continuationBlock({ steer: 'add a default instead' });

    expect(block).toBe(
      '[Continuation] No output from an earlier attempt of this step is available. The user says: add a default instead',
    );
    expect(block).not.toContain('interrupted');
  });

  it('defaults the steer in the same sentence', () => {
    expect(continuationBlock({})).toBe(
      '[Continuation] No output from an earlier attempt of this step is available. The user says: continue from where you left off',
    );
  });

  it('reports the partial when the attempt left one behind', () => {
    const block = continuationBlock({ partial: 'half a file', steer: 'finish it' });

    expect(
      block.startsWith('[Continuation] The previous attempt of this step was interrupted.'),
    ).toBe(true);
    expect(block).toContain('Partial output so far:');
    expect(block).toContain('half a file');
    expect(block).toContain('The user says: finish it');
  });

  it('never replaces the base prompt', () => {
    const prompt = composeContinuation({ basePrompt: 'BASE', steer: 'x' });
    expect(prompt.startsWith('BASE\n\n[Continuation]')).toBe(true);
  });
});
