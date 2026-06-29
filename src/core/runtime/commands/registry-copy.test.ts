import { afterEach, describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { CopyResult, CopyTarget } from './types.js';

afterEach(() => {
  resetAllStores();
});

describe('/copy command', () => {
  it('copies the given target and reports the path taken', async () => {
    let copied: CopyTarget | undefined;
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        copyTarget: async (target) => {
          copied = target;
          return 'native';
        },
        setFeedbackMessage: (m) => {
          feedback = m;
        },
      }),
    );

    await executeRuntimeCommand(commands, '/copy path', 'workflow', noop);

    expect(copied).toBe('path');
    expect(feedback).toBe('Copied (native)');
  });

  it('defaults to the last message when called without an argument', async () => {
    let copied: CopyTarget | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        copyTarget: async (target) => {
          copied = target;
          return 'osc52';
        },
      }),
    );

    await executeRuntimeCommand(commands, '/copy', 'workflow', noop);
    expect(copied).toBe('message');
  });

  it('reports nothing to copy when the target resolves empty', async () => {
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        copyTarget: async (): Promise<CopyResult> => 'empty',
        setFeedbackMessage: (m) => {
          feedback = m;
        },
      }),
    );

    await executeRuntimeCommand(commands, '/copy brief', 'workflow', noop);
    expect(feedback).toBe('Nothing to copy');
  });

  it('rejects an unknown target without copying', async () => {
    let copied = false;
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        copyTarget: async () => {
          copied = true;
          return 'native';
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );

    await executeRuntimeCommand(commands, '/copy bogus', 'workflow', noop);
    expect(copied).toBe(false);
    expect(error).toMatch(/Invalid copy target/);
  });

  it('is unavailable on the summary screen', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(makeCtx());
    await executeRuntimeCommand(commands, '/copy path', 'summary', (m) => {
      error = m;
    });
    expect(error).toMatch(/only available/);
  });

  it('is unavailable on the home screen so stale workflow stores are never read', async () => {
    let copied = false;
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        copyTarget: async () => {
          copied = true;
          return 'native';
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await executeRuntimeCommand(commands, '/copy path', 'home', (m) => {
      error = m;
    });
    expect(copied).toBe(false);
    expect(error).toMatch(/only available/);
  });
});
