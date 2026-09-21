import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { createEventBus } from '../../events/bus.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { ChangedFilesSnapshotSchema } from '../../../core/schemas/workflow.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';

const control = vi.hoisted(() => ({
  editAfterRename: '',
  editTarget: '',
  editAlreadyApplied: false,
  failChmodName: '',
  partialWriteName: '',
  failReaddir: '',
  statusFiles: [] as string[],
  gitCalls: [] as string[][],
  tree: new Map<string, { bytes: Buffer; mode: number }>(),
  workspace: '',
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (String(args[1]) === control.editAfterRename) {
        await actual.writeFile(control.editTarget, 'user edited B\n');
        if (control.editAlreadyApplied) await actual.writeFile(String(args[1]), 'user edited A\n');
      }
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (
        control.partialWriteName &&
        basename(String(args[0])).startsWith(`.${control.partialWriteName}.tmp.`)
      ) {
        await actual.writeFile(args[0], 'partial bytes');
        throw new Error('EIO: partial temporary write');
      }
      return actual.writeFile(...args);
    },
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (
        control.failChmodName &&
        basename(String(args[0])).startsWith(`.${control.failChmodName}.tmp.`)
      ) {
        throw new Error('EPERM: chmod rejected');
      }
      return actual.chmod(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) === control.failReaddir) throw new Error('EACCES: directory unreadable');
      return actual.readdir(...args);
    },
  };
});
// This Git adapter is read-only and never starts a process or creates objects/indexes.
vi.mock('simple-git', () => ({
  simpleGit: () => ({
    checkIsRepo: async () => true,
    status: async () => ({ files: control.statusFiles.map((path) => ({ path })) }),
    raw: async (args: string[]) => {
      control.gitCalls.push(args);
      if (args[0] === 'rev-parse') return 'fake-head';
      if (args[0] === 'ls-files') return '';
      if (args[0] === 'ls-tree') {
        const path = args.at(-1)?.replace(/^:\(literal\)/, '') ?? '';
        const entry = control.tree.get(path);
        return entry === undefined
          ? ''
          : `${entry.mode === 0o755 ? '100755' : '100644'} blob abcdef\t${path}\0`;
      }
      throw new Error(`Unexpected Git command: ${args.join(' ')}`);
    },
    diff: async () => '',
    showBuffer: async () => {
      const last =
        control.gitCalls
          .at(-1)
          ?.at(-1)
          ?.replace(/^:\(literal\)/, '') ?? '';
      const entry = control.tree.get(last);
      if (entry === undefined) throw new Error('missing blob');
      return entry.bytes;
    },
  }),
}));
vi.mock('../isolation/worktree.js', () => ({
  ensureIsolationWorktree: async () => ({
    kind: 'ready',
    worktreePath: control.workspace,
    reused: true,
  }),
  removeNodeModulesExclude: async () => {},
}));

const { captureAcquisitionBaseline, readConfinedEntry } = await import('./file-snapshots/entry.js');
const { gateAndPromoteChangedFiles } = await import('./gate-and-promote.js');
const { restoreDirtyFilesFromSnapshot } = await import('./file-snapshots/restore.js');
const { getChangedFilesSinceSnapshot, getChangedFilesSnapshot } = await import(
  './file-snapshots/capture.js'
);
const { createRunIsolation } = await import('../isolation/create.js');
const { initializeWorkflow } = await import('../run/init.js');
const { applyRecoveryAction } = await import('../recovery/actions.js');

const roots: string[] = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'splitbrief-filesystem-boundary-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  control.editAfterRename =
    control.editTarget =
    control.failChmodName =
    control.partialWriteName =
    control.failReaddir =
    control.workspace =
      '';
  control.editAlreadyApplied = false;
  control.statusFiles = [];
  control.gitCalls.length = 0;
  control.tree.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const config = makeNoValidationConfig({
  approval: { enabled: false, feedRejectionsToPlanner: true },
});
const sessionId = 'sess-filesystem';
async function fixture() {
  const root = tempRoot();
  const projectDir = join(root, 'project');
  const stageDir = join(root, 'worker');
  mkdirSync(projectDir);
  mkdirSync(stageDir);
  const baselineFileHashes: Record<string, string> = {};
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    const original = `original ${name}\n`;
    writeFileSync(join(projectDir, name), original);
    writeFileSync(join(stageDir, name), `worker ${name}\n`);
    baselineFileHashes[name] = sha256Hex(original);
  }
  const snapshot = {
    head: 'fake-head',
    files: ['a.ts'],
    dirtyFileContents: { 'a.ts': 'original a.ts\n' },
    baselineFileHashes,
  };
  const workspace = {
    projectDir: stageDir,
    sandboxEnv: {},
    snapshot,
    targetBaseline: await captureAcquisitionBaseline(projectDir),
    cleanup: () => rmSync(stageDir, { recursive: true, force: true }),
  };
  const task = makeTask({ id: 'T011', action: 'modify', file: 'a.ts', status: 'in_progress' });
  const state = makeImplState([task], {
    changedFilesBaseline: { head: 'fake-head', fingerprints: {}, activeTaskSnapshot: snapshot },
  });
  const ref = { projectDir, sessionId };
  saveState(ref, state);
  const saved = loadState(ref);
  if (saved === null) throw new Error('fixture state did not persist');
  return {
    projectDir,
    stageDir,
    workspace,
    task,
    state: saved,
    ref,
    run: () =>
      gateAndPromoteChangedFiles({
        task,
        state: saved,
        projectDir,
        sessionId,
        bus: createEventBus(),
        callbacks: makeCallbacks().callbacks,
        config,
        workspace,
        usesIsolation: true,
        taskStartSnapshot: snapshot,
        dependsOnFiles: [],
        cleanup: workspace.cleanup,
        handleConflict: async (s) => s,
        onApproved: () => {},
      }),
  };
}

