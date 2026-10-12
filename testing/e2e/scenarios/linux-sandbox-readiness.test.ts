import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { resolveBareCommandOnPath } from '../../../src/lib/process/command-path.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from '../helpers/live-cli-harness.js';

const REVIEW_TEXT = JSON.stringify({
  tasks: [],
  criteria: [],
  findings: [
    {
      id: 'F1',
      kind: 'defect',
      severity: 'minor',
      taskId: null,
      file: null,
      line: null,
      text: 'the changed line has no test.',
      acceptance: null,
      checkIds: null,
      criterionId: null,
    },
  ],
});

const REVIEWER_SCRIPT = `for await (const chunk of process.stdin) void chunk;
process.stdout.write(${JSON.stringify(REVIEW_TEXT)});
`;

const SANDBOX_BLOCKER = 'Claude Code sandbox cannot start: bwrap and socat are not on PATH.';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) cleanupTempDir(tmpDir);
  tmpDir = undefined;
});

/**
 * A project whose default implementer is claude-code, with shell planner and review
 * seats, and a PATH that holds only node and git: no bwrap and no socat.
 */
function createFixture(): { projectDir: string; stateHome: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'splitbrief-linux-sandbox-'));
  tmpDir = root;
  const projectDir = join(root, 'project');
  mkdirSync(projectDir);
  createTestGitRepo(projectDir, { 'tools/reviewer.mjs': REVIEWER_SCRIPT });
  writeFileSync(join(projectDir, 'tools/reviewer.mjs'), `${REVIEWER_SCRIPT}// changed\n`);
  const shellSeat = {
    kind: 'shell' as const,
    command: 'node',
    args: ['./tools/reviewer.mjs'],
    outputFormat: 'text' as const,
  };
  mkdirSync(join(projectDir, SPLITBRIEF_DIR));
  writeFileSync(
    join(projectDir, SPLITBRIEF_DIR, 'config.yaml'),
    YAML.stringify(
      makeConfig({
        planner: shellSeat,
        implementer: { kind: 'cli', tool: 'claude-code' },
        reviewer: { ...shellSeat, model: 'fixture-reviewer' },
      }),
    ),
  );
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const git = resolveBareCommandOnPath('git', projectDir);
  if (git === null) throw new Error('git is not on PATH');
  symlinkSync(git, join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const stateHome = join(root, 'state');
  mkdirSync(stateHome);
  return { projectDir, stateHome, path: bin };
}

async function runCli(
  fixture: ReturnType<typeof createFixture>,
  args: readonly string[],
): ReturnType<typeof spawnCli> {
  const originalPath = process.env.PATH;
  process.env.PATH = fixture.path;
  try {
    return await spawnCli({
      args: [
        '--import',
        'tsx',
        'src/cli.ts',
        ...args,
        '--allow-repo-runners',
        '--project',
        fixture.projectDir,
      ],
      stateHome: fixture.stateHome,
      timeoutMs: 60_000,
    });
  } finally {
    process.env.PATH = originalPath;
  }
}

describe.runIf(process.platform === 'linux')(
  'e2e: Claude Code sandbox readiness on Linux without bwrap and socat',
  { timeout: 120_000 },
  () => {
    it('reviews, because a one-shot review calls no implementer', async () => {
      const fixture = createFixture();

      const review = await runCli(fixture, ['review']);

      expect(review.exitCode, review.stderr).toBe(0);
      expect(`${review.stdout}${review.stderr}`).not.toContain(SANDBOX_BLOCKER);
      expect(review.stdout).toContain('pass_with_notes');
    });

    it('blocks a start, because the claude-code implementer needs the sandbox', async () => {
      const fixture = createFixture();

      const start = await runCli(fixture, ['start', 'change the reviewer', '--plain']);

      expect(start.exitCode).toBe(1);
      expect(`${start.stdout}${start.stderr}`).toContain(SANDBOX_BLOCKER);
    });
  },
);
