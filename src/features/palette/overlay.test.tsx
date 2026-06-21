import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { saveSummary } from '../../core/sessions/io.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { commandPaletteMruStore } from '../../stores/ui/command-palette-mru.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import { executeRuntimeCommand } from '../../core/runtime/commands/dispatch.js';
import type {
  RuntimeCommandContext,
  RuntimeCommandDef,
} from '../../core/runtime/commands/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { tick } from '#testing/helpers/ink.js';
import { CommandPaletteOverlay } from './overlay.js';

function write(instance: ReturnType<typeof render>, chars: string): void {
  instance.stdin.write(chars);
}

function setWorkflowModeForTest(mode: WorkflowMode): boolean {
  const state = configStore.get();
  if (!state.config) return false;
  configStore.__testReset({
    ...state,
    config: {
      ...state.config,
      workflow: { ...state.config.workflow, mode },
    },
  });
  return true;
}

function createTestCommands(): RuntimeCommandDef[] {
  const ctx: RuntimeCommandContext = {
    openOverlay: overlayStore.open,
    navigate: (to) => routerStore.navigate({ to }),
    quit: () => {},
    setWorkflowMode: setWorkflowModeForTest,
    setPlannerEffort: () => true,
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => {},
    refreshProjectFiles: () => {},
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestRewind: () => true,
    requestTaskRedo: () => true,
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: () => ({ status: 'cleared', count: 0 }),
    rebuildRepomap: async () => ({ deleted: false, files: [] }),
    attachImage: () => ({ ok: false, reason: 'not implemented in test' }),
    detachImage: () => false,
    listAttachments: () => [],
    writeHandoff: async () => ({ outputDir: '' }),
    listApprovals: () => [],
    clearApprovals: () => 0,
    getApprovalEnabled: () => true,
    setApprovalEnabled: () => {},
    acceptRunSnapshot: async () => ({ snapshotId: 'test-snapshot', isFirstSnapshot: false }),
    rejectRunSnapshot: async () => ({ status: 'empty' }),
    compactTranscript: async () => ({ status: 'unsupported', plannerName: 'test' }),
    exportSession: async () => ({ status: 'ok', path: '/tmp/report.html' }),
    scrollConversation: () => ({ status: 'scrolled' }),
    toggleLatestActivityBatch: () => ({ status: 'toggled', expanded: true }),
  };
  return createRuntimeCommands(ctx);
}

function renderCommandPalette(): ReturnType<typeof render> {
  const commands = createTestCommands();
  return render(
    <CommandPaletteOverlay
      commands={commands}
      onRuntimeCommand={(raw) =>
        executeRuntimeCommand(commands, raw, {
          screen: routerStore.get().screen,
          phase: lifecycleStore.get().phase,
          onError: feedbackStore.setError,
        })
      }
      onWorkflowMode={setWorkflowModeForTest}
    />,
  );
}

function paletteResultRows(frame: string): string[] {
  return frame.split('\n').filter((line) => /\[(command|mode|picker|session|task)\]/.test(line));
}

function rowContaining(rows: string[], text: string): string {
  const row = rows.find((line) => line.includes(text));
  expect(row).toBeDefined();
  return row ?? '';
}

const DOWN = '\u001b[B';
const UP = '\u001b[A';
const ENTER = '\r';
const ESC = '\u001b';
const BACKSPACE = '\u007f';

let projectDir = '';

beforeEach(() => {
  projectDir = createTempDir('command-palette-overlay-test');
  configStore.__testReset({ config: makeConfig(), projectDir });
  overlayStore.reset();
  feedbackStore.reset();
  routerStore.reset();
  sessionsStore.reset();
  tasksStore.reset();
  lifecycleStore.reset();
  commandPaletteMruStore.__testReset();
  terminalSizeStore.reset();
  overlayStore.open('command-palette');
});

