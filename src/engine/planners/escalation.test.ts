import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TREES_DIR } from '../../core/paths.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { buildLanguageContext } from '../spec/prompts/language-context.js';
import { escalateFull } from './escalation.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const TARGET = 'src/app.ts';
const FIRST_ATTEMPT = 'export const app = "written by the attempt that failed";\n';

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

describe('escalateFull with escalateFullMode: "files"', () => {
  it("names the call's own directory in the prompt it sends", async () => {
    const worktree = makeDirtyWorktree('escalate-full-rules');
    const invokeEscalate = vi
      .fn()
      .mockResolvedValue(makeRunnerCallResult({ status: 'completed', text: '' }));

    await escalateFull(
      { invokeEscalate, escalateFullMode: 'files' },
      {
        task: makeTask({ file: TARGET }),
        error: 'validation failed',
        projectDir: worktree,
        callbacks: { onOutput: () => {} },
        languageContext: buildLanguageContext('typescript'),
        changeDetection: 'file-hashes',
      },
    );

    const prompt: string = invokeEscalate.mock.calls[0]?.[0]?.prompt ?? '';
    expect(prompt).toContain(`- Stay inside ${worktree}:`);
    expect(prompt).toContain('- Use git only to read (status, diff, log, show);');
    expect(prompt).toContain('- Dependencies are already installed;');
  });
});
