import { describe, it, expect } from 'vitest';
import { canonicalModelId, isSameCanonicalModel } from './canonical-model-id.js';

describe('canonicalModelId', () => {
  it('strips a :free suffix and lower-cases the id', () => {
    expect(canonicalModelId({ id: 'DeepSeek-V4-Flash:free' })).toBe('deepseek-v4-flash');
  });

  it('keeps a non-free tag because it names a distinct local model', () => {
    expect(canonicalModelId({ id: 'qwen3-coder:30b' })).toBe('qwen3-coder:30b');
  });

  it('qualifies a bare id with its catalog owner', () => {
    expect(canonicalModelId({ id: 'ox-alpha', owner: 'OpenRouter' })).toBe('openrouter/ox-alpha');
  });

  it('leaves an already-prefixed id unqualified by its owner', () => {
    expect(canonicalModelId({ id: 'openai/gpt-5.6-luna', owner: 'opencode' })).toBe(
      'openai/gpt-5.6-luna',
    );
  });
});

describe('isSameCanonicalModel', () => {
  it('matches a :free catalog twin against its provider-qualified runtime id', () => {
    expect(
      isSameCanonicalModel(
        { id: 'openrouter/deepseek/deepseek-v4-flash' },
        { id: 'deepseek-v4-flash:free', owner: 'deepseek' },
      ),
    ).toBe(true);
  });

  it('keeps two provider routes of one model apart', () => {
    expect(
      isSameCanonicalModel({ id: 'openai/gpt-5.6-luna' }, { id: 'opencode-go/gpt-5.6-luna' }),
    ).toBe(false);
  });

  it('collapses one model listed under two owners', () => {
    expect(
      isSameCanonicalModel({ id: 'ox-alpha', owner: 'x' }, { id: 'ox-alpha', owner: 'y' }),
    ).toBe(true);
  });

  it('matches a bare runtime id against the same bare catalog id', () => {
    expect(
      isSameCanonicalModel(
        { id: 'gpt-5.6-sol', owner: 'codex' },
        { id: 'gpt-5.6-sol', owner: 'openai' },
      ),
    ).toBe(true);
  });

  it('keeps two local model tags apart', () => {
    expect(isSameCanonicalModel({ id: 'qwen3-coder:30b' }, { id: 'qwen3-coder:7b' })).toBe(false);
  });

  it('keeps a claude alias apart from its 1m variant', () => {
    expect(
      isSameCanonicalModel(
        { id: 'sonnet', owner: 'claude-code' },
        { id: 'sonnet[1m]', owner: 'claude-code' },
      ),
    ).toBe(false);
  });
});
