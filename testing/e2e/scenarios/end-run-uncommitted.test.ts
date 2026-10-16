import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPLITBRIEF_IDENTITY } from '../../../src/core/identity.js';
import { sessionDir } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
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
const ORIGINAL_GREET = 'export const original = true;\n';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

function writingImplementerScript(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';

for await (const chunk of process.stdin) void chunk;

mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

describe('e2e: headless End run on a run worktree with uncommitted changes', () => {
  it('removes the worktree and its branch without a warning and keeps the changes in run.patch', async () => {
    fixture = createStopContinueFixture(writingImplementerScript);
    const target = fixture;
    mkdirSync(join(target.projectDir, 'src'));
    writeFileSync(target.greetPath, ORIGINAL_GREET);
    git(target.projectDir, ['add', GREET_FILE]);
    git(target.projectDir, ['commit', '--quiet', '-m', 'add greet']);
    const checkoutAtStart = checkoutEntries(target.projectDir);

    const run = await cli(target, ['start', 'smoke'], { timeoutMs: RUN_TIMEOUT_MS });
    expect(run.exitCode, run.stderr).toBe(0);
    const sessionId = readActive(target.projectDir);
    if (sessionId === null) throw new Error(`the run left no active session: ${run.stderr}`);
    const ready = readState(target, sessionId);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    const workspace = ready.workspace;
    if (workspace === undefined) throw new Error('the run has no workspace');
    expect(workspace.kind).toBe('worktree');
    const uncommitted = git(workspace.path, ['status', '--porcelain', '--', 'src']);
    expect(uncommitted).toContain(` M ${GREET_FILE}`);
    expect(uncommitted).toContain(`?? ${MARKER_FILE}`);
    const branch = `${SPLITBRIEF_IDENTITY.branchPrefix}${sessionId.slice(0, 64)}`;
    expect(git(target.projectDir, ['branch', '--list', branch])).toContain(branch);

    const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(ended.stderr).not.toContain('run.patch');
    expect(ended.stderr).not.toContain('Could not remove the run workspace');
    expect(ended.stderr).not.toContain('forcing removal');
    const closed = readState(target, sessionId).closed;
    expect(closed?.as).toBe('discarded');
    if (closed?.patch === undefined) throw new Error('the ended run has no patch');
    expect(ended.stdout).toBe(
      `Run ${sessionId} closed. Run changes not applied are saved in ${closed.patch}; apply them with git apply.\n`,
    );
    const patch = join(target.projectDir, closed.patch);
    expect(patch).toBe(join(sessionDir(target.projectDir, sessionId), 'run.patch'));
    const patchText = readFileSync(patch, 'utf8');
    expect(patchText).toContain('-export const original = true;');
    expect(patchText).toContain('+export function greet(name: string): string {');
    expect(patchText).toContain("+export const RUN_MARKER = 'implementer-started';");
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(target.projectDir, ['branch', '--list', branch])).toBe('');
    expect(git(target.projectDir, ['worktree', 'list', '--porcelain'])).not.toContain(
      workspace.path,
    );
    expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);
  }, 180_000);
});
