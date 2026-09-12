import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, runCommandInTest } from '#testing/helpers/runtime-commands.js';

describe('run snapshot runtime commands', () => {
  it('accepts the current run and surfaces the snapshot id', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        acceptRunSnapshot: async () => ({ snapshotId: 'snap-1', isFirstSnapshot: false }),
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
        rejectRunSnapshot: async () => {
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
        rejectRunSnapshot: async () => ({
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
        rejectRunSnapshot: async () => {
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
        rejectRunSnapshot: async () => ({
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
});
