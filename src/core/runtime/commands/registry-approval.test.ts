import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, runCommandInTest } from '#testing/helpers/runtime-commands.js';

describe('/approval command', () => {
  it('lists sticky approval grants from the context', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        listApprovals: () => [
          { pattern: 'src/**', class: 'write_in_scope', scope: 'always', grantedAt: '0' },
        ],
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );

    await runCommandInTest({
      commands: commands,
      raw: '/approval list',
      screen: 'workflow',
      onError: noop,
    });

    expect(message).toMatch(/src\/\*\* \(write_in_scope, always\)/);
  });

  it('clears grants and reports the cleared count', async () => {
    let cleared = false;
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        clearApprovals: () => {
          cleared = true;
          return 2;
        },
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );

    await runCommandInTest({
      commands: commands,
      raw: '/approval clear',
      screen: 'workflow',
      onError: noop,
    });

    expect(cleared).toBe(true);
    expect(message).toMatch(/Cleared 2 approval grant/i);
  });

  it('rejects unknown approval subcommands', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );

    await runCommandInTest({
      commands: commands,
      raw: '/approval purge',
      screen: 'workflow',
      onError: noop,
    });

    expect(error).toMatch(/Unknown approval command/i);
  });
});
