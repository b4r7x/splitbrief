import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeResearchingState, setupProject } from '#testing/helpers/queue.js';
import { makeCtx, runCommandInTest } from '#testing/helpers/runtime-commands.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createRuntimeCommands } from '../../../src/core/runtime/commands/registry.js';
import { phaseStage } from '../../../src/core/rail-stages.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { clearPendingQueue } from '../../../src/engine/orchestrator/queue/clear.js';
import {
  commitQueueMessagesDrained,
  drainQueueForReview,
  readQueueForPrompt,
} from '../../../src/engine/orchestrator/queue/drain.js';
import { enqueueUserMessage } from '../../../src/engine/orchestrator/queue/submit.js';
import { queueCopy } from '../../../src/features/workflow/queue-copy.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { hydrateFromState } from '../../../src/stores/workflow/actions/hydrate.js';
import { loadEvents } from '../../../src/stores/workflow/actions/load.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';

const dirs: string[] = [];

afterEach(() => {
  resetWorkflow();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('queue count across delivery and reopening', () => {
  it('keeps show, clear, replay and a fresh process consistent after REVIEW then BUILD', async () => {
    resetWorkflow();
    const ref = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    bus.subscribe(addEvent);
    const state = { ...makeResearchingState(), phase: 'final-review' as const };
    const reviewed = enqueueUserMessage({
      ...ref,
      state,
      message: plainUserMessage('keep this for the fix'),
      phase: 'final-review',
      bus,
    });
    let current = (await drainQueueForReview({ ...ref, state: reviewed.state, bus })).state;
    expect(lifecycleStore.get().queueDepth).toBe(0);
    const pending = enqueueUserMessage({
      ...ref,
      state: current,
      message: plainUserMessage('another message'),
      phase: 'implementing',
      bus,
    });
    current = pending.state;
    const message = current.messageQueue.find((queued) => queued.text === 'keep this for the fix');
    if (message === undefined) throw new Error('Missing reviewer history');
    const read = readQueueForPrompt({ ...ref, state: current, ids: [message.id] });
    const built = commitQueueMessagesDrained({
      ...ref,
      state: read.state,
      messages: read.messages,
      bus,
      seat: 'build',
    });
    current = built.state;
    expect(lifecycleStore.get().queueDepth).toBe(1);

    loadEvents(events);
    expect(lifecycleStore.get().queueDepth).toBe(1);
    const saved = loadState(ref);
    if (saved === null) throw new Error('Missing saved queue');
    hydrateFromState(saved);
    expect(lifecycleStore.get().queueDepth).toBe(1);
    const reopened = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { loadState } from './src/core/state/persistence.js';
       import { hydrateFromState } from './src/stores/workflow/actions/hydrate.js';
       import { lifecycleStore } from './src/stores/workflow/lifecycle.js';
       hydrateFromState(loadState(JSON.parse(process.argv[1])));
       process.stdout.write(String(lifecycleStore.get().queueDepth));`,
        JSON.stringify(ref),
      ],
      { encoding: 'utf8' },
    );
    expect(reopened).toBe('1');

    let feedback = '';
    const commands = createRuntimeCommands(
      makeCtx({
        getQueueCopy: (count) =>
          queueCopy({
            seat: phaseStage(current.phase),
            count: count ?? lifecycleStore.get().queueDepth,
          }),
        clearQueue: () => {
          const cleared = clearPendingQueue({ ...ref, state: current, bus });
          current = cleared.state;
          return { status: 'cleared', count: cleared.count };
        },
        setFeedbackMessage: (text) => {
          feedback = text;
        },
      }),
    );
    const command = (raw: string) =>
      runCommandInTest({
        commands,
        raw,
        screen: 'workflow',
        onError: (text) => {
          throw new Error(text);
        },
      });
    await command('/queue show');
    expect(feedback).toBe('1 queued for REVIEW');
    await command('/queue clear');
    expect(feedback).toBe('Cleared 1 queued message');
    expect(current.messageQueue.map((queued) => queued.id)).toEqual([message.id]);
    await command('/queue show');
    expect(feedback).toBe('Queue is empty');
    await command('/queue clear');
    expect(feedback).toBe('Queue is already empty');
  });
});
