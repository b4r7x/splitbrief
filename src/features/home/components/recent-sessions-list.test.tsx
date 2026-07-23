import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_EXEC_WAIT_MS,
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { Box } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { Session } from '../../../core/schemas/session.js';
import { RecentSessionsList } from './recent-sessions-list.js';

const originalPlatform = process.platform;

const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const FOCUS_BAR = '▌';

function lineIndexContaining(frame: string, text: string): number {
  const index = frame.split('\n').findIndex((line) => line.includes(text));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function makeSessions(labels: string[]): Session[] {
  return labels.map((feature, i) =>
    makeSession({ id: `sess-${i}`, feature, startedAt: 1_700_000_000 + i }),
  );
}

function renderWithOutdentRoom(element: Parameters<typeof renderFeature>[0]) {
  return renderFeature(<Box marginLeft={2}>{element}</Box>);
}

describe('RecentSessionsList', () => {
  let selected: Session | null;
  let closed: number;

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    installClipboardExecFixture();
    resetClipboardExecFixture();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    selected = null;
    closed = 0;
  });

  afterEach(() => {
    resetAllStores();
    restoreClipboardExecFixture();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  const onSelect = (s: Session) => {
    selected = s;
  };
  const onClose = () => {
    closed += 1;
  };

  it('renders the header, all rows, the hint line, and seats the cursor on row 0', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Recent sessions');
    expect(frame).toContain('alpha');
    expect(frame).toContain('bravo');
    expect(frame).toContain('charlie');
    expect(frame).not.toContain('navigate');
    expect(frame).not.toContain('Enter resume');
    expect(frame).not.toContain('Esc back');
    expect(frame).toContain(FOCUS_BAR);
    expect(lineIndexContaining(frame, FOCUS_BAR)).toBe(lineIndexContaining(frame, 'alpha'));
    ui.unmount();
  });

  it('keeps each focused row on a single line inside a body-width container (no wrap)', async () => {
    const sessions = makeSessions([
      'a-long-recent-session-feature-name-number-one',
      'another-fairly-long-recent-session-feature-two',
      'third-recent-session-feature-that-is-also-long',
    ]);
    const ui = renderFeature(
      <Box marginLeft={2} width={72}>
        <RecentSessionsList
          sessions={sessions}
          hasOverlay={false}
          onSelect={onSelect}
          onClose={onClose}
        />
      </Box>,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n').filter((line) => line.trim().length > 0);
    const prefixLines = [
      lines.find((line) => line.includes('a-long-recent')),
      lines.find((line) => line.includes('another-fairly')),
      lines.find((line) => line.includes('third-recent')),
    ];
    expect(prefixLines.every((line) => line !== undefined)).toBe(true);
    expect(new Set(prefixLines).size).toBe(3);
    expect(lines.length).toBeLessThanOrEqual(7);
    ui.unmount();
  });

  it('Up at index 0 calls onClose, does not call onSelect, and does not wrap to the last row', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await flushEffects();

    const before = lineIndexContaining(ui.lastFrame() ?? '', FOCUS_BAR);

    ui.stdin.write(ARROW_UP);
    await flushEffects();

    expect(closed).toBe(1);
    expect(selected).toBeNull();
    expect(lineIndexContaining(ui.lastFrame() ?? '', FOCUS_BAR)).toBe(before);
    ui.unmount();
  });

  it('y copies the focused session feature and leaves the filter unchanged', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await flushEffects();

    // The copy runs the clipboard tool under the production 2s kill window, so a badly starved
    // box can lose an attempt outright; press again while nothing has recorded yet.
    await vi.waitFor(
      () => {
        if (readClipboardExecCalls().length === 0) ui.stdin.write('y');
        expect(readClipboardExecCalls().at(-1)?.stdin).toBe('alpha');
      },
      { timeout: CLIPBOARD_EXEC_WAIT_MS, interval: 500 },
    );
    expect(selected).toBeNull();
    expect(closed).toBe(0);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('bravo');
    expect(frame).toContain('charlie');
    expect(frame).not.toContain('No matching sessions');
    ui.unmount();
  }, 20_000);

  it('y copies the currently highlighted session, not always the first', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    await flushEffects();

    await vi.waitFor(
      () => {
        if (readClipboardExecCalls().length === 0) ui.stdin.write('y');
        expect(readClipboardExecCalls().at(-1)?.stdin).toBe('bravo');
      },
      { timeout: CLIPBOARD_EXEC_WAIT_MS, interval: 500 },
    );
    ui.unmount();
  }, 20_000);

  it('keeps the focused row clean with no per-row "y copy" affordance', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('y copy');
    const focusedRow = lineIndexContaining(frame, FOCUS_BAR);
    expect(focusedRow).toBe(lineIndexContaining(frame, 'alpha'));
    expect(frame.split('\n')[focusedRow]).not.toContain('y copy');
    ui.unmount();
  });

  it('y does not copy when no session row is visible in the list budget', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
        maxVisible={0}
      />,
    );
    await flushEffects();

    ui.stdin.write('y');
    await flushEffects();

    expect(readClipboardExecCalls()).toHaveLength(0);
    ui.unmount();
  });

  it('with hasOverlay=true, Down/Enter/Esc are no-ops', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await flushEffects();

    const before = lineIndexContaining(ui.lastFrame() ?? '', FOCUS_BAR);

    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    ui.stdin.write(ESC);
    await flushEffects();

    expect(lineIndexContaining(ui.lastFrame() ?? '', FOCUS_BAR)).toBe(before);
    expect(selected).toBeNull();
    expect(closed).toBe(0);
    ui.unmount();
  });
});
