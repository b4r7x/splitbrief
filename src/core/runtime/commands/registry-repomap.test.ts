import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';

describe('/repomap rebuild command', () => {
  it('surfaces a success message when the repomap cache was present', async () => {
    const messages: string[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        rebuildRepomap: async () => ({ deleted: true, files: ['/proj/.diptych/repomap.sqlite'] }),
        setFeedbackMessage: (m) => {
          messages.push(m);
        },
      }),
    );
    await executeRuntimeCommand(commands, '/repomap rebuild', 'home', noop);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/cleared/i);
  });

  it('surfaces a not-present message when no repomap cache exists', async () => {
    const messages: string[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        rebuildRepomap: async () => ({ deleted: false, files: [] }),
        setFeedbackMessage: (m) => {
          messages.push(m);
        },
      }),
    );
    await executeRuntimeCommand(commands, '/repomap rebuild', 'home', noop);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/not present/i);
  });

  it('surfaces a usage error for unknown sub-commands', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    executeRuntimeCommand(commands, '/repomap purge', 'home', noop);
    expect(error).toMatch(/unknown repomap/i);
  });

  it('surfaces a usage error when called with no sub-command', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    executeRuntimeCommand(commands, '/repomap', 'home', noop);
    expect(error).toMatch(/unknown repomap/i);
  });
});
