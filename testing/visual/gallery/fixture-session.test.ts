import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  flushEffects,
  renderFeature,
  tick,
  type RenderFeatureResult,
} from '#testing/helpers/ink.js';
import type { AppProps } from '../../../src/app/root.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { viewport, type Viewport } from '../contracts/geometry.js';
import { FIXED_CLOCK } from './environment.js';

/** Every production effect an interactive path could still reach, spied at its own module. */
const production = vi.hoisted(() => ({
  prepareExecution: vi.fn(),
  refreshPickerDetection: vi.fn(),
  refreshDetectionForCurrentConfig: vi.fn(),
  detectProviderCatalog: vi.fn(),
  discoverSkills: vi.fn(),
  copyToClipboard: vi.fn(),
  requestQuit: vi.fn(),
  requestStopNow: vi.fn(),
  resolveEditorArgv: vi.fn(),
  resolveViewerArgv: vi.fn(),
  readRunRecord: vi.fn(),
}));

const setupFailure = vi.hoisted(() => ({ armed: false }));

vi.mock('../../../src/engine/runners/prepare-execution/prepare-execution.js', async (original) => ({
  ...(await original<
    typeof import('../../../src/engine/runners/prepare-execution/prepare-execution.js')
  >()),
  prepareExecution: production.prepareExecution,
}));
vi.mock('../../../src/features/runners/refresh-detection.js', async (original) => ({
  ...(await original<typeof import('../../../src/features/runners/refresh-detection.js')>()),
  refreshPickerDetection: production.refreshPickerDetection,
}));
vi.mock('../../../src/engine/detection/store-publication.js', async (original) => ({
  ...(await original<typeof import('../../../src/engine/detection/store-publication.js')>()),
  refreshDetectionForCurrentConfig: production.refreshDetectionForCurrentConfig,
}));
vi.mock('../../../src/engine/providers/catalog-detection.js', async (original) => ({
  ...(await original<typeof import('../../../src/engine/providers/catalog-detection.js')>()),
  detectProviderCatalog: production.detectProviderCatalog,
}));
vi.mock('../../../src/engine/skill-discovery.js', async (original) => ({
  ...(await original<typeof import('../../../src/engine/skill-discovery.js')>()),
  discoverSkills: production.discoverSkills,
}));
vi.mock('../../../src/lib/clipboard/clipboard.js', async (original) => ({
  ...(await original<typeof import('../../../src/lib/clipboard/clipboard.js')>()),
  copyToClipboard: production.copyToClipboard,
}));
vi.mock('../../../src/features/workflow/handlers.js', async (original) => ({
  ...(await original<typeof import('../../../src/features/workflow/handlers.js')>()),
  requestQuit: production.requestQuit,
  requestStopNow: production.requestStopNow,
}));
vi.mock('../../../src/features/workflow/editor-command.js', async (original) => ({
  ...(await original<typeof import('../../../src/features/workflow/editor-command.js')>()),
  resolveEditorArgv: production.resolveEditorArgv,
  resolveViewerArgv: production.resolveViewerArgv,
}));
vi.mock('../../../src/core/sessions/run-record-io.js', async (original) => ({
  ...(await original<typeof import('../../../src/core/sessions/run-record-io.js')>()),
  readRunRecord: production.readRunRecord,
}));
// The one seam a fixture setup can be made to fail at, armed for a single call.
vi.mock('#testing/helpers/stores.js', async (original) => {
  const actual = await original<typeof import('#testing/helpers/stores.js')>();
  return {
    ...actual,
    resetAllStores: () => {
      if (setupFailure.armed) {
        setupFailure.armed = false;
        throw new Error('fixture setup refused');
      }
      actual.resetAllStores();
    },
  };
});

const runRecordIo = await vi.importActual<
  typeof import('../../../src/core/sessions/run-record-io.js')
