import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';
import type { ScrollCommandTarget } from './types.js';

type RewindCall = { target: string; comment: string | undefined };
type RedoCall = { taskId: string };

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
    executeRuntimeCommand(commands, '/refresh', 'home', noop);
    // /refresh chains an async: we wait a microtask for the promise chain to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

describe('/revise-spec command', () => {
  it('forwards target=spec and the trimmed comment to the engine', () => {
    const rewinds: RewindCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (target, comment) => {
          rewinds.push({ target, comment });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    executeRuntimeCommand(
      commands,
      '/revise-spec needs more detail',
      'workflow',
      noop,
      'implementing',
    );
    expect(rewinds).toEqual([{ target: 'spec', comment: 'needs more detail' }]);
  });

  it('forwards target=spec with no comment when none is given', () => {
    const rewinds: RewindCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (target, comment) => {
          rewinds.push({ target, comment });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    executeRuntimeCommand(commands, '/revise-spec', 'workflow', noop, 'implementing');
    expect(rewinds).toEqual([{ target: 'spec', comment: undefined }]);
  });

  it('does NOT call the engine and surfaces a guard error when phase is too early', () => {
    const rewinds: RewindCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (t, c) => {
          rewinds.push({ target: t, comment: c });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'researching',
      }),
    );
    executeRuntimeCommand(
      commands,
      '/revise-spec',
      'workflow',
      (m) => {
        error = m;
      },
      'researching',
    );
    expect(rewinds).toEqual([]);
    expect(error).toMatch(/only available|not available|cannot/i);
  });

  it('surfaces a guard error when the engine rejects the rewind', () => {
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: () => false,
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    executeRuntimeCommand(commands, '/revise-spec', 'workflow', noop, 'implementing');
    expect(error).toMatch(/cannot rewind|no active/i);
  });
});

describe('/revise-plan command', () => {
  it('forwards target=plan and the trimmed comment to the engine', () => {
    const rewinds: RewindCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (t, c) => {
          rewinds.push({ target: t, comment: c });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    executeRuntimeCommand(
      commands,
      '/revise-plan too many tasks',
      'workflow',
      noop,
      'implementing',
    );
    expect(rewinds).toEqual([{ target: 'plan', comment: 'too many tasks' }]);
  });

  it('does NOT call the engine and surfaces a guard error when phase is too early', () => {
    const rewinds: RewindCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestRewind: (t, c) => {
          rewinds.push({ target: t, comment: c });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'specifying',
      }),
    );
    executeRuntimeCommand(
      commands,
      '/revise-plan',
      'workflow',
      (m) => {
        error = m;
      },
      'specifying',
    );
    expect(rewinds).toEqual([]);
    expect(error).toMatch(/only available|not available|cannot/i);
  });
});

describe('/redo-task command', () => {
  it('forwards the task ID to the engine', () => {
    const redos: RedoCall[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        requestTaskRedo: (id) => {
          redos.push({ taskId: id });
          return true;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    executeRuntimeCommand(commands, '/redo-task T001', 'workflow', noop, 'implementing');
    expect(redos).toEqual([{ taskId: 'T001' }]);
  });

  it('does NOT call the engine and surfaces a usage error when no task ID is given', () => {
    const redos: RedoCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestTaskRedo: (id) => {
          redos.push({ taskId: id });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'implementing',
      }),
    );
    executeRuntimeCommand(commands, '/redo-task', 'workflow', noop, 'implementing');
    expect(redos).toEqual([]);
    expect(error).toMatch(/task id/i);
  });

  it('does NOT call the engine and surfaces a guard error when phase does not allow redo', () => {
    const redos: RedoCall[] = [];
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        requestTaskRedo: (id) => {
          redos.push({ taskId: id });
          return true;
        },
        setFeedbackError: (m) => {
          error = m;
        },
        getCurrentPhase: () => 'planning',
      }),
    );
    executeRuntimeCommand(
      commands,
      '/redo-task T001',
      'workflow',
      (m) => {
        error = m;
      },
      'planning',
    );
    expect(redos).toEqual([]);
    expect(error).toMatch(/only available|not available/i);
  });
});

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

    executeRuntimeCommand(commands, raw, 'workflow', noop);

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

    executeRuntimeCommand(commands, '/scroll', 'workflow', noop);

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

    executeRuntimeCommand(commands, '/scroll sideways', 'workflow', noop);

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

    executeRuntimeCommand(commands, '/scroll top', 'workflow', noop);

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

    executeRuntimeCommand(commands, '/activity', 'workflow', noop);

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

    executeRuntimeCommand(commands, '/activity', 'workflow', noop);

    expect(error).toBe('No expandable activity batch is available.');
  });

  it('labels scroll and activity commands for palette and help surfaces', () => {
    const commands = createRuntimeCommands(makeCtx());

    expect(commands.find((command) => command.name === '/scroll')?.label).toBe('Scroll');
    expect(commands.find((command) => command.name === '/activity')?.label).toBe('Activity');
  });
});

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
    executeRuntimeCommand(commands, '/repomap rebuild', 'home', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
    executeRuntimeCommand(commands, '/repomap rebuild', 'home', noop);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
