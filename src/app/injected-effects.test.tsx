import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { ConfigSaveResult } from '../stores/project/config.js';
import type { RuntimeCommandContext } from '../core/runtime/commands/types.js';
import type { ProviderCatalogOutcome } from '../engine/providers/types.js';
import type { SeatPickerRole } from '../core/runners/seat-roles.js';
import type { SessionSelectDeps } from '../stores/navigation/session-select.js';
import type { HomeScreenDeps } from './screens/home.js';
import type { SetupScreenDeps } from './screens/setup.js';
import type { AppKeyDeps } from './keys.js';
import type { PickerEffectDeps } from '../features/runners/use-picker-actions.js';
import { glyph } from '../lib/glyphs.js';
import { saveSummary } from '../core/sessions/io.js';
import { getKnownProviderBaseURL } from '../core/providers/catalog.js';
import { CREW_SEAT_LABELS } from '../core/crew/identity.js';
import { PICKER_ROLE_SEAT_IDS } from '../core/runners/seat-roles.js';

vi.mock('../lib/git/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/git/files.js')>()),
  checkIgnoredPaths: async () => [],
}));

// The production effects this card takes off the interactive path. Each one is replaced at its
// own module boundary, so a test can say of a whole mounted App that it was never reached.
const production = vi.hoisted(() => ({
  prepareExecution: vi.fn(),
  readRunRecord: vi.fn(),
  refreshPickerDetection: vi.fn(),
  refreshDetectionForCurrentConfig: vi.fn(),
  copyToClipboard: vi.fn(),
  detectProviderCatalog: vi.fn(),
  discoverSkills: vi.fn(),
  requestQuit: vi.fn(),
  requestStopNow: vi.fn(),
}));

vi.mock('../engine/runners/prepare-execution/prepare-execution.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../engine/runners/prepare-execution/prepare-execution.js')
  >()),
  prepareExecution: production.prepareExecution,
}));
vi.mock('../core/sessions/run-record-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/sessions/run-record-io.js')>()),
  readRunRecord: production.readRunRecord,
}));
vi.mock('../features/runners/refresh-detection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/runners/refresh-detection.js')>()),
  refreshPickerDetection: production.refreshPickerDetection,
}));
vi.mock('../engine/detection/store-publication.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/detection/store-publication.js')>()),
  refreshDetectionForCurrentConfig: production.refreshDetectionForCurrentConfig,
}));
vi.mock('../lib/clipboard/clipboard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/clipboard/clipboard.js')>()),
  copyToClipboard: production.copyToClipboard,
}));
vi.mock('../engine/providers/catalog-detection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/providers/catalog-detection.js')>()),
  detectProviderCatalog: production.detectProviderCatalog,
}));
vi.mock('../engine/skill-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/skill-discovery.js')>()),
  discoverSkills: production.discoverSkills,
}));
vi.mock('../features/workflow/handlers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/workflow/handlers.js')>()),
  requestQuit: production.requestQuit,
  requestStopNow: production.requestStopNow,
}));

const { configStore } = await import('../stores/project/config.js');
const { detectionStore } = await import('../stores/project/detection.js');
const { overlayStore } = await import('../stores/ui/overlay.js');
const { pickerViewStore } = await import('../stores/ui/picker-view.js');
const { routerStore } = await import('../stores/navigation/router.js');
const { sessionsStore } = await import('../stores/project/sessions.js');
const { terminalSizeStore } = await import('../stores/ui/terminal-size.js');
const { App } = await import('./root.js');
type AppInteractionDeps = import('./root.js').AppInteractionDeps;

const ENTER = '\r';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const CTRL_C = '\u0003';
const CTRL_Q = '\u0011';
const CTRL_R = '\u0012';
const CTRL_S = '\u0013';

const VIEWPORT = { cols: 120, rows: 36 };
const OLLAMA_SEAT_BASE = 'http://localhost:11435/v1';
const SEAT_PICKER_ROLES: readonly SeatPickerRole[] = ['planner', 'implementer', 'reviewer'];

const SAVED: ConfigSaveResult = {
  kind: 'saved',
  ok: true,
  revision: {
    rawSha256: 'injected-effects-fixture',
    fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
  },
};

