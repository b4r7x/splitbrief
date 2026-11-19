import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir, sessionsRoot, SNAPSHOT_BASELINE_ID } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { resolveValidatedBlobPath } from '../../../src/engine/snapshots/blob-resolver.js';
import { readManifest } from '../../../src/engine/snapshots/manifest.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  ESCAPED_BRANCH,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

const USER_EDIT = 'my uncommitted edit\n';
const SHORT_BLOB = 'my unc';
const ATTEMPT_BYTES = 'the attempt rewrote this\n';

/**
 * Cuts the stored copy of the user's uncommitted `init.txt` short, as a cut write would, then
 * rewrites `init.txt` and moves the checkout's Git state to trigger a put-back.
 */
function cuttingImplementer(checkoutDir: string): string {
  const sessions = sessionsRoot(checkoutDir);
  const hash = sha256Hex(USER_EDIT);
  return `import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
for await (const chunk of process.stdin) void chunk;
for (const id of readdirSync(${JSON.stringify(sessions)})) {
  const blob = join(${JSON.stringify(sessions)}, id, 'entries', ${JSON.stringify(hash)});
  if (existsSync(blob)) writeFileSync(blob, ${JSON.stringify(SHORT_BLOB)});
}
spawnSync('git', ['-C', ${JSON.stringify(checkoutDir)}, 'branch', ${JSON.stringify(ESCAPED_BRANCH)}]);
writeFileSync('init.txt', ${JSON.stringify(ATTEMPT_BYTES)});
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

describe('e2e: a checkout revert over a stored entry that does not match its hash', () => {
  it('names the corrupt snapshot while keeping the checkout edits and the original user bytes', async () => {
    fixture = createStopContinueFixture(cuttingImplementer, { isolation: 'none' });
    const userFile = join(fixture.projectDir, 'init.txt');
    writeFileSync(userFile, USER_EDIT);

    const halted = await cli(fixture, ['start', 'smoke']);

    expect(halted.exitCode).toBe(1);
    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error(`the halted run left no session: ${halted.stderr}`);
    const ref = { projectDir: fixture.projectDir, sessionId };
    const blob = join(sessionDir(ref.projectDir, sessionId), 'entries', sha256Hex(USER_EDIT));
    expect(readFileSync(blob, 'utf8')).toBe(SHORT_BLOB);
    expect(halted.stderr).toContain('Entry snapshot does not match its hash: init.txt');
    const state = readState(fixture, sessionId);
    expect(state.pendingRecovery?.reason).toBe('checkout-changed');
    expect(state.closed).toBeUndefined();
    expect(readFileSync(userFile, 'utf8')).toBe(ATTEMPT_BYTES);
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(fixture.markerPath, 'utf8')).toBe(MARKER_SOURCE);

    const baseline = await readManifest(ref.projectDir, sessionId, SNAPSHOT_BASELINE_ID);
    const original = await resolveValidatedBlobPath({
      ...ref,
      snapshotId: SNAPSHOT_BASELINE_ID,
      path: 'init.txt',
      entry: baseline.fileEntries.find((entry) => entry.path === 'init.txt'),
    });
    if (original === null) throw new Error('The run baseline lost its copy of init.txt.');
    expect(readFileSync(original, 'utf8')).toBe(USER_EDIT);
  }, 150_000);
});
