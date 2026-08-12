import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createLogger, resetLoggerForTests } from '../lib/logger.js';
import { initLogger, resolveLoggerEnabled } from './logger.js';

describe('resolveLoggerEnabled', () => {
  it('enables for a tsx run from TypeScript sources and disables for a dist build', () => {
    expect(
      resolveLoggerEnabled({ moduleFilename: '/repo/src/core/logger.ts', override: undefined }),
    ).toBe(true);
    expect(
      resolveLoggerEnabled({ moduleFilename: '/app/dist/core/logger.js', override: undefined }),
    ).toBe(false);
  });

  it('SPLITBRIEF_DEBUG forces on in a built app and off in a development run', () => {
    expect(
      resolveLoggerEnabled({ moduleFilename: '/app/dist/core/logger.js', override: '1' }),
    ).toBe(true);
    expect(
      resolveLoggerEnabled({ moduleFilename: '/app/dist/core/logger.js', override: 'true' }),
    ).toBe(true);
    expect(
      resolveLoggerEnabled({ moduleFilename: '/repo/src/core/logger.ts', override: '0' }),
    ).toBe(false);
    expect(
      resolveLoggerEnabled({ moduleFilename: '/repo/src/core/logger.ts', override: 'false' }),
    ).toBe(false);
  });

  it('treats an empty SPLITBRIEF_DEBUG as unset', () => {
    expect(resolveLoggerEnabled({ moduleFilename: '/repo/src/core/logger.ts', override: '' })).toBe(
      true,
    );
    expect(resolveLoggerEnabled({ moduleFilename: '/app/dist/core/logger.js', override: '' })).toBe(
      false,
    );
  });
});

describe('initLogger', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir('logger-test');
    vi.stubEnv('SPLITBRIEF_DEBUG', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetLoggerForTests();
    cleanupTempDir(tmp);
  });

  it('routes a development run to .splitbrief/logs/debug.log under the project dir', () => {
    initLogger(tmp);
    createLogger('bootstrap').info('hello');

    const content = readFileSync(join(tmp, '.splitbrief', 'logs', 'debug.log'), 'utf-8');
    expect(content).toContain('INFO');
    expect(content).toContain('[bootstrap] hello');
  });
});
