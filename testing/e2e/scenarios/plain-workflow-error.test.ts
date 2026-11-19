import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionsRoot, SNAPSHOTS_DIR } from '../../../src/core/paths.js';
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
  vi.unstubAllEnvs();
});

// Put a regular file in the snapshots folder's place when the CLI creates this fixture's session.
// The same file blocks the baseline on start and on continue, independent of when planning runs.
function withBlockedSnapshots(): StopContinueFixture {
  const target = createStopContinueFixture();
  const sessions = sessionsRoot(realpathSync(target.projectDir));
  const preload = join(target.tmpDir, 'block-snapshot-folder.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const mkdirSync = fs.mkdirSync;
fs.mkdirSync = (path, options) => {
  const result = mkdirSync(path, options);
  if (typeof path === 'string' && dirname(path) === ${JSON.stringify(sessions)} && !options?.recursive) {
    fs.writeFileSync(join(path, ${JSON.stringify(SNAPSHOTS_DIR)}), 'not a folder', { flag: 'wx' });
  }
  return result;
};
syncBuiltinESMExports();
`,
  );
  vi.stubEnv(
    'NODE_OPTIONS',
    `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
  );
  return target;
}

describe('e2e: a headless run whose workflow fails', () => {
  it('names the session folder and the filesystem reason when start cannot allocate it', async () => {
    fixture = createStopContinueFixture();
    writeFileSync(sessionsRoot(fixture.projectDir), 'occupied');
    const run = await cli(fixture, ['start', 'smoke']);
    expect(run.exitCode, run.stderr).toBe(1);
    expect(run.stderr).toContain('Could not create the session folder');
    expect(run.stderr).toMatch(/file already exists|not a directory/i);
  });

  it('prints the cause on stderr before the pointer to it under start and continue --plain', async () => {
    fixture = withBlockedSnapshots();

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

  it('keeps stdout pure NDJSON and carries the cause in an error record under start and continue --json', async () => {
    fixture = withBlockedSnapshots();
    const json = { json: true, timeoutMs: 60_000 };

    const started = await cli(fixture, ['start', 'smoke'], json);
    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error(`the failed run left no session: ${started.stderr}`);
    const continued = await cli(fixture, ['continue', sessionId], json);

    for (const run of [started, continued]) {
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
    }
  });
});
