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
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { Session } from '../../../core/schemas/session.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { RecentSessionsList } from './recent-sessions-list.js';

const originalPlatform = process.platform;

const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const FOCUS_BAR = '▌';
const VIEWPORT = { cols: 80, rows: 24 };
const CLIPBOARD_TEST_TIMEOUT_MS = CLIPBOARD_EXEC_WAIT_MS + 5_000;
const KITTY_SUPER_Y = '\u001b[121;9u';
const KITTY_HYPER_Y = '\u001b[121;17u';

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

describe('RecentSessionsList', () => {
  let selected: Session | null;
  let closed: number;

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
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
  const view = (
    sessions: Session[],
    options: {
      hasOverlay?: boolean | undefined;
      maxVisible?: number | undefined;
      onSelect?: ((session: Session) => void) | undefined;
    } = {},
  ) => (
    <Box marginLeft={2}>
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={options.hasOverlay ?? false}
        onSelect={options.onSelect ?? onSelect}
        onClose={onClose}
        maxVisible={options.maxVisible}
      />
    </Box>
  );
  const renderList = (sessions: Session[], options?: Parameters<typeof view>[1]) =>
    renderFeature(view(sessions, options));

  it('renders the header, all rows, the hint line, and seats the cursor on row 0', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderList(sessions);
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
    const ui = renderList(sessions);
    await flushEffects();

    const before = lineIndexContaining(ui.lastFrame() ?? '', FOCUS_BAR);

    await flushEffects();
    ui.stdin.write(ARROW_UP);
    await flushEffects();

    expect(closed).toBe(1);
    expect(selected).toBeNull();
    expect(lineIndexContaining(ui.lastFrame() ?? '', FOCUS_BAR)).toBe(before);
    ui.unmount();
  });

  it('keeps the selected session ID through prepend and reorder, then opens that session', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderFeature(view(sessions));
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    await flushEffects();

    const prepended = makeSession({
      id: 'sess-new',
      feature: 'delta',
      startedAt: 1_700_000_100,
    });
    const refreshed = [prepended, ...sessions.slice().reverse()].map((session) => ({
      ...session,
      feature: `${session.feature}-refreshed`,
    }));
    ui.rerender(view(refreshed));
    await flushEffects();

    ui.stdin.write(ENTER);
    await flushEffects();

    expect(selected?.id).toBe('sess-1');
    expect(selected?.feature).toBe('bravo-refreshed');
    ui.unmount();
  });

  it('resets to the first match after a filter edit and keeps that ID through reorder', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderFeature(view(sessions));
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write('a');
    await flushEffects();

    ui.rerender(
      view(
        sessions
          .slice()
          .reverse()
          .map((session) => ({ ...session })),
      ),
    );
    await flushEffects();

    ui.stdin.write(ENTER);
    await flushEffects();

    expect(selected?.id).toBe('sess-0');
    ui.unmount();
  });

  it('applies queued Down before Enter and selects once', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const selections: Session[] = [];
    const ui = renderList(sessions, {
      onSelect: (session) => selections.push(session),
    });
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(selections.map(({ id }) => id)).toEqual(['sess-1']);
    ui.unmount();
  });

  it('applies a queued filter before Enter and selects its first match once', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const selections: Session[] = [];
    const ui = renderList(sessions, {
      onSelect: (session) => selections.push(session),
    });
    await flushEffects();

    ui.stdin.write('char');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(selections.map(({ id }) => id)).toEqual(['sess-2']);
    ui.unmount();
  });

  it(
    'y copies the highlighted session once and leaves the filter unchanged',
    async () => {
      const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
      const ui = renderList(sessions);
      await flushEffects();

      ui.stdin.write(ARROW_DOWN);
      await flushEffects();
      ui.stdin.write('y');
      await vi.waitFor(
        () => {
          expect(readClipboardExecCalls().at(-1)?.stdin).toBe('bravo');
        },
        { timeout: CLIPBOARD_EXEC_WAIT_MS },
      );

      expect(readClipboardExecCalls()).toHaveLength(1);
      expect(selected).toBeNull();
      expect(closed).toBe(0);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('alpha');
      expect(frame).toContain('bravo');
      expect(frame).toContain('charlie');
      expect(frame).not.toContain('No matching sessions');
      ui.unmount();
    },
    CLIPBOARD_TEST_TIMEOUT_MS,
  );

  it(
    'commits queued copy then select exactly once each',
    async () => {
      const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
      const selections: Session[] = [];
      const ui = renderList(sessions, {
        onSelect: (session) => selections.push(session),
      });
      await flushEffects();

      ui.stdin.write('y');
      await flushEffects();
      ui.stdin.write(ENTER);
      await vi.waitFor(
        () => {
          expect(readClipboardExecCalls().map(({ stdin }) => stdin)).toEqual(['alpha']);
          expect(selections.map(({ id }) => id)).toEqual(['sess-0']);
        },
        { timeout: CLIPBOARD_EXEC_WAIT_MS },
      );

      expect(closed).toBe(0);
      ui.unmount();
    },
    CLIPBOARD_TEST_TIMEOUT_MS,
  );

  it(
    'commits queued copy then Escape close exactly once each',
    async () => {
      const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
      const selections: Session[] = [];
      const ui = renderList(sessions, {
        onSelect: (session) => selections.push(session),
      });
      await flushEffects();

      ui.stdin.write('y');
      await flushEffects();
      ui.stdin.write(ESC);
      await vi.waitFor(
        () => {
          expect(readClipboardExecCalls().map(({ stdin }) => stdin)).toEqual(['alpha']);
          expect(closed).toBe(1);
        },
        { timeout: CLIPBOARD_EXEC_WAIT_MS },
      );

      expect(selections).toHaveLength(0);
      ui.unmount();
    },
    CLIPBOARD_TEST_TIMEOUT_MS,
  );

  it('keeps the focused row clean with no per-row "y copy" affordance', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderList(sessions);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('y copy');
    const focusedRow = lineIndexContaining(frame, FOCUS_BAR);
    expect(focusedRow).toBe(lineIndexContaining(frame, 'alpha'));
    expect(frame.split('\n')[focusedRow]).not.toContain('y copy');
    ui.unmount();
  });

  it('opens the clicked session by logical row key', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderList(sessions);
    await flushEffects();

    await vi.waitFor(() => {
      expect(collectClickableZones(VIEWPORT).has('recent-session:sess-1')).toBe(true);
    });
    collectClickableZones(VIEWPORT).get('recent-session:sess-1')?.();
    await flushEffects();

    expect(selected?.id).toBe('sess-1');
    expect(selected?.feature).toBe('bravo');
    expect(closed).toBe(0);
    ui.unmount();
  });

  it('y does not copy when no session row is visible in the list budget', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderList(sessions, { maxVisible: 0 });
    await flushEffects();

    ui.stdin.write('y');
    await flushEffects();

    expect(readClipboardExecCalls()).toHaveLength(0);
    ui.unmount();
  });

  it('does not copy or filter on modified y input', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderList(sessions);
    await flushEffects();

    ui.stdin.write(KITTY_SUPER_Y);
    await flushEffects();
    ui.stdin.write(KITTY_HYPER_Y);
    await flushEffects();

    expect(readClipboardExecCalls()).toHaveLength(0);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('bravo');
    expect(frame).toContain('charlie');
    ui.unmount();
  });

  it('with hasOverlay=true, Down/Enter/Esc are no-ops', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderList(sessions, { hasOverlay: true });
    await flushEffects();

    const before = lineIndexContaining(ui.lastFrame() ?? '', FOCUS_BAR);

    await flushEffects();
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
