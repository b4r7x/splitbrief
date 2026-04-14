import { describe, it, expect } from 'vitest';
import { isModuleNotFoundError, loadSdk, isAgentSdkAvailable } from './agent-sdk.js';

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

describe('loadSdk', () => {
  it('throws install message when SDK is not installed', async () => {
    await expect(loadSdk()).rejects.toThrow(
      'Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
    );
  });
});

describe('isAgentSdkAvailable', () => {
  it('returns false when SDK is not installed', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      expect(await isAgentSdkAvailable()).toBe(false);
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('returns false when ANTHROPIC_API_KEY is not set and no apiKey param', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await isAgentSdkAvailable()).toBe(false);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('returns false when SDK is not installed even if apiKey param is provided', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // SDK is not installed, so even with a configured apiKey it should return false
      expect(await isAgentSdkAvailable('sk-ant-configured-key')).toBe(false);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
