import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { parseSeatSpecOption } from './seat-spec.js';

describe('parseSeatSpecOption', () => {
  it.each([
    { spec: 'codex', expected: { tool: 'codex' } },
    { spec: 'codex@high', expected: { tool: 'codex', effort: 'high' } },
    {
      spec: 'cmd:deepseek/deepseek-v4-flash',
      expected: { tool: 'cmd', model: 'deepseek/deepseek-v4-flash' },
    },
    {
      spec: 'opencode:opencode-go/kimi-k3@high',
      expected: { tool: 'opencode', model: 'opencode-go/kimi-k3', variant: 'high' },
    },
    { spec: 'kilo-code@max', expected: { tool: 'kilo-code', variant: 'max' } },
    { spec: 'cursor@high', expected: { tool: 'cursor', effort: 'high' } },
    {
      spec: 'cursor:gpt-5.3-codex-high',
      expected: { tool: 'cursor', model: 'gpt-5.3-codex-high' },
    },
  ])('reads $spec', ({ spec, expected }) => {
    expect(parseSeatSpecOption(spec)).toEqual(expected);
  });

  it('splits on the first colon, so a model id may carry its own', () => {
    expect(parseSeatSpecOption('api:openai:gpt-5')).toEqual({ tool: 'api', model: 'openai:gpt-5' });
  });

  it.each(['', '@high', ':model', 'codex:', 'codex@'])('rejects %j', (spec) => {
    expect(() => parseSeatSpecOption(spec)).toThrow(InvalidArgumentError);
  });
});
