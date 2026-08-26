import { describe, it, expect } from 'vitest';
import { createSanitizedChildEnv } from './child-env.js';

describe('createSanitizedChildEnv', () => {
  it('copies runtime values and explicit credentials without ambient secrets or controls', {
    timeout: 60_000,
  }, () => {
    const env = createSanitizedChildEnv(
      {
        LANG: 'C.UTF-8',
        HOME: '/host/home',
        PATH: '/project/bin',
        NODE_OPTIONS: '--require=/tmp/loader.js',
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_API_KEY: 'sk-anthropic',
      },
      ['OPENAI_API_KEY', 'HOME', 'NODE_OPTIONS'],
    );

    expect(env).toEqual({ LANG: 'C.UTF-8', OPENAI_API_KEY: 'sk-openai' });
  });
});
