import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionsStore } from './sessions.js';
import { saveSummary } from '../../core/sessions/io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';

let tmp: string;

afterEach(() => {
  sessionsStore.__testReset();
  if (tmp) cleanupTempDir(tmp);
});

describe('sessionsStore.refresh', () => {
  it('tells no one when the runs on disk did not change, and tells them once a run did', () => {
    tmp = createTempDir('sessions-store-test');
    const ref = { projectDir: tmp, sessionId: '2024-01-01-run' };
    saveSummary(ref, makeSession({ id: ref.sessionId, feature: 'before' }));
    sessionsStore.load(tmp);
    const listener = vi.fn();
    const unsubscribe = sessionsStore.subscribe(listener);

    sessionsStore.refresh();
    expect(listener).not.toHaveBeenCalled();

    saveSummary(ref, makeSession({ id: ref.sessionId, feature: 'after the change' }));
    sessionsStore.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sessionsStore.get().sessions[0]?.feature).toBe('after the change');
    unsubscribe();
  });
});
