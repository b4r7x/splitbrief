import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { setClearQueueHandler, clearAllHandlers } from '../features/workflow/handlers.js';
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
    setClearQueueHandler(() => 2);

    expect(buildCommandContext({ exit: () => {} }).clearQueue()).toBe(2);
  });
});
