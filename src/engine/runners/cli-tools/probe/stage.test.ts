import { readdirSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { awaitToolStages, stopToolStages, withProbeStage } from './stage.js';

let tmp = '';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDir(tmp);
});

// One test: the stop holds for the rest of the process, as the quit it stands for.
it('stops a stage whose caller gave no signal, waits for its removal, and refuses later stages', async () => {
  tmp = createTempDir('probe-stage');
  vi.stubEnv('TMPDIR', tmp);
  const started = Promise.withResolvers<void>();
  const stage = withProbeStage('splitbrief-readiness-', undefined, async (_dir, signal) => {
    started.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return 'stopped';
  });
  await started.promise;
  expect(readdirSync(tmp)).toEqual([expect.stringMatching(/^splitbrief-readiness-/)]);

  stopToolStages();
  await awaitToolStages();

  expect(readdirSync(tmp)).toEqual([]);
  await expect(stage).resolves.toBe('stopped');
  const run = vi.fn(async () => 'ran');
  await expect(withProbeStage('splitbrief-catalog-', undefined, run)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(run).not.toHaveBeenCalled();
  expect(readdirSync(tmp)).toEqual([]);
});
