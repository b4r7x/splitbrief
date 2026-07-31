import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProcessStartTimeMs } from './start-time.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('readProcessStartTimeMs', () => {
  it('reads the current process start time without a platform command', () => {
    const startTimeMs = readProcessStartTimeMs(process.pid);

    expect(startTimeMs).not.toBeNull();
    expect(Math.abs((startTimeMs ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(50);
  });

  itUnix('does not execute a ps binary supplied by the ambient PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'splitbrief-start-time-'));
    tempDirs.push(dir);
    const shadowPsPath = join(dir, 'ps');
    const markerPath = `${shadowPsPath}.executed`;
    writeFileSync(shadowPsPath, '#!/bin/sh\n: > "$0.executed"\n');
    chmodSync(shadowPsPath, 0o700);
    process.env.PATH = dir;

    const startTimeMs = readProcessStartTimeMs(process.ppid);

    expect(startTimeMs === null || Number.isFinite(startTimeMs)).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
  });
});
