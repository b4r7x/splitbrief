import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  applyRun,
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 90_000;
const SUBMODULE = 'vendor';
const SUBMODULE_FILE = `${SUBMODULE}/lib.txt`;
const SUBMODULE_SOURCE = 'submodule content\n';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

/** Where the implementer records what it read from the submodule in its workspace. */
const viewPath = (projectDir: string): string => join(dirname(projectDir), 'implementer-view.json');

function submoduleReadingImplementerScript(projectDir: string): string {
  return `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

for await (const chunk of process.stdin) void chunk;

writeFileSync(
  ${JSON.stringify(viewPath(projectDir))},
  JSON.stringify({
    cwd: process.cwd(),
    submodule: existsSync(${JSON.stringify(SUBMODULE_FILE)})
      ? readFileSync(${JSON.stringify(SUBMODULE_FILE)}, 'utf8')
      : null,
  }),
);
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

/** Adds a submodule cloned from a local bare repository and commits it in the project. */
function addLocalSubmodule(target: StopContinueFixture): void {
  const source = join(target.tmpDir, 'vendor-source');
  createTestGitRepo(source, { 'lib.txt': SUBMODULE_SOURCE });
  const bare = join(target.tmpDir, 'vendor.git');
  git(target.tmpDir, ['clone', '--quiet', '--bare', source, bare]);
  git(target.projectDir, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    bare,
    SUBMODULE,
  ]);
  git(target.projectDir, ['commit', '--quiet', '-m', 'add vendor submodule']);
}

describe('e2e: a project with a git submodule', () => {
  it('checks the submodule out in the run worktree, passes the brief and applies it', async () => {
    fixture = createStopContinueFixture(submoduleReadingImplementerScript);
    const target = fixture;
    addLocalSubmodule(target);
    // The run worktree clones the submodule over file://; git refuses that transport by default.
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });

    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.exitCode, output).toBe(0);
    expect(run.stdout).toContain('task T001: done');
    expect(output).not.toMatch(/Needs you \(|Seat down \(/);
    expect(output).not.toContain('falling back to a staged copy');
    const sessionId = readActive(target.projectDir);
    if (sessionId === null) throw new Error(`the run left no active session: ${output}`);
    const workspace = readState(target, sessionId).workspace;
    if (workspace === undefined) throw new Error('the run has no workspace');
    expect(workspace.kind).toBe('worktree');
    const view: { cwd: string; submodule: string | null } = JSON.parse(
      readFileSync(viewPath(target.projectDir), 'utf-8'),
    );
    expect(view.submodule).toBe(SUBMODULE_SOURCE);
    expect(existsSync(target.greetPath)).toBe(false);

    const applied = await applyRun(target, sessionId);

    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stderr).not.toContain('Could not remove the run workspace');
    expect(readFileSync(target.greetPath, 'utf-8')).toBe(GREET_SOURCE);
    expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);
    expect(readFileSync(join(target.projectDir, SUBMODULE_FILE), 'utf-8')).toBe(SUBMODULE_SOURCE);
    expect(readState(target, sessionId).closed?.as).toBe('applied');
    expect(existsSync(workspace.path)).toBe(false);
  }, 180_000);
});
