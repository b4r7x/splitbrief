import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createImplementerBase, type ImplementerBaseConfig } from './base.js';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';
import type { TuiEvent } from '../../core/types/events.js';

vi.mock('../parsers/response-extractor.js', () => ({
  extractCode: vi.fn(),
}));

vi.mock('./apply.js', () => ({
  applyCode: vi.fn(),
}));

vi.mock('../../utils/diff.js', () => ({
  computeDiff: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  readFileOrEmpty: vi.fn().mockResolvedValue(''),
  SECURE_DIR_MODE: 0o700,
  SECURE_FILE_MODE: 0o600,
}));

vi.mock('../../utils/git.js', () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
}));

import { extractCode } from '../parsers/response-extractor.js';
import { applyCode } from './apply.js';
import { computeDiff } from '../../utils/diff.js';
import { readFileOrEmpty } from '../../utils/fs.js';
import { getChangedFiles } from '../../utils/git.js';

function makeBaseConfig(overrides?: Partial<ImplementerBaseConfig>): ImplementerBaseConfig {
  return {
    extractsCode: true,
    invoke: vi.fn().mockResolvedValue({ text: 'code output', usage: { inputTokens: 10, outputTokens: 20 } }),
    buildPrompt: vi.fn().mockReturnValue('test prompt'),
    buildRetryPrompt: vi.fn().mockReturnValue('retry prompt'),
    ...overrides,
  };
}

