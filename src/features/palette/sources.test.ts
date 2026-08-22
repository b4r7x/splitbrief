import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import type {
  RuntimeCommandDef,
  RuntimeConfigSaveResult,
} from '../../core/runtime/commands/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { Screen } from '../../core/navigation/types.js';
import { createInitialState } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { handleSessionSelect, sessionSelectStore } from '../../stores/navigation/session-select.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { buildPaletteSources } from './sources.js';

const noop = () => {};
const savedMode = async (): Promise<RuntimeConfigSaveResult> => ({ kind: 'saved', ok: true });
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
    onWorkflowMode: savedMode,
    onSessionSelect: noopSessionSelect,
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

  it('runs command item actions through the runtime command callback', async () => {
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

    // biome-ignore lint/nursery/noFloatingPromises: the action result is awaited here; the rule mis-reads the void | Promise<void> union
    await items[0]?.action();

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
      projectDir: '/tmp/splitbrief-test',
      onRuntimeCommand: noop,
      onWorkflowMode: savedMode,
      onSessionSelect: noopSessionSelect,
      isAttached: true,
    });

    expect(sources.modeItems).toEqual([]);
    expect(sources.pickerItems.map((item) => item.label)).toEqual(['sessions']);
    expect(sources.customItems).toEqual([]);
  });
});

function buildHomeSources() {
  return buildPaletteSources({
    commands: [],
    screen: 'home',
    config: makeConfig(),
    phase: 'idle',
    tasks: [],
    sessions: [],
    projectDir: '/tmp/splitbrief-test',
    onRuntimeCommand: noop,
    onWorkflowMode: savedMode,
    onSessionSelect: noopSessionSelect,
  });
}

describe('buildPaletteSources display descriptions', () => {
  it('describes every mode and picker entry', () => {
    const sources = buildHomeSources();

    expect(sources.modeItems.find((item) => item.label === 'instant')?.description).toBe(
      'Switch to instant mode',
    );
    expect(sources.pickerItems.map((item) => item.label)).toEqual([
      'planner',
      'implementer',
      'reviewer',
      'crew',
      'sessions',
      'settings',
    ]);
    for (const item of sources.pickerItems) {
      expect(item.description).not.toBe('');
    }
  });
});

describe('buildPaletteSources picker items', () => {
  beforeEach(() => {
    overlayStore.reset();
  });

  afterEach(() => {
    overlayStore.reset();
  });

  it('opens the reviewer picker and the crew surface from their picker entries', async () => {
    const pickerItems = buildHomeSources().pickerItems;

    await pickerItems.find((item) => item.label === 'reviewer')?.action();
    expect(overlayStore.get().active).toBe('reviewer-picker');

    await pickerItems.find((item) => item.label === 'crew')?.action();
    expect(overlayStore.get().active).toBe('crew');
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
      onWorkflowMode: savedMode,
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
      onWorkflowMode: savedMode,
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