it('persists a late conflict prefix, preserves newer edits, and retains unapplied worker output', async () => {
  const f = await fixture();
  control.editAfterRename = join(f.projectDir, 'a.ts');
  control.editTarget = join(f.projectDir, 'b.ts');
  control.editAlreadyApplied = true;
  const result = await f.run();
  expect(result.outcome).toBe('error');
  expect(readFileSync(join(f.projectDir, 'a.ts'), 'utf8')).toBe('user edited A\n');
  expect(readFileSync(join(f.projectDir, 'b.ts'), 'utf8')).toBe('user edited B\n');
  expect(readFileSync(join(f.projectDir, 'c.ts'), 'utf8')).toBe('original c.ts\n');
  expect(existsSync(f.stageDir)).toBe(true);
  expect(readEvidenceLedger(f.ref)?.tasks[0]?.promotionAttempts?.[0]?.appliedFiles).toEqual([
    { path: 'a.ts', sha256: sha256Hex('worker a.ts\n'), mode: 0o644 },
  ]);
  expect(loadState(f.ref)?.pendingRecovery?.facts?.partialPromotion).toBe(true);
});

it.each(['mode', 'write'] as const)(
  'does not mutate B when preparing its %s fails after A',
  async (failure) => {
    const f = await fixture();
    if (failure === 'mode') control.failChmodName = 'b.ts';
    else control.partialWriteName = 'b.ts';
    const result = await f.run();
    expect(result.outcome).toBe('error');
    expect(readFileSync(join(f.projectDir, 'a.ts'), 'utf8')).toBe('worker a.ts\n');
    expect(readFileSync(join(f.projectDir, 'b.ts'), 'utf8')).toBe('original b.ts\n');
    expect(readFileSync(join(f.projectDir, 'c.ts'), 'utf8')).toBe('original c.ts\n');
    expect(readdirSync(f.projectDir).some((file) => file.includes('.tmp.'))).toBe(false);
    expect(
      readEvidenceLedger(f.ref)?.tasks[0]?.promotionAttempts?.[0]?.appliedFiles.map(
        (file) => file.path,
      ),
    ).toEqual(['a.ts']);
  },
);

it('blocks acquisition instead of accepting an incomplete directory scan', async () => {
  const root = tempRoot();
  const child = join(root, 'src');
  mkdirSync(child);
  writeFileSync(join(child, 'app.ts'), 'present\n');
  control.failReaddir = child;
  await expect(captureAcquisitionBaseline(root)).rejects.toThrow('directory unreadable');
});

it('restores exact blob bytes and permissions without changing any Git index', async () => {
  const root = tempRoot();
  const bytes = Buffer.from([0xff, 0, 0xfe]);
  control.tree.set('existing.bin', { bytes, mode: 0o755 });
  writeFileSync(join(root, 'existing.bin'), 'worker bytes');
  writeFileSync(join(root, 'created.ts'), 'worker new file');
  const result = await restoreDirtyFilesFromSnapshot(
    root,
    { head: 'SNAPSHOT', files: [], dirtyFileContents: {} },
    ['existing.bin', 'created.ts'],
  );
  expect(result).toEqual({ restoredFiles: ['existing.bin', 'created.ts'], conflictedFiles: [] });
  expect(readFileSync(join(root, 'existing.bin'))).toEqual(bytes);
  expect(statSync(join(root, 'existing.bin')).mode & 0o777).toBe(0o755);
  expect(existsSync(join(root, 'created.ts'))).toBe(false);
  expect(control.gitCalls.every((args) => args[0] === 'ls-tree')).toBe(true);
});

