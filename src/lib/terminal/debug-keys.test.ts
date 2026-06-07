import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureKeyDebugLog,
  initKeyDebugLog,
  keyLogPath,
  logRawChunk,
  resetKeyDebugForTests,
} from './debug-keys.js';

describe('debug-keys', () => {
  beforeEach(() => {
    resetKeyDebugForTests();
  });

  afterEach(() => {
    resetKeyDebugForTests();
  });

  it('uses a randomized temp path instead of a fixed global filename', () => {
    configureKeyDebugLog({ enabled: true, target: { kind: 'temp', filePrefix: 'keys' } });
    initKeyDebugLog();
    const first = keyLogPath();
    resetKeyDebugForTests();
    configureKeyDebugLog({ enabled: true, target: { kind: 'temp', filePrefix: 'keys' } });
    initKeyDebugLog();
    const second = keyLogPath();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(first).toMatch(/keys-[0-9a-f]+\.log$/);
    expect(first).not.toBe(join(tmpdir(), 'keys.log'));
  });

  it('writes confined project logs under the configured relative directory', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'debug-keys-'));
    try {
      configureKeyDebugLog({
        enabled: true,
        target: {
          kind: 'project',
          projectDir,
          relativeDir: join('debug', 'keys'),
          filePrefix: 'log',
        },
      });
      initKeyDebugLog();
      const path = keyLogPath();
      expect(path).toMatch(/debug[/\\]keys[/\\]log-[0-9a-f]+\.log$/);
      logRawChunk(Buffer.from('x'));
      expect(readFileSync(path!, 'utf8')).toContain('RAW');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
