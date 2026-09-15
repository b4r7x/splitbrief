import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text } from 'ink';
import { DRAFT_ESCAPE_HINT, useAppKeys } from './keys.js';
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
import { feedbackStore } from '../stores/ui/feedback.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { completionStore } from '../stores/ui/completion.js';
import { controlsStore } from '../stores/ui/controls.js';
import { cancelEscapeAction } from '../lib/terminal/escape-debounce.js';
import * as handlers from '../features/workflow/handlers.js';
import { approvalPromptStore, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import { editorStore } from '../stores/ui/editor.js';
import { reviewStore } from '../stores/workflow/review.js';
import { continueRunInPlace, sessionSelectStore } from '../stores/navigation/session-select.js';
import { configStore } from '../stores/project/config.js';
import { skillsStore } from '../stores/project/skills.js';
import { SessionPreparation } from './session-preparation.js';

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

  it('a second ctrl+c stops again instead of exiting', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeCtrlC(ui);
    await tick();
    await writeCtrlC(ui);
    await tick();

    expect(abort).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('ctrl+c leaves once there is nothing left to stop', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeCtrlC(ui);
    await tick();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('none');
    ui.unmount();
  });

  it('Ctrl+C on the home screen exits immediately on the first press', async () => {
    routerStore.navigate({ to: 'home' });
    handlers.createAbortHandlerScope()(vi.fn());
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeCtrlC(ui);
    await tick();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('none');
    ui.unmount();
  });
});

describe('useAppKeys: ESC stop ladder', () => {
  beforeEach(STOP_LADDER_SETUP);
  afterEach(STOP_LADDER_TEARDOWN);

  it('esc with draft is inert on run and draft', async () => {
    const abort = vi.fn();
    handlers.createAbortHandlerScope()(abort);
    composerLiveStore.setEmpty(false);
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick();

    await writeEsc(ui);
    await tick();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);

    expect(overlayStore.get().active).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(feedbackStore.get().message).toBe(DRAFT_ESCAPE_HINT);
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
        stop: { kind: 'interrupted' },
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
        loadResumeState: () => ({ kind: 'loaded', state: resumeState }),
        prepareResume: () => pending.promise,
        hydrateRun: async () => {},
      },
    });
    const exit = vi.fn();
    const ui = renderFeature(<SessionPreparationKeysHarness exit={exit} />);
    await tick();

    expect(sessionSelectStore.get().preparation.kind).toBe('preparing');
    expect(ui.lastFrame() ?? '').toContain('Preparing your tools');

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
      tier: 'sticky',
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
      tier: 'sticky',
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

describe('useAppKeys: suppressed while the inline briefs field editor owns input', () => {
  const LAYOUT = { columns: 40, rows: 6 };

  beforeEach(() => {
    resetAllStores();
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord(),
      execution: localExecution('field-edit test'),
    });
    // The field editor is not an overlay: give a field session ownership of the live prompt by
    // matching its captured token to reviewStore.ownerToken (the CON-B ownership predicate).
    const token = reviewStore.setReviewFile('/tmp/TASKS.md');
    editorStore.openField({
      filePath: '/tmp/TASKS.md',
      value: 'x',
      ownerToken: token,
      layout: LAYOUT,
    });
  });

  afterEach(() => {
    editorStore.close();
    reviewStore.clearReview();
    stopStore.__testReset();
  });

  it.each([
    { name: 'Ctrl+K', input: '\x0b' },
    { name: 'Ctrl+,', input: '\x1b[44;5u' },
    { name: 'Ctrl+/ (legacy \\x1f)', input: '\x1f' },
  ] as const)('$name does not open an overlay over the field editor', async ({ input }) => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, input);
    await tick(20);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Ctrl+Q does not exit while the field editor owns input', async () => {
    const exit = vi.fn();
    const ui = renderFeature(<Harness exit={exit} />);
    await tick(20);

    await writeKey(ui, '\x11');
    await tick(20);

    expect(exit).not.toHaveBeenCalled();
    ui.unmount();
  });
});
