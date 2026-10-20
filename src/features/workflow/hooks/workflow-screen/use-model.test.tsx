import { plainUserMessage } from '../../../../core/types/user-input.js';
import { useEffect } from 'react';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { taskId } from '../../../../core/schemas/task.js';
import { saveState } from '../../../../core/state/persistence.js';
import { sessionDir } from '../../../../core/paths.js';
import { writeLockfile } from '../../../../core/sessions/lockfile.js';
import { HEARTBEAT_STALENESS_MS } from '../../../../core/sessions/lockfile-status.js';
import { LOCKFILE_PING_INTERVAL_MS } from '../../../../engine/orchestrator/run/heartbeat.js';
import { glyph } from '../../../../lib/glyphs.js';
import { routerStore } from '../../../../stores/navigation/router.js';
import { feedbackStore } from '../../../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { addEvent } from '../../../../stores/workflow/actions/event.js';
import { hydrateFromState } from '../../../../stores/workflow/actions/hydrate.js';
import { recoveryNoticeStore } from '../../../../stores/workflow/recovery-notice.js';
import { stopStore } from '../../../../stores/workflow/stop.js';
import { departureStore } from '../../../../stores/workflow/departure.js';
import {
  activeApply,
  trackActiveApply,
} from '../../../../engine/orchestrator/session-lifecycle/shutdown.js';
import { Rail } from '../../components/rail.js';
import { clearAllHandlers } from '../../handlers.js';
import { useWorkflowScreen } from './use-model.js';

type Model = ReturnType<typeof useWorkflowScreen>;

function Harness({ capture }: { capture: { current: Model | null } }) {
  const model = useWorkflowScreen({
    onRuntimeCommand: () => {},
    deps: { runWorkflow: () => new Promise(() => {}) },
  });
  useEffect(() => {
    capture.current = model;
  });
  return <Text>ready</Text>;
}

function requireModel(capture: { current: Model | null }): Model {
  if (capture.current === null) throw new Error('expected the workflow screen model');
  return capture.current;
}

describe('useWorkflowScreen while a brief is parked', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    clearAllHandlers();
    projectDir = createTempDir('use-model-parked');
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord(),
      execution: {
        kind: 'local',
        prepared: prepareWorkflowExecution({
          projectDir,
          feature: 'parked feature',
          config: makeConfig(),
          sessionId: 'use-model-session',
        }),
      },
    });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it.each([
    ['mid-brief', 'stop-now'],
    ['boundary', 'pause-after-brief'],
  ] as const)('blank enter at a %s park resumes the run like /resume', async (kind, intent) => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const steer = vi.fn();
    stopStore.request(intent);
    stopStore.park(kind, 'T004', steer);
    await tick();

    requireModel(capture).onEmptySubmit?.();

    expect(steer).toHaveBeenCalledWith(plainUserMessage(''));
    expect(stopStore.get().phase).toBe('idle');
    expect(feedbackStore.get().isError).toBe(false);
    ui.unmount();
  });

  it('typed instructions steer the parked brief and resume it', async () => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const steer = vi.fn();
    stopStore.request('stop-now');
    stopStore.park('mid-brief', 'T002', steer);
    await tick();

    requireModel(capture).handleInput(plainUserMessage('use the other adapter'));

    expect(steer).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    expect(stopStore.get().phase).toBe('idle');
    ui.unmount();
  });
});

