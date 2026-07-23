import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';

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

    await executeRuntimeCommand(commands, '/approval list', 'workflow', noop);

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

    await executeRuntimeCommand(commands, '/approval clear', 'workflow', noop);

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

    await executeRuntimeCommand(commands, '/approval purge', 'workflow', noop);

    expect(error).toMatch(/Unknown approval command/i);
  });
});

describe('/yolo command', () => {
  it('/yolo toggles approval enabled state', () => {
    let approvalEnabled = true;
    let feedback: string | undefined;
    const ctx = makeCtx({
      getApprovalEnabled: () => approvalEnabled,
      setApprovalEnabled: (value) => {
        approvalEnabled = value;
      },
      setFeedbackMessage: (message) => {
        feedback = message;
      },
    });
    const commands = createRuntimeCommands(ctx);
    const yolo = commands.find((command) => command.name === '/yolo');
    if (!yolo) throw new Error('Expected /yolo command');
    if (yolo.kind !== 'noarg') throw new Error('Expected /yolo to be a noarg command');

    yolo.handler();
    expect(approvalEnabled).toBe(false);
    expect(feedback).toMatch(/ON|enabled|disabled/i);

    yolo.handler();
    expect(approvalEnabled).toBe(true);
    expect(feedback).toMatch(/OFF|restored/i);
  });
});
