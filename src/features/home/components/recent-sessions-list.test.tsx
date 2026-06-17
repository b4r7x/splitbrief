import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { CURSOR } from '../../../components/pickers/cursor-glyph.js';
import type { Session } from '../../../core/schemas/session.js';
import { RecentSessionsList } from './recent-sessions-list.js';

const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const CURSOR_GLYPH = CURSOR.trimEnd();

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
    resetAllStores();
    selected = null;
    closed = 0;
  });

  afterEach(() => {
    resetAllStores();
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
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Recent sessions');
    expect(frame).toContain('alpha');
    expect(frame).toContain('bravo');
    expect(frame).toContain('charlie');
    expect(frame).not.toContain('navigate');
    expect(frame).not.toContain('Enter resume');
    expect(frame).not.toContain('Esc back');
    expect(frame).toContain(CURSOR_GLYPH);
    expect(lineIndexContaining(frame, CURSOR_GLYPH)).toBe(lineIndexContaining(frame, 'alpha'));
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
    await tick(20);

    const nonBlank = (ui.lastFrame() ?? '').split('\n').filter((line) => line.trim().length > 0);
    expect(nonBlank.length).toBeLessThanOrEqual(5);
    ui.unmount();
  });

  it('Down moves the cursor to a later row and wraps from the last row back to the first', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await tick(20);

    const firstRow = lineIndexContaining(ui.lastFrame() ?? '', 'alpha');
    const before = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    const after = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);
    expect(after).toBeGreaterThan(before);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    ui.stdin.write(ARROW_DOWN);
    await tick(20);

    const wrapped = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);
    expect(wrapped).toBe(firstRow);
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
    await tick(20);

    const before = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);

    ui.stdin.write(ARROW_UP);
    await tick(20);

    expect(closed).toBe(1);
    expect(selected).toBeNull();
    expect(lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH)).toBe(before);
    ui.unmount();
  });

  it('Enter selects the currently highlighted row (not always index 0) and does not call onClose', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await tick(20);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect(selected?.id).toBe(sessions[1]?.id);
    expect(closed).toBe(0);
    ui.unmount();
  });

  it('Esc calls onClose', async () => {
    const sessions = makeSessions(['alpha', 'bravo', 'charlie']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await tick(20);

    ui.stdin.write(ESC);
    await tick(20);

    expect(closed).toBe(1);
    expect(selected).toBeNull();
    ui.unmount();
  });

  it('filters rows by typed text and resets the cursor to the first match', async () => {
    const sessions = makeSessions(['alpha task', 'beta task', 'gamma task']);
    const ui = renderWithOutdentRoom(
      <RecentSessionsList
        sessions={sessions}
        hasOverlay={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await tick(20);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);

    ui.stdin.write('gamma');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('gamma task');
    expect(frame).not.toContain('alpha task');
    expect(frame).not.toContain('beta task');
    expect(lineIndexContaining(frame, CURSOR_GLYPH)).toBe(lineIndexContaining(frame, 'gamma task'));
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
    await tick(20);

    const before = lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH);

    ui.stdin.write(ARROW_DOWN);
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);
    ui.stdin.write(ESC);
    await tick(20);

    expect(lineIndexContaining(ui.lastFrame() ?? '', CURSOR_GLYPH)).toBe(before);
    expect(selected).toBeNull();
    expect(closed).toBe(0);
    ui.unmount();
  });
});
