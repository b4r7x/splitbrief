import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, runCommandInTest } from '#testing/helpers/runtime-commands.js';

describe('run snapshot runtime commands', () => {
  it('accepts the current run and surfaces the snapshot id', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        acceptRun: async () => ({
          status: 'snapshot-accepted',
          snapshotId: 'snap-1',
          isFirstSnapshot: false,
        }),
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );
    await runCommandInTest({
      commands: commands,
      raw: '/run accept',
      screen: 'workflow',
      onError: noop,
    });
    expect(message).toContain('snap-1');
  });

  it('requires explicit confirmation before rejecting a run', () => {
    let called = false;
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        rejectRun: async () => {
          called = true;
          return { status: 'empty' };
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    runCommandInTest({ commands: commands, raw: '/run reject', screen: 'workflow', onError: noop });
    expect(called).toBe(false);
    expect(error).toMatch(/confirm/i);
  });

  it('rejects the current run and reports changed files', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        rejectRun: async () => ({
          status: 'rejected',
          snapshotId: 'snap-2',
          restoredPaths: ['src/a.ts'],
          deletedPaths: ['src/b.ts'],
          conflictedPaths: [],
          missingSnapshotFiles: [],
        }),
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );
    await runCommandInTest({
      commands: commands,
      raw: '/run reject confirm',
      screen: 'workflow',
      onError: noop,
    });
    expect(message).toContain('2 file(s)');
    expect(message).toContain('snap-2');
  });

  it('blocks run rejection while the workflow is live', async () => {
    let called = false;
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        getCurrentPhase: () => 'implementing',
        rejectRun: async () => {
          called = true;
          return { status: 'empty' };
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );

    await runCommandInTest({
      commands: commands,
      raw: '/run reject confirm',
      screen: 'workflow',
      phase: 'implementing',
      onError: noop,
    });

    expect(called).toBe(false);
    expect(error).toMatch(/unavailable while work is active/i);
  });

  it('surfaces conflicts as an error when rejecting a run', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        rejectRun: async () => ({
          status: 'rejected',
          snapshotId: 'snap-3',
          restoredPaths: [],
          deletedPaths: [],
          conflictedPaths: ['src/a.ts'],
          missingSnapshotFiles: [],
        }),
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await runCommandInTest({
      commands: commands,
      raw: '/run reject confirm',
      screen: 'workflow',
      onError: noop,
    });
    expect(error).toMatch(/conflict/i);
  });

  it('reports the files Apply wrote on a workspace run', async () => {
    let message: string | undefined;
    let refreshed = false;
    const commands = createRuntimeCommands(
      makeCtx({
        acceptRun: async () => ({ status: 'applied', files: ['src/a.ts', 'src/b.ts'] }),
        refreshRun: () => {
          refreshed = true;
        },
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );
    await runCommandInTest({ commands, raw: '/run accept', screen: 'workflow', onError: noop });
    expect(message).toBe('Applied 2 files to your checkout.');
    expect(refreshed).toBe(true);
  });

  it('points a halted Apply at the recovery menu', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        acceptRun: async () => ({ status: 'halted' }),
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await runCommandInTest({ commands, raw: '/run accept', screen: 'workflow', onError: noop });
    expect(error).toMatch(/recovery menu/i);
  });

  it('names the open findings of a run accepted as is and applies only on confirm', async () => {
    const calls: boolean[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        acceptRun: async (confirm) => {
          calls.push(confirm);
          return confirm
            ? { status: 'applied', files: ['src/a.ts'] }
            : { status: 'confirm-override', findings: ['src/a.ts drops the error'] };
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await runCommandInTest({ commands, raw: '/run accept', screen: 'workflow', onError: noop });
    expect(error).toContain('src/a.ts drops the error');
    expect(error).toContain('/run accept confirm');
    expect(error).not.toMatch(/passed/i);
    await runCommandInTest({
      commands,
      raw: '/run accept confirm',
      screen: 'workflow',
      onError: noop,
    });
    expect(calls).toEqual([false, true]);
  });

  it('sends a changed candidate back to its checks and review', async () => {
    let message: string | undefined;
    let refreshed = false;
    const commands = createRuntimeCommands(
      makeCtx({
        acceptRun: async () => ({ status: 'review' }),
        refreshRun: () => {
          refreshed = true;
        },
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );
    await runCommandInTest({ commands, raw: '/run accept', screen: 'workflow', onError: noop });
    expect(message).toMatch(/checks and review again/);
    expect(refreshed).toBe(true);
  });

  it('surfaces why a run cannot be accepted', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        acceptRun: async () => ({ status: 'unavailable', message: 'Run already applied.' }),
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await runCommandInTest({ commands, raw: '/run accept', screen: 'workflow', onError: noop });
    expect(error).toBe('Run already applied.');
  });

  it('reports a discarded run and where its changes are kept', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        rejectRun: async () => ({ status: 'discarded' }),
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );
    await runCommandInTest({
      commands,
      raw: '/run reject confirm',
      screen: 'workflow',
      onError: noop,
    });
    expect(message).toMatch(/discarded/i);
    expect(message).toContain('run.patch');
  });

  it('reports an undone Apply and names the files left as the user changed them', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        rejectRun: async () => ({
          status: 'undone',
          restored: ['src/a.ts'],
          unchanged: [],
          conflicts: ['src/b.ts'],
        }),
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await runCommandInTest({
      commands,
      raw: '/run reject confirm',
      screen: 'workflow',
      onError: noop,
    });
    expect(error).toBe('Apply undone: put back 1 file; left as you changed them: src/b.ts.');
  });

  it('reports a clean undo as a message', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        rejectRun: async () => ({
          status: 'undone',
          restored: ['src/a.ts', 'src/b.ts'],
          unchanged: [],
          conflicts: [],
        }),
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );
    await runCommandInTest({
      commands,
      raw: '/run reject confirm',
      screen: 'workflow',
      onError: noop,
    });
    expect(message).toBe('Apply undone: put back 2 files.');
  });
});
