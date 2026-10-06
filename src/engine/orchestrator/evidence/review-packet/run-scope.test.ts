import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../../core/paths-io.js';
import { isInternalGitStatusPath } from '../../../../core/paths.js';
import { getCurrentDiff } from '../../../../lib/git/diff.js';
import { getChangedFilesSnapshot } from '../../approval/file-snapshots/capture.js';
import { captureTaskReviewChanges } from '../review-capture.js';
import { resolveRunReviewScope } from './run-scope.js';

const cleanups: Array<() => void> = [];
const file = 'src/mixed.ts';
const operator = 'export const operatorFix = true;\nexport const feature = false;\n';
const worker = operator.replace('feature = false', 'feature = true');
const merged = `${worker}export const checkoutFix = true;\n`;

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function project() {
  const projectDir = createTempDir('run-scope');
  cleanups.push(() => cleanupTempDir(projectDir));
  createTestGitRepo(projectDir, { [file]: operator });
  const ref = { projectDir, sessionId: 'run-scope-test' };
  ensureSessionDir(projectDir, ref.sessionId);
  const task = makeTask({ suggestedFiles: [file], action: 'modify', status: 'in_progress' });
  return { projectDir, ref, task };
}

describe('resolveRunReviewScope with Apply-merged paths', () => {
  it('diffs a merged path from the run base to the merged workspace only when asked', async () => {
    const p = project();
    const taskStartSnapshot = await getChangedFilesSnapshot(p.projectDir);
    writeFileSync(join(p.projectDir, file), worker);
    await captureTaskReviewChanges({
      ref: p.ref,
      workspaceDir: p.projectDir,
      task: p.task,
      taskStartSnapshot,
    });
    writeFileSync(join(p.projectDir, file), merged);
    const workspaceDiff = await getCurrentDiff(p.projectDir, isInternalGitStatusPath);

    const base = {
      ref: p.ref,
      workspaceDir: p.projectDir,
      tasks: [p.task],
      workspaceFiles: [file],
      workspaceDiff,
    };

    const unchanged = await resolveRunReviewScope(base);
    expect(unchanged.files.map((entry) => [entry.path, entry.taskIds])).toEqual([[file, ['T001']]]);
    expect(unchanged.files[0]?.diff ?? '').not.toContain('checkoutFix');
    expect(unchanged.laterDiff).toContain('checkoutFix');

    const mergedScope = await resolveRunReviewScope({ ...base, mergedPaths: [file] });
    const diff = mergedScope.files[0]?.diff ?? '';
    expect(diff).toContain('-export const feature = false;');
    expect(diff).toContain('+export const feature = true;');
    expect(diff).toContain('+export const checkoutFix = true;');
    expect(mergedScope.laterDiff).toBe('');
    expect(mergedScope.provenance.uncertainFiles).toEqual([]);
  });
});
