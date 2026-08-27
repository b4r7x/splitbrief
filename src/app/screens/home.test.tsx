import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeResumeAuthorityDeps } from '#testing/helpers/factories/state-authority.js';
import { saveSummary } from '../../core/sessions/io.js';
import { prepareNewSession } from '../../core/sessions/prepare.js';
import { saveState } from '../../core/state/persistence.js';
import { loadState } from '../../core/state/persistence.js';
import { createInitialState } from '../../core/state/machine.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { sessionSelectStore } from '../../stores/navigation/session-select.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import type { TieredApprovalResponse } from '../../core/approval/types.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import type { PrepareExecutionInput } from '../../engine/runners/prepare-execution.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import {
  approvalPromptStore,
  closeApprovalPrompt,
  openApprovalPrompt,
} from '../../stores/approval-prompt/prompt.js';
import { getLogo } from '../../features/home/logo.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { HomeScreen, type HomeScreenDeps } from './home.js';
import { Layout } from '../layout.js';
import { SessionPreparation } from '../session-preparation.js';

const prepareExecutionMock = vi.fn<(input: PrepareExecutionInput) => Promise<PreparationOutcome>>();

const originalPlatform = process.platform;

const CTRL_R = '\x12';
const ARROW_DOWN = '\u001b[B';
const ARROW_UP = '\u001b[A';
const ESC = '\u001b';
const ENTER = '\r';
const DEFAULT_HOME_HINT = '/help · /crew · /settings · /skills · ctrl+k commands';
const HOME_HINT = '/help · /crew · /settings · /skills · ctrl+r recent · ctrl+k commands';
const RECENT_SESSIONS_HINT = '↑↓ navigate · ⏎ open · y copy · esc back';
const FOCUS_BAR = '▌';
// Real session-file I/O (saveSummary + load/loadAll) can outlive vi.waitFor's 1s default
// under full-suite load; filter-settle polls need more headroom.
const SESSION_FILTER_WAIT_MS = 5000;
const DISCOVERY_CONTEXTS = {
  readiness: 'home:readiness',
  modelsDev: 'home:models-dev',
  cliModels: 'home:cli-models',
};

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: 'Show help',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/mode',
    label: 'Mode',
    description: 'Workflow mode',
    category: 'navigate',
    args: { kind: 'free', hint: '<text>' },
    validScreens: ['home'],
    handler: () => {},
  },
];

function readinessReport(checks: ReadinessCheck[] = []): ReadinessReport {
  const counts = {
    ok: checks.filter((check) => check.severity === 'ok').length,
    info: checks.filter((check) => check.severity === 'info').length,
    warning: checks.filter((check) => check.severity === 'warning').length,
    blocker: checks.filter((check) => check.severity === 'blocker').length,
  };
  const blocked = counts.blocker > 0;
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: '/project',
    status: blocked ? 'blocked' : 'ready',
    counts,
    nextAction: blocked
      ? { kind: 'exit', label: 'Exit', reason: 'Resolve the blocker.' }
      : { kind: 'continue', label: 'Continue', reason: 'Ready.' },
    sections: checks.length > 0 ? [{ id: 'tools', title: 'Configured tools', checks }] : [],
    metadata: {},
  };
}

function preparedExecution(input: PrepareExecutionInput): PreparedExecution {
  const report = readinessReport();
  const sessionId = 'existingSession' in input ? input.existingSession.sessionId : 'home-prepared';
  const receipt = {
    version: 1 as const,
    sessionId,
    generation: '11111111-1111-4111-8111-111111111111',
  };
  return {
    purpose: input.policy.purpose,
    config: input.effectiveConfig,
    preparationId: 'home-preparation',
    report,
    gates: [],
    session:
      'existingSession' in input
        ? { kind: 'existing', ref: input.existingSession, active: receipt }
        : newPreparedSession(input, report),
    runtime: {
      feature: input.feature,
      ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
      ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
      allowRepoRunners: input.policy.allowRepoRunners,
      allowHooks: input.policy.allowHooks,
    },
  };
}

function newPreparedSession(
  input: Exclude<PrepareExecutionInput, { existingSession: object }>,
  report: ReadinessReport,
): Extract<PreparedExecution['session'], { kind: 'new' }> {
  const prepared = prepareNewSession({
    projectDir: input.projectDir,
    feature: input.feature,
    config: input.effectiveConfig,
    report,
  });
  if (prepared.kind === 'aborted') throw new Error('Expected the test session to be prepared.');
  return { kind: 'new', ...prepared.session };
}

