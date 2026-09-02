import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, runCommandInTest } from '#testing/helpers/runtime-commands.js';

describe('/handoff command', () => {
  it('appears in catalog with validScreens including workflow and summary', () => {
    const commands = createRuntimeCommands(makeCtx());
    const cmd = commands.find((c) => c.name === '/handoff');
    expect(cmd).toBeDefined();
    expect(cmd?.validScreens).toContain('workflow');
    expect(cmd?.validScreens).toContain('summary');
  });

  it('shows a usage hint when no args given', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    runCommandInTest({ commands: commands, raw: '/handoff', screen: 'workflow', onError: noop });
    expect(error).toMatch(/usage/i);
  });

  it('reports valid targets for an unknown target', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    runCommandInTest({
      commands: commands,
      raw: '/handoff unknown-target',
      screen: 'workflow',
      onError: noop,
    });
    expect(error).toMatch(/valid/i);
    expect(error).toContain('spec-kit');
  });

  it.each([
    ['/handoff spec-kit', { target: 'spec-kit', taskId: undefined }],
    ['/handoff claude-code T003', { target: 'claude-code', taskId: 'T003' }],
  ])('forwards %s to writeHandoff', async (raw, expected) => {
    const calls: Array<{ target: string; taskId: string | undefined }> = [];
    const commands = createRuntimeCommands(
      makeCtx({
        writeHandoff: async (target, taskId) => {
          calls.push({ target, taskId });
          return { outputDir: '/fake' };
        },
      }),
    );
    await runCommandInTest({ commands: commands, raw: raw, screen: 'workflow', onError: noop });
    expect(calls).toEqual([expected]);
  });

  it('reports the output path on success', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        writeHandoff: async () => ({
          outputDir: '/proj/.splitbrief/sessions/s1/handoffs/spec-kit',
        }),
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );
    await runCommandInTest({
      commands: commands,
      raw: '/handoff spec-kit',
      screen: 'workflow',
      onError: noop,
    });
    expect(message).toContain('/proj/.splitbrief/sessions/s1/handoffs/spec-kit');
  });

  it('surfaces an error when the handoff fails', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        writeHandoff: async () => {
          throw new Error('No active session for handoff');
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await runCommandInTest({
      commands: commands,
      raw: '/handoff spec-kit',
      screen: 'workflow',
      onError: noop,
    });
    expect(error).toContain('No active session for handoff');
  });
});

describe('/export command', () => {
  it('appears in catalog for workflow and summary screens', () => {
    const commands = createRuntimeCommands(makeCtx());
    const command = commands.find((c) => c.name === '/export');
    expect(command).toBeDefined();
    expect(command?.validScreens).toEqual(['workflow', 'summary']);
  });

  it('exports the session and reports the output path', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        exportSession: async () => ({
          status: 'ok',
          path: '/proj/.splitbrief/sessions/s1/report.html',
        }),
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );

    await runCommandInTest({
      commands: commands,
      raw: '/export',
      screen: 'workflow',
      onError: noop,
    });

    expect(message).toContain('/proj/.splitbrief/sessions/s1/report.html');
  });

  it('surfaces export errors from the context', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        exportSession: async () => ({
          status: 'error',
          error: 'No summary.json found for session',
        }),
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );

    await runCommandInTest({
      commands: commands,
      raw: '/export',
      screen: 'summary',
      onError: noop,
    });

    expect(error).toContain('No summary.json found for session');
  });
});

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
    runCommandInTest({ commands: commands, raw: '/reject-run', screen: 'workflow', onError: noop });
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
