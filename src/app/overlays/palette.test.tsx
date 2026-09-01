import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
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
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import { executeRuntimeCommand } from '../../core/runtime/commands/dispatch.js';
import { COMMAND_CATEGORY_LABELS } from '../../core/runtime/commands/types.js';
import type {
  RuntimeConfigSaveResult,
  RuntimeCommandContext,
  RuntimeCommandDef,
} from '../../core/runtime/commands/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { flushEffects, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { glyph } from '../../lib/glyphs.js';
import { CommandPaletteOverlay } from './palette.js';

async function write(instance: ReturnType<typeof render>, chars: string): Promise<void> {
  await flushEffects();
  instance.stdin.write(chars);
}

async function setWorkflowModeForTest(mode: WorkflowMode): Promise<RuntimeConfigSaveResult> {
  const state = configStore.get();
  if (!state.config) return { kind: 'failure', ok: false };
  configStore.__testReset({
    ...state,
    config: {
      ...state.config,
      workflow: { ...state.config.workflow, mode },
    },
  });
  return { kind: 'saved', ok: true };
}

function createTestCommands(opts: { isAttached?: boolean } = {}): RuntimeCommandDef[] {
  const ctx: RuntimeCommandContext = {
    isAttached: opts.isAttached ?? false,
    openOverlay: overlayStore.open,
    navigate: (to) => routerStore.navigate({ to }),
    quit: () => {},
    setWorkflowMode: setWorkflowModeForTest,
    setFeedbackMessage: feedbackStore.setMessage,
    setFeedbackError: feedbackStore.setError,
    refreshDetection: async () => ({
      status: 'fresh',
      published: true,
      lanes: {
        readiness: { outcome: 'fresh' },
        modelsDev: { outcome: 'fresh' },
        cliModels: { outcome: 'fresh' },
      },
    }),
    refreshProjectFiles: () => {},
    listSkills: () => [],
    toggleSkill: () => ({ status: 'unknown' }),
    refreshSkills: () => {},
    getCurrentPhase: () => lifecycleStore.get().phase,
    requestRewind: () => true,
    requestTaskRedo: () => true,
    getQueueDepth: () => lifecycleStore.get().queueDepth,
    clearQueue: () => ({ status: 'cleared', count: 0 }),
    attachImage: () => ({ ok: false, reason: 'not-found' }),
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
    toggleLatestDiff: () => ({ status: 'toggled', expanded: true }),
    toggleSidebar: () => ({ status: 'toggled', visible: true }),
    copyTarget: async () => 'empty',
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
          attached: false,
          plannerSupportsImages: true,
          onError: feedbackStore.setError,
        })
      }
    />,
  );
}

function renderAttachedCommandPalette(): ReturnType<typeof render> {
  routerStore.navigate({
    to: 'workflow',
    execution: {
      kind: 'attached',
      feature: 'attached feature',
      sessionId: 'attached-session',
      attach: { sockPath: '/tmp/splitbrief.sock', authToken: 'tok' },
    },
  });
  const commands = createTestCommands({ isAttached: true });
  return render(
    <CommandPaletteOverlay
      commands={commands}
      onRuntimeCommand={(raw) =>
        executeRuntimeCommand(commands, raw, {
          screen: routerStore.get().screen,
          phase: lifecycleStore.get().phase,
          attached: false,
          plannerSupportsImages: true,
          onError: feedbackStore.setError,
        })
      }
    />,
  );
}

function enterWorkflowScreen(): void {
  routerStore.navigate({
    to: 'workflow',
    execution: {
      kind: 'local',
      prepared: makePreparedExecution({
        projectDir,
        sessionId: 'command-palette-session',
        feature: 'command palette workflow',
        config: makeConfig(),
        gates: () => [],
      }),
    },
  });
}

// Command rows are sectioned by category; task, session and custom rows by their source.
const GROUP_HEADERS = [...Object.values(COMMAND_CATEGORY_LABELS), 'Tasks', 'Sessions', 'Actions'];