const PROBE_CATALOG: ProviderCatalogOutcome = {
  kind: 'success',
  source: 'provider-runtime',
  provider: 'ollama',
  isLocal: true,
  credential: 'not-required',
  catalog: 'populated',
  // Both ids, so the row list is the same two rows for a seat that already carries one of
  // them and for a seat that carries none: the cursor arithmetic is then seat-independent.
  models: [{ id: 'qwen2.5-coder:7b' }, { id: 'gemma3:27b' }],
};

let projectDir = '';

/** A planner already pointed at a local server, so the seat forms have an address to check. */
function seatConfig() {
  return makeConfig({
    planner: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: OLLAMA_SEAT_BASE,
      model: 'qwen2.5-coder:7b',
    },
  });
}

/** Every port as a spy, each typed as the function it stands in for. */
function makePorts() {
  return {
    homePrepare: vi.fn<HomeScreenDeps['prepareExecution']>(async () => ({
      kind: 'failed',
      error: new Error('the fixture check refused'),
    })),
    setupPrepare: vi.fn<SetupScreenDeps['prepareExecution']>(async () => ({
      kind: 'prepared',
      execution: makePreparedExecution({
        projectDir,
        sessionId: 'injected-setup-session',
        feature: 'setup continues into a run',
        config: makeConfig(),
      }),
    })),
    setupReadRunRecord: vi.fn<SetupScreenDeps['readRunRecord']>((ref) =>
      makeRunRecord({
        ref,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'planner', call: 'tasks' },
        },
      }),
    ),
    setupRefresh: vi.fn<SetupScreenDeps['refreshPickerDetection']>(async () => {}),
    hydrateRun: vi.fn<SessionSelectDeps['hydrateRun']>(async () => {}),
    prepareResume: vi.fn<SessionSelectDeps['prepareResume']>(async () => {
      throw new Error('opening a run prepares nothing');
    }),
    pickerRefresh: vi.fn<PickerEffectDeps['refresh']>(async () => {}),
    checkConnection: vi.fn<PickerEffectDeps['checkConnection']>(async () => PROBE_CATALOG),
    saveConfig: vi.fn<PickerEffectDeps['saveConfig']>(async () => SAVED),
    requestQuit: vi.fn<AppKeyDeps['requestQuit']>(() => {}),
    requestStopNow: vi.fn<AppKeyDeps['requestStopNow']>(() => true),
    refreshSkills: vi.fn<AppKeyDeps['refreshSkills']>(async () => {}),
    ctxRefreshDetection: vi.fn<RuntimeCommandContext['refreshDetection']>(async () => ({
      status: 'fresh',
      published: true,
      lanes: {
        readiness: { outcome: 'fresh' },
        modelsDev: { outcome: 'fresh' },
        cliModels: { outcome: 'fresh' },
      },
    })),
    ctxCopyTarget: vi.fn<RuntimeCommandContext['copyTarget']>(async () => 'native'),
  };
}

/** One complete interaction object, every port a spy the test owns. */
function fixture(): { deps: AppInteractionDeps; ports: ReturnType<typeof makePorts> } {
  const ports = makePorts();
  const ctx = makeCtx({
    openOverlay: (overlay, focus) => overlayStore.open(overlay, focus),
    refreshDetection: ports.ctxRefreshDetection,
    copyTarget: ports.ctxCopyTarget,
  });

  return {
    ports,
    deps: {
      home: {
        prepareExecution: ports.homePrepare,
        sessionSelect: {
          loadResumeState: () => ({ kind: 'missing' }),
          prepareResume: ports.prepareResume,
          hydrateRun: ports.hydrateRun,
        },
      },
      setup: {
        prepareExecution: ports.setupPrepare,
        readRunRecord: ports.setupReadRunRecord,
        refreshPickerDetection: ports.setupRefresh,
      },
      runtimeContext: () => ctx,
      readClipboardImage: async () => ({ ok: false, reason: 'no-image' }),
      listProjectFiles: async () => [],
      keys: {
        requestQuit: ports.requestQuit,
        requestStopNow: ports.requestStopNow,
        refreshSkills: ports.refreshSkills,
      },
      picker: {
        refresh: ports.pickerRefresh,
        checkConnection: ports.checkConnection,
        saveConfig: ports.saveConfig,
      },
    },
  };
}