afterEach(() => {
  configStore.reset();
  overlayStore.reset();
  feedbackStore.reset();
  routerStore.reset();
  sessionsStore.reset();
  tasksStore.reset();
  lifecycleStore.reset();
  commandPaletteMruStore.__testReset();
  terminalSizeStore.reset();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

describe('CommandPaletteOverlay', () => {
  it('renders the palette shell with default command sources', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Command Palette');
    expect(frame).toContain('navigate');
    expect(frame).toContain('Esc close');
    expect(frame).toMatch(/\[command\]|\[mode\]|\[picker\]/);
    instance.unmount();
  });

  it('typing and backspace update the query text shown on screen', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'hel');
    await tick(1);
    await tick(1);

    expect(instance.lastFrame() ?? '').toContain('hel_');
    write(instance, BACKSPACE);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('he_');
    expect(frame).not.toContain('hel_');
    instance.unmount();
  });

  it('backspace removes a whole emoji from the query, not a lone surrogate', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'hi😀');
    await tick(1);
    await tick(1);
    expect(instance.lastFrame() ?? '').toContain('hi😀_');

    write(instance, BACKSPACE);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('hi_');
    // No half of the surrogate pair left behind.
    expect(frame).not.toContain('\ud83d');
    expect(frame).not.toContain('\ude00');
    instance.unmount();
  });

  it('shows "No matching commands" when query has no matches', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'xyzzyxyzzy');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame.toLowerCase()).toContain('no matching commands');
    instance.unmount();
  });

  it('Escape closes the overlay', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('command-palette');
    write(instance, ESC);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    instance.unmount();
  });

  it('arrow keys move the visible cursor between results', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    const initial = instance.lastFrame() ?? '';
    write(instance, DOWN);
    await tick(1);
    await tick(1);
    const afterDown = instance.lastFrame() ?? '';
    write(instance, UP);
    await tick(1);
    await tick(1);
    const afterUp = instance.lastFrame() ?? '';

    expect(afterDown).not.toBe(initial);
    expect(afterUp).toBe(initial);
    instance.unmount();
  });

  it('Enter selects the highlighted command, records MRU, and closes the palette', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('command-palette');
    expect(commandPaletteMruStore.get().ids).toHaveLength(0);

    write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('help');
    expect(commandPaletteMruStore.get().ids).toEqual(['command:Help']);
    instance.unmount();
  });

  it('session items from disk appear in results when query matches', async () => {
    const session = makeSession({
      id: 'sess-abc',
      feature: 'add login form',
      status: 'interrupted',
      summary: null,
    });
    saveSummary({ projectDir: projectDir, sessionId: session.id }, session);

    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'add login');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[session]');
    expect(frame).toContain('add login form');
    instance.unmount();
  });

  it('custom items from config appear in results when searched', async () => {
    const baseConfig = makeConfig();
    configStore.__testReset({
      config: {
        ...baseConfig,
        palette: {
          customActions: [
            {
              id: 'my-cmd',
              label: 'SuperUniquePaletteAction',
              description: 'zxqwerty',
              command: '/refresh',
            },
          ],
        },
      },
      projectDir,
    });

    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'SuperUniquePaletteAction');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('SuperUniquePaletteAction');
    expect(frame).toContain('[custom]');
    instance.unmount();
  });

  it('executes a custom palette command from config', async () => {
    const baseConfig = makeConfig();
    configStore.__testReset({
      config: {
        ...baseConfig,
        palette: {
          customActions: [
            {
              id: 'open-settings-custom',
              label: 'Open Settings Custom Action',
              command: '/settings',
            },
          ],
        },
      },
      projectDir,
    });

    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'Open Settings Custom Action');
    await tick(1);
    await tick(1);
    write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('settings');
    instance.unmount();
  });

  it.each([
    { phase: 'idle', showsTask: false },
    { phase: 'implementing', showsTask: true },
    { phase: 'validating-task', showsTask: true },
    { phase: 'escalating', showsTask: true },
  ] as const)('task item visibility follows the $phase phase', async ({ phase, showsTask }) => {
    tasksStore.__testReset({
      tasks: [{ id: 'T001', title: 'uniquetasktitle123', status: 'in_progress' }],
    });
    lifecycleStore.__testReset({ phase });

    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);
    write(instance, 'uniquetasktitle123');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    if (showsTask) {
      expect(frame).toContain('[task]');
    } else {
      expect(frame).not.toContain('[task]');
    }
    instance.unmount();
  });

  it('mode items are shown in results', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'standard');
    await tick(1);
    await tick(1);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[mode]');
    instance.unmount();
  });

  it('executes the injected workflow mode action', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'instant');
    await tick(1);
    await tick(1);
    write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(configStore.get().config?.workflow.mode).toBe('instant');
    expect(overlayStore.get().active).toBe('none');
    instance.unmount();
  });

  it('picker items are shown in results', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'Settings');
    await tick(1);
    await tick(1);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/Settings/);
    instance.unmount();
  });

  it('truncates long palette result rows instead of wrapping them', async () => {
    terminalSizeStore.__testReset({ cols: 50, rows: 24, isSmall: true });
    const longCommand: RuntimeCommandDef = {
      kind: 'noarg',
      name: '/very-long-command-name-for-row-layout',
      label: 'VeryLongCommandLabelForPaletteRowLayout',
      description: 'A long command description that must be truncated before TAIL_SENTINEL_PALETTE',
      validScreens: ['home'],
      handler: () => {},
    };

    const instance = render(
      <CommandPaletteOverlay
        commands={[longCommand]}
        onRuntimeCommand={() => {}}
        onWorkflowMode={setWorkflowModeForTest}
      />,
    );
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    const resultLines = frame.split('\n').filter((line) => line.includes('[command]'));
    expect(resultLines).toHaveLength(1);
    expect(rowContaining(resultLines, '[command]')).toContain('…');
    expect(frame).not.toContain('TAIL_SENTINEL_PALETTE');

    instance.unmount();
  });

  it('shows visible palette actions within the result budget', async () => {
    terminalSizeStore.__testReset({ cols: 140, rows: 36, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    const rows = paletteResultRows(instance.lastFrame() ?? '');
    expect(rows.length).toBeLessThanOrEqual(8);

    const helpRow = rowContaining(rows, 'Help');
    const settingsRow = rowContaining(rows, 'Settings');
    expect(helpRow).toContain('Show help overlay');
    expect(settingsRow).toContain('Planner');
    expect(settingsRow).toContain('settings');

    instance.unmount();
  });

  it('keeps palette command shortcuts visible when descriptions overflow', async () => {
    terminalSizeStore.__testReset({ cols: 58, rows: 24, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, 'Settings');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    const commandRows = paletteResultRows(frame).filter((line) => line.includes('[command]'));
    expect(commandRows.length).toBeLessThanOrEqual(8);

    const settingsRow = rowContaining(commandRows, 'Settings');
    expect(settingsRow).toContain('[Ctrl+,]');
    expect(frame.split('\n').filter((line) => line.includes('[Ctrl+,]'))).toHaveLength(1);

    instance.unmount();
  });

  it('session action does not double-close overlay (underlying overlay survives)', async () => {
    const uniqueFeature = 'uniquefeaturexyz987';
    const session = makeSession({
      id: 'sess-regression',
      feature: uniqueFeature,
      status: 'interrupted',
      summary: null,
    });
    saveSummary({ projectDir: projectDir, sessionId: session.id }, session);

    overlayStore.reset();
    overlayStore.open('settings');
    overlayStore.open('command-palette');

    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    write(instance, uniqueFeature);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[session]');

    write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('settings');

    instance.unmount();
  });

  it('reports a synchronously thrown action error via feedback without crashing', async () => {
    const commands = createTestCommands();
    const instance = render(
      <CommandPaletteOverlay
        commands={commands}
        onRuntimeCommand={() => {}}
        onWorkflowMode={() => {
          throw new Error('mode switch boom');
        }}
      />,
    );
    await tick(1);
    await tick(1);

    write(instance, 'instant');
    await tick(1);
    await tick(1);
    write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('mode switch boom');
    expect(overlayStore.get().active).toBe('none');
    instance.unmount();
  });
});