>('../../../src/core/sessions/run-record-io.js');
const { App } = await import('../../../src/app/root.js');
const { glyph } = await import('../../../src/lib/glyphs.js');
const { configStore } = await import('../../../src/stores/project/config.js');
const { feedbackStore } = await import('../../../src/stores/ui/feedback.js');
const { overlayStore } = await import('../../../src/stores/ui/overlay.js');
const { editorStore } = await import('../../../src/stores/ui/editor.js');
const { pickerViewStore } = await import('../../../src/stores/ui/picker-view.js');
const { routerStore } = await import('../../../src/stores/navigation/router.js');
const { terminalSizeStore } = await import('../../../src/stores/ui/terminal-size.js');
const { findVisualScenario } = await import('../catalog.js');
const { PREVIEW_UNAVAILABLE } = await import('../fixtures/common.js');
const { createPreviewController } = await import('../preview/controller.js');
const { PreviewView } = await import('../preview/view.js');
const { createFixtureSession, FIXTURE_SESSION_ROOT, isInsideFixtureRoot } = await import(
  './fixture-session.js'
);

const ENTER = '\r';
const DOWN = '\u001B[B';
const CTRL_C = '\u0003';
const CTRL_O = '\u000F';
const CTRL_Q = '\u0011';
const CTRL_R = '\u0012';
const CTRL_S = '\u0013';

const WIDE = viewport({ cols: 120, rows: 40 });
const NARROW = viewport({ cols: 60, rows: 18 });

/** A real project directory the host is pointed at before every preview. */
let sentinel = '';

function scenarioNamed(id: string) {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  return scenario;
}

function newSession(id: string, size: Viewport = WIDE) {
  return createFixtureSession({ scenario: scenarioNamed(id), viewport: size });
}

/** One preview: the shared session plus a live renderer, torn down by `close`. */
async function open(id: string, size: Viewport = WIDE) {
  const session = await newSession(id, size);
  const ui = renderFeature(createElement<AppProps>(App, session.props), size);
  await flushEffects();
  return {
    ui,
    session,
    close: async () => {
      ui.unmount();
      await session.dispose();
    },
  };
}

async function press(ui: RenderFeatureResult, text: string): Promise<void> {
  ui.stdin.write(text);
  await flushEffects();
  await tick(20);
}

function frame(ui: RenderFeatureResult): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

/** Names the offending effect rather than a count; the in-root read is pinned, not waived. */
function expectNoProductionEffect(): void {
  for (const [name, spy] of Object.entries(production)) {
    if (name === 'readRunRecord') continue;
    expect(`${name} ran ${spy.mock.calls.length} times`).toBe(`${name} ran 0 times`);
  }
  const outside = production.readRunRecord.mock.calls
    .map(([ref]) => (ref as SessionRef).projectDir)
    .filter((dir) => !isInsideFixtureRoot(dir));
  expect(outside).toEqual([]);
}

/** Every path the route, the config and the run refs name has to be the fixture's own. */
function expectEveryPathInFixtureRoot(): void {
  expect(isInsideFixtureRoot(configStore.get().projectDir)).toBe(true);
  const route = routerStore.get();
  if (route.screen === 'workflow') {
    expect(isInsideFixtureRoot(route.run.ref.projectDir)).toBe(true);
  }
  expect(readdirSync(sentinel)).toEqual([]);
}

beforeEach(() => {
  sentinel = mkdtempSync(join(tmpdir(), 'preview-sentinel-'));
  configStore.__testReset({ projectDir: sentinel, config: makeConfig() });
  routerStore.init({ screen: 'home' });
  terminalSizeStore.__testReset({ cols: WIDE.cols, rows: WIDE.rows, isSmall: false });
  for (const spy of Object.values(production)) spy.mockReset();
  production.readRunRecord.mockImplementation(runRecordIo.readRunRecord);
  production.resolveEditorArgv.mockReturnValue({ command: 'preview-editor', args: [] });
  production.resolveViewerArgv.mockReturnValue({
    command: 'preview-editor',
    args: [],
    kind: 'editor',
  });
  production.requestStopNow.mockReturnValue(true);
  production.discoverSkills.mockResolvedValue([]);
});

afterEach(() => {
  setupFailure.armed = false;
  rmSync(sentinel, { recursive: true, force: true });
});