function innerText(line: string): string {
  // Strip the OverlayPanel frame (vertical borders + padding) so the checks below see the bare
  // row content; the ascii glyph tier renders the round border as `+-|`.
  return stripAnsiStyles(line)
    .replace(/^\s*[|│]\s*/u, '')
    .replace(/\s*[|│]\s*$/u, '')
    .trim();
}

function sectionHeaders(frame: string): string[] {
  return frame
    .split('\n')
    .map(innerText)
    .filter((text) => GROUP_HEADERS.includes(text));
}

function commandRows(frame: string): string[] {
  return paletteResultRows(frame).filter((line) =>
    innerText(line).replace(glyph('liveBar'), '').trimStart().startsWith('/'),
  );
}

function paletteResultRows(frame: string): string[] {
  return frame.split('\n').filter((line) => {
    const text = innerText(line);
    if (text === '') return false;
    if (/^[+-]+$/.test(text)) return false;
    if (text.startsWith(`${glyph('prompt')} `)) return false;
    if (text.includes('navigate')) return false;
    if (text === 'No matching commands') return false;
    if (/^[↑↓] (?:\d+ )?more$/.test(text)) return false;
    if (GROUP_HEADERS.includes(text)) return false;
    return true;
  });
}

function rowContaining(rows: string[], text: string): string {
  const row = rows.find((line) => line.includes(text));
  expect(row).toBeDefined();
  return row ?? '';
}

// The column the description column opens at: the first ink past the row's label, whatever the
// label happens to be. A row whose label column is wider pushes this further right.
function descriptionStart(row: string, label: string): number {
  const plain = stripAnsiStyles(row);
  const afterLabel = plain.indexOf(label) + label.length;
  return afterLabel + plain.slice(afterLabel).search(/\S/u);
}

// The bordered panel's own height. The overlay's outer box always fills the terminal, so the
// frame's line count never moves; the silhouette that jumps as a query narrows is this one.
function panelHeight(frame: string): number {
  const lines = stripAnsiStyles(frame).split('\n');
  const rules = lines.flatMap((line, index) =>
    /^\s*[+\u256d\u2570][-\u2500]+/u.test(line) ? [index] : [],
  );
  const first = rules.at(0) ?? -1;
  const last = rules.at(-1) ?? -1;
  return last - first + 1;
}