/**
 * Every port is required. Omitting one is a compile error — `npm run typecheck` is the
 * assertion — rather than an optional field that would fall back to production at runtime.
 */
function assertEveryPortIsRequired(complete: AppInteractionDeps): void {
  const { picker: _picker, ...withoutPicker } = complete;
  // @ts-expect-error - `picker` is required on AppInteractionDeps; there is no fallback
  const incomplete: AppInteractionDeps = withoutPicker;
  void incomplete;
}

/** Walks the crew list to Continue and activates it; Enter anywhere else edits a seat. */
async function activateSetupContinue(ui: ReturnType<typeof renderFeature>): Promise<void> {
  const underCursor = `${glyph('liveBar')} Continue`;
  for (let step = 0; step < 16; step += 1) {
    if (frame(ui).includes(underCursor)) {
      await type(ui, ENTER);
      return;
    }
    await type(ui, DOWN);
  }
  throw new Error('never reached the Continue row');
}

/** A run that never settles: the screen mounts, nothing is executed. */
const idleWorkflowDeps = { runWorkflow: () => new Promise<never>(() => {}) };

function mount(interactionDeps?: AppInteractionDeps) {
  return renderFeature(
    <App workflowDeps={idleWorkflowDeps} {...(interactionDeps && { interactionDeps })} />,
    VIEWPORT,
  );
}

function frame(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

async function type(ui: ReturnType<typeof renderFeature>, text: string): Promise<void> {
  ui.stdin.write(text);
  await flushEffects();
  await tick(20);
}

/** Names the offending port in the failure rather than just a count. */
function expectNoProductionEffect(): void {
  for (const [name, spy] of Object.entries(production)) {
    expect(`${name} called ${spy.mock.calls.length} times`).toBe(`${name} called 0 times`);
  }
}

beforeEach(() => {
  resetAllStores();
  projectDir = mkdtempSync(join(tmpdir(), 'injected-effects-'));
  configStore.__testReset({ projectDir, config: seatConfig() });
  terminalSizeStore.__testReset({ cols: VIEWPORT.cols, rows: VIEWPORT.rows, isSmall: false });
  for (const spy of Object.values(production)) spy.mockReset();
  production.prepareExecution.mockResolvedValue({
    kind: 'failed',
    error: new Error('the production check must not run here'),
  });
  production.readRunRecord.mockImplementation((ref: { projectDir: string; sessionId: string }) =>
    makeRunRecord({
      ref,
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'interrupted' } },
        resumeAt: { kind: 'planner', call: 'tasks' },
      },
    }),
  );
  production.refreshPickerDetection.mockResolvedValue(undefined);
  production.refreshDetectionForCurrentConfig.mockResolvedValue({
    status: 'fresh',
    published: true,
    lanes: {
      readiness: { outcome: 'fresh' },
      modelsDev: { outcome: 'fresh' },
      cliModels: { outcome: 'fresh' },
    },
  });
  production.copyToClipboard.mockResolvedValue('native');
  production.detectProviderCatalog.mockResolvedValue(PROBE_CATALOG);
  production.discoverSkills.mockResolvedValue([]);
  production.requestQuit.mockImplementation(() => {});
  production.requestStopNow.mockReturnValue(true);
});