describe('the preview session owns one scenario at a time', () => {
  it('disposes once, however often it is asked, and switches to the next scenario', async () => {
    const first = await newSession('home-empty');
    expect(isInsideFixtureRoot(configStore.get().projectDir)).toBe(true);

    await first.dispose();
    expect(configStore.get().projectDir).toBe(sentinel);

    // A second disposal must be inert: running again would put the prior stores back over
    // whatever is on screen by then.
    const movedOn = join(sentinel, 'moved-on');
    configStore.__testReset({ projectDir: movedOn, config: makeConfig() });
    await first.dispose();
    expect(configStore.get().projectDir).toBe(movedOn);

    const second = await newSession('overlay-settings');
    expect(second.scenario.id).toBe('overlay-settings');
    expect(second.checkpoint.id).toBe('ready');
    await second.dispose();
  });

  it('gives the project and the route back when the fixture setup fails', async () => {
    setupFailure.armed = true;

    await expect(newSession('home-empty')).rejects.toThrow('fixture setup refused');

    expect(configStore.get().projectDir).toBe(sentinel);
    expect(routerStore.get().screen).toBe('home');
    expect(existsSync(FIXTURE_SESSION_ROOT)).toBe(false);
  });

  it('publishes the viewport a resize actually asks for', async () => {
    const preview = await open('workflow-idle');
    expect(terminalSizeStore.get()).toEqual({ cols: 120, rows: 40, isSmall: false });

    expect(preview.session.resize(NARROW)).toEqual(NARROW);
    await flushEffects();
    expect(terminalSizeStore.get()).toEqual({ cols: 60, rows: 18, isSmall: true });

    preview.session.resize(WIDE);
    expect(terminalSizeStore.get()).toEqual({ cols: 120, rows: 40, isSmall: false });
    await preview.close();
  });

  it('leaves the clock and the randomness of a live terminal alone', async () => {
    const now = Date.now;
    const random = Math.random;
    const before = Date.now();

    const preview = await open('home-empty');
    expect(Date.now).toBe(now);
    expect(Math.random).toBe(random);
    await tick(2);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
    // The capture's frozen instant is FIXED_CLOCK; a live preview must never read it.
    expect(Date.now()).not.toBe(Date.parse(FIXED_CLOCK));
    await preview.close();
  });
});