// A run stopped inside Apply is continued: the screen turns local while the engine is still on its
// way to `workflow_resumed`. The rail the run rested with stands until the engine speaks.
describe('useWorkflowScreen continuing a run stopped at Apply', () => {
  const DONE = glyph('stageDone');
  let projectDir = '';

  function RailHarness({ capture }: { capture: { current: Model | null } }) {
    const model = useWorkflowScreen({
      onRuntimeCommand: () => {},
      deps: { runWorkflow: () => new Promise(() => {}) },
    });
    useEffect(() => {
      capture.current = model;
    });
    return <Rail form="B" {...(model.railStages !== undefined && { stages: model.railStages })} />;
  }

  beforeEach(() => {
    resetAllStores();
    clearAllHandlers();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    projectDir = createTempDir('use-model-apply-continue');
    const ref = { projectDir, sessionId: 'applying-interrupted' };
    const state = makeWorkflowState({
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'staged-copy',
        path: `${projectDir}/workspace`,
        base: { snapshotId: 'workspace-base', head: null },
      },
      applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'backup-interrupted' },
    });
    saveState(ref, state);
    // The replay of the run's history, as a continue lays it on the stores before the screen turns local.
    addEvent({ type: 'workflow_complete', ts: 1, phase: 'complete', review: 'passed' });
    hydrateFromState(state);
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({
        ref,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'apply' },
        },
        hydration: { kind: 'loaded', state },
      }),
      execution: {
        kind: 'local',
        prepared: prepareWorkflowExecution({
          projectDir,
          feature: 'Recover Apply',
          config: makeConfig(),
          sessionId: ref.sessionId,
          resumeState: state,
        }),
      },
    });
  });

  afterEach(() => {
    clearAllHandlers();
    recoveryNoticeStore.reset();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('keeps the Apply stage on the rail before the engine resumes the run', async () => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<RailHarness capture={capture} />);
    await tick();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    for (const label of ['Plan', 'Build', 'Review']) expect(frame).toContain(`${DONE} ${label}`);
    expect(frame).toContain('Apply');
    ui.unmount();
  });

  it('hands the rail to the live run at its first event, and keeps it there after Apply ends', async () => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<RailHarness capture={capture} />);
    await tick();

    addEvent({ type: 'workflow_resumed', ts: 2, phase: 'complete', inProcess: true });
    await tick();
    expect(requireModel(capture).railStages).toBeUndefined();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${DONE} Apply`);

    addEvent({ type: 'workflow_complete', ts: 3, phase: 'complete', review: 'passed' });
    await tick();
    expect(requireModel(capture).railStages).toBeUndefined();
    ui.unmount();
  });

  it('shows the live rail at once on a continue that does not resume into Apply', async () => {
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('expected the workflow route');
    routerStore.navigate({
      to: 'workflow',
      execution: route.execution,
      run: {
        ...route.run,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 1 },
        },
      },
    });
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<RailHarness capture={capture} />);
    await tick();

    expect(requireModel(capture).railStages).toBeUndefined();
    ui.unmount();
  });

  it('hands the rail to the halt the recovery menu opens', async () => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<RailHarness capture={capture} />);
    await tick();

    recoveryNoticeStore.open({
      seat: null,
      resetAt: null,
      issue: makeRecoveryIssue({ reason: 'apply-partial', phase: 'complete' }),
      at: { kind: 'apply' },
    });
    await tick();
    expect(requireModel(capture).railStages).toBeUndefined();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('statusFailed')} Apply`);
    ui.unmount();
  });

  it('reads the live run as applying while its Apply writes, and Enter queues home behind it', async () => {
    const capture: { current: Model | null } = { current: null };
    const ui = renderFeature(<RailHarness capture={capture} />);
    await tick();
    expect(requireModel(capture).applying).toBe(false);

    const apply = Promise.withResolvers<void>();
    void trackActiveApply(apply.promise);
    onTestFinished(async () => {
      apply.resolve();
      await activeApply();
    });
    await tick();

    const model = requireModel(capture);
    expect(model.atRestRecord).toBeUndefined();
    expect(model.applying).toBe(true);
    expect(model.inputHint).toBe('/ for a command · ⏎ for home when Apply finishes…');
    expect(model.commandsOnly).toBe(true);
    model.onEmptySubmit?.();
    expect(departureStore.get()?.kind).toBe('home');
    expect(routerStore.get().screen).toBe('workflow');

    apply.resolve();
    await activeApply();
    await tick();
    expect(requireModel(capture).applying).toBe(false);
    ui.unmount();
  });
});

// Another process owns the run on screen. When that owner stops answering without a word on disk
// (killed, or hung), no watched file changes, so only the screen's own check can see it.
describe('useWorkflowScreen at rest on a run another process owns', () => {
  let projectDir = '';

  beforeEach(async () => {
    resetAllStores();
    clearAllHandlers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    projectDir = createTempDir('use-model-owner-gone');
    const ref = { projectDir, sessionId: 'owned-elsewhere' };
    saveState(ref, makeWorkflowState({ phase: 'implementing' }));
    await writeLockfile(sessionDir(projectDir, ref.sessionId), {
      pid: process.pid,
      startTimeMs: 0,
      lastAliveMs: Date.now(),
      sessionId: ref.sessionId,
      feature: 'owned elsewhere',
    });
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref, status: { kind: 'running' } }),
      execution: { kind: 'at-rest' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAllHandlers();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('reads the run again once its owner stops answering, with no file change', async () => {
    const capture: { current: Model | null } = { current: null };
    const seeded = routerStore.get();
    const ui = renderFeature(<Harness capture={capture} />);
    // The mount read sees the owner alive.
    await vi.waitFor(() => expect(routerStore.get()).not.toBe(seeded));
    const statusKind = () => {
      const route = routerStore.get();
      return route.screen === 'workflow' ? route.run.status.kind : undefined;
    };
    expect(statusKind()).toBe('running');

    vi.advanceTimersByTime(HEARTBEAT_STALENESS_MS + LOCKFILE_PING_INTERVAL_MS);

    await vi.waitFor(() => expect(statusKind()).toBe('open'));
    ui.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
