import { describe, expect, it, vi } from 'vitest';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import type { ProviderDetection } from '../../core/discovery/detection.js';
import { PROVIDER_CATALOG_FAILURE_KINDS } from '../../engine/providers/types.js';
import type { PickerOptionStatus } from './model-catalog/status.js';
import {
  configHasInlineApiKey,
  failureCopy,
  gitignoreCoversSplitbrief,
  needsAuthAction,
  redactKey,
  validateProviderKey,
} from './provider-auth.js';

const PASTED_KEY = 'sk-test-super-secret-4242';

const UNAUTHENTICATED: PickerOptionStatus = {
  state: 'unauthenticated',
  remediation: 'Set OPENAI_API_KEY or configure an inline apiKey, then refresh detection.',
};
const READY: PickerOptionStatus = { state: 'ready', remediation: null };

function detection(
  overrides: Partial<ProviderDetection> & { provider: 'openai' | 'deepseek' | 'ollama-cloud' },
): ProviderDetection {
  return { available: false, isLocal: false, ...overrides };
}

describe('validateProviderKey', () => {
  setupFetchMock();

  it('reports a populated catalog as a valid key without carrying the key', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-5-mini' }] }), { status: 200 }),
    );

    const result = await validateProviderKey({ provider: 'openai', apiKey: PASTED_KEY });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.models.map((model) => model.id)).toContain('gpt-5-mini');
    }
    expect(JSON.stringify(result)).not.toContain(PASTED_KEY);
  });

  it('maps an HTTP 401 rejection to the invalid-credential failure kind', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 401 }));

    const result = await validateProviderKey({ provider: 'openai', apiKey: PASTED_KEY });

    expect(result).toEqual({ kind: 'invalid', failure: 'invalid-credential' });
  });

  it('rejects a key with the wrong provider prefix before any request leaves', async () => {
    const result = await validateProviderKey({ provider: 'openai', apiKey: 'wrong-prefix-key' });

    expect(result).toEqual({ kind: 'invalid', failure: 'invalid-credential' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('failureCopy', () => {
  const descriptors = [API_PROVIDER_CATALOG.openai, API_PROVIDER_CATALOG.groq];

  it.each(PROVIDER_CATALOG_FAILURE_KINDS)(
    'returns actionable %s copy that cannot contain a pasted key',
    (failure) => {
      for (const descriptor of descriptors) {
        const copy = failureCopy(failure, descriptor);
        expect(copy.length).toBeGreaterThan(0);
        expect(copy).toContain(descriptor.displayName);
        expect(copy).not.toContain(PASTED_KEY);
      }
    },
  );
});

describe('needsAuthAction', () => {
  const openai = API_PROVIDER_CATALOG.openai;

  it('offers add-key for an unauthenticated verified provider with no key', () => {
    const result = needsAuthAction(
      UNAUTHENTICATED,
      detection({ provider: 'openai', hasKey: false }),
      openai,
    );
    expect(result).toBe('add-key');
  });

  it('offers add-key when no detection has run yet', () => {
    expect(needsAuthAction(UNAUTHENTICATED, undefined, openai)).toBe('add-key');
  });

  it('offers replace-key when the provider rejected the present credential', () => {
    const result = needsAuthAction(
      UNAUTHENTICATED,
      detection({ provider: 'openai', hasKey: true, failure: 'invalid-credential' }),
      openai,
    );
    expect(result).toBe('replace-key');
  });

  it('offers replace-key when a key is present but the provider stays unauthenticated', () => {
    const result = needsAuthAction(
      UNAUTHENTICATED,
      detection({ provider: 'openai', hasKey: true }),
      openai,
    );
    expect(result).toBe('replace-key');
  });

  it('never offers auth for DeepSeek (compatibility tier, not verified)', () => {
    const result = needsAuthAction(
      UNAUTHENTICATED,
      detection({ provider: 'deepseek', hasKey: false }),
      API_PROVIDER_CATALOG.deepseek,
    );
    expect(result).toBeNull();
  });

  it('never offers auth for Ollama Cloud (compatibility tier, not verified)', () => {
    const result = needsAuthAction(
      UNAUTHENTICATED,
      detection({ provider: 'ollama-cloud', hasKey: false }),
      API_PROVIDER_CATALOG['ollama-cloud'],
    );
    expect(result).toBeNull();
  });

  it('never offers auth for a local provider that requires no key', () => {
    expect(needsAuthAction(UNAUTHENTICATED, undefined, API_PROVIDER_CATALOG.ollama)).toBeNull();
  });

  it('offers nothing once the provider is ready', () => {
    expect(needsAuthAction(READY, undefined, openai)).toBeNull();
  });
});

describe('redactKey', () => {
  it('strips every occurrence of the key from a message', () => {
    const message = `auth ${PASTED_KEY} failed; retried with ${PASTED_KEY}`;
    const redacted = redactKey(message, PASTED_KEY);
    expect(redacted).not.toContain(PASTED_KEY);
    expect(redacted).toContain('[redacted]');
  });

  it('leaves the message alone for a blank key', () => {
    expect(redactKey('nothing to hide', '   ')).toBe('nothing to hide');
  });
});

describe('configHasInlineApiKey', () => {
  it('is false for a config without stored keys', () => {
    expect(configHasInlineApiKey(makeConfig())).toBe(false);
  });

  const OPENAI_BASE = 'https://api.openai.com/v1';

  it('detects an inline implementer key', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'openai',
        apiBase: OPENAI_BASE,
        model: 'gpt-5-mini',
        apiKey: PASTED_KEY,
      },
    });
    expect(configHasInlineApiKey(config)).toBe(true);
  });

  it('detects an inline planner key', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        apiBase: OPENAI_BASE,
        model: 'gpt-5-mini',
        apiKey: PASTED_KEY,
      },
    });
    expect(configHasInlineApiKey(config)).toBe(true);
  });

  it('detects an inline reviewer key', () => {
    const config = makeConfig({
      reviewer: {
        kind: 'api',
        provider: 'openai',
        apiBase: OPENAI_BASE,
        model: 'gpt-5-mini',
        apiKey: PASTED_KEY,
      },
    });
    expect(configHasInlineApiKey(config)).toBe(true);
  });

  it('does not count env: references as inline secrets', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'openai',
        apiBase: OPENAI_BASE,
        model: 'gpt-5-mini',
        apiKey: 'env:OPENAI_API_KEY',
      },
    });
    expect(configHasInlineApiKey(config)).toBe(false);
  });
});

describe('gitignoreCoversSplitbrief', () => {
  it.each([
    [null, false],
    ['', false],
    ['node_modules/\ndist/\n', false],
    ['node_modules/\n.splitbrief/\n', true],
    ['.splitbrief', true],
    ['/.splitbrief/', true],
    ['  .splitbrief/  ', true],
    ['# .splitbrief/\n', false],
  ])('classifies %j as covered=%s', (content, covered) => {
    expect(gitignoreCoversSplitbrief(content)).toBe(covered);
  });
});
