import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TREES_DIR } from '../../core/paths.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { buildLanguageContext } from '../spec/prompts/language-context.js';
import { escalateHint } from './escalation.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const TARGET = 'src/app.ts';
const FIRST_ATTEMPT = 'export const app = "written by the attempt that failed";\n';
const REWRITTEN = 'export const app = "rewritten by the hint escalation";\n';

function makeDirtyWorktree(prefix: string): string {
  const projectDir = createTempDir(prefix);
  dirs.push(projectDir);
  createTestGitRepo(projectDir, { [TARGET]: 'export const app = "committed";\n' });
  execSync(`git worktree add ${TREES_DIR}/sess -b splitbrief/sess`, {
    cwd: projectDir,
    stdio: 'pipe',
  });
  const worktree = join(projectDir, TREES_DIR, 'sess');
  // The failed attempt already wrote this path, so it is in the worktree's git
  // status before the escalation runs.
  writeFileSync(join(worktree, TARGET), FIRST_ATTEMPT);
  return worktree;
}

describe('escalateHint with hintSuccessMode: "files"', () => {
  it('reports success when the declared baseline sees a rewrite of an already-dirty file', async () => {
    const worktree = makeDirtyWorktree('escalate-hint-declared');

    const result = await escalateHint(
      {
        invokeEscalate: async ({ projectDir }) => {
          writeFileSync(join(projectDir, TARGET), REWRITTEN);
          return makeRunnerCallResult({ status: 'completed', text: '' });
        },
        capabilities: { supportsHintEscalation: true },
        hintSuccessMode: 'files',
      },
      {
        task: makeTask({ file: TARGET }),
        error: 'validation failed',
        projectDir: worktree,
        callbacks: { onOutput: () => {} },
        languageContext: buildLanguageContext('typescript'),
        changeDetection: 'file-hashes',
      },
    );

    expect(result.success).toBe(true);
  });

  it('reports no success when the escalation writes nothing', async () => {
    const worktree = makeDirtyWorktree('escalate-hint-no-write');

    const result = await escalateHint(
      {
        invokeEscalate: async () => makeRunnerCallResult({ status: 'completed', text: '' }),
        capabilities: { supportsHintEscalation: true },
        hintSuccessMode: 'files',
      },
      {
        task: makeTask({ file: TARGET }),
        error: 'validation failed',
        projectDir: worktree,
        callbacks: { onOutput: () => {} },
        languageContext: buildLanguageContext('typescript'),
        changeDetection: 'file-hashes',
      },
    );

    expect(result.success).toBe(false);
  });
});
