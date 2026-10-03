import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { UserEditConflictAction } from '../../../core/schemas/enums.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { hashTaskBrief } from '../../brief-hash.js';
import type { UserEditConflict } from '../../events/workflow-events.js';
import { captureChangedFilesBaseline } from '../changed-files-baseline.js';
import { checkUserEditConflicts } from './detection.js';

let projectDir: string;

/** The ledger's record that a promotion of `task` left `content` in `file`. */
function recordPromotion({
  task,
  file,
  content,
}: {
  task: ReturnType<typeof makeTask>;
  file: string;
  content: string;
}): void {
  const ledger = createEvidenceLedger({
    sessionId: 'sess-detection',
    feature: 'feat',
    tasks: [task],
  });
  writeEvidenceLedger(
    { projectDir, sessionId: 'sess-detection' },
    {
      ...ledger,
      tasks: ledger.tasks.map((entry) => ({
        ...entry,
        promotedBriefHash: hashTaskBrief([task]),
        promotedFiles: [{ path: file, sha256: sha256Hex(content), mode: 0o644 }],
      })),
    },
  );
}

beforeEach(() => {
  projectDir = createTempDir('user-edit-detection');
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

async function runCheck(opts: {
  tasks: ReturnType<typeof makeTask>[];
  baseline: Awaited<ReturnType<typeof captureChangedFilesBaseline>>;
  onUserEditConflict?:
    | ((conflict: UserEditConflict) => Promise<UserEditConflictAction>)
    | undefined;
}) {
  ensureSessionDir(projectDir, 'sess-detection');
  const task = opts.tasks[0];
  if (!task) throw new Error('checkUserEditConflicts needs at least one task');
  const state = makeImplState(opts.tasks);
  const callbacks = makeCallbacks(
    opts.onUserEditConflict ? { onUserEditConflict: opts.onUserEditConflict } : undefined,
  );
  const { bus, events } = makeBusRecorder();
  const acknowledgedUserEditFiles = new Set<string>();
  const result = await checkUserEditConflicts({
    projectDir,
    sessionId: 'sess-detection',
    callbacks: callbacks.callbacks,
    bus,
    state,
    task,
    taskIndex: 0,
    baseline: opts.baseline,
    acknowledgedUserEditFiles,
    setTrackedState: vi.fn(),
  });
  return { result, events, acknowledgedUserEditFiles };
}

describe('checkUserEditConflicts', () => {
  it('warns and lets the task proceed when the changed-file scan cannot run', async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1' });
    const task = makeTask({ id: 'T001', file: 'src/current.ts' });
    const escapingBaseline = {
      head: null,
      fingerprints: new Map([['../escape.ts', 'stale-hash']]),
    };

    const { result, events } = await runCheck({
      tasks: [task],
      baseline: escapingBaseline,
    });

    expect(result.stopped).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(events.find((event) => event.type === 'warning')).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('Failed to check user edit conflicts'),
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('takes an edit to the file of a brief that has not started as its stale input', async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1' });
    const task = makeTask({ id: 'T001', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, 'src/current.ts'), 'user edit');

    const { result, events, acknowledgedUserEditFiles } = await runCheck({
      tasks: [task],
      baseline,
    });

    expect(result.stopped).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.absorbedFiles).toEqual(['src/current.ts']);
    expect(acknowledgedUserEditFiles.has('src/current.ts')).toBe(true);
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'continue-unrelated',
      conflict: {
        kind: 'future-task-stale-input',
        files: ['src/current.ts'],
        affectedTaskIds: ['T001'],
      },
    });
  });

  it('continues and acknowledges an unrelated edit', async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1', 'notes.txt': 'note' });
    const task = makeTask({ id: 'T001', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, 'notes.txt'), 'user edit');

    const { result, acknowledgedUserEditFiles } = await runCheck({
      tasks: [task],
      baseline,
    });

    expect(result.stopped).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(acknowledgedUserEditFiles.has('notes.txt')).toBe(true);
  });

  it('falls back to pausing when the conflict prompt rejects', async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1', 'src/future.ts': 'v1' });
    const first = makeTask({ id: 'T001', file: 'src/current.ts' });
    const second = makeTask({ id: 'T002', action: 'modify', file: 'src/future.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, 'src/future.ts'), 'user edit');
    const onUserEditConflict = vi.fn().mockRejectedValue(new Error('prompt UI crashed'));

    const { result, events } = await runCheck({
      tasks: [first, second],
      baseline,
      onUserEditConflict,
    });

    expect(onUserEditConflict).toHaveBeenCalled();
    expect(result.stopped).toBe(true);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      files: ['src/future.ts'],
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'future-task-stale-input',
        files: ['src/future.ts'],
      },
    });
  });

  it("keeps a parked brief's own output and classifies only what it did not declare", async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1', 'notes.txt': 'note' });
    const task = makeTask({ id: 'T001', status: 'in_progress', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    recordPromotion({
      task,
      file: 'src/current.ts',
      content: 'half written by the parked attempt',
    });
    writeFileSync(join(projectDir, 'src/current.ts'), 'half written by the parked attempt');
    writeFileSync(join(projectDir, 'notes.txt'), 'user edit');

    const { result, events, acknowledgedUserEditFiles } = await runCheck({
      tasks: [task],
      baseline,
    });

    expect(result.stopped).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(acknowledgedUserEditFiles.has('src/current.ts')).toBe(true);
    expect(events.find((event) => event.type === 'warning')).toMatchObject({
      code: 'own_partial_output_kept',
      message: expect.stringContaining('src/current.ts'),
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      conflict: { kind: 'unrelated', files: ['notes.txt'] },
    });
    expect(result.absorbedFiles).toEqual(['notes.txt']);
  });

  it("asks nothing when only the parked brief's own declared files changed", async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1' });
    const task = makeTask({ id: 'T001', status: 'in_progress', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    recordPromotion({
      task,
      file: 'src/current.ts',
      content: 'half written by the parked attempt',
    });
    writeFileSync(join(projectDir, 'src/current.ts'), 'half written by the parked attempt');

    const { result, events } = await runCheck({ tasks: [task], baseline });

    expect(result.stopped).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it("asks about an edit to a parked brief's declared file that the brief never wrote", async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1' });
    const task = makeTask({ id: 'T001', status: 'in_progress', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, 'src/current.ts'), 'operator edit while the run was parked');
    const onUserEditConflict = vi.fn().mockResolvedValue('continue-unrelated');

    const { result, events, acknowledgedUserEditFiles } = await runCheck({
      tasks: [task],
      baseline,
      onUserEditConflict,
    });

    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
    expect(onUserEditConflict).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'future-task-stale-input', safeToContinue: true }),
    );
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      selectedAction: 'continue-unrelated',
      conflict: {
        kind: 'future-task-stale-input',
        files: ['src/current.ts'],
        affectedTaskIds: ['T001'],
      },
    });
    expect(result.stopped).toBe(false);
    expect(result.absorbedFiles).toEqual(['src/current.ts']);
    expect(acknowledgedUserEditFiles.has('src/current.ts')).toBe(true);
  });

  it("keeps a parked brief's own output in a file it did not declare", async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1', 'src/dep.ts': 'v1' });
    const dependency = makeTask({ id: 'T001', status: 'done', file: 'src/dep.ts' });
    const task = makeTask({
      id: 'T002',
      status: 'in_progress',
      file: 'src/current.ts',
      dependsOn: ['T001'],
    });
    const baseline = await captureChangedFilesBaseline(projectDir);
    recordPromotion({ task, file: 'src/dep.ts', content: 'promoted by the parked attempt' });
    writeFileSync(join(projectDir, 'src/dep.ts'), 'promoted by the parked attempt');

    const { result, events, acknowledgedUserEditFiles } = await runCheck({
      tasks: [task, dependency],
      baseline,
    });

    expect(result.stopped).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(acknowledgedUserEditFiles.has('src/dep.ts')).toBe(true);
    expect(events.find((event) => event.type === 'warning')).toMatchObject({
      code: 'own_partial_output_kept',
      message: expect.stringContaining('src/dep.ts'),
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('halts on an edit made over what a parked brief wrote', async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1' });
    const task = makeTask({ id: 'T001', status: 'in_progress', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    recordPromotion({ task, file: 'src/current.ts', content: 'promoted by the parked attempt' });
    writeFileSync(join(projectDir, 'src/current.ts'), 'operator edit over the promoted file');

    const { result, events } = await runCheck({ tasks: [task], baseline });

    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      selectedAction: 'pause',
      conflict: {
        kind: 'current-task-conflict',
        files: ['src/current.ts'],
        affectedTaskIds: ['T001'],
      },
    });
    expect(result.stopped).toBe(true);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      files: ['src/current.ts'],
    });
  });

  it('raises no recovery issue when nothing changed since the baseline', async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1' });
    const task = makeTask({ id: 'T001', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);

    const { result, events } = await runCheck({ tasks: [task], baseline });

    expect(result.stopped).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });
});