function preparedResumeExecution(
  input: Parameters<HomeScreenDeps['sessionSelect']['prepareResume']>[0],
): PreparedExecution {
  const active = {
    version: 1 as const,
    sessionId: input.ref.sessionId,
    generation: '22222222-2222-4222-8222-222222222222',
  };
  return {
    purpose: 'resume',
    config: makeConfig(),
    preparationId: 'home-resume-preparation',
    report: readinessReport(),
    gates: [],
    session: { kind: 'existing', ref: input.ref, active },
    runtime: {
      feature: input.state.feature,
      resumeState: input.state,
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

const HOME_DEPS: HomeScreenDeps = {
  prepareExecution: prepareExecutionMock,
  sessionSelect: {
    ...makeResumeAuthorityDeps((ref) => loadState(ref)),
    prepareResume: async (input) => ({
      kind: 'prepared',
      execution: preparedResumeExecution(input),
    }),
  },
};

// Ink lays out at stdout.columns, so a mount that ignores the seeded viewport
// renders the body at a width the screen never asked for: at 120 the wide body
// (108) overflows the helper's 100-column default and the frame loses its left
// edge — the outdent cursor first.
function seededViewport() {
  const { cols, rows } = terminalSizeStore.get();
  return { cols, rows };
}

function renderHome(deps: HomeScreenDeps = HOME_DEPS) {
  return renderFeature(
    <HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} deps={deps} />,
    seededViewport(),
  );
}

function HomeWithSessionPreparation({ deps }: { deps: HomeScreenDeps }) {
  const preparationActive = sessionSelectStore.use((state) => state.preparation.kind !== 'idle');
  return (
    <Layout
      screen={<HomeScreen commands={COMMANDS} onRuntimeCommand={() => {}} deps={deps} />}
      overlay={null}
      sessionPreparation={<SessionPreparation />}
      sessionPreparationActive={preparationActive}
    />
  );
}

function renderHomeWithSessionPreparation(deps: HomeScreenDeps) {
  return renderFeature(<HomeWithSessionPreparation deps={deps} />, seededViewport());
}

beforeEach(() => {
  prepareExecutionMock.mockReset();
  prepareExecutionMock.mockImplementation(async (input) => ({
    kind: 'prepared',
    execution: preparedExecution(input),
  }));
});

function lineContaining(frame: string, text: string): string {
  const line = stripAnsiStyles(frame)
    .split('\n')
    .find((candidate) => candidate.includes(text));
  expect(line).toBeDefined();
  return line ?? '';
}

function expectLineContains(frame: string, anchor: string, text: string): void {
  const line = lineContaining(frame, anchor);
  expect(line).toContain(text);
}

function columnIndexOf(frame: string, text: string): number {
  return lineContaining(frame, text).indexOf(text);
}

describe('HomeScreen', () => {
  let projectDir = '';

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    projectDir = createTempDir('home-screen-test');
    configStore.__testReset({ config: makeConfig(), projectDir });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
    projectDir = '';
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('shows the cold initialization notice while first discovery runs, then hides it', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    detectionStore.beginRefresh({ contexts: DISCOVERY_CONTEXTS });

    const ui = renderHome();
    await flushEffects();
    const coldFrame = ui.lastFrame() ?? '';
    expect(coldFrame).toContain('Initializing your tools…');
    const anchorRow = coldFrame.split('\n').findIndex((line) => line.includes('Recent sessions'));

    detectionStore.hydrate({
      providers: [],
      cliTools: [],
      fetchedAt: 100,
      validatedAt: 100,
      generation: 1,
      requestId: 1,
      contexts: DISCOVERY_CONTEXTS,
    });
    await flushEffects();
    const settledFrame = ui.lastFrame() ?? '';
    expect(settledFrame).not.toContain('Initializing your tools…');
    expect(settledFrame).not.toContain('Tools ready');
    // The box floats in the slack between content and the bottom-anchored
    // composer: neither the recent-sessions block nor the input may move when
    // it disappears, and nothing may linger in its place.
    expect(settledFrame.split('\n').findIndex((line) => line.includes('Recent sessions'))).toBe(
      anchorRow,
    );
    expect(settledFrame.split('\n').findIndex((line) => line.includes('›'))).toBe(
      coldFrame.split('\n').findIndex((line) => line.includes('›')),
    );
    ui.unmount();
  });

  it('shows the refreshing notice during a warm background refresh', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    detectionStore.hydrate({
      providers: [],
      cliTools: [],
      fetchedAt: 100,
      validatedAt: 100,
      generation: 1,
      requestId: 1,
      contexts: DISCOVERY_CONTEXTS,
    });
    detectionStore.beginRefresh({ contexts: DISCOVERY_CONTEXTS });

    const ui = renderHome();
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Refreshing your tools…');
    expect(frame).not.toContain('Initializing your tools…');
    ui.unmount();
  });

  it('shows an actionable failure line when cold discovery fails', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const request = detectionStore.beginRefresh({ contexts: DISCOVERY_CONTEXTS });
    expect(
      detectionStore.publish({
        request,
        result: {
          providers: [],
          cliTools: [],
          catalog: null,
          cliModels: [],
          generation: 1,
          outcomes: {
            readiness: {
              kind: 'failed',
              source: 'readiness',
              contextKey: DISCOVERY_CONTEXTS.readiness,
              generation: 1,
              requestId: 1,
              checkedAt: 100,
              error: { kind: 'timeout', message: 'Discovery request timed out.' },
            },
            modelsDev: {
              kind: 'not-run',
              source: 'models-dev',
              contextKey: DISCOVERY_CONTEXTS.modelsDev,
              reason: 'offline',
            },
            cliModels: {
              kind: 'not-run',
              source: 'cli-models',
              contextKey: DISCOVERY_CONTEXTS.cliModels,
              reason: 'offline',
            },
          },
        },
      }),
    ).toBe(true);

    const ui = renderHome();
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Tool check failed');
    expect(frame).toContain('Open /settings to retry.');
    expect(frame).not.toContain('Initializing your tools…');
    ui.unmount();
  });

  it('centers the main content on wide terminals while keeping the input visible', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 42, isSmall: false });

    const ui = renderHome();
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    const plannerLine = frame.split('\n').find((line) => line.includes('Claude Code CLI')) ?? '';
    expect(plannerLine.indexOf('Claude Code CLI')).toBeGreaterThan(0);
    expect(frame).not.toContain('plan expensively · build cheaply');
    expect(frame).toContain(DEFAULT_HOME_HINT);
    ui.unmount();
  });

  it('keeps useful compact content on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: true });

    const ui = renderHome();
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('|___/ .__/');
    expect(frame).toContain('standard');
    expect(frame).toContain('No recent sessions');
    ui.unmount();
  });

  it('renders slash suggestions with the docked input', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 34, isSmall: false });

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('/');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('tab fill');
    ui.unmount();
  });

  it('gives every seat its own bounded row above the composer', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
    const longModel = 'provider-family-long';
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: longModel },
        implementer: { model: longModel },
        workflow: { mode: 'standard' },
      }),
    });

    const ui = renderHome();
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(lineContaining(frame, 'OpenAI Codex CLI')).not.toContain('Ollama');
    expect(lineContaining(frame, 'Ollama')).toContain('BUILD');
    expect(lineContaining(frame, 'REVIEW')).toContain(PLANNER_INHERITANCE.sentence);
    expect(frame.split('\n').length).toBeLessThanOrEqual(30);
    expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 100)).toBe(true);
    ui.unmount();
  });

  it('caps recent sessions and reports a hidden count when capacity is tight', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 18, isSmall: true });

    for (let i = 0; i < 25; i++) {
      saveSummary(
        { projectDir: projectDir, sessionId: `session-${i}` },
        makeSession({
          id: `session-${i}`,
          feature: `feature ${i}`,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }

    const ui = renderHome();
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('feature 24');
    expect(frame).toMatch(/\b\d+ more\b/);
    expect(frame).not.toContain('ctrl+r');
    ui.unmount();
  });

  it('shows recent sessions on short terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 18, isSmall: true });
    saveSummary(
      { projectDir: projectDir, sessionId: 'short-session' },
      makeSession({
        id: 'short-session',
        feature: 'short feature',
      }),
    );

    const ui = renderHome();
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('short feature');
    expect(sessionsStore.get().sessions.length).toBeGreaterThan(0);
    ui.unmount();
  });

  it('opens slash suggestions as an overlay while keeping centered content visible', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 42, isSmall: false });

    const ui = renderHome();
    await flushEffects();

    const before = ui.lastFrame() ?? '';
    const plannerLine = lineContaining(before, 'Claude Code CLI');
    const modeLine = lineContaining(before, 'standard');

    await flushEffects();
    ui.stdin.write('/');
    await flushEffects();

    const after = ui.lastFrame() ?? '';
    expect(after).toContain('tab fill');
    expect(lineContaining(after, 'Claude Code CLI')).toBe(plannerLine);
    expect(lineContaining(after, 'standard')).toBe(modeLine);
    ui.unmount();
  });

  it('renders the full ASCII wordmark on large terminals', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });

    const ui = renderHome();
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('|____/| .__/');
    const renderedLogoLines = getLogo('full')
      .split('\n')
      .filter((line) => frame.includes(line.trim()));
    expect(renderedLogoLines.length).toBeGreaterThanOrEqual(5);
    ui.unmount();
  });

  it('renders compact ASCII art on small terminals', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 15, isSmall: true });

    const ui = renderHome();
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('|___/ .__/');
    const compactLines = new Set(
      getLogo('compact')
        .split('\n')
        .map((line) => line.trim()),
    );
    const fullOnlyLines = getLogo('full')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !compactLines.has(line));
    expect(fullOnlyLines.filter((line) => frame.includes(line))).toEqual([]);
    ui.unmount();
  });

  it('uses all safe vertical space before cutting recent sessions on tall terminals', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });

    for (let i = 0; i < 30; i++) {
      saveSummary(
        { projectDir: projectDir, sessionId: `session-${i}` },
        makeSession({
          id: `session-${i}`,
          feature: `tall feature ${i}`,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }

    const ui = renderHome();
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    const visibleCount = Array.from({ length: 30 }, (_, i) => `tall feature ${i}`).filter((label) =>
      frame.includes(label),
    ).length;
    expect(visibleCount).toBe(30);
    expect(frame).not.toMatch(/\b\d+ more\b/);
    expect(frame).toContain(HOME_HINT);
    expect(frame).toContain('›');
    ui.unmount();
  });

  it('renders logo and recent sessions within the terminal budget', async () => {
    const terminalRows = 30;
    terminalSizeStore.__testReset({ cols: 120, rows: terminalRows, isSmall: false });

    saveSummary(
      { projectDir: projectDir, sessionId: 'gap-session' },
      makeSession({
        id: 'gap-session',
        feature: 'gap test feature',
        startedAt: 1_700_000_000,
      }),
    );

    const ui = renderHome();
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(terminalRows);
    expect(frame).toContain('|____/| .__/');
    expect(frame).toContain('gap test feature');
    expect(frame).toContain(HOME_HINT);
    ui.unmount();
  });

  it('cached ready cannot bypass a fresh blocked preparation', async () => {
    detectionStore.hydrate({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      fetchedAt: 100,
      validatedAt: 100,
      generation: 1,
      requestId: 1,
      contexts: DISCOVERY_CONTEXTS,
    });
    prepareExecutionMock.mockResolvedValue({
      kind: 'blocked',
      report: readinessReport([
        {
          id: 'runners.planner.fresh-evidence',
          severity: 'blocker',
          summary: 'The configured planner could not be verified.',
          fix: 'Review the configured runner and retry.',
        },
      ]),
    });

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('fresh denial');
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Start is blocked');
    }, SESSION_FILTER_WAIT_MS);
    expect(prepareExecutionMock).toHaveBeenCalledOnce();
    expect(prepareExecutionMock.mock.calls[0]?.[0]).toMatchObject({
      projectDir,
      feature: 'fresh denial',
      policy: { purpose: 'new-workflow', interaction: 'interactive' },
    });
    expect(routerStore.get()).toEqual({ screen: 'home' });
    expect(existsSync(join(projectDir, '.splitbrief', 'sessions'))).toBe(false);
    ui.unmount();
  });

  it('start while background refresh is pending uses independent fresh preparation', async () => {
    detectionStore.hydrate({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      fetchedAt: 100,
      validatedAt: 100,
      generation: 1,
      requestId: 1,
      contexts: DISCOVERY_CONTEXTS,
    });
    detectionStore.beginRefresh({ contexts: DISCOVERY_CONTEXTS });
    const pending = Promise.withResolvers<PreparationOutcome>();
    prepareExecutionMock.mockReturnValue(pending.promise);

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('independent preparation');
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(
      () => expect(prepareExecutionMock).toHaveBeenCalledOnce(),
      SESSION_FILTER_WAIT_MS,
    );
    expect(detectionStore.get().refresh.readiness.refreshing).toBe(true);
    const input = prepareExecutionMock.mock.calls[0]?.[0];
    if (!input) throw new Error('Expected a preparation input.');
    const exactExecution = preparedExecution(input);
    pending.resolve({ kind: 'prepared', execution: exactExecution });

    await vi.waitFor(
      () => expect(routerStore.get().screen).toBe('workflow'),
      SESSION_FILTER_WAIT_MS,
    );
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.execution).toEqual({ kind: 'local', prepared: exactExecution });
      if (route.execution.kind === 'local') {
        expect(route.execution.prepared).toBe(exactExecution);
      }
    }
    const exactSessionDir = join(
      exactExecution.session.ref.projectDir,
      '.splitbrief',
      'sessions',
      exactExecution.session.ref.sessionId,
    );
    expect(existsSync(join(exactSessionDir, '.prepare-owner.json'))).toBe(false);
    expect(existsSync(join(exactSessionDir, 'readiness.json'))).toBe(true);
    ui.unmount();
  });

  it('failed preparation stays on Home with generic retry back settings and prioritized blockers', async () => {
    const checks: ReadinessCheck[] = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `runners.warning-${index + 1}`,
        severity: 'warning' as const,
        summary: `Configured runner warning ${index + 1}.`,
      })),
      {
        id: 'runners.blocker',
        severity: 'blocker',
        summary: 'A configured runner must be fixed before starting.',
        fix: 'Open settings and review the runner.',
      },
    ];
    prepareExecutionMock.mockResolvedValue({
      kind: 'failed',
      report: readinessReport(checks),
      error: new Error('Fresh tool preparation could not finish.'),
    });

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('actionable failure');
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Tool preparation · Failed');
      expect(frame).toContain('runners.blocker');
      expect(frame).toContain('2 checks hidden');
      expect(frame).toContain('r retry · esc back · s settings');
    }, SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toEqual({ screen: 'home' });
    expect(existsSync(join(projectDir, '.splitbrief', 'sessions'))).toBe(false);

    // Let the failed-panel useInput handler attach before the shortcut press
    // (under suite load a same-tick `s` can miss and leave overlay idle).
    await flushEffects();
    await tick();
    ui.stdin.write('s');
    await flushEffects();
    await vi.waitFor(
      () => expect(overlayStore.get().active).toBe('settings'),
      SESSION_FILTER_WAIT_MS,
    );
    overlayStore.close();
    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain(DEFAULT_HOME_HINT);
      expect(frame).not.toContain('Tool preparation');
    }, SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toEqual({ screen: 'home' });
    ui.unmount();
  });

  it('during preparation the submitted text stays in the composer with no byline', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    prepareExecutionMock.mockReturnValue(pending.promise);

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('background preparation');
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(
      () => expect(prepareExecutionMock).toHaveBeenCalledOnce(),
      SESSION_FILTER_WAIT_MS,
    );
    await flushEffects();
    const submittedFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(submittedFrame).toContain('background preparation');
    expect(submittedFrame).not.toContain('Initializing your tools…');

    await tick(500);
    const settledFrame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(settledFrame).toContain('|____/| .__/');
    expect(settledFrame).toContain('background preparation');
    expect(settledFrame).toContain(DEFAULT_HOME_HINT);
    expect(settledFrame).not.toContain('Initializing your tools…');
    ui.unmount();
  });

  it('esc during preparation leaves the submitted draft in the composer input', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    prepareExecutionMock.mockReturnValue(pending.promise);

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('restore this draft');
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(
      () => expect(prepareExecutionMock).toHaveBeenCalledOnce(),
      SESSION_FILTER_WAIT_MS,
    );
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('restore this draft');
      expect(frame).not.toContain('Initializing your tools…');
    }, SESSION_FILTER_WAIT_MS);

    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('restore this draft');
      expect(frame).toContain(DEFAULT_HOME_HINT);
      expect(frame).not.toContain('Initializing your tools…');
    }, SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toEqual({ screen: 'home' });
    ui.unmount();
  });

  it('a repeat Enter during preparation keeps the submitted draft in the composer', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    prepareExecutionMock.mockReturnValue(pending.promise);

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('keep this draft');
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('keep this draft');
      expect(frame).not.toContain('Initializing your tools…');
    }, SESSION_FILTER_WAIT_MS);

    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('keep this draft');
      expect(frame).not.toContain('Describe your feature…');
    }, SESSION_FILTER_WAIT_MS);
    expect(prepareExecutionMock).toHaveBeenCalledOnce();

    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('keep this draft');
      expect(frame).toContain(DEFAULT_HOME_HINT);
    }, SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toEqual({ screen: 'home' });
    ui.unmount();
  });

  it('aborts on Escape and rolls back a late prepared completion without navigation', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    prepareExecutionMock.mockImplementation((input) => {
      signal = input.signal;
      return pending.promise;
    });

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('cancel preparation');
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => expect(prepareExecutionMock).toHaveBeenCalledOnce(),
      SESSION_FILTER_WAIT_MS,
    );
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('cancel preparation');
      expect(frame).not.toContain('Initializing your tools…');
    }, SESSION_FILTER_WAIT_MS);

    ui.stdin.write(ESC);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toEqual({ screen: 'home' });
    const input = prepareExecutionMock.mock.calls[0]?.[0];
    if (!input) throw new Error('Expected a preparation input.');
    const lateExecution = preparedExecution(input);
    const lateSessionDir = join(
      lateExecution.session.ref.projectDir,
      '.splitbrief',
      'sessions',
      lateExecution.session.ref.sessionId,
    );
    expect(existsSync(lateSessionDir)).toBe(true);
    pending.resolve({ kind: 'prepared', execution: lateExecution });

    await vi.waitFor(() => expect(existsSync(lateSessionDir)).toBe(false), SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toEqual({ screen: 'home' });
    expect(existsSync(join(projectDir, '.splitbrief', 'active'))).toBe(false);
    ui.unmount();
  });

  it('aborts an in-flight preparation on unmount', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    prepareExecutionMock.mockImplementation((input) => {
      signal = input.signal;
      return pending.promise;
    });

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('unmount preparation');
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => expect(prepareExecutionMock).toHaveBeenCalledOnce(),
      SESSION_FILTER_WAIT_MS,
    );

    ui.unmount();
    expect(signal?.aborted).toBe(true);
    const input = prepareExecutionMock.mock.calls[0]?.[0];
    if (!input) throw new Error('Expected a preparation input.');
    const lateExecution = preparedExecution(input);
    const lateSessionDir = join(
      lateExecution.session.ref.projectDir,
      '.splitbrief',
      'sessions',
      lateExecution.session.ref.sessionId,
    );
    expect(existsSync(lateSessionDir)).toBe(true);
    pending.resolve({ kind: 'prepared', execution: lateExecution });
    await vi.waitFor(() => expect(existsSync(lateSessionDir)).toBe(false), SESSION_FILTER_WAIT_MS);
    expect(routerStore.get()).toEqual({ screen: 'home' });
  });

  it('reports a stale cleanup failure without navigating or rejecting unobserved', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    prepareExecutionMock.mockImplementation((input) => {
      signal = input.signal;
      return pending.promise;
    });

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('cleanup failure');
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => expect(prepareExecutionMock).toHaveBeenCalledOnce(),
      SESSION_FILTER_WAIT_MS,
    );
    ui.stdin.write(ESC);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), SESSION_FILTER_WAIT_MS);

    const input = prepareExecutionMock.mock.calls[0]?.[0];
    if (!input) throw new Error('Expected a preparation input.');
    const lateExecution = preparedExecution(input);
    const ownershipFile = join(
      lateExecution.session.ref.projectDir,
      '.splitbrief',
      'sessions',
      lateExecution.session.ref.sessionId,
      '.prepare-owner.json',
    );
    unlinkSync(ownershipFile);
    pending.resolve({ kind: 'prepared', execution: lateExecution });

    await vi.waitFor(
      () => expect(feedbackStore.get().message).toContain('Could not clean up tool preparation'),
      SESSION_FILTER_WAIT_MS,
    );
    expect(ui.lastFrame() ?? '').toContain('Could not clean up tool preparation');
    expect(routerStore.get()).toEqual({ screen: 'home' });
    ui.unmount();
  });

  it('renders the existing tiered approval prompt during fresh preparation', async () => {
    const pending = Promise.withResolvers<PreparationOutcome>();
    prepareExecutionMock.mockImplementation(async (input) => {
      const onTieredApproval = input.policy.onTieredApproval;
      if (!onTieredApproval) throw new Error('Expected the interactive approval callback.');
      await onTieredApproval({
        tier: 'sticky',
        actionClass: 'network',
        actionDescription: 'Run the configured custom tool',
        phase: 'planning',
      });
      return pending.promise;
    });

    const ui = renderHome();
    await flushEffects();
    ui.stdin.write('custom tool approval');
    await flushEffects();
    ui.stdin.write(ENTER);

    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Run the configured custom tool');
      expect(frame).not.toContain('Preparing your tools');
    }, SESSION_FILTER_WAIT_MS);
    closeApprovalPrompt();
    pending.resolve({ kind: 'aborted' });
    await flushEffects();
    ui.unmount();
  });
});

