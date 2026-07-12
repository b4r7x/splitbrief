import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { Screen } from '../../core/navigation/types.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { buildPaletteSources } from './sources.js';

const noop = () => {};

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
    projectDir: '/tmp/diptych-test',
    onRuntimeCommand,
    onWorkflowMode: noop,
  }).commandItems;
}

describe('buildPaletteSources command items', () => {
  it('converts labeled commands to palette command items', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/help',
        label: 'Help',
        description: 'Show help',
        shortcut: 'ctrl+/',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: '/help',
      description: 'Show help',
      shortcut: 'ctrl+/',
      availableOn: ['home'],
    });
  });

  it('excludes unlabeled commands and commands unavailable on the current screen', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/no-label',
        description: 'Hidden',
        validScreens: ['home'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/workflow-only',
        label: 'Workflow only',
        description: 'Workflow command',
        validScreens: ['workflow'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        label: 'Visible',
        description: 'Visible command',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map((item) => item.label)).toEqual(['/visible']);
  });

  it('runs command item actions through the runtime command callback', () => {
    const calls: string[] = [];
    const items = buildCommandSources(
      [
        {
          kind: 'noarg',
          name: '/settings',
          label: 'Settings',
          description: 'Open settings',
          validScreens: ['home'],
          handler: noop,
        },
      ],
      (raw) => calls.push(raw),
    );

    items[0]?.action();

    expect(calls).toEqual(['/settings']);
  });

  it('excludes phase-guarded commands outside their valid phase', () => {
    const commands: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/redo-task',
        label: 'Redo Task',
        description: 'Reset a task',
        validScreens: ['workflow'],
        phaseGuard: (phase) => phase === 'implementing',
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        label: 'Visible',
        description: 'Visible command',
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
      projectDir: '/tmp/diptych-test',
      onRuntimeCommand: noop,
      onWorkflowMode: noop,
      isAttached: true,
    });

    expect(sources.modeItems).toEqual([]);
    expect(sources.pickerItems.map((item) => item.label)).toEqual(['sessions']);
    expect(sources.customItems).toEqual([]);
  });
});

describe('buildPaletteSources display descriptions', () => {
  it('uses sentence-cased descriptions for modes and pickers', () => {
    const sources = buildPaletteSources({
      commands: [],
      screen: 'home',
      config: makeConfig(),
      phase: 'idle',
      tasks: [],
      sessions: [],
      projectDir: '/tmp/diptych-test',
      onRuntimeCommand: noop,
      onWorkflowMode: noop,
    });

    expect(sources.modeItems.find((item) => item.label === 'instant')?.description).toBe(
      'Switch to instant mode',
    );
    expect(sources.pickerItems.map((item) => item.description)).toEqual([
      'Select planner tool',
      'Select implementer',
      'Browse past sessions',
      'Planner, model & settings',
    ]);
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

  it('resumes an interrupted session with its saved state instead of starting fresh', () => {
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
      onWorkflowMode: noop,
    });

    sessionItems[0]?.action();

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.feature).toBe('saved add auth');
      expect(route.resumeState).toEqual(savedState);
      expect(route.sessionId).toBe(session.id);
    }
  });

  it('surfaces palette-triggered session selection errors through global feedback', () => {
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
      onWorkflowMode: noop,
    });

    sessionItems[0]?.action();

    expect(sessionSelectStore.get().error).toBe(
      'Cannot resume: saved workflow state is missing or invalid',
    );
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Cannot resume: saved workflow state is missing or invalid',
    });
  });
});
