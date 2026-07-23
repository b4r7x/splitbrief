import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';

describe('/mode command', () => {
  it('opens mode-selector overlay when called without args', () => {
    let openedOverlay: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type) => {
          openedOverlay = type;
        },
      }),
    );
    executeRuntimeCommand(commands, '/mode', 'home', noop);
    expect(openedOverlay).toBe('mode-selector');
  });

  it('sets mode to quick without opening the overlay', () => {
    let savedMode: string | undefined;
    let feedback: string | undefined;
    let openedOverlay: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type) => {
          openedOverlay = type;
        },
        setWorkflowMode: (m) => {
          savedMode = m;
          return true;
        },
        setFeedbackMessage: (m) => {
          feedback = m;
        },
      }),
    );
    executeRuntimeCommand(commands, '/mode quick', 'home', noop);
    expect(savedMode).toBe('quick');
    expect(feedback).toMatch(/quick/);
    expect(openedOverlay).toBeUndefined();
  });

  it('sets mode to speckit', () => {
    let savedMode: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setWorkflowMode: (m) => {
          savedMode = m;
          return true;
        },
      }),
    );
    executeRuntimeCommand(commands, '/mode speckit', 'home', noop);
    expect(savedMode).toBe('speckit');
  });

  it('does not show success feedback when setWorkflowMode reports failure', () => {
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setWorkflowMode: () => false,
        setFeedbackMessage: (m) => {
          feedback = m;
        },
      }),
    );
    executeRuntimeCommand(commands, '/mode quick', 'home', noop);
    expect(feedback).toBeUndefined();
  });

  it('rejects invalid mode and surfaces an error', () => {
    let savedMode: string | undefined;
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setWorkflowMode: (m) => {
          savedMode = m;
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    executeRuntimeCommand(commands, '/mode turbo', 'home', noop);
    expect(savedMode).toBeUndefined();
    expect(error).toMatch(/invalid/i);
  });
});

describe('/refresh command', () => {
  it('runs detection and surfaces a status message to the user', async () => {
    let refreshRan = false;
    const messages: string[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        refreshDetection: async () => {
          refreshRan = true;
        },
        setFeedbackMessage: (m) => {
          messages.push(m);
        },
      }),
    );
    await executeRuntimeCommand(commands, '/refresh', 'home', noop);
    expect(refreshRan).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe('/planner command', () => {
  it('opens the planner-picker overlay', () => {
    let openedOverlay: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type) => {
          openedOverlay = type;
        },
      }),
    );
    executeRuntimeCommand(commands, '/planner', 'home', noop);
    expect(openedOverlay).toBe('planner-picker');
  });
});
