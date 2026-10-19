import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text } from 'ink';
import { useAppKeys } from './keys.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import {
  parsePreparedConfig,
  type PreparationOutcome,
  type PreparedExecution,
} from '../engine/runners/prepared-execution.js';
import { createInitialState } from '../core/state/machine.js';
import { routerStore } from '../stores/navigation/router.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { stopStore } from '../stores/workflow/stop.js';
import { composerLiveStore } from '../stores/ui/composer-live.js';
import { createDraftDocument } from '../core/composer/document.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { completionStore } from '../stores/ui/completion.js';
import { controlsStore } from '../stores/ui/controls.js';
import { cancelEscapeAction } from '../lib/terminal/escape-debounce.js';
import * as handlers from '../features/workflow/handlers.js';
import {
  activeApply,
  trackActiveApply,
} from '../engine/orchestrator/session-lifecycle/shutdown.js';
import { approvalPromptStore, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import { continueRunInPlace, sessionSelectStore } from '../stores/navigation/session-select.js';
import { configStore } from '../stores/project/config.js';
import { skillsStore } from '../stores/project/skills.js';
import { SessionPreparation } from './session-preparation.js';
import { Composer } from '../components/composer/composer.js';
import { composerDraftStore } from '../stores/ui/composer-draft.js';
import { reviewKeysStore } from '../stores/ui/review-keys.js';
import { recoveryNoticeStore } from '../stores/workflow/recovery-notice.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';

// Comfortably past the escape-debounce defer (DEFAULT_DELAY_MS in escape-debounce.ts)
// so the deferred arm flushes without copying that module-private literal here.
const PAST_DEBOUNCE_MS = 100;

function localExecution(feature: string): { kind: 'local'; prepared: PreparedExecution } {
  const projectDir = '/tmp/splitbrief-app-keys';
  const preparationId = 'app-keys-preparation';
  const sessionId = 'app-keys-session';
  const active = {
    version: 1 as const,
    sessionId,
    generation: '11111111-1111-4111-8111-111111111111',
  };

  return {
    kind: 'local',
    prepared: {
      purpose: 'new-workflow',
      config: parsePreparedConfig(
        makeConfig({
          planner: {
            kind: 'api',
            provider: 'custom-endpoint',
            service: 'custom-endpoint',
            offering: 'payg',
            model: 'test-planner',
            apiBase: 'https://api.example.test/v1',
            apiKey: 'test-key',
            contextLength: 32_768,
          },
        }),
      ),
      preparationId,
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [
          {
            id: 'runners',
            title: 'Runners',
            checks: [
              { id: 'runner.planner', severity: 'ok', summary: 'Planner ready' },
              {
                id: 'runner.implementer.default',
                severity: 'ok',
                summary: 'Implementer ready',
              },
            ],
          },
        ],
        metadata: {},
      },
      gates: [
        {
          kind: 'api',
          slot: { role: 'planner' },
          preparationId,
          provider: 'custom-endpoint',
          endpointOrigin: 'https://api.example.test',
        },
        {
          kind: 'api',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          provider: 'ollama',
          endpointOrigin: 'http://localhost:11434',
        },
      ],
      session: {
        kind: 'new',
        ref: { projectDir, sessionId },
        ownership: active,
        active,
      },
      runtime: {
        feature,
        allowRepoRunners: false,
        allowHooks: false,
      },
    },
  };
}

function Harness({ exit }: { exit: () => void }) {
  useAppKeys({ exit });
  return (
    <Box>
      <Text>ready</Text>
    </Box>
  );
}

function SessionPreparationKeysHarness({ exit }: { exit: () => void }) {
  useAppKeys({ exit });
  return <SessionPreparation />;
}

async function writeCtrlC(ui: { stdin: { write: (d: string) => void } }) {
  await flushEffects();
  ui.stdin.write('\x03');
}

async function writeEsc(ui: { stdin: { write: (d: string) => void } }) {
  await flushEffects();
  ui.stdin.write('\x1b');
}

async function writeKey(ui: { stdin: { write: (d: string) => void } }, chars: string) {
  await flushEffects();
  ui.stdin.write(chars);
}