afterEach(() => {
  resetAllStores();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('App screens route to the supplied interaction ports', () => {
  it.each(['home', 'workflow'] as const)(
    'uses the supplied clipboard and file listing on %s',
    async (screen) => {
      const fx = fixture();
      configStore.__testReset({ projectDir, config: makeConfig() });
      if (screen === 'workflow') {
        routerStore.init({
          screen,
          run: makeRunRecord({
            ref: { projectDir, sessionId: 'clipboard-port' },
            status: {
              kind: 'open',
              stop: { kind: 'stopped', on: { kind: 'interrupted' } },
              resumeAt: { kind: 'planner', call: 'tasks' },
            },
          }),
          execution: {
            kind: 'local',
            prepared: makePreparedExecution({
              projectDir,
              sessionId: 'clipboard-port',
              feature: 'clipboard port',
              config: makeConfig(),
            }),
          },
        });
      }
      const ui = mount({ ...fx.deps, listProjectFiles: async () => ['injected-only.ts'] });
      try {
        await flushEffects();
        await type(ui, '\u0016');
        expect(frame(ui)).toContain('Clipboard has no image');
        await type(ui, '@injected');
        expect(frame(ui)).toContain('injected-only.ts');
        expectNoProductionEffect();
      } finally {
        ui.unmount();
      }
    },
  );

  it('sends a Home submit to the supplied prepare and spends no production effect', async () => {
    const fx = fixture();
    const ui = mount(fx.deps);
    await flushEffects();

    await type(ui, 'add a parser');
    await type(ui, ENTER);
    await vi.waitFor(() => expect(fx.ports.homePrepare).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(fx.ports.homePrepare.mock.calls[0]?.[0]).toMatchObject({ feature: 'add a parser' });
    expectNoProductionEffect();
  });

  it('sends Setup continue to the supplied prepare and record reader', async () => {
    const fx = fixture();
    const request = detectionStore.beginRefresh({
      contexts: {
        readiness: 'injected-readiness',
        modelsDev: 'injected-models-dev',
        cliModels: 'injected-cli-models',
      },
    });
    expect(
      detectionStore.publish({
        request,
        result: {
          cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
          providers: [],
          catalog: {},
          cliModels: [],
          generation: 1,
        },
      }),
    ).toBe(true);
    routerStore.init({
      screen: 'setup',
      onComplete: 'workflow',
      feature: 'setup continues into a run',
      allowRepoRunners: false,
    });

    const ui = mount(fx.deps);
    await flushEffects();
    await vi.waitFor(() => expect(frame(ui)).toContain('Set up your crew'));

    await activateSetupContinue(ui);
    await vi.waitFor(() => expect(fx.ports.setupPrepare).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fx.ports.setupReadRunRecord).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(fx.ports.setupPrepare.mock.calls[0]?.[0]).toMatchObject({
      feature: 'setup continues into a run',
    });
    expect(fx.ports.setupReadRunRecord.mock.calls[0]?.[0]).toEqual({
      projectDir,
      sessionId: 'injected-setup-session',
    });
    expect(production.prepareExecution).not.toHaveBeenCalled();
    expect(production.readRunRecord).not.toHaveBeenCalled();
    expect(production.refreshPickerDetection).not.toHaveBeenCalled();
  });

  it('sends a Sessions selection to the supplied session-select ports', async () => {
    const fx = fixture();
    const session = makeSession({ id: 'sess-injected', feature: 'replayed run', status: 'open' });
    // The picker reads the list again from disk when it opens.
    saveSummary({ projectDir, sessionId: session.id }, session);
    sessionsStore.__testReset({ sessions: [session], totalCount: 1, projectDir });
    overlayStore.open('sessions');

    const ui = mount(fx.deps);
    await flushEffects();
    await vi.waitFor(() => expect(frame(ui)).toContain('replayed run'));

    await type(ui, ENTER);
    await vi.waitFor(() => expect(routerStore.get().screen).toBe('workflow'));
    ui.unmount();

    expect(fx.ports.hydrateRun).toHaveBeenCalledTimes(1);
    expect(fx.ports.prepareResume).not.toHaveBeenCalled();
    expect(production.prepareExecution).not.toHaveBeenCalled();
    expect(production.refreshPickerDetection).not.toHaveBeenCalled();
    // The one production read left on this path is the store's own admission read of the record
    // it was asked to open: `handleSessionSelect` owns it, not one of this card's files.
    expect(production.readRunRecord.mock.calls).toEqual([[{ projectDir, sessionId: session.id }]]);
  });
});

describe('Runtime commands run through the supplied context', () => {
  it('runs a slash command through the supplied context, not the production refresh', async () => {
    const fx = fixture();
    const ui = mount(fx.deps);
    await flushEffects();

    await type(ui, '/refresh');
    await type(ui, ENTER);
    await vi.waitFor(() => expect(fx.ports.ctxRefreshDetection).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(production.refreshDetectionForCurrentConfig).not.toHaveBeenCalled();
  });

  it('runs the same command from the palette through the supplied context', async () => {
    const fx = fixture();
    overlayStore.open('command-palette');
    const ui = mount(fx.deps);
    await flushEffects();

    await type(ui, 'refresh');
    expect(frame(ui)).toContain('/refresh');
    await type(ui, ENTER);
    await vi.waitFor(() => expect(fx.ports.ctxRefreshDetection).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(production.refreshDetectionForCurrentConfig).not.toHaveBeenCalled();
  });

  it('copies through the supplied context without reaching the clipboard', async () => {
    const fx = fixture();
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        ref: { projectDir, sessionId: 'sess-copy' },
        feature: 'copy through the port',
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'planner', call: 'tasks' },
        },
      }),
      execution: { kind: 'at-rest' },
    });

    const ui = mount(fx.deps);
    await flushEffects();
    await type(ui, '/copy');
    await type(ui, ENTER);
    await vi.waitFor(() => expect(fx.ports.ctxCopyTarget).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(fx.ports.ctxCopyTarget.mock.calls[0]?.[0]).toBe('message');
    expect(production.copyToClipboard).not.toHaveBeenCalled();
  });

  it('requires every port on the supplied object', () => {
    assertEveryPortIsRequired(fixture().deps);
  });
});

