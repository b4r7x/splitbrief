import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { setActiveTerminalHandover } from '../../../lib/terminal/editor-handover.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import type { SpawnEditor } from '../review-parser.js';
import { showRunDiff } from './show-diff.js';

const patch = vi.hoisted(() => ({ path: '/tmp/result-run.patch' }));
vi.mock('../../../engine/orchestrator/apply/patch.js', () => ({
  writeRunPatch: vi.fn(async () => patch.path),
}));

function readyRecord() {
  return makeRunRecord({
    status: { kind: 'ready-to-apply', override: false },
    hydration: {
      kind: 'loaded',
      state: makeWorkflowState({
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'worktree',
          path: '/tmp/run-workspace',
          base: { snapshotId: 'workspace-base', head: null },
        },
      }),
    },
  });
}

describe('showRunDiff', () => {
  const terminal = {
    isRaw: true,
    paused: false,
    pause: () => {
      terminal.paused = true;
    },
    resume: () => {
      terminal.paused = false;
    },
    setRawMode: (mode: boolean) => {
      terminal.isRaw = mode;
    },
  };

  beforeEach(() => {
    feedbackStore.reset();
    vi.stubEnv('VISUAL', 'mock-editor --wait');
    terminal.isRaw = true;
    terminal.paused = false;
    setActiveTerminalHandover({ fullscreen: false, mouse: false, sourceStdin: terminal });
  });

  afterEach(() => {
    setActiveTerminalHandover(undefined);
    feedbackStore.reset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { editor: 'mock-editor --wait', instruction: 'Close the file to return.' },
    { editor: '/usr/bin/open -W -t', instruction: 'Quit the editor app to return.' },
    { editor: '/usr/bin/open --wait-apps -t', instruction: 'Quit the editor app to return.' },
  ])('shows the return instruction for $editor while it waits', async ({ editor, instruction }) => {
    vi.stubEnv('VISUAL', editor);
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const child = new EventEmitter();
    const started = Promise.withResolvers<void>();
    const editing = showRunDiff(readyRecord(), () => {
      started.resolve();
      return child;
    });
    try {
      await started.promise;
      expect(terminal).toMatchObject({ isRaw: false, paused: true });
      expect(output.join('')).toContain(instruction);
      expect(output.join('')).toContain('result-run.patch open in');
    } finally {
      child.emit('close', 0, null);
      await editing;
    }
    expect(terminal).toMatchObject({ isRaw: true, paused: false });
  });

  it('opens the written patch in the editor and restores the terminal', async () => {
    const child = new EventEmitter();
    const spawnEditor = vi.fn<SpawnEditor>(() => {
      expect(terminal).toMatchObject({ isRaw: false, paused: true });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });

    await showRunDiff(readyRecord(), spawnEditor);

    expect(spawnEditor).toHaveBeenCalledWith('mock-editor', ['--wait', patch.path]);
    expect(feedbackStore.get().isError).toBe(false);
    expect(terminal).toMatchObject({ isRaw: true, paused: false });
  });

  it.each([
    { code: 1, signal: null, message: 'Editor exited with code 1' },
    { code: null, signal: 'SIGTERM', message: 'Editor exited with SIGTERM' },
  ] satisfies { code: number | null; signal: NodeJS.Signals | null; message: string }[])(
    'reports $message and restores the terminal',
    async ({ code, signal, message }) => {
      const child = new EventEmitter();
      const spawnEditor: SpawnEditor = () => {
        queueMicrotask(() => child.emit('close', code, signal));
        return child;
      };

      await showRunDiff(readyRecord(), spawnEditor);

      expect(feedbackStore.get()).toEqual({ message, isError: true });
      expect(terminal).toMatchObject({ isRaw: true, paused: false });
    },
  );

  it('reports a record without a workspace', async () => {
    const record = makeRunRecord({
      hydration: { kind: 'loaded', state: makeWorkflowState() },
    });
    const spawnEditor = vi.fn<SpawnEditor>();

    await showRunDiff(record, spawnEditor);

    expect(feedbackStore.get()).toEqual({ message: 'No run workspace to diff.', isError: true });
    expect(spawnEditor).not.toHaveBeenCalled();
  });
});