const STOP_LADDER_SETUP = () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(1000);
  resetAllStores();
  handlers.clearAllHandlers();
  routerStore.navigate({
    to: 'workflow',
    run: makeRunRecord(),
    execution: localExecution('test'),
  });
  lifecycleStore.__testReset({ phase: 'implementing' });
};

const STOP_LADDER_TEARDOWN = () => {
  cancelEscapeAction();
  completionStore.reset();
  handlers.clearAllHandlers();
  stopStore.__testReset();
  lifecycleStore.__testReset();
  vi.useRealTimers();
};

describe('useAppKeys: Ctrl+C', () => {
  beforeEach(STOP_LADDER_SETUP);
  afterEach(STOP_LADDER_TEARDOWN);

  it('ctrl+c performs stop now without arming', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeCtrlC(ui);
    await tick();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('queues the quit on the first press while this process applies the run, with no hint', async () => {
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ status: { kind: 'running' } }),
      execution: { kind: 'at-rest' },
    });
    const apply = Promise.withResolvers<void>();
    void trackActiveApply(apply.promise);
    onTestFinished(async () => {
      apply.resolve();
      await activeApply();
    });
    const exit = vi.fn();
    const deps = { requestQuit: vi.fn(), requestStopNow: vi.fn(), refreshSkills: vi.fn() };
    function ApplyHarness() {
      useAppKeys({ exit, deps });
      return <Text>ready</Text>;
    }
    const ui = renderFeature(<ApplyHarness />);
    await tick();

    await writeCtrlC(ui);
    await tick();

    expect(deps.requestQuit).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(deps.requestStopNow).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).not.toBe('Press ctrl+c again to quit');
    ui.unmount();
  });

  it('a second ctrl+c waits for one stop to finish and exits once', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeCtrlC(ui);
    await tick();
    await writeCtrlC(ui);
    await tick();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stopStore.markSettling();
    expect(exit).not.toHaveBeenCalled();
    stopStore.park('mid-brief', null, null);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    await writeCtrlC(ui);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it.each([
    'home',
    'idle',
    'parked',
    'parked with the session options',
    'parked without the session options',
  ] as const)('requires two Ctrl+C presses within two seconds when %s', async (state) => {
    if (state === 'home') routerStore.navigate({ to: 'home' });
    if (state === 'idle' || state.startsWith('parked '))
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord(),
        execution: { kind: 'at-rest' },
      });
    if (state === 'parked') stopStore.park('mid-brief', null, null);
    if (state.startsWith('parked ')) {
      stopStore.request('stop-now');
      stopStore.park('mid-brief', null, null);
    }
    if (state === 'parked with the session options') overlayStore.open('stop-sheet');
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeCtrlC(ui);
    await tick();
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBe('Press ctrl+c again to quit');
    vi.advanceTimersByTime(1900);
    await writeCtrlC(ui);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).not.toBe('end-run');
    ui.unmount();
  });

  it.each(['parked with the session options', 'parked without the session options'] as const)(
    're-arms quit after a Ctrl+C press outside the two-second window when %s',
    async (state) => {
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord(),
        execution: { kind: 'at-rest' },
      });
      stopStore.request('stop-now');
      stopStore.park('mid-brief', null, null);
      if (state === 'parked with the session options') overlayStore.open('stop-sheet');
      const exit = vi.fn();
      const ui = renderFeature(<Harness exit={exit} />);
      await tick();
      await writeCtrlC(ui);
      await tick();
      expect(exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2001);
      await writeCtrlC(ui);
      await tick();
      expect(exit).not.toHaveBeenCalled();
      expect(feedbackStore.get().message).toBe('Press ctrl+c again to quit');

      vi.advanceTimersByTime(1900);
      await writeCtrlC(ui);
      await tick();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(stopStore.get().intent).not.toBe('end-run');
      ui.unmount();
    },
  );

  // A terminal read late hands both presses to Ink in one chunk, which arrives as `\x03\x03` with
  // no ctrl flag. A run stopped at a gate sat parked behind its session options exactly like this.
  it.each([
    'home',
    'at rest',
    'parked with the session options',
    'parked without the session options',
  ] as const)('quits on two Ctrl+C presses read in one chunk when %s', async (state) => {
    if (state === 'home') routerStore.navigate({ to: 'home' });
    else
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord(),
        execution: { kind: 'at-rest' },
      });
    if (state.startsWith('parked')) {
      stopStore.request('stop-now');
      stopStore.park('mid-brief', null, null);
    }
    if (state === 'parked with the session options') overlayStore.open('stop-sheet');
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeKey(ui, '\x03\x03');
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('stops now on the first of two Ctrl+C presses read in one chunk and quits once it settles', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeKey(ui, '\x03\x03');
    await tick();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('stop-now');
    expect(exit).not.toHaveBeenCalled();
    stopStore.park('mid-brief', null, null);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('reads two Kitty-encoded Ctrl+C presses in one chunk as two presses', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeKey(ui, '\x1b[99;5u\x1b[99;5u');
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  // Text typed in the same late read shares the chunk with the presses. Each `\x03` in it is still
  // a press, and the text between presses clears the quit confirmation, as typing does.
  it.each(['home', 'at rest'] as const)(
    'quits on two Ctrl+C presses read in one chunk after typed text when %s',
    async (state) => {
      if (state === 'home') routerStore.navigate({ to: 'home' });
      else
        routerStore.navigate({
          to: 'workflow',
          run: makeRunRecord(),
          execution: { kind: 'at-rest' },
        });
      const exit = vi.fn();
      const ui = renderFeature(<Harness exit={exit} />);
      await tick();
      await writeKey(ui, 'fix\x03\x03');
      await tick();
      expect(exit).toHaveBeenCalledTimes(1);
      ui.unmount();
    },
  );

  it('stops now on typed text and two Ctrl+C presses read in one chunk and quits once it settles', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeKey(ui, 'fix\x03\x03');
    await tick();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stopStore.park('mid-brief', null, null);
    await tick();
    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('stops now on a Ctrl+C read in one chunk before typed text', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeKey(ui, '\x03fix');
    await tick();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('cancels the quit confirmation with text read between two Ctrl+C presses in one chunk', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeKey(ui, '\x03fix\x03');
    await tick();
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBe('Press ctrl+c again to quit');
    ui.unmount();
  });

  it('expires the idle quit hint after two seconds', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeCtrlC(ui);
    await tick();
    vi.advanceTimersByTime(2001);
    expect(feedbackStore.get().message).not.toBe('Press ctrl+c again to quit');
    await writeCtrlC(ui);
    await tick();
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBe('Press ctrl+c again to quit');
    ui.unmount();
  });

  it('cancels the idle quit confirmation on other input', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeCtrlC(ui);
    await tick();
    await writeKey(ui, 'x');
    await tick();
    expect(feedbackStore.get().message).not.toBe('Press ctrl+c again to quit');
    await writeCtrlC(ui);
    await tick();
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('preserves the second Ctrl+C confirmation when stopping settles at rest', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeCtrlC(ui);
    await tick();
    stopStore.park('mid-brief', null, null);
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('expected workflow');
    routerStore.updateRun({ run: route.run, execution: { kind: 'at-rest' } });
    await tick();
    await writeCtrlC(ui);
    await tick();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it.each(['another session', 'resumed work'] as const)(
    'clears an armed confirmation on %s without changing screens',
    async (transition) => {
      routerStore.navigate({
        to: 'workflow',
        run: makeRunRecord(),
        execution: { kind: 'at-rest' },
      });
      const exit = vi.fn();
      const ui = renderFeature(<Harness exit={exit} />);
      await tick();
      await writeCtrlC(ui);
      await tick();
      const abort = vi.fn();
      if (transition === 'resumed work') {
        handlers.createAbortHandlerScope()(abort);
        routerStore.navigate({
          to: 'workflow',
          run: makeRunRecord(),
          execution: localExecution('resumed'),
        });
      } else {
        routerStore.navigate({
          to: 'workflow',
          run: makeRunRecord({ ref: { projectDir: '/tmp/other-run', sessionId: 'other-run' } }),
          execution: { kind: 'at-rest' },
        });
      }
      await tick();
      expect(feedbackStore.get().message).not.toBe('Press ctrl+c again to quit');
      await writeCtrlC(ui);
      await tick();
      expect(exit).not.toHaveBeenCalled();
      if (transition === 'resumed work') expect(abort).toHaveBeenCalledTimes(1);
      ui.unmount();
    },
  );

  it('clears the confirmation when navigation opens a run', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeCtrlC(ui);
    await tick();
    routerStore.navigate({ to: 'workflow', run: makeRunRecord(), execution: { kind: 'at-rest' } });
    await tick();
    expect(feedbackStore.get().message).not.toBe('Press ctrl+c again to quit');
    await writeCtrlC(ui);
    await tick();
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });
});

describe('useAppKeys: ESC stop ladder', () => {
  beforeEach(STOP_LADDER_SETUP);
  afterEach(STOP_LADDER_TEARDOWN);

  it('esc opens the menu without touching the run or draft', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    composerLiveStore.setDraft(createDraftDocument('draft'));
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(abort).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(composerLiveStore.get().empty).toBe(false);
    ui.unmount();
  });

  it('esc on an empty composer opens the stop sheet', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(stopStore.get().intent).toBe('none');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('esc on question opens sheet', async () => {
    controlsStore.setInputMode('question');
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(lifecycleStore.get().cancelled).toBe(false);
    ui.unmount();
  });

  it('esc in the plan card comment returns to the card rows, and the next esc opens the sheet', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    controlsStore.setInputMode('review');
    const exit = vi.fn();
    const ui = renderFeature(
      <>
        <Harness exit={exit} />
        <Composer
          commands={[]}
          currentScreen="workflow"
          mode="review"
          hint=""
          onSubmit={() => {}}
          onRuntimeCommand={() => {}}
        />
      </>,
    );
    await tick();
    composerDraftStore.request('comment drop T003');
    await flushEffects();
    expect(reviewKeysStore.get().commenting).toBe(true);

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await flushEffects();

    expect(overlayStore.get().active).toBe('none');
    expect(composerLiveStore.get().empty).toBe(true);
    expect(reviewKeysStore.get().commenting).toBe(false);

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('esc ends an empty Request changes and hands the keys back to the card rows', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    controlsStore.setInputMode('review');
    const ui = renderFeature(
      <>
        <Harness exit={vi.fn()} />
        <Composer
          commands={[]}
          currentScreen="workflow"
          mode="review"
          hint=""
          onSubmit={() => {}}
          onRuntimeCommand={() => {}}
        />
      </>,
    );
    await tick();
    reviewKeysStore.requestComment();
    await flushEffects();
    expect(reviewKeysStore.get().commenting).toBe(true);

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await flushEffects();

    expect(overlayStore.get().active).toBe('none');
    expect(reviewKeysStore.get()).toEqual({ commenting: false, requested: false });
    ui.unmount();
  });

  it.each([
    ['two presses', ['\x1b', '\x1b']],
    ['one chunk', ['\x1b\x1b']],
  ])(
    'a double esc (%s) in the plan card comment clears the comment and opens the sheet',
    async (_name, chunks) => {
      lifecycleStore.__testReset({ phase: 'reviewing-plan' });
      controlsStore.setInputMode('review');
      const ui = renderFeature(
        <>
          <Harness exit={vi.fn()} />
          <Composer
            commands={[]}
            currentScreen="workflow"
            mode="review"
            hint=""
            onSubmit={() => {}}
            onRuntimeCommand={() => {}}
          />
        </>,
      );
      await tick();
      composerDraftStore.request('comment drop T003');
      await flushEffects();

      // Two presses inside the debounce read as the slow sequence: the first cancels the comment,
      // the second opens the sheet. Neither is lost and neither stops the run.
      for (const chunk of chunks) {
        await writeKey(ui, chunk);
        await tick();
      }
      vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
      await flushEffects();

      expect(composerLiveStore.get().empty).toBe(true);
      expect(overlayStore.get().active).toBe('stop-sheet');
      expect(stopStore.get().intent).toBe('none');
      ui.unmount();
    },
  );

  it('a split escape sequence in the plan card comment keeps the comment', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    controlsStore.setInputMode('review');
    const ui = renderFeature(
      <>
        <Harness exit={vi.fn()} />
        <Composer
          commands={[]}
          currentScreen="workflow"
          mode="review"
          hint=""
          onSubmit={() => {}}
          onRuntimeCommand={() => {}}
        />
      </>,
    );
    await tick();
    composerDraftStore.request('comment drop T003');
    await flushEffects();

    await writeEsc(ui);
    await tick();
    await writeKey(ui, '[A');
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await flushEffects();

    expect(composerLiveStore.get().text).toContain('comment drop T003');
    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('esc during validating-task opens sheet', async () => {
    lifecycleStore.__testReset({ phase: 'validating-task' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(overlayStore.get().active).toBe('stop-sheet');
    ui.unmount();
  });

  it('esc on a continued run that has not reached its first call opens the stop sheet', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'paused' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(routerStore.get().screen).toBe('workflow');
    expect(overlayStore.get().active).toBe('stop-sheet');
    ui.unmount();
  });

  // A run halted on Apply or on a failed final review has completed its phases, yet the panel
  // waiting on it is part of the run: esc answers it as on a halt in the middle of a build.
  it.each([
    { reason: 'apply-conflict', at: { kind: 'apply' } },
    { reason: 'review-failed', at: { kind: 'review', cycle: 0 } },
  ] as const)(
    'esc on the $reason halt panel of a completed run opens the stop sheet',
    async ({ reason, at }) => {
      lifecycleStore.__testReset({ phase: 'complete', status: 'complete' });
      recoveryNoticeStore.open({
        seat: null,
        resetAt: null,
        issue: makeRecoveryIssue({
          reason,
          phase: 'complete',
          taskId: undefined,
          taskTitle: undefined,
          availableActions: ['retry-same-worker', 'end-run'],
          recommendedAction: 'retry-same-worker',
        }),
        at,
      });
      const exit = vi.fn();
      const ui = renderFeature(<Harness exit={exit} />);
      await tick();

      await writeEsc(ui);
      await tick();
      vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

      expect(routerStore.get().screen).toBe('workflow');
      expect(overlayStore.get().active).toBe('stop-sheet');
      ui.unmount();
    },
  );

  it('parked Escape returns home even with an unsent draft', async () => {
    stopStore.park('mid-brief', null, null);
    composerLiveStore.setDraft(createDraftDocument('draft'));
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(routerStore.get().screen).toBe('home');
    expect(composerLiveStore.get().empty).toBe(false);
    expect(stopStore.get().intent).not.toBe('end-run');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('queues home on a third Escape until the original stop settles', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();
    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    await tick();
    await writeEsc(ui);
    await tick();
    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(routerStore.get().screen).toBe('workflow');
    stopStore.markSettling();
    expect(routerStore.get().screen).toBe('workflow');
    stopStore.park('mid-brief', null, null);
    await tick();
    expect(routerStore.get().screen).toBe('home');
    expect(stopStore.get().intent).toBe('stop-now');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('a split escape sequence (ESC then an arrow tail) does not open the sheet', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    // ESC arrives first (deferred), then the rest of an Up-arrow sequence over a slow link.
    await writeEsc(ui);
    await tick();
    await writeKey(ui, '[A');
    await tick();

    vi.advanceTimersByTime(50);
    expect(overlayStore.get().active).toBe('none');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('esc after the run was cancelled navigates home', async () => {
    lifecycleStore.__testReset({ cancelled: true });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(routerStore.get().screen).toBe('home');
    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('a split escape sequence in the cancelled state does not navigate home', async () => {
    lifecycleStore.__testReset({ cancelled: true });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    // ESC arrives first (deferred), then the rest of an Up-arrow sequence over a slow link.
    await writeEsc(ui);
    await tick();
    await writeKey(ui, '[A');
    await tick();

    // The non-ESC tail cancels the deferred navigate before its deadline.
    vi.advanceTimersByTime(50);
    expect(routerStore.get().screen).toBe('workflow');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ESC never exits the app on the home screen', async () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    await writeEsc(ui);
    await tick();

    expect(exit).not.toHaveBeenCalled();
    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('session preparation owns Escape and shortcuts while returning to the run it came from', async () => {
    const record = makeRunRecord({
      ref: { projectDir: '/tmp/session-preparation-keys', sessionId: 'resume-from-run' },
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'interrupted' } },
        resumeAt: { kind: 'planner', call: 'tasks' },
      },
    });
    routerStore.navigate({ to: 'workflow', run: record, execution: { kind: 'at-rest' } });
    const exactRoute = routerStore.get();
    const resumeState = {
      ...createInitialState('resume from run'),
      phase: 'implementing' as const,
    };
    const pending = Promise.withResolvers<PreparationOutcome>();
    const selection = continueRunInPlace({
      record,
      state: resumeState,
      deps: {
        applying: () => false,
        loadResumeState: () => ({ kind: 'loaded', state: resumeState }),
        prepareResume: () => pending.promise,
        hydrateRun: async () => {},
      },
    });
    const exit = vi.fn();
    const ui = renderFeature(<SessionPreparationKeysHarness exit={exit} />);
    await tick();

    expect(sessionSelectStore.get().preparation.kind).toBe('preparing');
    // The routine check takes no page: the run stays on its screen and this owner paints nothing.
    expect(ui.lastFrame() ?? '').toBe('');

    await writeKey(ui, '\x0b');
    await tick();
    expect(overlayStore.get().active).toBe('none');
    expect(routerStore.get()).toBe(exactRoute);

    await writeEsc(ui);
    await tick();
    expect(sessionSelectStore.get().preparation.kind).toBe('idle');
    expect(routerStore.get()).toBe(exactRoute);
    expect(exit).not.toHaveBeenCalled();

    pending.resolve({ kind: 'aborted' });
    await selection;
    ui.unmount();
  });

  it('ESC closes an open overlay instead of opening the stop sheet', async () => {
    overlayStore.open('settings');
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    expect(overlayStore.get().active).toBe('settings');

    await writeEsc(ui);
    await tick();

    expect(overlayStore.get().active).toBe('none');
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ESC does not open the stop sheet while a tiered approval prompt is pending', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    void openApprovalPrompt({
      tier: 'confirm',
      actionClass: 'network',
      actionDescription: 'push to origin',
      phase: 'implementing',
    });
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    // The prompt keeps its own esc-to-deny, so the global ladder stands down entirely.
    expect(overlayStore.get().active).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ESC does not open the stop sheet while a completion menu is open', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    completionStore.setOpen(true);
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    // The completion menu owns ESC (it dismisses the menu), so the global ladder is suppressed.
    expect(overlayStore.get().active).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });
});

describe('useAppKeys: keystroke binding', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    stopStore.__testReset();
    approvalPromptStore.__testReset();
  });

  it.each([
    { name: 'Ctrl+K', input: '\x0b', overlay: 'command-palette' },
    { name: 'Ctrl+,', input: '\x1b[44;5u', overlay: 'settings' },
    { name: 'Ctrl+/ (legacy \\x1f)', input: '\x1f', overlay: 'help' },
    { name: 'Ctrl+/ (kitty CSI-u)', input: '\x1b[47;5u', overlay: 'help' },
  ] as const)('$name opens the $overlay overlay', async ({ input, overlay }) => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().active).toBe('none');

    await writeKey(ui, input);
    await tick(20);

    expect(overlayStore.get().active).toBe(overlay);
    ui.unmount();
  });

  describe('skills rescan', () => {
    let projectDir = '';
    let fakeHome = '';
    let originalHome: string | undefined;

    beforeEach(() => {
      projectDir = realpathSync(createTempDir('splitbrief-keys-project'));
      fakeHome = realpathSync(createTempDir('splitbrief-keys-home'));
      originalHome = process.env.HOME;
      process.env.HOME = fakeHome;
      const skillDir = join(projectDir, '.claude', 'skills', 'rescan-proof');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: rescan-proof\ndescription: proves the rescan ran\n---\nBody\n',
      );
      configStore.__testReset({ projectDir });
      skillsStore.setAvailable([
        {
          id: 'stale-skill',
          name: 'stale-skill',
          description: 'seeded before the keypress',
          path: '/nowhere/stale-skill/SKILL.md',
          scope: 'project',
        },
      ]);
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      cleanupTempDir(projectDir);
      cleanupTempDir(fakeHome);
    });

    function availableIds(): string[] {
      return skillsStore.get().available.map((skill) => skill.id);
    }

    it('Ctrl+S opens the skills overlay over a freshly scanned list', async () => {
      const ui = renderFeature(<Harness exit={vi.fn()} />);
      await tick(20);

      await writeKey(ui, '\x13');
      await tick(20);

      expect(overlayStore.get().active).toBe('skills');
      await vi.waitFor(() => expect(availableIds()).toEqual(['rescan-proof']));
      ui.unmount();
    });

    it('opening a non-skills overlay leaves the skills list untouched', async () => {
      const ui = renderFeature(<Harness exit={vi.fn()} />);
      await tick(20);

      await writeKey(ui, '\x0b');
      // Long enough for a rescan to have landed: the Ctrl+S scan above runs against the same
      // two temp directories and resolves well inside this window.
      await tick(100);

      expect(overlayStore.get().active).toBe('command-palette');
      expect(availableIds()).toEqual(['stale-skill']);
      ui.unmount();
    });
  });

  it('Ctrl+K when an overlay is already open does not open command-palette', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, '\x0b');
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  it('Ctrl+K while a tiered approval prompt is pending does not open an overlay over it', async () => {
    const exit = vi.fn();
    void openApprovalPrompt({
      tier: 'confirm',
      actionClass: 'network',
      actionDescription: 'push to origin',
      phase: 'implementing',
    });
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, '\x0b');
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Ctrl+Q calls exit()', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, '\x11');
    await tick(20);

    expect(exit).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('Escape when overlay is exclusive does not close the overlay', async () => {
    const exit = vi.fn();
    overlayStore.open('settings');
    overlayStore.setExclusive(true);
    await tick(20);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    expect(overlayStore.get().exclusive).toBe(true);

    await writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  it('Escape closes a stacked passive overlay back to its parent (help over settings -> settings)', async () => {
    const exit = vi.fn();
    // The command palette closes itself before launching the chosen overlay, so opening Help from
    // the palette over Settings leaves Settings beneath Help on the stack.
    overlayStore.open('settings');
    overlayStore.open('command-palette');
    overlayStore.close();
    overlayStore.open('help');
    await tick(20);
    expect(overlayStore.get().active).toBe('help');
    expect(overlayStore.get().stack.length).toBe(1);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  it('Escape leaves a stacked self-closing overlay to its own handler (no global double-pop)', async () => {
    const exit = vi.fn();
    // A runner picker carries its own Escape handler. The global close must stand down while it sits
    // on a non-empty stack, or one Escape would fire both handlers and skip past Settings.
    overlayStore.open('settings');
    overlayStore.open('planner-picker');
    await tick(20);
    expect(overlayStore.get().active).toBe('planner-picker');
    expect(overlayStore.get().stack.length).toBe(1);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('planner-picker');
    ui.unmount();
  });

  it('Escape leaves an unstacked runner picker to its own handler (filter-clearing press must not exit)', async () => {
    const exit = vi.fn();
    // The picker clears a non-empty filter query on the first Escape and only closes on the next
    // one. The global close must stand down even without a parent on the stack, or the
    // query-clearing press would also close the overlay.
    overlayStore.open('planner-picker');
    await tick(20);
    expect(overlayStore.get().stack.length).toBe(0);

    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, '\x1b');
    await tick(20);

    expect(overlayStore.get().active).toBe('planner-picker');
    ui.unmount();
  });
});
