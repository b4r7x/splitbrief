import { describe, expect, it } from 'vitest';
import { validateCliArgs } from './validate-args.js';

const BASE_ARGS = ['run', '<PROMPT>'];

describe('validateCliArgs', () => {
  it('recognizes only explicitly value-taking short flags as attached protected values', () => {
    const protectedFlags = new Set(['--model', '-m', '-p']);
    const protectedShortValueFlags = new Set(['-m']);

    expect(
      validateCliArgs({
        invocationArgs: [...BASE_ARGS, '-mclaude'],
        baseArgs: BASE_ARGS,
        protectedFlags,
        protectedShortValueFlags,
        promptTransport: 'argv',
      }),
    ).toEqual({ valid: false, conflicts: ['-m'] });
    expect(
      validateCliArgs({
        invocationArgs: [...BASE_ARGS, '--model=claude'],
        baseArgs: BASE_ARGS,
        protectedFlags,
        protectedShortValueFlags,
        promptTransport: 'argv',
      }),
    ).toEqual({ valid: false, conflicts: ['--model'] });
    expect(
      validateCliArgs({
        invocationArgs: [...BASE_ARGS, '-profile'],
        baseArgs: BASE_ARGS,
        protectedFlags,
        protectedShortValueFlags,
        promptTransport: 'argv',
      }),
    ).toEqual({ valid: true });
  });
});
