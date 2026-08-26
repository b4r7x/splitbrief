import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { WORKFLOW_MODES } from '../../core/schemas/enums.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { Screen } from '../../core/navigation/types.js';
import { createInitialState } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { handleSessionSelect, sessionSelectStore } from '../../stores/navigation/session-select.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { buildPaletteSources } from './sources.js';

const noop = () => {};
const noopSessionSelect = async () => {};

function buildCommandSources(
  commands: RuntimeCommandDef[],
  onRuntimeCommand: (raw: string) => void = noop,
  opts: { screen?: Screen; phase?: Phase } = {},
) {
  return buildPaletteSources({
    commands,
    screen: opts.screen ?? 'home',
    config: makeConfig(),
    phase: opts.phase ?? 'idle',
    tasks: [],
    sessions: [],
    projectDir: '/tmp/splitbrief-test',
    onRuntimeCommand,
    onSessionSelect: noopSessionSelect,
  }).commandItems;
}

function buildRegistrySources(onRuntimeCommand: (raw: string) => void = noop) {
  return buildCommandSources(createRuntimeCommands(makeCtx()), onRuntimeCommand, {
    screen: 'workflow',
    phase: 'implementing',
  });
}

describe('buildPaletteSources command items', () => {
  it('converts visible commands to palette command items', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/help',
        label: 'Help',
        description: 'Show help',
        shortcut: 'ctrl+/',
        category: 'navigate',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: '/help',
      description: 'Show help',
      shortcut: 'ctrl+/',
      category: 'navigate',
    });
  });

  it('excludes hidden commands and commands unavailable on the current screen', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/hidden',
        description: 'Hidden',
        category: 'navigate',
        hidden: true,
        validScreens: ['home'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/workflow-only',
        description: 'Workflow command',
        category: 'navigate',
        validScreens: ['workflow'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        description: 'Visible command',
        category: 'navigate',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map((item) => item.label)).toEqual(['/visible']);
  });

  it('excludes phase-guarded commands outside their valid phase', () => {
    const commands: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/redo-task',
        description: 'Reset a task',
        category: 'workflow',
        args: { kind: 'free', hint: '<task-id>' },
        validScreens: ['workflow'],
        guard: (c) => (c.phase === 'implementing' ? undefined : 'Only while implementing'),
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        description: 'Visible command',
        category: 'navigate',
        validScreens: ['workflow'],
        handler: noop,
      },
    ];

    expect(
      buildCommandSources(commands, noop, { screen: 'workflow', phase: 'planning' }).map(
        (item) => item.label,
      ),
    ).toEqual(['/visible']);
    expect(
      buildCommandSources(commands, noop, { screen: 'workflow', phase: 'implementing' }).map(
        (item) => item.label,
      ),
    ).toEqual(['/redo-task', '/visible']);
  });

  it('shows the accepted values of an argument command in its description', () => {
    const items = buildCommandSources([
      {
        kind: 'arg',
        name: '/mode',
        description: 'Workflow mode',
        category: 'crew',
        args: { kind: 'closed', options: ['instant', 'quick'], optional: true },
        validScreens: ['home'],
        handler: noop,
      },
      {
        kind: 'arg',
        name: '/redo-task',
        description: 'Reset a task',
        category: 'workflow',
        args: { kind: 'free', hint: '<task-id>' },
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map((item) => item.description)).toEqual([
      expect.stringMatching(/^Workflow mode\s+\[instant\|quick\]$/),
      expect.stringMatching(/^Reset a task\s+<task-id>$/),
    ]);
  });

  it('runs a no-argument command through the runtime command callback', () => {
    const calls: string[] = [];
    const items = buildCommandSources(
      [
        {
          kind: 'noarg',
          name: '/settings',
          description: 'Open settings',
          category: 'navigate',
          validScreens: ['home'],
          handler: noop,
        },
      ],
      (raw) => calls.push(raw),
    );

    const action = items[0]?.action;
    if (action?.kind === 'run') void action.run();

    expect(calls).toEqual(['/settings']);
  });
});

