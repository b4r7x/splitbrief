import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
} from '../helpers/stop-continue-fixture.js';

const FIRST_PARTIAL = 'first run partial\n';

function overlappingImplementer(projectDir: string): string {
  const started = join(dirname(projectDir), 'direct-a-started');
  const release = join(dirname(projectDir), 'release-direct-a');
  return `import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
if (!existsSync(${JSON.stringify(started)})) {
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(FIRST_PARTIAL)});
  writeFileSync(${JSON.stringify(started)}, '');
  while (!existsSync(${JSON.stringify(release)})) await delay(25);
  const branch = spawnSync('git', ['branch', 'changed-during-a'], { stdio: 'inherit' });
  if (branch.status !== 0) process.exit(1);
} else {
  writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
  writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
}
console.log('Updated the greeting');
`;
}

it('keeps both direct builds in the checkout and preserves the second run’s writes on the first run’s halt', async () => {
  const fixture = createStopContinueFixture(overlappingImplementer, { isolation: 'none' });
  const sessions = sessionsRoot(fixture.projectDir);
  const started = join(fixture.tmpDir, 'direct-a-started');
  const release = join(fixture.tmpDir, 'release-direct-a');
  const options = { timeoutMs: 90_000, reapProjectDir: fixture.projectDir };
  const first = cli(fixture, ['start', 'first checkout build'], options);
  try {
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 40_000 });
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(FIRST_PARTIAL);
    const [firstId] = readdirSync(sessions);
    if (firstId === undefined) throw new Error('The first run did not create a session.');

    const second = await cli(fixture, ['start', 'second checkout build'], options);
    expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
    const secondId = readdirSync(sessions).find((id) => id !== firstId);
    if (secondId === undefined) throw new Error('The second run did not create its own session.');
    const checkout = { kind: 'checkout', path: realpathSync(fixture.projectDir) };
    expect(readState(fixture, firstId).workspace).toMatchObject(checkout);
    expect(readState(fixture, secondId).workspace).toMatchObject(checkout);
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(fixture.markerPath, 'utf8')).toBe(MARKER_SOURCE);

    writeFileSync(release, '');
    const halted = await first;

    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(readState(fixture, firstId).pendingRecovery?.reason).toBe('checkout-changed');
    expect(halted.stderr).toContain('Left these checkout paths as they are');
    expect(halted.stderr).toContain(GREET_FILE);
    expect(halted.stderr).toContain(MARKER_FILE);
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    expect(readFileSync(fixture.markerPath, 'utf8')).toBe(MARKER_SOURCE);
  } finally {
    writeFileSync(release, '');
    await first;
    cleanupTempDir(fixture.tmpDir);
  }
}, 180_000);