describe('Seat pickers spend the supplied picker ports', () => {
  it.each(SEAT_PICKER_ROLES)('%s: ctrl+R refreshes through the port', async (role) => {
    const fx = fixture();
    overlayStore.open(`${role}-picker`);
    const ui = mount(fx.deps);
    await flushEffects();

    await type(ui, CTRL_R);
    await vi.waitFor(() => expect(fx.ports.pickerRefresh).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(fx.ports.pickerRefresh.mock.calls[0]).toEqual([projectDir]);
    expect(production.refreshPickerDetection).not.toHaveBeenCalled();
  });

  it.each(SEAT_PICKER_ROLES)(
    "%s: Check asks the supplied probe about that seat's own address",
    async (role) => {
      const fx = fixture();
      overlayStore.open(`${role}-picker`, 'tool:ollama');
      pickerViewStore.open({ kind: 'local-connection', provider: 'ollama' });
      const ui = mount(fx.deps);
      await flushEffects();

      expect(frame(ui)).toContain(CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]]);
      await type(ui, ENTER);
      await vi.waitFor(() => expect(fx.ports.checkConnection).toHaveBeenCalledTimes(1));
      ui.unmount();

      // PLAN owns the configured address; the other two seats own none, so the form offers the
      // profile default rather than reading the planner's server.
      expect(fx.ports.checkConnection.mock.calls[0]?.[0]).toEqual({
        provider: 'ollama',
        apiBase: role === 'planner' ? OLLAMA_SEAT_BASE : getKnownProviderBaseURL('ollama'),
      });
      expect(production.detectProviderCatalog).not.toHaveBeenCalled();
    },
  );

  it.each(SEAT_PICKER_ROLES)(
    '%s: a confirmation saves through the port and a cancel saves nothing',
    async (role) => {
      const fx = fixture();
      overlayStore.open(`${role}-picker`, 'tool:ollama');
      pickerViewStore.open({ kind: 'local-connection', provider: 'ollama' });
      const cancelled = mount(fx.deps);
      await flushEffects();
      await type(cancelled, ENTER);
      await vi.waitFor(() => expect(cancelled.lastFrame()).toContain('gemma3:27b'));
      await type(cancelled, ESC);
      cancelled.unmount();

      expect(fx.ports.saveConfig).not.toHaveBeenCalled();

      overlayStore.open(`${role}-picker`, 'tool:ollama');
      pickerViewStore.open({ kind: 'local-connection', provider: 'ollama' });
      const ui = mount(fx.deps);
      await flushEffects();
      await type(ui, ENTER);
      await vi.waitFor(() => expect(ui.lastFrame()).toContain('gemma3:27b'));
      // Address, Token, Check, then the two catalog rows: the second one is a model no seat
      // is on, so a save that carries it can only have come from the row under the cursor.
      for (const key of [DOWN, DOWN, DOWN, DOWN]) await type(ui, key);
      await type(ui, ENTER);
      await vi.waitFor(() => expect(fx.ports.saveConfig).toHaveBeenCalledTimes(1));
      ui.unmount();

      const saved = fx.ports.saveConfig.mock.calls[0]?.[0] as ReturnType<typeof seatConfig>;
      const seat =
        role === 'planner'
          ? saved.planner
          : role === 'reviewer'
            ? saved.reviewer
            : saved.implementer;
      expect(seat).toMatchObject({ kind: 'api', provider: 'ollama', model: 'gemma3:27b' });
      // Nothing reached the project either: the port is the only way out.
      expect(readdirSync(projectDir)).toEqual([]);
    },
  );
});

