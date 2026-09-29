import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import {
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 90_000;

/** The shape `npx skills add` leaves: an untracked link from a tool's directory back into the project. */
const LINK = '.claude/skills/tools';
const LINK_TARGET = '../../tools';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/** Where the implementer records the directory it ran in and the link it found there. */
const viewPath = (projectDir: string): string => join(dirname(projectDir), 'implementer-view.json');

function writingImplementerScript(projectDir: string): string {
  return `import { mkdirSync, readlinkSync, writeFileSync } from 'node:fs';

for await (const chunk of process.stdin) void chunk;

writeFileSync(
  ${JSON.stringify(viewPath(projectDir))},
  JSON.stringify({ cwd: process.cwd(), link: readlinkSync(${JSON.stringify(LINK)}) }),
);
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

describe('e2e: a checkout holding an untracked symlink that stays inside the project', () => {
  it('builds the brief in the isolation worktree and promotes it, with no halt and no warning', async () => {
    fixture = createStopContinueFixture(writingImplementerScript);
    mkdirSync(join(fixture.projectDir, '.claude', 'skills'), { recursive: true });
    symlinkSync(LINK_TARGET, join(fixture.projectDir, LINK), 'dir');

    const run = await spawnCli({
      args: [
        '--import',
        'tsx',
        'src/cli.ts',
        'start',
        '--mode',
        'quick',
        '--approve',
        'none',
        'smoke',
        '--plain',
        '--allow-repo-runners',
        '--project',
        fixture.projectDir,
      ],
      stateHome: fixture.stateHome,
      timeoutMs: RUN_TIMEOUT_MS,
    });

    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.exitCode, output).toBe(0);
    expect(run.stdout).toContain('task T001: done');
    expect(output).not.toContain('could not be read');
    expect(output).not.toContain('falling back to a staged copy');
    expect(output).not.toContain('Recovery required');
    // The implementer ran in the isolation worktree, and the link was there with it.
    const view: { cwd: string; link: string } = JSON.parse(
      readFileSync(viewPath(fixture.projectDir), 'utf-8'),
    );
    const treesDir = join(
      realpathSync(fixture.stateHome),
      relative(fixture.stateHome, fixture.isolationTreesDir),
    );
    expect(view.cwd.startsWith(`${treesDir}${sep}`)).toBe(true);
    expect(view.link).toBe(LINK_TARGET);
    expect(readFileSync(fixture.greetPath, 'utf-8')).toBe(GREET_SOURCE);
    expect(lstatSync(join(fixture.projectDir, LINK)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fixture.projectDir, LINK))).toBe(LINK_TARGET);
  }, 150_000);
});
