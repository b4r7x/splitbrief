import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import {
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { readConfigDocument } from '../../../core/config/load/document.js';
import { saveState } from '../../../core/state/persistence.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import {
  readSeatIdentities,
  recordSeatIdentities,
  reconcileSeatIdentities,
  seatIdentitiesFromConfig,
} from '../../../core/state/seats.js';
import type { EngineEvent } from '../../events/types.js';
import type { ResumeContextHolder } from '../types.js';
import { initializeWorkflow } from '../run/init.js';
import { createRecoveryBus } from './bus.js';
import { switchSeatAndPrepareResume } from './switch-seat-resume.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('recorded seat switch reconciliation', () => {
  it.each([
    ['plan', false],
    ['build', false],
    ['review', false],
    ['plan', true],
    ['build', true],
    ['review', true],
  ] as const)('reconciles a %s switch with auto=%s during resume init', async (seat, auto) => {
    const projectDir = createTempDir('switch-seat-record');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'seat-record' };
    ensureSessionDir(projectDir, ref.sessionId);
    const runner = { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol' } as const;
    const config = makeConfig({ planner: runner, implementer: runner, reviewer: runner });
    writeConfig(projectDir, config);
    recordSeatIdentities(ref, config);
    const configRevision = readConfigDocument(projectDir).revision?.rawSha256;
    if (configRevision === undefined) throw new Error('Expected config revision');
    const candidate = { tool: 'claude-code', model: 'sonnet' };
    const task = makeTask();
    const state = makeImplState([task], {
      plannerSessionId: 'native-session-from-primary',
      pendingRecovery: makeRecoveryIssue({
        reason: 'runner-usage-limit',
        taskId: task.id,
        availableActions: ['switch-seat'],
        recommendedAction: 'switch-seat',
        switchSeat: {
          seat,
          candidates: [candidate],
          ...(auto ? { auto: { candidate, configRevision } } : {}),
        },
      }),
    });
    saveState(ref, state);
    appendMessage(ref, { role: 'user', phase: state.phase, text: state.feature });
    const events: EngineEvent[] = [];
    const bus = createRecoveryBus({ ...ref, sink: (event) => events.push(event) });
    const result = await switchSeatAndPrepareResume({
      ...ref,
      state,
      config,
      candidate,
      bus,
      signal: new AbortController().signal,
      policy: {
        purpose: 'resume',
        interaction: 'headless',
        allowRepoRunners: false,
        allowHooks: false,
        unverifiedAuth: 'denied',
      },
      prepare: async (input) => ({
        kind: 'prepared',
        execution: makePreparedExecution({
          ...ref,
          feature: state.feature,
          config: input.effectiveConfig,
          purpose: 'resume',
        }),
      }),
    });
    if (result.kind !== 'switched') throw new Error('Expected seat switch');
    expect(events.filter((event) => event.type === 'seat_switched')).toHaveLength(1);
    const seatsBeforeInit = readSeatIdentities(ref);
    const planner = makePlanner();
    planner.capabilities.supportsSessionResume = true;
    const resumeHolder: ResumeContextHolder = { messages: [] };
    const init = await initializeWorkflow({
      opts: {
        prepared: result.preparation.execution,
        callbacks: makeCallbacks().callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        _planner: planner,
        _reviewer: planner,
        _implementer: makeImplementer(),
        _eventSink: (event) => events.push(event),
      },
      config: result.config,
      sessionId: ref.sessionId,
      summaryBase: {
        ...ref,
        feature: state.feature,
        startTime: Date.now(),
        plannerTool: 'test-planner',
        implementerTool: 'test-implementer',
      },
      metadata: {
        planner: 'test-planner · auto',
        implementer: 'test-implementer · auto',
        reviewer: 'test-planner · auto',
      },
      setTrackedState: () => {},
      resumeHolder,
      isolation: makeCopyingIsolation(ref),
      savedState: result.state,
    });
    if (!init.ok) throw new Error('Expected resume init');
    expect(init.state.plannerSessionId).toBe(
      seat === 'plan' ? null : 'native-session-from-primary',
    );
    if (seat === 'plan') {
      expect(resumeHolder.messages).toContainEqual(
        expect.objectContaining({ role: 'user', content: state.feature }),
      );
    } else {
      expect(resumeHolder.messages).toEqual([]);
    }
    expect(seatsBeforeInit).toEqual(seatIdentitiesFromConfig(config));
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(result.config));
    expect(
      events.filter((event) => event.type === 'warning' && /seat changed/.test(event.message)),
    ).toEqual([]);
    expect(reconcileSeatIdentities(ref, result.config)).toEqual([]);
    expect(reconcileSeatIdentities(ref, config).map((change) => change.seat)).toEqual([seat]);
  });
});
