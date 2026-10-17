import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureConfigGitignore } from '../../../src/core/config/load/document.js';
import { reviewPacketMarkdownPath, sessionsRoot } from '../../../src/core/paths.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
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

const IMPLEMENTER = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  restorePath?.();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
  restorePath = undefined;
});

/** A checkout whose committed .gitignore has no final newline, with Setup's ignore rule saved. */
async function checkoutWithSetupRule(): Promise<StopContinueFixture> {
  fixture = createStopContinueFixture(() => IMPLEMENTER, { isolation: 'none' });
  const { projectDir } = fixture;
  restorePath = activateSafeCliShimPath(fixture.tmpDir);
  const tool = (path: string) => readFileSync(join(projectDir, path), 'utf8');
  createTestGitRepo(projectDir, {
    '.gitignore': 'node_modules',
    'tools/planner.mjs': tool('tools/planner.mjs'),
    'tools/implementer.mjs': tool('tools/implementer.mjs'),
  });
  expect(await ensureConfigGitignore(projectDir)).toBe(true);
  expect(readFileSync(join(projectDir, '.gitignore'), 'utf8')).toBe('node_modules\n.splitbrief/\n');
  return fixture;
}

describe('e2e: the .gitignore rule Setup adds to a file with no final newline', () => {
  it('is no operator change for doctor or the run start, and the review packet names it', async () => {
    const target = await checkoutWithSetupRule();

    const doctor = await cli(target, ['doctor'], { json: true, timeoutMs: 60_000 });
    expect(
      JSON.parse(doctor.stdout).report.checks.map((check: { id: string }) => check.id),
      doctor.stdout,
    ).not.toContain('repo.dirty-worktree');

    const run = await cli(target, ['start', 'smoke']);
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain('Working tree has');
    const [sessionId = ''] = readdirSync(sessionsRoot(target.projectDir));
    expect(readState(target, sessionId).phase).toBe('complete');
    const packet = readFileSync(
      reviewPacketMarkdownPath({ projectDir: target.projectDir, sessionId }),
      'utf8',
    );
    expect(packet).toContain('- Already changed when this run started: none.');
    expect(packet).toContain("- SPLITBRIEF's own setup changes, not run changes: .gitignore.");
  });
});
