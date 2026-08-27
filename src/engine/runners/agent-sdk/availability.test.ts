import { describe, it, expect, vi } from 'vitest';
import { isModuleNotFoundError, loadSdk, isAgentSdkAvailable } from './availability.js';

describe('isModuleNotFoundError', () => {
  it('returns true for ERR_MODULE_NOT_FOUND', () => {
    const err = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(isModuleNotFoundError(err)).toBe(true);
  });

  it('returns true for MODULE_NOT_FOUND', () => {
    const err = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    expect(isModuleNotFoundError(err)).toBe(true);
  });

  it('returns true for "Cannot find package" message without code', () => {
    expect(isModuleNotFoundError(new Error('Cannot find package "@foo/bar"'))).toBe(true);
  });

  it('returns true for "Could not resolve" message without code', () => {
    expect(isModuleNotFoundError(new Error('Could not resolve "@foo/bar"'))).toBe(true);
  });

  it('returns false for other error codes', () => {
    const err = Object.assign(new Error('syntax error'), { code: 'ERR_INVALID_ARG_TYPE' });
    expect(isModuleNotFoundError(err)).toBe(false);
  });

  it('returns false for errors without code or matching message', () => {
    expect(isModuleNotFoundError(new TypeError('Cannot read properties'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isModuleNotFoundError(null)).toBe(false);
    expect(isModuleNotFoundError(undefined)).toBe(false);
    expect(isModuleNotFoundError('string')).toBe(false);
  });
});

const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';

function mockMissingSdk(): void {
  vi.doMock(SDK_MODULE, () => {
    throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
  });
}

function withApiKey(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
  return run().finally(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });
}

describe('loadSdk', () => {
  it('rejects when the SDK module fails to load', async () => {
    mockMissingSdk();
    try {
      await expect(loadSdk()).rejects.toThrow();
    } finally {
      vi.doUnmock(SDK_MODULE);
    }
  });

  it('resolves the module when it is installed', async () => {
    vi.doMock(SDK_MODULE, () => ({ query: () => {} }));
    try {
      await expect(loadSdk()).resolves.toHaveProperty('query');
    } finally {
      vi.doUnmock(SDK_MODULE);
    }
  });
});

describe('isAgentSdkAvailable', () => {
  it('returns false without any credential', async () => {
    await withApiKey(undefined, async () => {
      expect(await isAgentSdkAvailable()).toBe(false);
    });
  });

  it('returns false when the SDK module is missing regardless of credential', async () => {
    mockMissingSdk();
    try {
      await withApiKey('test-key', async () => {
        expect(await isAgentSdkAvailable()).toBe(false);
      });
      await withApiKey(undefined, async () => {
        expect(await isAgentSdkAvailable('sk-ant-configured-key')).toBe(false);
      });
    } finally {
      vi.doUnmock(SDK_MODULE);
    }
  });

  it('returns true when the SDK loads and a credential is present', async () => {
    vi.doMock(SDK_MODULE, () => ({ query: () => {} }));
    try {
      await withApiKey(undefined, async () => {
        expect(await isAgentSdkAvailable('sk-ant-configured-key')).toBe(true);
      });
      await withApiKey('test-key', async () => {
        expect(await isAgentSdkAvailable()).toBe(true);
      });
    } finally {
      vi.doUnmock(SDK_MODULE);
    }
  });
});
