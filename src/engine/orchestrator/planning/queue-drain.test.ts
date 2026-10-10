import { afterEach, describe, expect, it } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeMessage, makeStateWithQueue, setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { drainAndFormat } from './queue-drain.js';
import { saveState } from '../../../core/state/persistence.js';
import { transitionAndSave } from '../state-ops.js';
import { trackMidCallDelivery } from '../queue/mid-call.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

describe('drainAndFormat', () => {
  it('waits for a mid-call outcome before reading the planning queue', async () => {
    const ref = setupProject(dirs);
    const { bus } = makeBusRecorder();
    const state = makeStateWithQueue([makeMessage('already sent live')]);
    saveState(ref, state);
    const ack = Promise.withResolvers<void>();
    trackMidCallDelivery(
      ref,
      'msg-test',
      ack.promise.then(() => {
        transitionAndSave(ref, state, { type: 'MARK_DELIVERED_NATIVE', id: 'msg-test' });
      }),
    );

    const pending = drainAndFormat(ref.projectDir, ref.sessionId, state, bus);
    ack.resolve();
    expect((await pending).messages).toEqual([]);
  });

  it('publishes the plan seat when formatting a planning message', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();

    const result = await drainAndFormat(
      projectDir,
      sessionId,
      makeStateWithQueue([makeMessage('use UTC everywhere')]),
      bus,
    );

    expect(result.prefix).toContain('use UTC everywhere');
    expect(result.messages).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'queue_drained', seat: 'plan' }));
  });
});
