import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { Session } from '../../core/schemas/session.js';
import { SessionsPicker } from './picker.js';
import { tick } from '#testing/helpers/ink.js';

let tmp: string;

function writeSessionSummary(projectDir: string, session: Session): void {
  const dir = join(projectDir, DIPTYCH_DIR, 'sessions', session.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(session));
}

beforeEach(() => {
  tmp = createTempDir('sessions-picker-test');
  sessionsStore.reset();
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  feedbackStore.reset();
  // Seed configStore with a real tmpDir projectDir via real load (defaults ok).
  configStore.load(tmp);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  sessionsStore.reset();
  configStore.reset();
  overlayStore.reset();
  routerStore.reset();
  feedbackStore.reset();
});

describe('SessionsPicker', () => {
  it('renders session feature names from disk once the store loads them', async () => {
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-alpha',
        feature: 'add authentication',
        status: 'interrupted',
        summary: null,
      }),
    );
    writeSessionSummary(
      tmp,
      makeSession({
        id: 'sess-beta',
        feature: 'refactor payments',
        status: 'interrupted',
        summary: null,
      }),
    );

    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    // User-observable: the features appear in the rendered frame.
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('add authentication');
    expect(frame).toContain('refactor payments');
    // Title reflects the number of sessions loaded from disk.
    expect(frame).toContain('(2)');

    instance.unmount();
  });

  it('shows an empty-state hint when there are no sessions on disk', async () => {
    const instance = render(<SessionsPicker />);
    await tick(1);
    await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('(0)');
    expect(frame.toLowerCase()).toMatch(/no.*sessions/);

    instance.unmount();
  });
});