describe('createImplementerBase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns failure when invoke throws', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('connection failed'));
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('connection failed');
  });

  it('re-throws when shouldThrow returns true', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('command not found'));
    const implementer = createImplementerBase(makeBaseConfig({
      invoke,
      shouldThrow: (err) => err instanceof Error && err.message.includes('command not found'),
    }));
    const config = makeConfig();

    await expect(
      implementer.implement({ task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn() }),
    ).rejects.toThrow('command not found');
  });

  it('returns failure when code extraction fails', async () => {
    vi.mocked(readFileOrEmpty).mockResolvedValue('');
    vi.mocked(extractCode).mockReturnValue({ error: 'No code found' });

    const implementer = createImplementerBase(makeBaseConfig());
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No code found');
  });

  it('returns failure when applyCode fails', async () => {
    vi.mocked(readFileOrEmpty).mockResolvedValue('');
    vi.mocked(extractCode).mockReturnValue({ code: 'const x = 1;', confidence: 'high' });
    vi.mocked(applyCode).mockResolvedValue({ success: false, error: 'Write failed' });

    const implementer = createImplementerBase(makeBaseConfig());
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Write failed');
  });

  it('returns success with diff when extractsCode pipeline succeeds', async () => {
    vi.mocked(readFileOrEmpty)
      .mockResolvedValueOnce('old content')
      .mockResolvedValueOnce('new content');
    vi.mocked(extractCode).mockReturnValue({ code: 'const x = 1;', confidence: 'high' });
    vi.mocked(applyCode).mockResolvedValue({ success: true });
    vi.mocked(computeDiff).mockReturnValue({ diff: '+ const x = 1;', linesAdded: 1, linesRemoved: 0 });

    const implementer = createImplementerBase(makeBaseConfig());
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('code output');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(extractCode).toHaveBeenCalledWith('code output');
    expect(applyCode).toHaveBeenCalledWith('const x = 1;', expect.objectContaining({ file: 'src/hello.ts' }), '/proj');
    expect(computeDiff).toHaveBeenCalledWith('old content', 'new content');
  });

  it('uses detectChanges when extractsCode is false', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: true, output: '' });
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
    }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(detectChanges).toHaveBeenCalledWith('/proj', expect.any(Array));
    expect(result.success).toBe(true);
  });

  it('passes before-snapshot to detectChanges so pre-existing dirty files are excluded', async () => {
    vi.mocked(getChangedFiles).mockResolvedValue(['src/pre-existing.ts']);
    const detectChanges = vi.fn().mockResolvedValue({ changed: true, output: '' });
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
    }));
    const config = makeConfig();

    await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    const [, beforeArg] = detectChanges.mock.calls[0] ?? [];
    expect(beforeArg).toEqual(['src/pre-existing.ts']);
  });

  it('returns success when extractsCode is false and no detectChanges provided', async () => {
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
    }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('code output');
  });

  it('returns failure when detectChanges finds no changes', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: false, output: 'No files changed' });
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
    }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/proj', config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No files changed');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  describe('retry', () => {
    it('retries with temperature escalation for kind "local"', async () => {
      vi.mocked(readFileOrEmpty).mockResolvedValue('old');
      vi.mocked(extractCode).mockReturnValue({ code: 'const x = 1;', confidence: 'high' });
      vi.mocked(applyCode).mockResolvedValue({ success: true });
      vi.mocked(computeDiff).mockReturnValue({ diff: '+ line', linesAdded: 1, linesRemoved: 0 });

      const invoke = vi.fn().mockResolvedValue({ text: 'retry output', usage: null });
      const implementer = createImplementerBase(makeBaseConfig({ invoke, retryTemperatureStep: 0.1 }));
      const config = makeConfig();

      const result = await implementer.retry({
        task: makeTask(), projectDir: '/proj', config, context: defaultContext,
        onOutput: vi.fn(), error: 'tsc failed', attempt: 2, kind: 'local',
      });

      expect(result.success).toBe(true);
      const invokeCall = invoke.mock.calls[0]?.[0];
      expect(invokeCall?.temperature).toBe(0.2 + 0.1 * 2);
    });

    it('retries with base temperature for kind "hint"', async () => {
      vi.mocked(readFileOrEmpty).mockResolvedValue('old');
      vi.mocked(extractCode).mockReturnValue({ code: 'fixed code', confidence: 'high' });
      vi.mocked(applyCode).mockResolvedValue({ success: true });
      vi.mocked(computeDiff).mockReturnValue({ diff: '+ fixed', linesAdded: 1, linesRemoved: 0 });

      const invoke = vi.fn().mockResolvedValue({ text: 'hint output', usage: null });
      const buildRetryPrompt = vi.fn().mockReturnValue('hint prompt');
      const implementer = createImplementerBase(makeBaseConfig({ invoke, buildRetryPrompt, retryTemperatureStep: 0.1 }));
      const config = makeConfig();

      const result = await implementer.retry({
        task: makeTask(), projectDir: '/proj', config, context: defaultContext,
        onOutput: vi.fn(), error: 'lint failed', attempt: 1, kind: 'hint',
      });

      expect(result.success).toBe(true);
      const invokeCall = invoke.mock.calls[0]?.[0];
      expect(invokeCall?.temperature).toBe(0.2);
      expect(buildRetryPrompt).toHaveBeenCalled();
    });
  });

  describe('onEvent callbacks', () => {
    it('fires "running" event at start', async () => {
      const invoke = vi.fn().mockRejectedValue(new Error('fail'));
      const events: TuiEvent[] = [];
      const onEvent = (e: TuiEvent) => { events.push(e); };
      const implementer = createImplementerBase(makeBaseConfig({ invoke }));
      const config = makeConfig();

      await implementer.implement({
        task: makeTask(), projectDir: '/proj', config, context: defaultContext,
        onOutput: vi.fn(), onEvent,
      });

      expect(events[0]?.type).toBe('implementer-generate-running');
    });

    it('fires "done" event on success with diff data', async () => {
      vi.mocked(readFileOrEmpty).mockResolvedValue('old');
      vi.mocked(extractCode).mockReturnValue({ code: 'x', confidence: 'high' });
      vi.mocked(applyCode).mockResolvedValue({ success: true });
      vi.mocked(computeDiff).mockReturnValue({ diff: '+ x', linesAdded: 3, linesRemoved: 1 });

      const events: TuiEvent[] = [];
      const onEvent = (e: TuiEvent) => { events.push(e); };
      const implementer = createImplementerBase(makeBaseConfig());
      const config = makeConfig();

      await implementer.implement({
        task: makeTask(), projectDir: '/proj', config, context: defaultContext,
        onOutput: vi.fn(), onEvent,
      });

      const doneEvent = events.find(e => e.type === 'implementer-generate-done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.type === 'implementer-generate-done' && doneEvent.linesAdded).toBe(3);
      expect(doneEvent?.type === 'implementer-generate-done' && doneEvent.linesRemoved).toBe(1);
      expect(doneEvent?.type === 'implementer-generate-done' && doneEvent.diff).toBe('+ x');
    });

    it('fires "failed" event on failure', async () => {
      vi.mocked(readFileOrEmpty).mockResolvedValue('');
      vi.mocked(extractCode).mockReturnValue({ error: 'parse error' });

      const events: TuiEvent[] = [];
      const onEvent = (e: TuiEvent) => { events.push(e); };
      const implementer = createImplementerBase(makeBaseConfig());
      const config = makeConfig();

      await implementer.implement({
        task: makeTask(), projectDir: '/proj', config, context: defaultContext,
        onOutput: vi.fn(), onEvent,
      });

      const failedEvent = events.find(e => e.type === 'implementer-generate-failed');
      expect(failedEvent).toBeDefined();
    });
  });
});
