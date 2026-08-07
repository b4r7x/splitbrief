import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { UserEditConflictAction } from '../../../core/schemas/enums.js';
import type { UserEditConflict } from '../../events/workflow-events.js';
import { captureChangedFilesBaseline } from '../changed-files-baseline.js';
import { checkUserEditConflicts } from './detection.js';

let projectDir: string;

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

  it('pauses with an issue naming the file when the current task file was edited', async () => {
    createTestGitRepo(projectDir, { 'src/current.ts': 'v1' });
    const task = makeTask({ id: 'T001', file: 'src/current.ts' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, 'src/current.ts'), 'user edit');

    const { result, events } = await runCheck({ tasks: [task], baseline });

    expect(result.stopped).toBe(true);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T001',
      files: ['src/current.ts'],
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'pause',
      conflict: {
        kind: 'current-task-conflict',
        files: ['src/current.ts'],
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
