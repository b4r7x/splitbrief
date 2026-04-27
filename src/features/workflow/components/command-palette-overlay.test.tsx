import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { configStore } from '../../../stores/project/config.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { paletteMruStore } from '../../../stores/ui/palette-mru.js';
import { CommandPaletteOverlay } from './command-palette-overlay.js';

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function write(
  instance: ReturnType<typeof render>,
  chars: string,
): void {
  instance.stdin.write(chars);
}

const DOWN = '[B';
const UP = '[A';
const ENTER = '\r';
const ESC = '';
const BACKSPACE = '';

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
  paletteMruStore.__testReset();
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
  paletteMruStore.__testReset();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

describe('CommandPaletteOverlay', () => {
  it('renders the palette shell with default command sources', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Command Palette');
    expect(frame).toContain('navigate');
    expect(frame).toContain('Esc close');
    expect(frame).toMatch(/\[slash\]|\[mode\]|\[picker\]/);
    instance.unmount();
  });

  it('typing and backspace update the query text shown on screen', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, 'hel');
    await tick();

    expect(instance.lastFrame() ?? '').toContain('hel_');
    write(instance, BACKSPACE);
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('he_');
    expect(frame).not.toContain('hel_');
    instance.unmount();
  });

  it('shows "No matching commands" when query has no matches', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, 'xyzzyxyzzy');
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame.toLowerCase()).toContain('no matching commands');
    instance.unmount();
  });

  it('Escape closes the overlay', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();

    expect(overlayStore.get().active).toBe('command-palette');
    write(instance, ESC);
    await tick();

    expect(overlayStore.get().active).toBe('none');
    instance.unmount();
  });

  it('arrow keys move the visible cursor between results', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();

    const initial = instance.lastFrame() ?? '';
    write(instance, DOWN);
    await tick();
    const afterDown = instance.lastFrame() ?? '';
    write(instance, UP);
    await tick();
    const afterUp = instance.lastFrame() ?? '';

    expect(afterDown).not.toBe(initial);
    expect(afterUp).toBe(initial);
    instance.unmount();
  });

  it('Enter selects the highlighted command, records MRU, and closes the palette', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();

    expect(overlayStore.get().active).toBe('command-palette');
    expect(paletteMruStore.get().ids).toHaveLength(0);

    write(instance, ENTER);
    await tick();

    expect(overlayStore.get().active).toBe('help');
    expect(paletteMruStore.get().ids).toEqual(['slash:Help']);
    instance.unmount();
  });

  it('session items from disk appear in results when query matches', async () => {
    const session = makeSession({ id: 'sess-abc', feature: 'add login form', status: 'interrupted', summary: null });
    saveSummary(projectDir, session.id, session);

    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, 'add login');
    await tick();

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
            { id: 'my-cmd', label: 'SuperUniquePaletteAction', description: 'zxqwerty', command: '/refresh' },
          ],
        },
      },
      projectDir,
    });

    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, 'SuperUniquePaletteAction');
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('SuperUniquePaletteAction');
    expect(frame).toContain('[custom]');
    instance.unmount();
  });

  it('executes a custom palette slash command from config', async () => {
    const baseConfig = makeConfig();
    configStore.__testReset({
      config: {
        ...baseConfig,
        palette: {
          customActions: [
            { id: 'open-settings-custom', label: 'Open Settings Custom Action', command: '/settings' },
          ],
        },
      },
      projectDir,
    });

    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, 'Open Settings Custom Action');
    await tick();
    write(instance, ENTER);
    await tick();

    expect(overlayStore.get().active).toBe('settings');
    instance.unmount();
  });

  it.each([
    { phase: 'idle', showsTask: false },
    { phase: 'implementing', showsTask: true },
    { phase: 'validating-task', showsTask: true },
    { phase: 'escalating', showsTask: true },
  ] as const)('task item visibility follows the $phase phase', async ({ phase, showsTask }) => {
    tasksStore.__testReset({ tasks: [{ id: 'T001', title: 'uniquetasktitle123', status: 'in_progress' }] });
    lifecycleStore.__testReset({ phase });

    const instance = render(<CommandPaletteOverlay />);
    await tick();
    write(instance, 'uniquetasktitle123');
    await tick();

    const frame = instance.lastFrame() ?? '';
    if (showsTask) {
      expect(frame).toContain('[task]');
    } else {
      expect(frame).not.toContain('[task]');
    }
    instance.unmount();
  });

  it('mode items are shown in results', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, 'standard');
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[mode]');
    instance.unmount();
  });

  it('picker items are shown in results', async () => {
    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, 'Settings');
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/Settings/);
    instance.unmount();
  });

  it('session action does not double-close overlay (underlying overlay survives)', async () => {
    const uniqueFeature = 'uniquefeaturexyz987';
    const session = makeSession({ id: 'sess-regression', feature: uniqueFeature, status: 'interrupted', summary: null });
    saveSummary(projectDir, session.id, session);

    overlayStore.reset();
    overlayStore.open('settings');
    overlayStore.open('command-palette');

    const instance = render(<CommandPaletteOverlay />);
    await tick();

    write(instance, uniqueFeature);
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[session]');

    write(instance, ENTER);
    await tick();

    expect(overlayStore.get().active).toBe('settings');

    instance.unmount();
  });
});
