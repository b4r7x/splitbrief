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
} from './key-debug.js';

describe('key-debug', () => {
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
    const projectDir = mkdtempSync(join(tmpdir(), 'key-debug-'));
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

  it('reassembles a multibyte character split across two raw chunks', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'key-debug-'));
    try {
      configureKeyDebugLog({
        enabled: true,
        target: { kind: 'project', projectDir, relativeDir: 'debug', filePrefix: 'log' },
      });
      initKeyDebugLog();
      const path = keyLogPath();

      // '日' is three UTF-8 bytes. Feeding the leading bytes then the remainder as separate
      // raw chunks must decode to the intact character — the module's StringDecoder buffers
      // the partial sequence rather than emitting a replacement character per chunk.
      const bytes = Buffer.from('日', 'utf8');
      logRawChunk(bytes.subarray(0, 1));
      logRawChunk(bytes.subarray(1));

      const contents = readFileSync(path!, 'utf8');
      expect(contents).toContain('日');
      expect(contents).not.toContain('�');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not leak a partial multibyte sequence across a reset into the next session', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'key-debug-'));
    try {
      configureKeyDebugLog({
        enabled: true,
        target: { kind: 'project', projectDir, relativeDir: 'debug', filePrefix: 'log' },
      });
      initKeyDebugLog();

      // Feed only the leading bytes of '日' (three UTF-8 bytes), leaving an incomplete
      // sequence buffered, then reset before the remainder arrives.
      logRawChunk(Buffer.from('日', 'utf8').subarray(0, 1));

      resetKeyDebugForTests();
      configureKeyDebugLog({
        enabled: true,
        target: { kind: 'project', projectDir, relativeDir: 'debug', filePrefix: 'log' },
      });
      initKeyDebugLog();
      const path = keyLogPath();

      // A fresh ASCII chunk in the new session must decode cleanly — the buffered partial
      // byte from the previous session must not prepend and corrupt this decode.
      logRawChunk(Buffer.from('A', 'utf8'));

      const contents = readFileSync(path!, 'utf8');
      expect(contents).toContain('RAW  bytes=1 A');
      expect(contents).not.toContain('�');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