describe('a previewed App spends fixture effects and no production one', () => {
  it.each(['home-empty', 'workflow-idle'])(
    'keeps %s image paste and file lookup away from host processes',
    async (scenario) => {
      const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        throw new Error('Unexpected preview subprocess');
      });
      const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation(() => {
        throw new Error('Unexpected preview clipboard process');
      });
      syncBuiltinESMExports();
      let preview: Awaited<ReturnType<typeof open>> | undefined;
      try {
        preview = await open(scenario);
        await press(preview.ui, '\u0016');
        expect(frame(preview.ui)).toContain('Cannot read clipboard image');
        await press(preview.ui, '@');
        expect(frame(preview.ui)).toContain('@');
        expectEveryPathInFixtureRoot();
        expect(spawn).not.toHaveBeenCalled();
        expect(execFile).not.toHaveBeenCalled();
        expectNoProductionEffect();
      } finally {
        await preview?.close();
        spawn.mockRestore();
        execFile.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  it('starts a run from home and answers /refresh, ctrl+c and ctrl+q in the preview', async () => {
    const preview = await open('home-empty');

    await press(preview.ui, 'add a parser');
    await press(preview.ui, ENTER);
    await vi.waitFor(() => expect(routerStore.get().screen).toBe('workflow'));
    expectEveryPathInFixtureRoot();

    await press(preview.ui, '/refresh');
    await press(preview.ui, ENTER);
    await vi.waitFor(() => expect(feedbackStore.get().message).toBe(PREVIEW_UNAVAILABLE));

    await press(preview.ui, CTRL_C);
    expect(feedbackStore.get().message).toBe(PREVIEW_UNAVAILABLE);

    await press(preview.ui, CTRL_Q);
    expect(feedbackStore.get().message).toBe(PREVIEW_UNAVAILABLE);

    await preview.close();
    expectNoProductionEffect();
  });

  it('rescans skills through the key port and opens the picker anyway', async () => {
    const preview = await open('home-empty');

    await press(preview.ui, CTRL_S);
    expect(feedbackStore.get().message).toBe(PREVIEW_UNAVAILABLE);
    expect(overlayStore.get().active).toBe('skills');

    await preview.close();
    expectNoProductionEffect();
  });

  it('opens a seeded session without preparing or loading a real one', async () => {
    const preview = await open('overlay-sessions');
    expect(frame(preview.ui)).toContain('Sessions');

    await press(preview.ui, ENTER);
    await vi.waitFor(() => expect(routerStore.get().screen).toBe('workflow'));
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.execution.kind).toBe('at-rest');
    expectEveryPathInFixtureRoot();

    await preview.close();
    expectNoProductionEffect();
  });

  it('answers a continuation from the fixture root and prepares nothing real', async () => {
    const preview = await open('workflow-at-rest-paused');

    await press(preview.ui, 'keep the parser out');
    await press(preview.ui, ENTER);
    await tick(200);

    // The classifying loader read the fixture's own session directory and answered from it; no
    // preparation followed, and no real project was opened to find one.
    expect(feedbackStore.get()).toEqual({
      message: 'No saved state to continue.',
      isError: true,
    });
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.execution.kind).toBe('at-rest');
    expectEveryPathInFixtureRoot();

    await preview.close();
    expectNoProductionEffect();
  });

  it('continues setup into a run through the fixture prepare and record read', async () => {
    const preview = await open('setup-initial');
    // The fixture's setup completes into home; a start is the route that continues into a run.
    routerStore.init({ screen: 'setup', onComplete: 'workflow', feature: 'preview a crew' });
    await flushEffects();

    await activateContinue(preview.ui);
    await vi.waitFor(() => expect(routerStore.get().screen).toBe('workflow'));
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.run.ref.sessionId).toBe('preview-run');
    expectEveryPathInFixtureRoot();

    await preview.close();
    expectNoProductionEffect();
  });

  it('refreshes, checks and saves a local connection without a process or a write', async () => {
    const preview = await open('overlay-picker-local-server');
    const configFile = join(FIXTURE_SESSION_ROOT, '.splitbrief', 'config.yaml');
    const seeded = readFileSync(configFile, 'utf8');

    await press(preview.ui, CTRL_R);
    expect(feedbackStore.get().message).toBe(PREVIEW_UNAVAILABLE);

    pickerViewStore.open({ kind: 'local-connection', provider: 'ollama' });
    await flushEffects();
    await press(preview.ui, ENTER);
    await vi.waitFor(() => expect(frame(preview.ui)).toContain('gemma3:27b'));

    // Address, Token, Check, then the two catalog rows: the second is a model no seat is on.
    for (const key of [DOWN, DOWN, DOWN, DOWN]) await press(preview.ui, key);
    await press(preview.ui, ENTER);
    await vi.waitFor(() =>
      expect(configStore.get().config?.planner).toMatchObject({
        kind: 'api',
        provider: 'ollama',
        model: 'gemma3:27b',
      }),
    );
    // The seat moved in memory only: the fixture project holds the config its seed wrote, and
    // nothing reached the real project the host was pointed at.
    expect(readdirSync(FIXTURE_SESSION_ROOT)).toEqual(['.splitbrief']);
    expect(readdirSync(join(FIXTURE_SESSION_ROOT, '.splitbrief'))).toEqual(['config.yaml']);
    expect(readFileSync(configFile, 'utf8')).toBe(seeded);
    expectEveryPathInFixtureRoot();

    await preview.close();
    expectNoProductionEffect();
  });
});

