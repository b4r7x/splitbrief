import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TuiEvent } from '../types.js';
import { makeTask } from '#testing/helpers/fixtures.js';

vi.mock('./extractor.js', () => ({
  extractCode: vi.fn(),
}));
vi.mock('./apply.js', () => ({
  applyCode: vi.fn(),
}));
vi.mock('../utils/diff.js', () => ({
  computeDiff: vi.fn(),
}));
vi.mock('../utils/fs.js', () => ({
  readFileOrEmpty: vi.fn(),
  ensureTinySpecDir: vi.fn(),
  writeSpecFile: vi.fn(),
  readSpecFile: vi.fn(),
  validateTaskPath: vi.fn(),
}));

import { createGenEventEmitter, processImplementerOutput } from './implementers/base.js';
import { extractCode } from './extractor.js';
import { applyCode } from './apply.js';
import { computeDiff } from '../utils/diff.js';
import { readFileOrEmpty } from '../utils/fs.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createGenEventEmitter', () => {
  it('emits implementer-generate event with running status', () => {
    const events: TuiEvent[] = [];
    const emit = createGenEventEmitter((e) => events.push(e), 'gpt-4', 'src/foo.ts');

    emit('running');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'implementer-generate',
      status: 'running',
      model: 'gpt-4',
      file: 'src/foo.ts',
    });
    expect(events[0].ts).toBeGreaterThan(0);
  });

  it('emits implementer-generate event with done status and metrics', () => {
    const events: TuiEvent[] = [];
    const emit = createGenEventEmitter((e) => events.push(e), 'llama', 'src/bar.ts');

    emit('done', { linesAdded: 10, linesRemoved: 3 });

    expect(events[0]).toMatchObject({
      type: 'implementer-generate',
      status: 'done',
      model: 'llama',
      file: 'src/bar.ts',
      linesAdded: 10,
      linesRemoved: 3,
    });
  });

  it('emits implementer-generate event with failed status', () => {
    const events: TuiEvent[] = [];
    const emit = createGenEventEmitter((e) => events.push(e), 'model-x', 'src/a.ts');

    emit('failed');

    expect(events[0]).toMatchObject({
      type: 'implementer-generate',
      status: 'failed',
    });
  });

  it('does not crash when onEvent is undefined', () => {
    const emit = createGenEventEmitter(undefined, 'model', 'file.ts');

    expect(() => emit('running')).not.toThrow();
    expect(() => emit('done', { linesAdded: 1 })).not.toThrow();
    expect(() => emit('failed')).not.toThrow();
  });
});

describe('processImplementerOutput', () => {
  it('returns error when code extraction fails', async () => {
    vi.mocked(extractCode).mockReturnValue({ error: 'No code found' });

    const result = await processImplementerOutput('garbage', makeTask(), '/tmp/proj', '');

    expect(result).toEqual({ success: false, error: 'No code found' });
    expect(applyCode).not.toHaveBeenCalled();
  });

  it('returns error when apply fails', async () => {
    vi.mocked(extractCode).mockReturnValue({ code: 'const x = 1;', confidence: 'high' });
    vi.mocked(applyCode).mockReturnValue({ success: false, error: 'Write failed' });

    const result = await processImplementerOutput('```ts\nconst x = 1;\n```', makeTask(), '/tmp/proj', '');

    expect(result).toEqual({ success: false, error: 'Write failed' });
    expect(computeDiff).not.toHaveBeenCalled();
  });

  it('returns success with diff metrics when pipeline succeeds', async () => {
    vi.mocked(extractCode).mockReturnValue({ code: 'const x = 1;', confidence: 'high' });
    vi.mocked(applyCode).mockReturnValue({ success: true });
    vi.mocked(readFileOrEmpty).mockReturnValue('const x = 1;');
    vi.mocked(computeDiff).mockReturnValue({ diff: '+ const x = 1;', linesAdded: 1, linesRemoved: 0 });

    const result = await processImplementerOutput('code', makeTask(), '/tmp/proj', '');

    expect(result).toEqual({ success: true, diff: '+ const x = 1;', linesAdded: 1, linesRemoved: 0 });
  });

  it('computes correct linesAdded and linesRemoved from diff', async () => {
    vi.mocked(extractCode).mockReturnValue({ code: 'new code', confidence: 'medium' });
    vi.mocked(applyCode).mockReturnValue({ success: true });
    vi.mocked(readFileOrEmpty).mockReturnValue('new code');
    vi.mocked(computeDiff).mockReturnValue({ diff: '@@ -1 +1 @@\n- old\n+ new', linesAdded: 5, linesRemoved: 2 });

    const task = makeTask({ file: 'src/hello.ts' });
    const result = await processImplementerOutput('response', task, '/tmp/proj', 'old content');

    expect(result).toEqual({
      success: true,
      diff: '@@ -1 +1 @@\n- old\n+ new',
      linesAdded: 5,
      linesRemoved: 2,
    });
    expect(readFileOrEmpty).toHaveBeenCalledWith('/tmp/proj/src/hello.ts');
    expect(computeDiff).toHaveBeenCalledWith('old content', 'new code');
  });
});
