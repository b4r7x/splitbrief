import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { captureAcquisitionBaseline } from '../approval/file-snapshots/entry.js';
import { prepareWorktreeAcquisition } from '../isolation/acquisition.js';
import { handleApprovalTimeUserEditConflict } from '../escalation/approval-conflict.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { createRecoveryIssue } from '../recovery/builders/issue.js';
import { fileHaltIsStale } from './init.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) cleanupTempDir(root);
});

async function fixture() {
  const root = createTempDir('promotion-halt');
  roots.push(root);
  const projectDir = join(root, 'project');
  const worktreeDir = join(root, 'worker');
  const sessionId = 'parked-conflict';
  for (const dir of [projectDir, worktreeDir]) {
    await mkdir(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
    await writeFile(join(dir, 'a.ts'), 'original a\n');
    await writeFile(join(dir, 'b.ts'), 'original b\n');
  }
  await prepareWorktreeAcquisition({
    projectDir,
    sessionId,
    worktreeDir,
    seedSnapshot: null,
    fresh: false,
    initialTargetBaseline: await captureAcquisitionBaseline(projectDir),
  });
  const task = makeTask({ id: 'T001', status: 'in_progress', file: 'a.ts' });
  const state = makeImplState([task], {
    changedFilesBaseline: serializeChangedFilesBaseline(
      await captureChangedFilesBaseline(projectDir),
    ),
    pendingRecovery: createRecoveryIssue({
      reason: 'approval-promotion-conflict',
      phase: 'implementing',
      task,
      files: ['a.ts', 'b.ts'],
      affectedTaskIds: [task.id],
      message: 'Promotion conflict',
      details: [],
      facts: { workspacePath: worktreeDir },
      availableActions: ['pause-run', 'end-run'],
      recommendedAction: 'pause-run',
      createdAt: '2026-09-26T00:00:00.000Z',
    }),
  });
  return { projectDir, worktreeDir, sessionId, state };
}

it('keeps a cold unresolved overlap parked even when the general file baseline absorbed the edits', async () => {
  const { projectDir, worktreeDir, sessionId, state } = await fixture();
  for (const file of ['a.ts', 'b.ts']) {
    await writeFile(join(projectDir, file), 'operator\n');
    await writeFile(join(worktreeDir, file), 'worker\n');
  }
  state.changedFilesBaseline = serializeChangedFilesBaseline(
    await captureChangedFilesBaseline(projectDir),
  );
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
});

it('continues only after every guarded copy agrees and leaves unrelated or partial halts parked', async () => {
  const { projectDir, worktreeDir, sessionId, state } = await fixture();
  for (const file of ['a.ts', 'b.ts']) {
    await writeFile(join(projectDir, file), 'operator\n');
    await writeFile(join(worktreeDir, file), 'worker\n');
  }
  await writeFile(join(projectDir, 'a.ts'), 'merged a\n');
  await writeFile(join(worktreeDir, 'a.ts'), 'merged a\n');
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
  await writeFile(join(projectDir, 'b.ts'), 'merged b\n');
  await writeFile(join(worktreeDir, 'b.ts'), 'merged b\n');
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(true);

  const issue = state.pendingRecovery;
  if (issue === undefined) throw new Error('Fixture requires a recovery issue');
  state.pendingRecovery = { ...issue, facts: { partialPromotion: true } };
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
  state.pendingRecovery = {
    ...issue,
    facts: { workspacePath: join(projectDir, 'unrelated-copy') },
  };
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
  state.pendingRecovery = { ...issue, reason: 'runner-usage-limit' };
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
});

it('clears a symlink promotion conflict once both copies hold the same project link', async () => {
  const { projectDir, worktreeDir, sessionId, state } = await fixture();
  await symlink('a.ts', join(projectDir, 'link.ts'));
  await writeFile(join(worktreeDir, 'link.ts'), 'worker\n');
  const issue = state.pendingRecovery;
  if (issue === undefined) throw new Error('Fixture requires a recovery issue');
  state.pendingRecovery = { ...issue, files: ['link.ts'] };
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);

  await rm(join(worktreeDir, 'link.ts'));
  await symlink('a.ts', join(worktreeDir, 'link.ts'));
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(true);
});

it('lets a legacy worktree continue after both conflicting copies are reconciled', async () => {
  const { projectDir, worktreeDir, sessionId, state } = await fixture();
  await rm(join(projectDir, '.splitbrief/sessions', sessionId, 'isolation-baseline.json'));
  await writeFile(join(projectDir, 'a.ts'), 'operator\n');
  await writeFile(join(worktreeDir, 'a.ts'), 'legacy worker partial\n');
  await prepareWorktreeAcquisition({
    projectDir,
    sessionId,
    worktreeDir,
    seedSnapshot: null,
    fresh: true,
    initialTargetBaseline: undefined,
  });
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
  await writeFile(join(projectDir, 'a.ts'), 'merged\n');
  await writeFile(join(worktreeDir, 'a.ts'), 'merged\n');
  expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(true);
});

it('persists the conflicting acquisition directory so cold recovery cannot use another workspace', async () => {
  const { projectDir, worktreeDir, sessionId } = await fixture();
  const task = makeTask({ id: 'T001', status: 'in_progress', file: 'a.ts' });
  await handleApprovalTimeUserEditConflict({
    ctx: makeWctx({ projectDir, sessionId }),
    state: makeImplState([task]),
    task,
    files: ['a.ts'],
    workspacePath: worktreeDir,
  });
  const saved: unknown = JSON.parse(
    await readFile(join(projectDir, '.splitbrief/sessions', sessionId, 'state.json'), 'utf8'),
  );
  expect(saved).toMatchObject({ pendingRecovery: { facts: { workspacePath: worktreeDir } } });
});