describe('HomeScreen recent-sessions focus (Ctrl+R navigation)', () => {
  let projectDir = '';

  function seedSessions(count: number): void {
    for (let i = 0; i < count; i++) {
      saveSummary(
        { projectDir, sessionId: `focus-session-${i}` },
        makeSession({
          id: `focus-session-${i}`,
          feature: `focus feature ${i}`,
          status: 'interrupted',
          summary: null,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }
  }

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    installClipboardExecFixture();
    resetClipboardExecFixture();
    projectDir = createTempDir('home-focus-test');
    configStore.__testReset({ config: makeConfig(), projectDir });
    terminalSizeStore.__testReset({ cols: 120, rows: 60, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
    restoreClipboardExecFixture();
    cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('Ctrl+R focuses the recent-sessions list', async () => {
    seedSessions(3);
    const ui = renderHome();
    await flushEffects();

    expect(ui.lastFrame() ?? '').not.toContain(FOCUS_BAR);

    await flushEffects();
    ui.stdin.write(CTRL_R);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(FOCUS_BAR);
    expect(frame).toContain(RECENT_SESSIONS_HINT);
    ui.unmount();
  });

  it('preserves the composer draft and selected session across viable resize changes', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    seedSessions(3);
    const target = {
      id: 'focus-session-1',
      feature: 'focus feature 1',
    };
    saveState(
      { projectDir, sessionId: target.id },
      {
        ...createInitialState(target.feature),
        phase: 'implementing',
      },
    );
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write('preserved draft');
    await flushEffects();
    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      expectLineContains(ui.lastFrame() ?? '', target.feature, FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);

    for (const viewport of [
      { cols: 80, rows: 24, isSmall: true },
      { cols: 120, rows: 40, isSmall: false },
    ]) {
      terminalSizeStore.__testReset(viewport);
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      expect(frame, `${viewport.cols}x${viewport.rows}`).toContain('preserved draft');
      expectLineContains(frame, target.feature, FOCUS_BAR);
      expect(frame.split('\n').length, `${viewport.cols}x${viewport.rows}`).toBeLessThanOrEqual(
        viewport.rows,
      );
    }

    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    }, SESSION_FILTER_WAIT_MS);
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.execution.kind).toBe('local');
      if (route.execution.kind === 'local') {
        expect(route.execution.prepared.runtime.feature).toBe(target.feature);
        expect(route.execution.prepared.session.ref.sessionId).toBe(target.id);
      }
    }
    ui.unmount();
  });

  it('engages the bordered focused recent-sessions chrome at a viable small height', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    seedSessions(30);
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Recent sessions');
      expect(frame).toContain('Type to filter…');
      expect(frame).toContain(RECENT_SESSIONS_HINT);
      expect(frame).toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Ctrl+R is a no-op at 80x16 where the bordered filter cannot fit', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 16, isSmall: true });
    seedSessions(30);
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(FOCUS_BAR);
    expect(frame).not.toContain('Type to filter…');
    expect(frame).not.toContain('Recent sessions');
    ui.unmount();
  });

  it('Ctrl+R does not shift the recent-session rows horizontally', async () => {
    seedSessions(3);
    const marker = 'focus feature 1';
    const ui = renderHome();
    await flushEffects();

    const before = columnIndexOf(ui.lastFrame() ?? '', marker);

    await flushEffects();
    ui.stdin.write(CTRL_R);
    await flushEffects();

    const after = columnIndexOf(ui.lastFrame() ?? '', marker);
    expect(after).toBe(before);
    ui.unmount();
  });

  it('Ctrl+R is a no-op when there are no sessions', async () => {
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(DEFAULT_HOME_HINT);
    expect(frame).not.toContain(FOCUS_BAR);
    ui.unmount();
  });

  it('Down moves the cursor to the next visible session', async () => {
    seedSessions(3);
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expectLineContains(ui.lastFrame() ?? '', 'focus feature 2', FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      expectLineContains(ui.lastFrame() ?? '', 'focus feature 1', FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Ctrl+R can filter beyond the unfocused preview budget', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30, isSmall: false });
    for (let i = 0; i < 35; i++) {
      saveSummary(
        { projectDir, sessionId: `focus-session-${i}` },
        makeSession({
          id: `focus-session-${i}`,
          feature: i === 0 ? 'ancient hidden focus target' : `focus feature ${i}`,
          status: 'interrupted',
          summary: null,
          startedAt: 1_700_000_000 + i,
        }),
      );
    }

    const ui = renderHome();
    await flushEffects();

    expect(ui.lastFrame() ?? '').not.toContain('ancient hidden focus target');

    await flushEffects();
    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write('ancient');
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('ancient hidden focus target');
      expectLineContains(frame, 'ancient hidden focus target', FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);

    ui.unmount();
  });

  it('Esc returns focus to the composer', async () => {
    seedSessions(3);
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain(FOCUS_BAR);
      expect(frame).toContain(HOME_HINT);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Up at the top returns focus to the composer without wrapping', async () => {
    seedSessions(3);
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write(ARROW_UP);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain(FOCUS_BAR);
      expect(frame).toContain(HOME_HINT);
    }, SESSION_FILTER_WAIT_MS);
    ui.unmount();
  });

  it('Enter with a filter that matches nothing selects no session', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    saveSummary(
      { projectDir, sessionId: 'invisible-complete' },
      makeSession({
        id: 'invisible-complete',
        feature: 'invisible feature',
        status: 'complete',
        summary: makeSummary({ feature: 'invisible feature' }),
        startedAt: 1_700_000_700,
      }),
    );

    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Type to filter…');
      expect(frame).toContain('invisible feature');
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write('zzznomatch');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').not.toContain('invisible feature');
    }, SESSION_FILTER_WAIT_MS);

    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(routerStore.get().screen).toBe('home');
    ui.unmount();
  });

  it('y does not copy a session when the filtered list is empty', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    saveSummary(
      { projectDir, sessionId: 'invisible-copy' },
      makeSession({
        id: 'invisible-copy',
        feature: 'invisible copy feature',
        status: 'complete',
        summary: makeSummary({ feature: 'invisible copy feature' }),
        startedAt: 1_700_000_800,
      }),
    );

    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Type to filter…');
      expect(frame).toContain('invisible copy feature');
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();

    ui.stdin.write('zzznomatch');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').not.toContain('invisible copy feature');
    }, SESSION_FILTER_WAIT_MS);

    await flushEffects();
    ui.stdin.write('y');
    await flushEffects();

    expect(readClipboardExecCalls()).toHaveLength(0);
    ui.unmount();
  });

  it('Enter resumes an interrupted session into the workflow screen', async () => {
    saveSummary(
      { projectDir, sessionId: 'resume-me' },
      makeSession({
        id: 'resume-me',
        feature: 'resume feature',
        status: 'interrupted',
        summary: null,
        startedAt: 1_700_000_500,
      }),
    );
    const savedState = {
      ...createInitialState('resume feature'),
      phase: 'implementing' as const,
    };
    saveState({ projectDir, sessionId: 'resume-me' }, savedState);

    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('workflow');
    }, SESSION_FILTER_WAIT_MS);

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.execution.kind).toBe('local');
      if (route.execution.kind === 'local') {
        expect(route.execution.prepared.session.ref.sessionId).toBe('resume-me');
      }
    }
    ui.unmount();
  });

  it('renders and denies a recent-session custom-runner approval without hanging', async () => {
    saveSummary(
      { projectDir, sessionId: 'resume-custom-runner' },
      makeSession({
        id: 'resume-custom-runner',
        feature: 'resume custom runner',
        status: 'interrupted',
        summary: null,
        startedAt: 1_700_000_525,
      }),
    );
    saveState(
      { projectDir, sessionId: 'resume-custom-runner' },
      {
        ...createInitialState('resume custom runner'),
        phase: 'implementing',
      },
    );
    let approvalResponse: TieredApprovalResponse | undefined;
    let resumeSettled = false;
    const deps: HomeScreenDeps = {
      ...HOME_DEPS,
      sessionSelect: {
        ...HOME_DEPS.sessionSelect,
        prepareResume: async () => {
          approvalResponse = await openApprovalPrompt({
            tier: 'sticky',
            actionClass: 'network',
            actionDescription: 'Run the configured custom tool for this session',
            phase: 'implementing',
          });
          resumeSettled = true;
          return {
            kind: 'blocked',
            report: readinessReport([
              {
                id: 'runners.custom-approval',
                severity: 'blocker',
                summary: 'The configured custom runner was not approved.',
              },
            ]),
          };
        },
      },
    };

    const ui = renderHomeWithSessionPreparation(deps);
    await flushEffects();
    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    ui.stdin.write(ENTER);

    // Anchor on the store before polling the frame: the prompt mounts one
    // render after the approval request settles into the store.
    await vi.waitFor(() => expect(approvalPromptStore.get().status).toBe('pending'));
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Run the configured custom tool for this session');
      expect(frame).not.toContain(RECENT_SESSIONS_HINT);
      expect(frame).not.toContain(DEFAULT_HOME_HINT);
    });
    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    ui.stdin.write(ESC);

    await vi.waitFor(() => expect(resumeSettled).toBe(true));
    expect(approvalResponse).toEqual({ decision: 'deny', reason: 'user_cancelled' });
    expect(routerStore.get()).toEqual({ screen: 'home' });
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Tool preparation');
      expect(frame).toContain('Blocked');
      expect(frame).toContain('The configured custom runner was');
      expect(frame).toContain('not approved.');
      expect(frame).toContain('r retry');
      expect(frame).toContain('esc back');
      expect(frame).toContain('s settings');
    });
    ui.unmount();
  });

  it('renders a rejected recent-session preparation on the shared failed surface', async () => {
    saveSummary(
      { projectDir, sessionId: 'resume-rejected' },
      makeSession({
        id: 'resume-rejected',
        feature: 'resume rejected boundary',
        status: 'interrupted',
        summary: null,
        startedAt: 1_700_000_526,
      }),
    );
    saveState(
      { projectDir, sessionId: 'resume-rejected' },
      {
        ...createInitialState('resume rejected boundary'),
        phase: 'implementing',
      },
    );
    const deps: HomeScreenDeps = {
      ...HOME_DEPS,
      sessionSelect: {
        ...HOME_DEPS.sessionSelect,
        prepareResume: async () => {
          throw new Error('home resume boundary rejected');
        },
      },
    };
    const ui = renderHomeWithSessionPreparation(deps);
    await flushEffects();
    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    ui.stdin.write(ENTER);

    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Tool preparation');
      expect(frame).toContain('Failed');
      expect(frame).toContain('home resume boundary rejected');
      expect(frame).toContain('r retry');
    });
    expect(routerStore.get()).toEqual({ screen: 'home' });
    ui.unmount();
  });

  it('Enter opens a completed session summary from the recent-sessions list', async () => {
    const summary = makeSummary({ feature: 'completed feature' });
    saveSummary(
      { projectDir, sessionId: 'summary-me' },
      makeSession({
        id: 'summary-me',
        feature: 'completed feature',
        status: 'complete',
        summary,
        startedAt: 1_700_000_550,
      }),
    );

    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(routerStore.get().screen).toBe('summary');
    }, SESSION_FILTER_WAIT_MS);

    const route = routerStore.get();
    if (route.screen === 'summary') {
      expect(route.sessionId).toBe('summary-me');
      expect(route.summary).toEqual(summary);
    }
    ui.unmount();
  });

  it('Enter on a failed session without a summary stays on home and surfaces feedback', async () => {
    saveSummary(
      { projectDir, sessionId: 'failed-one' },
      makeSession({
        id: 'failed-one',
        feature: 'broken feature',
        status: 'failed',
        summary: null,
        startedAt: 1_700_000_600,
      }),
    );

    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    }, SESSION_FILTER_WAIT_MS);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('failed without a summary');
    }, SESSION_FILTER_WAIT_MS);

    expect(routerStore.get().screen).toBe('home');
    expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);
    ui.unmount();
  });

  it('plain Up still recalls input history instead of focusing the list', async () => {
    seedSessions(3);
    inputHistoryStore.push('recalled prompt');

    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(ARROW_UP);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('recalled prompt');
    expect(frame).not.toContain(FOCUS_BAR);
    ui.unmount();
  });

  it('drops focus and keeps the composer usable when the terminal shrinks below the list', async () => {
    seedSessions(3);
    const ui = renderHome();
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain(FOCUS_BAR);

    terminalSizeStore.__testReset({ cols: 80, rows: 12, isSmall: true });
    await flushEffects();
    expect(ui.lastFrame() ?? '').not.toContain(FOCUS_BAR);

    await flushEffects();
    ui.stdin.write('hi');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('hi');
    ui.unmount();
  });
});
