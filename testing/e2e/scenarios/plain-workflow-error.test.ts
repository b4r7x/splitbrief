import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  ESCAPED_BRANCH,
  escapingImplementerScript,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const CAUSE = 'The run baseline snapshot could not be initialized; workspace acquisition stopped.';
const POINTER = 'Workflow failed — see the error output above.';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/**
 * The planner's first call puts a file where the session's snapshot folder belongs, so the
 * run baseline cannot be written and the workflow throws once planning is done.
 */
function blockSnapshotsConsult(tmpDir: string): string {
  const root = sessionsRoot(join(tmpDir, 'project'));
  return `() => {
  const { existsSync, readdirSync, writeFileSync } = process.getBuiltinModule('node:fs');
  for (const id of readdirSync(${JSON.stringify(root)})) {
    const path = ${JSON.stringify(root)} + '/' + id + '/snapshots';
    if (!existsSync(path)) writeFileSync(path, 'not a folder\\n');
  }
  return undefined;
}`;
}

describe('e2e: a headless run whose workflow fails', () => {
  it('prints the cause on stderr before the pointer to it under start and continue --plain', async () => {
    fixture = createStopContinueFixture(undefined, { consult: blockSnapshotsConsult });

    const run = await cli(fixture, ['start', 'smoke']);

    expect(run.exitCode, run.stderr).toBe(1);
    const cause = run.stderr.indexOf(CAUSE);
    expect(cause, run.stderr).toBeGreaterThanOrEqual(0);
    expect(run.stderr.indexOf(CAUSE, cause + 1), run.stderr).toBe(-1);
    expect(run.stderr.indexOf(POINTER), run.stderr).toBeGreaterThan(cause);

    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error(`the failed run left no session: ${run.stderr}`);
    const continued = await cli(fixture, ['continue', sessionId]);

    expect(continued.exitCode, continued.stderr).toBe(1);
    const again = continued.stderr.indexOf(CAUSE);
    expect(again, continued.stderr).toBeGreaterThanOrEqual(0);
    expect(continued.stderr.indexOf(CAUSE, again + 1), continued.stderr).toBe(-1);
    expect(continued.stderr.indexOf(POINTER), continued.stderr).toBeGreaterThan(again);
  });

  it('prints a halt cause once, in its own block, without the pointer under --plain', async () => {
    fixture = createStopContinueFixture(escapingImplementerScript);
    const halt = `Repository changed under T001 · branch ${ESCAPED_BRANCH}`;

    const run = await cli(fixture, ['start', 'smoke']);

    expect(run.exitCode, run.stderr).toBe(1);
    expect(run.stderr.split(halt).length - 1, run.stderr).toBe(1);
    expect(run.stderr).toContain(`Needs you (checkout-changed): ${halt}`);
    expect(run.stderr).not.toContain(POINTER);
  });

  it('keeps stdout pure NDJSON and carries the cause in an error record under --json', async () => {
    fixture = createStopContinueFixture(undefined, { consult: blockSnapshotsConsult });

    const run = await cli(fixture, ['start', 'smoke'], { json: true, timeoutMs: 60_000 });

    expect(run.exitCode, run.stderr).toBe(1);
    const records = run.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line): unknown => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'event',
        data: expect.objectContaining({ type: 'error', message: CAUSE }),
      }),
    );
    expect(run.stderr).not.toContain(CAUSE);
  });
});
