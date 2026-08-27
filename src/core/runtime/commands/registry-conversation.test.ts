import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, runCommandInTest } from '#testing/helpers/runtime-commands.js';
import type { ScrollCommandTarget } from './types.js';

describe('/scroll command', () => {
  const cases: Array<[string, ScrollCommandTarget, RegExp]> = [
    ['/scroll top', 'top', /to top/i],
    ['/scroll bottom', 'bottom', /to bottom/i],
    ['/scroll page-up', 'page-up', /up one page/i],
    ['/scroll page-down', 'page-down', /down one page/i],
  ];

  it.each(cases)('forwards %s to the command context', (raw, target, feedbackPattern) => {
    const targets: ScrollCommandTarget[] = [];
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        scrollConversation: (nextTarget) => {
          targets.push(nextTarget);
          return { status: 'scrolled' };
        },
        setFeedbackMessage: (message) => {
          feedback = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: raw, screen: 'workflow', onError: noop });

    expect(targets).toEqual([target]);
    expect(feedback).toMatch(feedbackPattern);
  });

  it('surfaces usage when no target is provided', () => {
    const targets: ScrollCommandTarget[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        scrollConversation: (target) => {
          targets.push(target);
          return { status: 'scrolled' };
        },
        setFeedbackError: (message) => {
          error = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: '/scroll', screen: 'workflow', onError: noop });

    expect(targets).toEqual([]);
    expect(error).toMatch(/usage: \/scroll <top\|bottom\|page-up\|page-down>/i);
  });

  it('rejects unknown targets before calling the command context', () => {
    const targets: ScrollCommandTarget[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        scrollConversation: (target) => {
          targets.push(target);
          return { status: 'scrolled' };
        },
        setFeedbackError: (message) => {
          error = message;
        },
      }),
    );

    runCommandInTest({
      commands: commands,
      raw: '/scroll sideways',
      screen: 'workflow',
      onError: noop,
    });

    expect(targets).toEqual([]);
    expect(error).toMatch(/invalid scroll target: sideways/i);
  });

  it('surfaces unavailable feedback from non-UI contexts', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        scrollConversation: () => ({
          status: 'unavailable',
          message: 'Conversation scrolling is not available here.',
        }),
        setFeedbackError: (message) => {
          error = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: '/scroll top', screen: 'workflow', onError: noop });

    expect(error).toBe('Conversation scrolling is not available here.');
  });
});

describe('/activity command', () => {
  it('toggles the latest activity batch through the command context', () => {
    let toggled = false;
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        toggleLatestActivityBatch: () => {
          toggled = true;
          return { status: 'toggled', expanded: true };
        },
        setFeedbackMessage: (message) => {
          feedback = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: '/activity', screen: 'workflow', onError: noop });

    expect(toggled).toBe(true);
    expect(feedback).toMatch(/expanded latest activity batch/i);
  });

  it('reports when no expandable activity batch exists', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        toggleLatestActivityBatch: () => ({
          status: 'unavailable',
          message: 'No expandable activity batch is available.',
        }),
        setFeedbackError: (message) => {
          error = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: '/activity', screen: 'workflow', onError: noop });

    expect(error).toBe('No expandable activity batch is available.');
  });

  it('labels scroll and activity commands for palette and help surfaces', () => {
    const commands = createRuntimeCommands(makeCtx());

    expect(commands.find((command) => command.name === '/scroll')?.label).toBe('scroll');
    expect(commands.find((command) => command.name === '/activity')?.label).toBe('activity');
    expect(commands.find((command) => command.name === '/activity')?.shortcut).toBe(
      '/activity, ctrl+a',
    );
  });
});

describe('/queue command', () => {
  it('shows the pending queue depth', () => {
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        getQueueDepth: () => 2,
        setFeedbackMessage: (message) => {
          feedback = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: '/queue show', screen: 'workflow', onError: noop });

    expect(feedback).toBe('Queue: 2 messages pending');
  });

  it('clears pending queue messages', async () => {
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        clearQueue: () => ({ status: 'cleared', count: 3 }),
        setFeedbackMessage: (message) => {
          feedback = message;
        },
      }),
    );

    await runCommandInTest({
      commands: commands,
      raw: '/queue clear',
      screen: 'workflow',
      onError: noop,
    });

    expect(feedback).toBe('Cleared 3 queued messages');
  });

  it('surfaces unknown queue subcommands before clearing', () => {
    let error: string | undefined;
    let cleared = false;
    const commands = createRuntimeCommands(
      makeCtx({
        clearQueue: () => {
          cleared = true;
          return { status: 'cleared', count: 1 };
        },
        setFeedbackError: (message) => {
          error = message;
        },
      }),
    );

    runCommandInTest({
      commands: commands,
      raw: '/queue purge',
      screen: 'workflow',
      onError: noop,
    });

    expect(cleared).toBe(false);
    expect(error).toBe('Unknown queue command: purge. Use: /queue show or /queue clear');
  });
});

describe('/sidebar command', () => {
  it('toggles the workflow sidebar through the command context', () => {
    let visible = false;
    let feedback: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        toggleSidebar: () => {
          visible = !visible;
          return { status: 'toggled', visible };
        },
        setFeedbackMessage: (message) => {
          feedback = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: '/sidebar', screen: 'workflow', onError: noop });
    expect(visible).toBe(true);
    expect(feedback).toBe('Sidebar shown');

    runCommandInTest({ commands: commands, raw: '/sidebar', screen: 'workflow', onError: noop });
    expect(visible).toBe(false);
    expect(feedback).toBe('Sidebar hidden');
  });

  it('surfaces unavailable sidebar feedback from non-UI contexts', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        toggleSidebar: () => ({
          status: 'unavailable',
          message: 'Sidebar is not available here.',
        }),
        setFeedbackError: (message) => {
          error = message;
        },
      }),
    );

    runCommandInTest({ commands: commands, raw: '/sidebar', screen: 'workflow', onError: noop });

    expect(error).toBe('Sidebar is not available here.');
  });

  it('labels sidebar for palette and help surfaces without claiming a shortcut', () => {
    const command = createRuntimeCommands(makeCtx()).find((entry) => entry.name === '/sidebar');

    expect(command).toMatchObject({
      label: 'sidebar',
      description: 'Show or hide workflow sidebar',
      validScreens: ['workflow'],
    });
    expect(command?.shortcut).toBeUndefined();
  });
});