it('roundtrips dirty binary snapshots and detects rewrites with the same decoded UTF-8 text', async () => {
  const root = tempRoot();
  const original = Buffer.from([0xff, 0]);
  const replacement = Buffer.from([0xfe, 0]);
  writeFileSync(join(root, 'asset.bin'), original);
  chmodSync(join(root, 'asset.bin'), 0o755);
  control.statusFiles = ['asset.bin'];
  const snapshot = ChangedFilesSnapshotSchema.parse(
    JSON.parse(JSON.stringify(await getChangedFilesSnapshot(root))),
  );
  expect(snapshot.dirtyFileContents).toEqual({});
  writeFileSync(join(root, 'asset.bin'), replacement);
  expect(original.toString('utf8')).toBe(replacement.toString('utf8'));
  expect(await getChangedFilesSinceSnapshot(root, snapshot)).toEqual(['asset.bin']);
  await restoreDirtyFilesFromSnapshot(root, snapshot, ['asset.bin']);
  expect(readFileSync(join(root, 'asset.bin'))).toEqual(original);
  expect(statSync(join(root, 'asset.bin')).mode & 0o777).toBe(0o755);
});

it('detects a later dirty binary rewrite when an actual isolation acquisition reuses a worktree', async () => {
  const f = await fixture();
  control.workspace = f.stageDir;
  mkdirSync(join(f.stageDir, '.git'));
  writeFileSync(join(f.stageDir, 'asset.bin'), Buffer.from([0xff, 0]));
  control.statusFiles = ['asset.bin'];
  const isolation = createRunIsolation({
    projectDir: f.projectDir,
    sessionId,
    strategy: 'worktree',
    onFallback: () => {},
    onRetained: () => {},
  });
  const workspace = await isolation.acquire({ role: 'implementer', config, writesFiles: 'direct' });
  writeFileSync(join(workspace.projectDir, 'asset.bin'), Buffer.from([0xfe, 0]));
  expect(await getChangedFilesSinceSnapshot(workspace.projectDir, workspace.snapshot)).toEqual([
    'asset.bin',
  ]);
});

async function resume(projectDir: string, savedState: WorkflowState) {
  const prepared = makePreparedExecution({
    projectDir,
    sessionId,
    feature: 'feat',
    config,
    resumeState: savedState,
  });
  return initializeWorkflow({
    opts: {
      prepared,
      savedState,
      callbacks: makeCallbacks().callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner(),
      _implementer: makeImplementer(),
    },
    config,
    sessionId,
    savedState,
    summaryBase: {
      projectDir,
      sessionId,
      feature: 'feat',
      startTime: Date.now(),
      plannerTool: 'test',
      implementerTool: 'test',
      mode: 'quick',
    },
    metadata: { plannerTool: 'test', implementerTool: 'test', mode: 'quick' },
    setTrackedState: () => {},
    resumeHolder: { messages: [] },
    isolation: createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'staged-copy',
      onFallback: () => {},
      onRetained: () => {},
    }),
  });
}

it.each([false, true])(
  'preserves post-promotion user edits through actual resume (legacy=%s)',
  async (legacy) => {
    const f = await fixture();
    control.failChmodName = 'b.ts';
    const failed = await f.run();
    expect(failed.outcome).toBe('error');
    writeFileSync(join(f.projectDir, 'a.ts'), 'user edit after promotion\n');
    control.failChmodName = '';
    control.statusFiles = ['a.ts'];
    const state = { ...failed.state };
    if (legacy) {
      delete state.pendingRecovery;
      saveState(f.ref, state);
    }
    const persisted = loadState(f.ref);
    if (persisted === null) throw new Error('missing state');
    const result = await resume(f.projectDir, persisted);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(f.projectDir, 'a.ts'), 'utf8')).toBe('user edit after promotion\n');
    if (!result.ok) return;
    if (legacy) expect(result.state.tasks[0]?.status).toBe('pending');
    else {
      expect(result.state.pendingRecovery?.reason).toBe('approval-promotion-conflict');
      const retry = applyRecoveryAction({
        ...f.ref,
        state: result.state,
        action: 'retry-same-worker',
        bus: createEventBus(),
        config,
      });
      expect(retry.ok).toBe(true);
      expect(retry.state.tasks[0]?.status).toBe('pending');
      expect(retry.state.pendingRecovery).toBeUndefined();
    }
    expect((await captureAcquisitionBaseline(f.projectDir)).get('a.ts')?.sha256).toBe(
      sha256Hex('user edit after promotion\n'),
    );
    expect(readEvidenceLedger(f.ref)?.tasks[0]?.promotionAttempts).toHaveLength(1);
  },
);

it('refuses a binary rollback if a user changed bytes during approval', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'asset.bin'), Buffer.from([0xff, 0]));
  const expected = new Map([['asset.bin', await readConfinedEntry(root, 'asset.bin')]]);
  writeFileSync(join(root, 'asset.bin'), Buffer.from([0xfe, 0]));
  const result = await restoreDirtyFilesFromSnapshot(
    root,
    { head: 'fake', files: ['asset.bin'], dirtyFileContents: { 'asset.bin': 'old' } },
    ['asset.bin'],
    {},
    expected,
  );
  expect(result.conflictedFiles).toEqual(['asset.bin']);
  expect(readFileSync(join(root, 'asset.bin'))).toEqual(Buffer.from([0xfe, 0]));
});
