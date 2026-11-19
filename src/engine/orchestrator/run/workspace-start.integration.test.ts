import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { runTrackedWorkflow } from '#testing/helpers/tracked-workflow.js';
import { planQuestionsFrom, scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { isolationWorktreeRoot, sessionDir } from '../../../core/paths.js';
import { writeLockfile, markExited } from '../../../core/sessions/lock/file.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { readHeadSha } from '../../../lib/git/repository.js';
import { beginCheckoutWriter } from '../../checkout-writers.js';
import { captureWorkspaceComparison, readBaseBytes } from '../apply/states.js';
import * as staging from '../approval/staged-project/create.js';
import * as worktree from '../isolation/worktree/ensure.js';
import * as snapshots from '../../snapshots/create.js';
import { hashFile } from '../../snapshots/files.js';
import { readManifest } from '../../snapshots/manifest.js';

const file = 'input.txt';
const questions = planQuestionsFrom(
  [{ id: 'Q1', type: 'input', text: 'Continue the plan?', default: 'Continue' }],
  '',
);

function pauseInPlanning(ref: SessionRef, isolation: 'worktree' | 'staged-copy' | 'none') {
  const state = loadState(ref) ?? undefined;
  const config = makeConfig({
    codebase: { enabled: false, tokenBudget: 1000 },
    workflow: { isolation },
  });
  const script = scriptedTypedCall([questions]);
  const calls: { cwd: string; input: string; workspace: ReturnType<typeof loadState> }[] = [];
  const planner = makePlanner({
    typedCall: (call) => {
      calls.push({
        cwd: call.projectDir,
        input: readFileSync(join(call.projectDir, file), 'utf8'),
        workspace: loadState(ref),
      });
      return script.typedCall(call);
    },
  });
  return runTrackedWorkflow({
    prepared: makePreparedExecution({
      ...ref,
      feature: 'Plan using the available input',
      config,
      resumeState: state,
    }),
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_SINKS,
    _planner: planner,
    _implementer: makeImplementer(),
  }).then(() => calls);
}

describe('workspace during planning', () => {
  it.each([
    {
      scenario: 'an ordinary worktree',
      strategy: 'worktree',
      kind: 'worktree',
      active: false,
      fallback: false,
    },
    {
      scenario: 'a concurrent worktree',
      strategy: 'worktree',
      kind: 'worktree',
      active: true,
      fallback: false,
    },
    {
      scenario: 'a concurrent staged copy',
      strategy: 'staged-copy',
      kind: 'staged-copy',
      active: true,
      fallback: false,
    },
    {
      scenario: 'a concurrent fallback copy',
      strategy: 'worktree',
      kind: 'staged-copy',
      active: true,
      fallback: true,
    },
  ] as const)(
    'records and plans inside $scenario',
    async ({ strategy, kind, active, fallback }) => {
      await withTempDir('planning-workspace-', async (projectDir) => {
        createTestGitRepo(projectDir, {
          [file]: 'from HEAD\n',
          '.gitattributes': 'input.txt export-ignore\n',
        });
        const head = await readHeadSha(projectDir);
        const committedHash = await hashFile(join(projectDir, file));
        writeFileSync(join(projectDir, file), 'from checkout\n');
        writeFileSync(join(projectDir, 'local.txt'), 'local only\n');
        const localHash = await hashFile(join(projectDir, file));
        if (fallback) {
          const root = isolationWorktreeRoot(realpathSync(join(projectDir, '.git')));
          mkdirSync(dirname(root), { recursive: true });
          writeFileSync(root, 'worktree placement is unavailable');
        }
        const other = { projectDir, sessionId: 'direct-planner' };
        const otherDir = sessionDir(projectDir, other.sessionId);
        if (active) {
          ensureSessionDir(projectDir, other.sessionId);
          saveState(other, {
            ...createInitialState('direct work'),
            phase: 'planning',
            workspace: {
              kind: 'checkout',
              path: projectDir,
              base: { snapshotId: 'baseline', head },
            },
          });
          await writeLockfile(otherDir, {
            pid: process.pid,
            startTimeMs: Date.now(),
            lastAliveMs: Date.now(),
            sessionId: other.sessionId,
            feature: 'direct work',
          });
        }
        const ref = { projectDir, sessionId: 'isolated-planner' };
        try {
          const calls = await pauseInPlanning(ref, strategy);
          expect(calls).toHaveLength(1);
          const call = calls[0];
          const workspace = call?.workspace?.workspace;
          expect(workspace).toMatchObject({ kind, path: call?.cwd });
          if (workspace === undefined) throw new Error('No workspace was recorded during planning');
          expect(workspace.path).not.toBe(projectDir);
          expect(call?.input).toBe(active ? 'from HEAD\n' : 'from checkout\n');
          if (active) expect(workspace.base.head).toBe(head);
          const base = await readManifest(projectDir, ref.sessionId, workspace.base.snapshotId);
          expect(base.fileHashes[file]).toBe(active ? committedHash : localHash);
          expect(Object.hasOwn(base.fileHashes, 'local.txt')).toBe(!active);
          expect(readFileSync(join(projectDir, file), 'utf8')).toBe('from checkout\n');

          const paused = loadState(ref);
          if (paused === null) throw new Error('The planner question was not saved');
          saveState(ref, { ...paused, pendingPlannerConversation: undefined });
          writeFileSync(join(projectDir, file), 'checkout moved on\n');
          expect(await pauseInPlanning(ref, 'none')).toEqual([
            expect.objectContaining({
              cwd: workspace.path,
              input: call?.input,
              workspace: expect.objectContaining({ workspace }),
            }),
          ]);
        } finally {
          if (active) await markExited(otherDir, 0);
        }
      });
    },
  );

  it('pins HEAD when a checkout writer starts and ends during the initial copy', async () => {
    await withTempDir('planning-checkout-race-', async (projectDir) => {
      createTestGitRepo(projectDir, { [file]: 'from HEAD\n' });
      const pinned = await readHeadSha(projectDir);
      const ensure = worktree.ensureIsolationWorktree;
      const intercepted = vi
        .spyOn(worktree, 'ensureIsolationWorktree')
        .mockImplementationOnce(async (input) => {
          const writer = beginCheckoutWriter({ projectDir, sessionId: 'finished-writer' });
          writeFileSync(join(projectDir, file), 'concurrent write\n');
          writer.finish();
          return ensure(input);
        });
      try {
        const [planning] = await pauseInPlanning(
          { projectDir, sessionId: 'new-planner' },
          'worktree',
        );
        expect(intercepted).toHaveBeenCalled();
        expect(planning).toMatchObject({
          input: 'from HEAD\n',
          workspace: { workspace: { kind: 'worktree', base: { head: pinned } } },
        });
        expect(readFileSync(join(projectDir, file), 'utf8')).toBe('concurrent write\n');
      } finally {
        intercepted.mockRestore();
      }
    });
  });

  it('continues a failed workspace setup from its reserved HEAD after the checkout moves', async () => {
    await withTempDir('planning-restart-seed-', async (projectDir) => {
      createTestGitRepo(projectDir, { [file]: 'first commit\n' });
      const head = await readHeadSha(projectDir);
      const writer = beginCheckoutWriter({ projectDir, sessionId: 'direct-writer' });
      const ref = { projectDir, sessionId: 'isolated-start' };
      const copy = vi.spyOn(staging, 'createStagedProject');
      copy.mockRejectedValueOnce(new Error('stage creation interrupted'));
      try {
        expect(await pauseInPlanning(ref, 'staged-copy')).toEqual([]);
        expect(copy).toHaveBeenCalledOnce();
        expect(loadState(ref)).toMatchObject({ phase: 'planning' });
      } finally {
        writer.finish();
        copy.mockRestore();
      }

      createTestGitRepo(projectDir, { [file]: 'second commit\n' });
      expect(await readHeadSha(projectDir)).not.toBe(head);
      const [restarted] = await pauseInPlanning(ref, 'none');
      expect(restarted).toMatchObject({
        input: 'first commit\n',
        workspace: { workspace: { kind: 'staged-copy', base: { head } } },
      });
    });
  });

  it.each([
    { label: 'without a project ignore file', original: null },
    { label: 'with dirty ignore rules', original: '.trees/\ncoverage/' },
  ])(
    'keeps worktree ignore setup out of the saved base $label after restart',
    async ({ original }) => {
      await withTempDir('workspace-ignore-base-', async (projectDir) => {
        createTestGitRepo(projectDir, {
          [file]: 'seed input\n',
          ...(original !== null && { '.gitignore': '.trees/\n' }),
        });
        if (original !== null) writeFileSync(join(projectDir, '.gitignore'), original);
        const ref = { projectDir, sessionId: 'remember-ignore-seed' };

        const writeSnapshot = vi
          .spyOn(snapshots, 'createSnapshot')
          .mockRejectedValueOnce(new Error('snapshot write was interrupted'));
        try {
          expect(await pauseInPlanning(ref, 'worktree')).toEqual([]);
          expect(writeSnapshot).toHaveBeenCalledOnce();
        } finally {
          writeSnapshot.mockRestore();
        }
        const [restarted] = await pauseInPlanning(ref, 'none');
        const workspace = restarted?.workspace?.workspace;
        if (workspace?.kind !== 'worktree') throw new Error('The run did not resume its worktree');
        const entries = await captureWorkspaceComparison({
          ...ref,
          snapshotId: workspace.base.snapshotId,
          workspaceDir: workspace.path,
          workspaceIgnoreDir: undefined,
        });
        const base = entries.base.get('.gitignore');
        expect(
          base === undefined ? null : (await readBaseBytes('.gitignore', base))?.toString('utf8'),
        ).toBe(original);
        expect(readFileSync(join(workspace.path, '.gitignore'), 'utf8')).toContain('.splitbrief/');
      });
    },
  );

  it('leaves an already-covered project ignore symlink in the worktree base', async () => {
    await withTempDir('workspace-ignore-link-', async (projectDir) => {
      createTestGitRepo(projectDir, {
        [file]: 'seed input\n',
        '.gitignore': { symlink: 'ignore-rules' },
        'ignore-rules': 'dist/\n',
      });
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.splitbrief/\n');
      const ref = { projectDir, sessionId: 'keep-ignore-link' };
      const [planned] = await pauseInPlanning(ref, 'worktree');
      const workspace = planned?.workspace?.workspace;
      if (workspace?.kind !== 'worktree') throw new Error('The run did not retain its worktree');
      const manifest = await readManifest(projectDir, ref.sessionId, workspace.base.snapshotId);
      expect(manifest.symlinks).toContainEqual({ path: '.gitignore', target: 'ignore-rules' });
    });
  });

  it('records the direct checkout before the planner starts', async () => {
    await withTempDir('planning-checkout-', async (projectDir) => {
      createTestGitRepo(projectDir, { [file]: 'from HEAD\n' });
      const calls = await pauseInPlanning({ projectDir, sessionId: 'direct-planner' }, 'none');
      expect(calls).toEqual([
        expect.objectContaining({
          cwd: projectDir,
          workspace: expect.objectContaining({
            workspace: expect.objectContaining({ kind: 'checkout', path: projectDir }),
          }),
        }),
      ]);
    });
  });
});
