import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir, sessionsRoot } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
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
 * rewrites `init.txt` and moves the checkout's git state, so the run halts and puts the attempt back.
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
  it('refuses the stored bytes and never writes them over the uncommitted file', async () => {
    fixture = createStopContinueFixture(cuttingImplementer, { isolation: 'none' });
    const userFile = join(fixture.projectDir, 'init.txt');
    writeFileSync(userFile, USER_EDIT);

    const halted = await cli(fixture, ['start', 'smoke']);

    expect(halted.exitCode).not.toBe(0);
    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error(`the halted run left no session: ${halted.stderr}`);
    const blob = join(sessionDir(fixture.projectDir, sessionId), 'entries', sha256Hex(USER_EDIT));
    expect(readFileSync(blob, 'utf8')).toBe(SHORT_BLOB);
    // The revert reached init.txt: it saved the attempt's bytes before it read the stored entry.
    const reverted = join(sessionDir(fixture.projectDir, sessionId), 'reverted');
    expect(
      readdirSync(reverted).some(
        (stamp) =>
          existsSync(join(reverted, stamp, 'init.txt')) &&
          readFileSync(join(reverted, stamp, 'init.txt'), 'utf8') === ATTEMPT_BYTES,
      ),
    ).toBe(true);
    expect(readFileSync(userFile, 'utf8')).toBe(ATTEMPT_BYTES);
  }, 150_000);
});
