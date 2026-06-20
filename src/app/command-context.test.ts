import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { RewindTarget } from '../core/state/build-rewind-action.js';
import {
  setClearQueueHandler,
  setRewindHandler,
  clearAllHandlers,
} from '../features/workflow/handlers.js';
import { configStore } from '../stores/project/config.js';
import { buildCommandContext } from './command-context.js';

let projectDir = '';

afterEach(() => {
  clearAllHandlers();
  configStore.__testReset();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

describe('buildCommandContext', () => {
  it('rebuilds the repo-map cache from the configured cacheDir', async () => {
    projectDir = createTempDir('app-command-context');
    const config = makeConfig({
      codebase: { enabled: true, tokenBudget: 4000, cacheDir: '.custom-cache' },
    });
    configStore.__testReset({ projectDir, config, diskConfig: config });
    const cacheDir = join(projectDir, '.custom-cache');
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, 'repomap.sqlite');
    writeFileSync(cacheFile, 'cache');

    const result = await buildCommandContext({ exit: () => {} }).rebuildRepomap();

    expect(result).toEqual({ deleted: true, files: [cacheFile] });
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('delegates queue clearing to the live workflow handler', () => {
    setClearQueueHandler(() => ({ status: 'cleared', count: 2 }));

    expect(buildCommandContext({ exit: () => {} }).clearQueue()).toEqual({
      status: 'cleared',
      count: 2,
    });
  });

  it('routes rewind requests to the live workflow handler', () => {
    const requests: RewindTarget[] = [];
    setRewindHandler((request) => requests.push(request));

    buildCommandContext({ exit: () => {} }).requestRewind('spec', 'redo');

    expect(requests).toEqual([{ target: 'spec', comment: 'redo' }]);
  });

  it('routes task redo through the live rewind handler', () => {
    const requests: RewindTarget[] = [];
    setRewindHandler((request) => requests.push(request));

    buildCommandContext({ exit: () => {} }).requestTaskRedo('T-1');

    expect(requests).toEqual([{ target: 'task', taskId: 'T-1' }]);
  });
});