function promptLine(frame: string): string {
  const marker = `${glyph('prompt')} `;
  return (
    stripAnsiStyles(frame)
      .split('\n')
      .find((line) => line.includes(marker)) ?? ''
  );
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
  composerDraftStore.clear();
  terminalSizeStore.reset();
  _resetMouseZones();
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
  composerDraftStore.clear();
  terminalSizeStore.reset();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

describe('CommandPaletteOverlay', () => {
  it('names the surface in the filter placeholder and offers the run-or-fill-in hint', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);
    const raw = instance.lastFrame() ?? '';
    const frame = stripAnsiStyles(raw);
    expect(promptLine(raw)).toContain('Type a command…');
    expect(frame).toContain('↑↓ navigate');
    expect(frame).toContain('run or fill in');
    expect(frame).toContain('esc close');
    expect(commandRows(raw).length).toBeGreaterThan(0);
    instance.unmount();
  });

  it('typing and backspace update the query text shown on screen', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    await write(instance, 'hel');
    await tick(1);
    await tick(1);

    expect(promptLine(instance.lastFrame() ?? '')).toContain('hel');
    await write(instance, BACKSPACE);
    await tick(1);
    await tick(1);

    const line = promptLine(instance.lastFrame() ?? '');
    expect(line).toContain('he');
    expect(line).not.toContain('hel');
    instance.unmount();
  });

  it('backspace removes a whole emoji from the query, not a lone surrogate', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    await write(instance, 'hi😀');
    await tick(1);
    await tick(1);
    expect(promptLine(instance.lastFrame() ?? '')).toContain('hi😀');

    await write(instance, BACKSPACE);
    await tick(1);
    await tick(1);

    const raw = instance.lastFrame() ?? '';
    const frame = stripAnsiStyles(raw);
    expect(promptLine(raw)).toContain('hi');
    expect(promptLine(raw)).not.toContain('😀');
    // No half of the surrogate pair left behind.
    expect(frame).not.toContain('\ud83d');
    expect(frame).not.toContain('\ude00');
    instance.unmount();
  });

  it('shows "No matching commands" when query has no matches', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    await write(instance, 'xyzzyxyzzy');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('No matching commands');
    instance.unmount();
  });

  it('Escape closes the overlay', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('command-palette');
    await write(instance, ESC);
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
    await write(instance, DOWN);
    await tick(1);
    await tick(1);
    const afterDown = instance.lastFrame() ?? '';
    await write(instance, UP);
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

    await write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('help');
    expect(commandPaletteMruStore.get().ids).toEqual(['command:/help']);
    instance.unmount();
  });

  it('clicking a result row runs its action, records MRU, and closes the palette', async () => {
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('command-palette');
    expect(commandPaletteMruStore.get().ids).toHaveLength(0);

    collectClickableZones({ cols: 100, rows: 50 }).get('palette:command:/help')?.();
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('help');
    expect(commandPaletteMruStore.get().ids).toEqual(['command:/help']);
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

    await write(instance, 'add login');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Sessions');
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

    await write(instance, 'SuperUniquePaletteAction');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('SuperUniquePaletteAction');
    expect(frame).toContain('Actions');
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

    await write(instance, 'Open Settings Custom Action');
    await tick(1);
    await tick(1);
    await write(instance, ENTER);
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
    await write(instance, 'uniquetasktitle123');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    if (showsTask) {
      expect(paletteResultRows(frame).some((row) => row.includes('uniquetasktitle123'))).toBe(true);
      expect(frame).toContain('Tasks');
    } else {
      expect(paletteResultRows(frame).some((row) => row.includes('uniquetasktitle123'))).toBe(
        false,
      );
    }
    instance.unmount();
  });

  it('truncates long palette result rows instead of wrapping them', async () => {
    terminalSizeStore.__testReset({ cols: 50, rows: 24, isSmall: true });
    const longCommand: RuntimeCommandDef = {
      kind: 'noarg',
      name: '/very-long-command-name-for-row-layout',
      label: 'VeryLongCommandLabelForPaletteRowLayout',
      description: 'A long command description that must be truncated before TAIL_SENTINEL_PALETTE',
      category: 'navigate',
      validScreens: ['home'],
      handler: () => {},
    };

    const instance = render(
      <CommandPaletteOverlay commands={[longCommand]} onRuntimeCommand={() => {}} />,
    );
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    const resultLines = paletteResultRows(frame).filter((line) =>
      line.includes('/very-long-command'),
    );
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]).toContain('…');
    expect(frame).not.toContain('TAIL_SENTINEL_PALETTE');

    instance.unmount();
  });

  it('shows visible palette actions within the terminal-derived result budget', async () => {
    terminalSizeStore.__testReset({ cols: 140, rows: 36, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    const rows = paletteResultRows(instance.lastFrame() ?? '');
    expect(rows.length).toBeGreaterThan(8);

    const helpRow = rowContaining(rows, '/help');
    const settingsRow = rowContaining(rows, '/settings');
    expect(helpRow).toContain('Show help');
    expect(settingsRow).toContain('Crew, validation, workflow');

    instance.unmount();
  });

  it('renders the shared ↓ N more indicator instead of the n/total counter', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 12, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain(glyph('prompt'));
    expect(frame).toContain('navigate');
    expect(frame).toContain('esc close');
    expect(frame).toMatch(/↓ \d+ more/);
    expect(frame).not.toMatch(/\d+\/\d+\s*↓/);

    instance.unmount();
  });

  it('sizes the result window from terminal rows instead of a fixed window', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 12, isSmall: false });
    const short = renderCommandPalette();
    await tick(1);
    await tick(1);
    const shortRows = paletteResultRows(short.lastFrame() ?? '');
    short.unmount();

    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
    const tall = renderCommandPalette();
    await tick(1);
    await tick(1);
    const tallRows = paletteResultRows(tall.lastFrame() ?? '');
    tall.unmount();

    expect(shortRows.length).toBeGreaterThan(0);
    expect(shortRows.length).toBeLessThan(tallRows.length);
    expect(tallRows.length).toBeGreaterThan(8);
  });

  it('keeps palette command shortcuts visible when descriptions overflow', async () => {
    terminalSizeStore.__testReset({ cols: 58, rows: 24, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    await write(instance, 'settings');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    const settingsRow = rowContaining(paletteResultRows(frame), 'ctrl+,');
    expect(settingsRow).toContain('/settings');
    expect(settingsRow).toContain('ctrl+,');
    expect(frame).not.toContain('[ctrl+,]');
    expect(frame.split('\n').filter((line) => line.includes('ctrl+,'))).toHaveLength(1);

    instance.unmount();
  });

  it('does not expose local config mutators for attached clients', async () => {
    const instance = renderAttachedCommandPalette();
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).not.toContain('Planner');
    expect(frame).not.toContain('implementer');
    expect(frame).not.toContain('settings');

    await write(instance, 'mode');
    await tick(1);
    await tick(1);
    expect(commandRows(instance.lastFrame() ?? '').some((row) => row.includes('/mode'))).toBe(
      false,
    );

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

    await write(instance, uniqueFeature);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(paletteResultRows(frame).some((row) => row.includes(uniqueFeature))).toBe(true);
    expect(frame).toContain('Sessions');

    await write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('settings');

    instance.unmount();
  });

  it('does not execute a hidden result, update MRU, or close on Enter when no row is visible', async () => {
    const hiddenCommand: RuntimeCommandDef = {
      kind: 'noarg',
      name: '/hidden',
      label: 'Hidden Palette Command',
      description: 'must not run when clipped',
      category: 'navigate',
      validScreens: ['home'],
      handler: () => {
        overlayStore.open('help');
      },
    };

    terminalSizeStore.__testReset({ cols: 80, rows: 1, isSmall: false });
    const instance = render(
      <CommandPaletteOverlay commands={[hiddenCommand]} onRuntimeCommand={() => {}} />,
    );
    await tick(1);
    await tick(1);

    const frame = stripAnsiStyles(instance.lastFrame() ?? '');
    expect(frame).not.toContain('/hidden');
    expect(frame).not.toContain('select');

    await write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('command-palette');
    expect(commandPaletteMruStore.get().ids).toHaveLength(0);

    instance.unmount();
  });

  it('groups rows under category headers when the list budget allows', async () => {
    for (const size of [
      { cols: 120, rows: 40 },
      { cols: 80, rows: 24 },
    ]) {
      terminalSizeStore.__testReset({ ...size, isSmall: false });
      const instance = renderCommandPalette();
      await tick(1);
      await tick(1);

      const headers = sectionHeaders(instance.lastFrame() ?? '');
      expect(headers, `${size.cols}x${size.rows}`).toContain('Navigate');
      expect(headers.length, `${size.cols}x${size.rows}`).toBeGreaterThan(1);
      instance.unmount();
    }
  });

  it('draws each section header exactly once when a query reorders the list by relevance', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);
    expect(sectionHeaders(instance.lastFrame() ?? '')).toContain('Navigate');

    await write(instance, 'e');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    const headers = sectionHeaders(frame);
    expect(headers.length).toBeGreaterThan(0);
    expect(new Set(headers).size).toBe(headers.length);
    expect(commandRows(frame).length).toBeGreaterThan(0);
    instance.unmount();
  });

  it('drops the category headers at the 60x18 floor and keeps the rows', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(sectionHeaders(frame)).toEqual([]);
    expect(commandRows(frame).length).toBeGreaterThanOrEqual(8);
    instance.unmount();
  });

  it('Enter on an argument command fills the composer instead of running it bare', async () => {
    enterWorkflowScreen();
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    await write(instance, '/copy');
    await tick(1);
    await tick(1);
    expect(commandRows(instance.lastFrame() ?? '')[0]).toContain('/copy');

    await write(instance, ENTER);
    await tick(1);
    await tick(1);

    expect(composerDraftStore.get().request?.value).toBe('/copy ');
    expect(overlayStore.get().active).toBe('none');
    expect(feedbackStore.get().isError).toBe(false);
    instance.unmount();
  });

  it('does not offer workflow-only commands on the home screen', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    const rows = commandRows(instance.lastFrame() ?? '');
    expect(rows.some((row) => row.includes('/help'))).toBe(true);
    expect(rows.some((row) => row.includes('/diff'))).toBe(false);
    expect(rows.some((row) => row.includes('/cost'))).toBe(false);
    instance.unmount();
  });

  it('reports no error whichever visible row is run', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const probe = renderCommandPalette();
    await tick(1);
    await tick(1);
    const rowCount = commandRows(probe.lastFrame() ?? '').length;
    probe.unmount();
    expect(rowCount).toBeGreaterThan(8);

    for (let row = 0; row < rowCount; row++) {
      overlayStore.reset();
      overlayStore.open('command-palette');
      feedbackStore.reset();
      commandPaletteMruStore.__testReset();
      const instance = renderCommandPalette();
      await tick(1);
      await tick(1);

      const label = commandRows(instance.lastFrame() ?? '')[row] ?? '';
      for (let step = 0; step < row; step++) await write(instance, DOWN);
      await tick(1);
      await write(instance, ENTER);
      await tick(1);
      await tick(1);

      expect(feedbackStore.get().isError, label).toBe(false);
      instance.unmount();
    }
  });

  it('gives a long session title the full row instead of the command-name column', async () => {
    const feature = 'refactor the authentication middleware and session store';
    const session = makeSession({
      id: 'sess-long-title',
      feature,
      status: 'interrupted',
      summary: null,
    });
    saveSummary({ projectDir, sessionId: session.id }, session);

    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    await write(instance, 'session');
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    const sessionRow = rowContaining(paletteResultRows(frame), feature);
    expect(stripAnsiStyles(sessionRow)).toContain(feature);
    expect(sessionRow).toContain('interrupted');
    expect(sessionRow).not.toContain('…');
    instance.unmount();
  });

  it('keeps command rows in one aligned column while a session row widens', async () => {
    const feature = 'refactor the authentication middleware and session store';
    const session = makeSession({
      id: 'sess-widening',
      feature,
      status: 'interrupted',
      summary: null,
    });
    saveSummary({ projectDir, sessionId: session.id }, session);

    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    await write(instance, 'session');
    await tick(1);
    await tick(1);

    const rows = paletteResultRows(instance.lastFrame() ?? '');
    const sessionsColumn = descriptionStart(rowContaining(rows, '/sessions'), '/sessions');
    const skillsColumn = descriptionStart(rowContaining(rows, '/skills'), '/skills');
    const sessionRowColumn = descriptionStart(rowContaining(rows, feature), feature);

    expect(sessionsColumn).toBe(skillsColumn);
    expect(sessionRowColumn).toBeGreaterThan(sessionsColumn);
    instance.unmount();
  });

  it('renders the same number of rows for an empty query and a one-match query', async () => {
    const feature = 'zzzuniquesessionfeature';
    const session = makeSession({
      id: 'sess-height',
      feature,
      status: 'interrupted',
      summary: null,
    });
    saveSummary({ projectDir, sessionId: session.id }, session);

    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const instance = renderCommandPalette();
    await tick(1);
    await tick(1);

    const browsing = panelHeight(instance.lastFrame() ?? '');
    expect(paletteResultRows(instance.lastFrame() ?? '').length).toBeGreaterThan(1);

    await write(instance, feature);
    await tick(1);
    await tick(1);

    const narrowed = panelHeight(instance.lastFrame() ?? '');
    expect(paletteResultRows(instance.lastFrame() ?? '')).toHaveLength(1);
    expect(narrowed).toBe(browsing);
    instance.unmount();
  });
});