describe('buildPaletteSources registry rows', () => {
  it('gives every row a distinct slash-command label', () => {
    const labels = buildRegistrySources().map((item) => item.label);

    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.startsWith('/'))).toBe(true);
  });

  it('lists an alias as its own row that runs the command it stands for', () => {
    const calls: string[] = [];
    const items = buildRegistrySources((raw) => calls.push(raw));

    const config = items.find((item) => item.label === '/config');
    expect(config?.description).toMatch(/\/settings$/);

    const planner = items.find((item) => item.label === '/planner');
    expect(planner?.description).toMatch(/\/crew plan$/);
    if (planner?.action.kind === 'run') void planner.action.run();
    expect(calls).toEqual(['/crew plan']);
  });

  it('prefills an alias whose expansion still needs an argument and runs the ones that do not', () => {
    const calls: string[] = [];
    const items = buildRegistrySources((raw) => calls.push(raw));

    const detach = items.find((item) => item.label === '/detach');
    expect(detach?.description).toMatch(/\/image remove$/);
    expect(detach?.action).toEqual({ kind: 'prefill', text: '/image remove ' });

    const acceptRun = items.find((item) => item.label === '/accept-run');
    expect(acceptRun?.action.kind).toBe('run');
    if (acceptRun?.action.kind === 'run') void acceptRun.action.run();
    expect(calls).toEqual(['/run accept']);
  });

  it('offers one prefill row for an argument command instead of one row per option', () => {
    const items = buildRegistrySources();

    const modeRows = items.filter((item) => item.label === '/mode');
    expect(modeRows).toHaveLength(1);
    expect(modeRows[0]?.action).toEqual({ kind: 'prefill', text: '/mode ' });
    for (const mode of WORKFLOW_MODES) {
      expect(items.some((item) => item.label === mode)).toBe(false);
    }
  });
});

describe('buildPaletteSources attached-client boundary', () => {
  it('omits local config mutation sources while attached', () => {
    const sources = buildPaletteSources({
      commands: [],
      screen: 'workflow',
      config: makeConfig(),
      phase: 'implementing',
      tasks: [],
      sessions: [],
      projectDir: '/tmp/splitbrief-test',
      onRuntimeCommand: noop,
      onSessionSelect: noopSessionSelect,
      isAttached: true,
    });

    expect(sources.customItems).toEqual([]);
  });
});

describe('buildPaletteSources session items', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir('palette-session-test');
    overlayStore.reset();
    routerStore.reset();
    feedbackStore.reset();
    sessionSelectStore.reset();
  });

  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    overlayStore.reset();
    routerStore.reset();
    feedbackStore.reset();
    sessionSelectStore.reset();
  });

  it('awaits interrupted-session preparation before exposing the prepared route', async () => {
    const session = makeSession({
      id: 'sess-resume',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });
    const savedState = {
      ...createInitialState('saved add auth'),
      phase: 'implementing' as const,
    };
    saveState({ projectDir: tmp, sessionId: session.id }, savedState);

    const { sessionItems } = buildPaletteSources({
      commands: [],
      screen: 'home',
      config: makeConfig(),
      phase: 'idle',
      tasks: [],
      sessions: [session],
      projectDir: tmp,
      onRuntimeCommand: noop,
      onSessionSelect: (selected, projectDir) =>
        handleSessionSelect(selected, projectDir, {
          loadState,
          prepareResume: async ({ ref, state }) => ({
            kind: 'prepared',
            execution: prepareWorkflowExecution({
              projectDir: ref.projectDir,
              feature: state.feature,
              sessionId: ref.sessionId,
              resumeState: state,
            }),
          }),
        }),
    });

    await sessionItems[0]?.action();

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.prepared.runtime.feature).toBe('saved add auth');
      expect(route.execution.prepared.runtime.resumeState).toEqual(savedState);
      expect(route.execution.prepared.session.ref.sessionId).toBe(session.id);
    }
  });

  it('surfaces palette-triggered session selection errors through global feedback', async () => {
    const session = makeSession({
      id: 'sess-missing-state',
      feature: 'missing state',
      status: 'interrupted',
      summary: null,
    });

    const { sessionItems } = buildPaletteSources({
      commands: [],
      screen: 'home',
      config: makeConfig(),
      phase: 'idle',
      tasks: [],
      sessions: [session],
      projectDir: tmp,
      onRuntimeCommand: noop,
      onSessionSelect: (selected, projectDir) =>
        handleSessionSelect(selected, projectDir, {
          loadState,
          prepareResume: async () => {
            throw new Error('Preparation should not run without saved state');
          },
        }),
    });

    await sessionItems[0]?.action();

    expect(sessionSelectStore.get().error).toBe(
      'Cannot resume: saved workflow state is missing or invalid',
    );
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Cannot resume: saved workflow state is missing or invalid',
    });
  });
});