describe('App keys spend the supplied key ports', () => {
  it('quits through the injected requestQuit', async () => {
    const fx = fixture();
    const ui = mount(fx.deps);
    await flushEffects();

    await type(ui, CTRL_Q);
    await vi.waitFor(() => expect(fx.ports.requestQuit).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(production.requestQuit).not.toHaveBeenCalled();
  });

  it('stops a local run through the injected requestStopNow', async () => {
    const fx = fixture();
    const prepared = makePreparedExecution({
      projectDir,
      sessionId: 'sess-local',
      feature: 'a run on screen',
      config: makeConfig(),
    });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        ref: prepared.session.ref,
        feature: 'a run on screen',
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'planner', call: 'tasks' },
        },
      }),
      execution: { kind: 'local', prepared },
    });

    const ui = mount(fx.deps);
    await flushEffects();
    await type(ui, CTRL_C);
    await vi.waitFor(() => expect(fx.ports.requestStopNow).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(production.requestStopNow).not.toHaveBeenCalled();
  });

  it('rescans skills through the injected refreshSkills', async () => {
    const fx = fixture();
    const ui = mount(fx.deps);
    await flushEffects();

    await type(ui, CTRL_S);
    await vi.waitFor(() => expect(fx.ports.refreshSkills).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(overlayStore.get().active).toBe('skills');
    expect(production.discoverSkills).not.toHaveBeenCalled();
  });
});

describe('Without the interaction object every surface keeps its production port', () => {
  it('rescans skills through the production discovery', async () => {
    const ui = mount();
    await flushEffects();

    await type(ui, CTRL_S);
    await vi.waitFor(() => expect(production.discoverSkills).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(production.discoverSkills.mock.calls[0]).toEqual([projectDir]);
  });

  it('refreshes detection through the production command context', async () => {
    const ui = mount();
    await flushEffects();

    await type(ui, '/refresh');
    await type(ui, ENTER);
    await vi.waitFor(() =>
      expect(production.refreshDetectionForCurrentConfig).toHaveBeenCalledTimes(1),
    );
    ui.unmount();
  });

  it('refreshes the picker through the production detection refresh', async () => {
    overlayStore.open('planner-picker');
    const ui = mount();
    await flushEffects();

    await type(ui, CTRL_R);
    await vi.waitFor(() => expect(production.refreshPickerDetection).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(production.refreshPickerDetection.mock.calls[0]).toEqual([projectDir]);
  });

  it('checks a local connection through the production catalog probe', async () => {
    overlayStore.open('planner-picker', 'tool:ollama');
    pickerViewStore.open({ kind: 'local-connection', provider: 'ollama' });
    const ui = mount();
    await flushEffects();

    await type(ui, ENTER);
    await vi.waitFor(() => expect(production.detectProviderCatalog).toHaveBeenCalledTimes(1));
    ui.unmount();

    expect(production.detectProviderCatalog.mock.calls[0]?.[0]).toMatchObject({
      provider: 'ollama',
      configOverrides: { apiBase: OLLAMA_SEAT_BASE },
    });
  });
});

/** Every relative import specifier in one module, in source order. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'(\.[^']*)'/g)].map((match) => match[1] ?? '');
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe('The import direction stays shell to page and feature', () => {
  it('has no page or feature reaching for App, the composition root or the router', () => {
    const src = resolve(import.meta.dirname, '..');
    const shellOnly = [join(src, 'app', 'root'), join(src, 'app', 'router')];
    const below = ['features', 'components', 'hooks', 'core', 'engine', 'stores'].map((dir) =>
      join(src, dir),
    );
    const offenders: string[] = [];

    for (const dir of [...below, join(src, 'app', 'screens'), join(src, 'app', 'overlays')]) {
      for (const file of sourceFiles(dir)) {
        for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
          const target = resolve(dirname(file), specifier).replace(/\.js$/, '');
          if (shellOnly.includes(target)) offenders.push(`${relative(src, file)} ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