describe('a replayed fixture walk', () => {
  it('returns the configured Claude effort after the cursor leaves and comes back', async () => {
    const forwarded: string[] = [];
    let rendered: RenderFeatureResult | undefined;
    // The real preview composition: its own view hands the fixture session the controller's
    // `pressToPreview`, so the scripted keys await the settlement production preview uses.
    const controller = createPreviewController({
      scenarios: [scenarioNamed('overlay-picker-claude-effort-returned')],
      hostViewport: WIDE,
      forward: (input) => {
        const text = input.toString('utf8');
        forwarded.push(text);
        if (rendered === undefined) throw new Error('input forwarded before the view rendered');
        rendered.stdin.write(text);
      },
    });
    const ui = renderFeature(createElement(PreviewView, { controller }), WIDE);
    rendered = ui;
    try {
      await flushEffects();
      await controller.selectScenario('overlay-picker-claude-effort-returned');

      // Each scripted key went through the preview's settlement form, in order.
      await vi.waitFor(
        () => expect(forwarded).toEqual(['\u001b[D', '\u001b[B', '\u001b[A', '\u001b[C']),
        { timeout: 10_000 },
      );
      // Forwarding the last key precedes its settlement; wait for the whole walk
      // so Enter reaches the returned column's input handler.
      const state = controller.getState();
      if (state.kind !== 'preview') throw new Error('Fixture walk requires an active preview');
      await state.session.activate(
        Object.assign((input: string) => controller.forwardToPreview(input), {
          press: controller.pressToPreview,
        }),
      );
      expect(controller.forwardToPreview).not.toHaveProperty('press');
      // The return restored the seat's effort level into the draft, and the expanded effort
      // axis reads it again; a reset lands on the unset word, never `high`. Only that axis
      // row carries both words, so this is not the seat identity line's `high`.
      await vi.waitFor(
        () => {
          expect(pickerViewStore.get().effortDraft).toBe('high');
          const lines = frame(ui).split('\n');
          expect(
            lines.some((line) => line.includes('effort') && line.includes('high')),
            lines.join('\n'),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );
      // Semantic confirmation: Enter acts on the cursor row. On the returned Claude row it
      // saves exactly the configured seat and closes the picker; on the launcher row it only
      // browses (the picker stays open), and on any other row it saves that row instead.
      // `high` stays visible in the seat identity throughout, so the saved seat — not the
      // frame text — is what establishes the returned selection.
      // Enter waits for the scripted Right key to settle; the forwarded list fills before it does.
      await flushEffects();
      await controller.pressToPreview('\r');
      await vi.waitFor(() => expect(overlayStore.get().active, frame(ui)).toBe('none'), {
        timeout: 10_000,
      });
      expect(configStore.get().config?.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'opus',
        effort: 'high',
      });
    } finally {
      await controller.dispose();
      ui.unmount();
    }
  }, 30_000);
});

describe('the preview answers for the effects it cannot simulate', () => {
  it('files the raw editor ctrl+o at the fixture editor, not at a process', async () => {
    const preview = await open('overlay-editor');
    expect(frame(preview.ui)).toContain('ctrl+o external');

    await press(preview.ui, CTRL_O);
    await vi.waitFor(() => expect(feedbackStore.get().message).toBe(PREVIEW_UNAVAILABLE));

    await preview.close();
    expectNoProductionEffect();
  });

  it('opens the plan card edit row on the fixture plan.json in the editor overlay', async () => {
    const preview = await open('workflow-plan-card');

    // Approve, request changes, then the row that files `edit-file` — the route the gate's own
    // legend advertises.
    await press(preview.ui, DOWN);
    await press(preview.ui, DOWN);
    expect(frame(preview.ui)).toContain('Edit plan.json');
    await press(preview.ui, ENTER);
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('editor'));
    const editor = editorStore.get();
    expect(editor.status === 'open' ? editor.value : '').toContain('"protectedOperations"');

    await preview.close();
    expectNoProductionEffect();
  });

  it('says unavailable for an action it does not simulate, and falls back to nothing', async () => {
    const preview = await open('workflow-idle');

    await press(preview.ui, '/run accept');
    await press(preview.ui, ENTER);
    await vi.waitFor(() => expect(feedbackStore.get().message).toBe(PREVIEW_UNAVAILABLE));
    expect(feedbackStore.get().isError).toBe(true);

    await press(preview.ui, '/copy');
    await press(preview.ui, ENTER);
    await vi.waitFor(() => expect(feedbackStore.get().message).toContain(PREVIEW_UNAVAILABLE));

    await preview.close();
    expectNoProductionEffect();
  });

  it('keeps a settings write inside the fixture root and hands the project back', async () => {
    const preview = await open('overlay-settings');
    expectEveryPathInFixtureRoot();

    await press(preview.ui, ENTER);
    await tick(30);
    expect(readdirSync(sentinel)).toEqual([]);

    await preview.close();
    expect(configStore.get().projectDir).toBe(sentinel);
    expect(configStore.get().config).toEqual(makeConfig());
    expect(readdirSync(sentinel)).toEqual([]);
    expectNoProductionEffect();
  });
});

/** Walks the crew list to Continue; Enter anywhere else edits a seat instead. */
async function activateContinue(ui: RenderFeatureResult): Promise<void> {
  const underCursor = `${glyph('liveBar')} Continue`;
  for (let step = 0; step < 16; step += 1) {
    if (frame(ui).includes(underCursor)) {
      await press(ui, ENTER);
      return;
    }
    await press(ui, DOWN);
  }
  throw new Error('never reached the Continue row');
}
