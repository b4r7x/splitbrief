import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import type { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { openHaltedRun } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  MARKER_FILE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REASON = 'No service.';
const MARKER_AT_START = 'export const RUN_MARKER = "as it was";\n';

function markerImplementerScript(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, 'export const RUN_MARKER = "half done";\\n');
console.log('Done');
`;
}

/** Green at the run base, red after the implementer's write. */
const MARKER_CHECK = `import { readFileSync } from 'node:fs';
process.exit(readFileSync(${JSON.stringify(MARKER_FILE)}, 'utf8').includes('half done') ? 1 : 0);
`;

const CANNOT = JSON.stringify({
  answer: { diagnosis: REASON, action: 'cannot', reason: REASON, next: 'skip-brief' },
});

function cannotConsult(): string {
  return `(prompt) => {
  const heading = prompt.split('\\n').find((line) => line.startsWith('# '));
  return heading === '# Consult on a failing task' || heading === '# Consult continued'
    ? ${JSON.stringify(CANNOT)}
    : undefined;
}`;
}

let fixture: StopContinueFixture | undefined;
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => resetAllStores());

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: the planner says a brief with failing checks cannot be done', () => {
  it('halts the run and takes the files of the brief back', async () => {
    fixture = createStopContinueFixture(markerImplementerScript, { consult: cannotConsult });
    const markerPath = join(fixture.projectDir, MARKER_FILE);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, MARKER_AT_START);
    writeFileSync(join(fixture.projectDir, 'tools/check.mjs'), MARKER_CHECK);
    const configPath = join(fixture.projectDir, SPLITBRIEF_DIR, 'config.yaml');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace('node --version', 'node tools/check.mjs'),
    );
    execFileSync('git', ['add', MARKER_FILE, 'tools/check.mjs'], { cwd: fixture.projectDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'add marker'], { cwd: fixture.projectDir });

    const halted = await cli(fixture, ['start', 'smoke']);
    expect(halted.exitCode, `${halted.stdout}\n${halted.stderr}`).toBe(1);
    expect(halted.stderr).toContain(`Planner said: ${REASON}`);

    const opened = await openHaltedRun(fixture, { heading: 'Needs you' });
    ui = opened.screen;
    const state = loadState(opened.ref);
    expect(state?.pendingRecovery?.reason).toBe('retry-exhausted');
    const workspace = state?.workspace?.path;
    if (workspace === undefined) throw new Error('the halted run has no workspace');
    expect(readFileSync(join(workspace, MARKER_FILE), 'utf8')).toBe(MARKER_AT_START);
  });
});
