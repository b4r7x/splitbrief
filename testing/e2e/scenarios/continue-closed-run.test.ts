import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('closed run continuation', () => {
  it.each(['ended', 'applied', 'discarded', 'complete'] as const)(
    'refuses a %s run with plain and JSON errors without changing saved state',
    async (as) => {
      fixture = createStopContinueFixture(() => '', { isolation: 'none' });
      const target = fixture;
      const sessionId = `closed-${as}`;
      saveState(
        { projectDir: target.projectDir, sessionId },
        {
          ...createInitialState('Closed run'),
          ...(as === 'complete'
            ? { phase: 'complete' as const, reviewStatus: 'passed' as const }
            : { closed: { as, at: '2026-10-11T00:00:00.000Z' } }),
        },
      );
      const statePath = join(sessionDir(target.projectDir, sessionId), 'state.json');
      const before = readFileSync(statePath, 'utf8');
      const message = `Run ${sessionId} is closed (${as}); nothing to resume.`;

      const plain = await cli(target, ['continue', sessionId]);
      expect(plain.exitCode, plain.stderr).toBe(1);
      expect(plain.stdout).toBe('');
      expect(plain.stderr).toContain(message);

      const json = await cli(target, ['continue', sessionId], { json: true, timeoutMs: 60_000 });
      expect(json.exitCode, json.stderr).toBe(1);
      expect(JSON.parse(json.stdout)).toEqual({ type: 'error', message });

      const ended = await cli(target, ['continue', sessionId, '--action', 'end-run'], {
        json: true,
        timeoutMs: 60_000,
      });
      expect(ended.exitCode, ended.stderr).toBe(1);
      expect(JSON.parse(ended.stdout)).toEqual({
        type: 'error',
        message: `Run ${sessionId} is closed (${as}); nothing to end.`,
      });
      expect(readFileSync(statePath, 'utf8')).toBe(before);
    },
  );

  it('distinguishes the most recent run from continuation by id and actions in help', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });

    const resume = await cli(fixture, ['resume', '--help']);
    const continued = await cli(fixture, ['continue', '--help']);

    expect(resume.exitCode, resume.stderr).toBe(0);
    expect(resume.stdout).toContain('Resume the most recent run');
    expect(continued.exitCode, continued.stderr).toBe(0);
    expect(continued.stdout).toContain('Continue a run by id, with recovery and Apply actions');
  });
});
