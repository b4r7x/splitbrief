import { describe, it, expect } from 'vitest';
import {
  isModuleNotFoundError,
  loadSdk,
  isAgentSdkAvailable,
  createAgentSdkBackend,
  PLANNER_ALLOWED_TOOLS,
  PLANNER_PERMISSION_MODE,
} from './agent-sdk-backend.js';

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

describe('planner read-only defaults', () => {
  it('excludes write tools and uses plan permission mode', () => {
    expect(PLANNER_ALLOWED_TOOLS).toEqual(['Read', 'Glob', 'Grep']);
    expect(PLANNER_PERMISSION_MODE).toBe('plan');
  });
});

describe('createAgentSdkBackend', () => {
  it('honors an already-aborted signal before loading the optional SDK peer', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const backend = createAgentSdkBackend({ allowedTools: ['Read'] });
    await expect(
      backend.invoke({
        prompt: 'hello',
        projectDir: '/tmp/proj',
        model: 'claude-sonnet-4-5',
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });
});

describe('isAgentSdkAvailable', () => {
  it('returns false when SDK is not installed regardless of API key', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      expect(await isAgentSdkAvailable()).toBe(false);

      delete process.env.ANTHROPIC_API_KEY;
      expect(await isAgentSdkAvailable()).toBe(false);
      expect(await isAgentSdkAvailable('sk-ant-configured-key')).toBe(false);
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
