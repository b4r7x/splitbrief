import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../../core/phases.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { appendProtectedEngineEvent } from '../../../core/sessions/log-writer.js';
import { RewindEventSchema } from '../../../core/state/rewind-event.js';
import { readRunEvents } from '../../events/replay.js';
import { abortError } from '../../../utils/abort.js';
import { transitionAndSave } from '../state-ops.js';
import { runWorkflow } from './workflow.js';
import { typedCallAnswering } from '#testing/helpers/typed-planner.js';

describe('rewind during a planner call', () => {
  let projectDir = '';

  afterEach(() => {
    if (projectDir) cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('keeps the rewound state without a transient stop or interruption row', async () => {
    projectDir = createTempDir('workflow-rewind-stop-');
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    const ref = { projectDir, sessionId: 'rewind-in-call' };
    ensureSessionDir(projectDir, ref.sessionId);
    const state = {
      ...createInitialState('Rewind during planning'),
      phase: 'planning' as const,
      mode: 'quick' as const,
      approve: 'none' as const,
      changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
    };
    saveState(ref, state);
    const prepared = makePreparedExecution({
      ...ref,
      feature: state.feature,
      resumeState: state,
      active: reactivateExistingSession(ref),
      config: makeConfig({
        workflow: { approve: 'none' },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        planner: {
          kind: 'shell',
          command: process.execPath,
          args: ['-e', ''],
          outputFormat: 'text',
        },
        implementer: {
          kind: 'shell',
          model: 'fixture',
          command: process.execPath,
          args: ['-e', ''],
          outputFormat: 'text',
        },
      }),
    });
    const controller = new AbortController();
    let rewound = false;
    await runWorkflow({
      prepared,
      sinks: TEST_SINKS,
      callbacks: makeCallbacks().callbacks,
      signal: controller.signal,
      _planner: makePlanner({
        typedCall: typedCallAnswering(() => {
          const current = loadState(ref);
          if (current === null) throw new Error('missing planner state');
          transitionAndSave(ref, current, { type: 'REWIND_TO_SPEC', comment: 'revisit spec' });
          appendProtectedEngineEvent(
            ref,
            {
              type: 'rewind_to_spec',
              ts: Date.now(),
              phase: current.phase,
              comment: 'revisit spec',
            },
            RewindEventSchema,
          );
          rewound = true;
          controller.abort(WORKFLOW_REWIND_ABORT_REASON);
          throw abortError(controller.signal);
        }),
      }),
      _implementer: makeImplementer(),
    });
    expect(rewound).toBe(true);
    const saved = loadState(ref);
    expect(saved?.rewindPending).toEqual({ target: 'spec', comment: 'revisit spec' });
    expect(saved?.interruptedStep).toBeUndefined();
    expect(readRunRecord(ref)?.status.kind).toBe('open');
    const events = (await readRunEvents(ref)).events;
    expect(events.some((event) => event.type === 'rewind_to_spec')).toBe(true);
    expect(events.some((event) => event.type === 'turn_interrupted')).toBe(false);
    expect(existsSync(join(projectDir, '.git', 'index'))).toBe(false);
    expect(readdirSync(join(projectDir, '.git', 'objects'))).toEqual(['info', 'pack']);
  });
});
