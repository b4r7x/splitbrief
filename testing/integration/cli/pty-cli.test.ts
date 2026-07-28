import { describe, expect, it } from 'vitest';
import { parsePtyCliOptions, runPtyCli } from './pty/cli.js';
import type { PtySmokeResult } from './pty/run.js';

describe('PTY behavior CLI', () => {
  it('derives required mode only from the explicit environment contract', () => {
    expect(parsePtyCliOptions([], {})).toMatchObject({ requirement: 'optional' });
    expect(parsePtyCliOptions([], { SPLITBRIEF_REQUIRE_PTY: '0' })).toMatchObject({
      requirement: 'optional',
    });
    expect(parsePtyCliOptions([], { SPLITBRIEF_REQUIRE_PTY: '1' })).toMatchObject({
      requirement: 'required',
    });
    expect(() => parsePtyCliOptions(['--optional'], {})).toThrow(
      'PTY smoke does not accept arguments',
    );
  });

  it('reports PASS only for a completed behavior result', async () => {
    const passed: PtySmokeResult = {
      status: 'passed',
      rawIo: '',
      pid: 42,
      exitCode: 0,
      editorReturned: true,
      approved: true,
      terminalRestored: true,
      processGroupReaped: true,
    };
    await expect(
      runPtyCli({ timeoutMs: 100, requirement: 'required' }, async () => passed),
    ).resolves.toMatch(/^PTY behavior PASS:/);

    const skipped: PtySmokeResult = {
      status: 'skipped',
      category: 'module-unavailable',
      reason: 'node-pty is unavailable on this platform',
    };
    await expect(
      runPtyCli({ timeoutMs: 100, requirement: 'optional' }, async () => skipped),
    ).resolves.toBe(
      'PTY behavior SKIP (module-unavailable): node-pty is unavailable on this platform',
    );
  });
});
