import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { configStore } from '../../../stores/project/config.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { CURSOR } from '../../../components/pickers/cursor-glyph.js';
import { RecentSessions } from './recent-sessions.js';

const CURSOR_GLYPH = CURSOR.trimEnd();

function lineContaining(frame: string, text: string): string {
  const line = frame.split('\n').find((candidate) => candidate.includes(text));
  expect(line).toBeDefined();
  return line ?? '';
}

describe('RecentSessions', () => {
  let projectDir = '';

  function seed(features: { id: string; feature: string; startedAt: number }[]): void {
    for (const { id, feature, startedAt } of features) {
      saveSummary({ projectDir, sessionId: id }, makeSession({ id, feature, startedAt }));
    }
    sessionsStore.load(projectDir);
  }

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('recent-sessions-test');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('unfocused render shows the header and plain rows with no cursor and no hint line', async () => {
    seed([
      { id: 'r-alpha', feature: 'alpha', startedAt: 1_700_000_001 },
      { id: 'r-bravo', feature: 'bravo', startedAt: 1_700_000_002 },
    ]);

    const ui = renderFeature(<RecentSessions />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Recent sessions');
    expect(frame).toContain('alpha');
    expect(frame).toContain('bravo');
    expect(frame).not.toContain(CURSOR_GLYPH);
    expect(frame).not.toContain('Esc back');
    expect(lineContaining(frame, 'alpha')).toMatch(/^○ alpha/);
    ui.unmount();
  });

  it('renders the empty state and neither header nor rows when no sessions are loaded', async () => {
    sessionsStore.load(projectDir);

    const ui = renderFeature(<RecentSessions />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('no recent sessions');
    expect(frame).not.toContain('Recent sessions');
    ui.unmount();
  });

  it("caps to `limit` rows and shows a '+N more' line with the correct hidden count; omits it when limit covers all", async () => {
    seed([
      { id: 's-0', feature: 'oldest-row', startedAt: 1_700_000_000 },
      { id: 's-1', feature: 'old-row', startedAt: 1_700_000_001 },
      { id: 's-2', feature: 'mid-row', startedAt: 1_700_000_002 },
      { id: 's-3', feature: 'new-row', startedAt: 1_700_000_003 },
      { id: 's-4', feature: 'newest-row', startedAt: 1_700_000_004 },
    ]);

    const capped = renderFeature(<RecentSessions limit={2} />);
    await tick(20);

    const cappedFrame = capped.lastFrame() ?? '';
    expect(cappedFrame).toContain('newest-row');
    expect(cappedFrame).toContain('new-row');
    expect(cappedFrame).not.toContain('mid-row');
    expect(cappedFrame).not.toContain('old-row');
    expect(cappedFrame).not.toContain('oldest-row');
    expect(cappedFrame).toContain('+3 more');
    capped.unmount();

    const full = renderFeature(<RecentSessions limit={10} />);
    await tick(20);

    const fullFrame = full.lastFrame() ?? '';
    expect(fullFrame).not.toMatch(/\+\d+ more/);
    for (const label of ['newest-row', 'new-row', 'mid-row', 'old-row', 'oldest-row']) {
      expect(fullFrame).toContain(label);
    }
    full.unmount();
  });

  it('a resize that changes limit but keeps it positive does not re-read the sessions directory', async () => {
    saveSummary(
      { projectDir, sessionId: 'rs-first' },
      makeSession({ id: 'rs-first', feature: 'first', startedAt: 1_700_000_000 }),
    );

    const ui = renderFeature(<RecentSessions limit={5} />);
    await tick(20);
    expect(sessionsStore.get().sessions.map((s) => s.id)).toEqual(['rs-first']);

    saveSummary(
      { projectDir, sessionId: 'rs-second' },
      makeSession({ id: 'rs-second', feature: 'second', startedAt: 1_700_000_001 }),
    );

    ui.rerender(<RecentSessions limit={4} />);
    await tick(20);

    expect(sessionsStore.get().sessions.map((s) => s.id)).toEqual(['rs-first']);
    ui.unmount();
  });

  it('limit<=0 renders null and skips the load effect', async () => {
    seed([{ id: 'hidden-one', feature: 'should-not-load', startedAt: 1_700_000_000 }]);
    sessionsStore.reset();

    const ui = renderFeature(<RecentSessions limit={0} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('Recent sessions');
    expect(frame).not.toContain('no recent sessions');
    expect(frame).not.toContain('should-not-load');
    expect(sessionsStore.get().sessions.length).toBe(0);
    ui.unmount();
  });

  it('focused with onSelect+onClose keeps a capped viewport but filters across all sessions', async () => {
    seed([
      { id: 'f-0', feature: 'oldest-focus', startedAt: 1_700_000_000 },
      { id: 'f-1', feature: 'old-focus', startedAt: 1_700_000_001 },
      { id: 'f-2', feature: 'mid-focus', startedAt: 1_700_000_002 },
      { id: 'f-3', feature: 'new-focus', startedAt: 1_700_000_003 },
      { id: 'f-4', feature: 'newest-focus', startedAt: 1_700_000_004 },
    ]);

    const ui = renderFeature(
      <Box marginLeft={2}>
        <RecentSessions
          focused
          limit={2}
          onSelect={() => {}}
          onClose={() => {}}
          hasOverlay={false}
        />
      </Box>,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('Esc back');
    expect(frame).toContain(CURSOR_GLYPH);
    expect(frame).toContain('newest-focus');
    expect(frame).toContain('new-focus');
    expect(frame).not.toContain('mid-focus');
    expect(frame).not.toContain('old-focus');
    expect(frame).not.toContain('oldest-focus');

    ui.stdin.write('oldest');
    await tick(20);

    const filteredFrame = ui.lastFrame() ?? '';
    expect(filteredFrame).toContain('oldest-focus');
    expect(filteredFrame).not.toContain('newest-focus');
    ui.unmount();
  });

  it('focused but missing onSelect/onClose falls back to the unfocused render', async () => {
    seed([
      { id: 'g-alpha', feature: 'alpha', startedAt: 1_700_000_001 },
      { id: 'g-bravo', feature: 'bravo', startedAt: 1_700_000_002 },
    ]);

    const ui = renderFeature(<RecentSessions focused />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Recent sessions');
    expect(frame).not.toContain(CURSOR_GLYPH);
    expect(frame).not.toContain('Esc back');
    ui.unmount();
  });
});
