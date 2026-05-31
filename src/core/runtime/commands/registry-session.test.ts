import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';

describe('/compact-transcript command', () => {
  it('appears in catalog for workflow and summary screens', () => {
    const commands = createRuntimeCommands(makeCtx());
    const command = commands.find((c) => c.name === '/compact-transcript');
    expect(command).toBeDefined();
    expect(command?.validScreens).toEqual(['workflow', 'summary']);
  });

  it('compacts the transcript and reports summarized message count', async () => {
    let message: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        compactTranscript: async () => ({
          status: 'compacted',
          summary: '## Summary\nProgress preserved',
          entriesRemoved: 12,
        }),
        setFeedbackMessage: (m) => {
          message = m;
        },
      }),
    );

    await executeRuntimeCommand(commands, '/compact-transcript', 'workflow', noop);

    expect(message).toMatch(/12 older messages summarized/i);
  });

  it('reports unsupported planners without treating it as a command failure', async () => {
    let message: string | undefined;
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        compactTranscript: async () => ({ status: 'unsupported', plannerName: 'shell' }),
        setFeedbackMessage: (m) => {
          message = m;
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );

    await executeRuntimeCommand(commands, '/compact-transcript', 'workflow', noop);

    expect(message).toMatch(/shell.*does not support transcript compaction/i);
    expect(error).toBeUndefined();
  });

  it('surfaces compaction errors from the context', async () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        compactTranscript: async () => {
          throw new Error('No active session for /compact-transcript');
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );

    await executeRuntimeCommand(commands, '/compact-transcript', 'summary', noop);

    expect(error).toContain('No active session for /compact-transcript');
  });
});
