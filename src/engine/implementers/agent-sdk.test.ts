import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeConfig, makeTask, defaultContext } from '#testing/helpers/fixtures.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { AgentSdkBackend } from '../agent-sdk.js';

vi.mock('../agent-sdk.js', () => ({
  createAgentSdkBackend: vi.fn(),
  isAgentSdkAvailable: vi.fn(),
  IMPLEMENTER_ALLOWED_TOOLS: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
}));

vi.mock('../../core/providers/index.js', () => ({
  resolveAutoModel: vi.fn(),
}));

import { createAgentSdkBackend, isAgentSdkAvailable } from '../agent-sdk.js';
import { resolveAutoModel } from '../../core/providers/index.js';
import { createAgentSdkImplementer } from './agent-sdk.js';

function makeAgentSdkConfig(overrides?: Record<string, unknown>) {
  return makeConfig({
    implementer: {
      kind: 'agent-sdk' as const,
      model: 'claude-sonnet-4-6',
      apiKey: undefined,
      ...overrides,
    },
  });
}

function makeBackendStub(extra?: Partial<AgentSdkBackend>): AgentSdkBackend {
  return {
    invoke: vi.fn().mockResolvedValue({ text: 'done', usage: null }),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createAgentSdkImplementer', () => {
  it('resolveAutoModel is called; resolved model is passed to backend.invoke', async () => {
    const backend = makeBackendStub();
    vi.mocked(createAgentSdkBackend).mockReturnValue(backend);
    vi.mocked(resolveAutoModel).mockReturnValue('claude-opus-4-5');

    const cfg = makeAgentSdkConfig({ model: 'auto' });
    const implementer = createAgentSdkImplementer(cfg);

    await implementer.implement({
      task: makeTask(),
      projectDir: '/tmp/proj',
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(resolveAutoModel).toHaveBeenCalledWith('auto', 'agent-sdk');
    const invokeCall = vi.mocked(backend.invoke).mock.calls[0];
    expect(invokeCall).toBeDefined();
    expect(invokeCall![0].model).toBe('claude-opus-4-5');
  });

  it('isAvailable() mirrors isAgentSdkAvailable — both true and false', async () => {
    const backend = makeBackendStub();
    vi.mocked(createAgentSdkBackend).mockReturnValue(backend);
    vi.mocked(resolveAutoModel).mockReturnValue('claude-sonnet-4-6');

    vi.mocked(isAgentSdkAvailable).mockResolvedValue(true);
    const implementerTrue = createAgentSdkImplementer(makeAgentSdkConfig());
    expect(await implementerTrue.isAvailable()).toBe(true);

    vi.mocked(isAgentSdkAvailable).mockResolvedValue(false);
    const implementerFalse = createAgentSdkImplementer(makeAgentSdkConfig());
    expect(await implementerFalse.isAvailable()).toBe(false);
  });

  describe('detectChanges forwarding', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTempDir('agent-sdk-detect-test');
      createTestGitRepo(testDir);
    });

    afterEach(() => {
      cleanupTempDir(testDir);
    });

    it('detectChanges is forwarded when backend provides it; absent otherwise', async () => {
      vi.mocked(resolveAutoModel).mockReturnValue('claude-sonnet-4-6');

      const detectChangesFn = vi.fn().mockResolvedValue({ changed: true, output: '' });
      const backendWithDetect = makeBackendStub({ detectChanges: detectChangesFn });
      vi.mocked(createAgentSdkBackend).mockReturnValue(backendWithDetect);

      const cfg = makeAgentSdkConfig();
      const implementerWithDetect = createAgentSdkImplementer(cfg);

      await implementerWithDetect.implement({
        task: makeTask(),
        projectDir: testDir,
        config: cfg,
        context: defaultContext,
        onOutput: vi.fn(),
      });
      expect(detectChangesFn).toHaveBeenCalled();

      // Backend without detectChanges: detectChangesFn must not be called again
      const callsBefore = detectChangesFn.mock.calls.length;
      const backendWithout = makeBackendStub();
      vi.mocked(createAgentSdkBackend).mockReturnValue(backendWithout);
      const implementerWithout = createAgentSdkImplementer(cfg);

      await implementerWithout.implement({
        task: makeTask(),
        projectDir: testDir,
        config: cfg,
        context: defaultContext,
        onOutput: vi.fn(),
      });
      expect(detectChangesFn.mock.calls.length).toBe(callsBefore);
    });
  });

  it('implement() invokes backend.invoke with correct shape', async () => {
    const backend = makeBackendStub();
    vi.mocked(createAgentSdkBackend).mockReturnValue(backend);
    vi.mocked(resolveAutoModel).mockReturnValue('claude-sonnet-4-6');

    const cfg = makeAgentSdkConfig();
    const implementer = createAgentSdkImplementer(cfg);
    const onOutput = vi.fn();

    await implementer.implement({
      task: makeTask(),
      projectDir: '/tmp/my-project',
      config: cfg,
      context: defaultContext,
      onOutput,
    });

    const invokeCall = vi.mocked(backend.invoke).mock.calls[0];
    expect(invokeCall).toBeDefined();
    const invokeOpts = invokeCall![0];
    expect(typeof invokeOpts.prompt).toBe('string');
    expect(invokeOpts.prompt.length).toBeGreaterThan(0);
    expect(invokeOpts.projectDir).toBe('/tmp/my-project');
    expect(invokeOpts.model).toBe('claude-sonnet-4-6');
    expect(typeof invokeOpts.onOutput).toBe('function');
  });

  it('apiKey is threaded to createAgentSdkBackend when set', () => {
    const backend = makeBackendStub();
    vi.mocked(createAgentSdkBackend).mockReturnValue(backend);
    vi.mocked(resolveAutoModel).mockReturnValue('claude-sonnet-4-6');

    const cfg = makeAgentSdkConfig({ apiKey: 'sk-test-api-key' });
    createAgentSdkImplementer(cfg);

    expect(createAgentSdkBackend).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test-api-key' }),
    );
  });
});
