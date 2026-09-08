import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { loadConfig } from '../../core/config/load/io.js';
import { configPath } from '../../core/config/load/document.js';
import { CONFIG_FILE, sessionDir, SPLITBRIEF_DIR } from '../../core/paths.js';
import { computeCrewPresets } from '../../core/crew/presets.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import { prepareNewSession } from '../../core/sessions/prepare.js';
import type {
  DetectionRefreshOutcomes,
  DetectionServiceResult,
} from '../../engine/detection/service.js';
import type { PrepareExecutionInput } from '../../engine/runners/prepare-execution/prepare-execution.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { approvalPromptStore, openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import type {
  DiscoveryRefreshRequest,
  DiscoverySourceContexts,
} from '../../stores/discovery/model-cache/types.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { glyph } from '../../lib/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { PRESET_SECTION, SetupScreen } from './setup.js';

const ENTER = '\r';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const UP = '\u001B[A';
const BACKSPACE = '\u0008';
const OSC_LEAD = '\u001B]';
const HOSTILE_ERROR = 'Failed to save config: \u001B]0;pwned\u0007oops';
const CREW_TITLE = 'Set up your crew';
const DISCOVERY_CONTEXTS: DiscoverySourceContexts = {
  readiness: 'setup-readiness',
  modelsDev: 'setup-models-dev',
  cliModels: 'setup-cli-models',
};

const INSTALLED_RUNNERS: {
  cliTools: CliToolDetection[];
  providers: ProviderDetection[];
} = {
  cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
  providers: [],
};

function beginDiscovery(): DiscoveryRefreshRequest {
  return detectionStore.beginRefresh({ contexts: DISCOVERY_CONTEXTS });
}

function freshDiscovery(
  request: DiscoveryRefreshRequest,
  generation: number,
  rows: typeof INSTALLED_RUNNERS = INSTALLED_RUNNERS,
): void {
  const result: DetectionServiceResult = {
    providers: rows.providers,
    cliTools: rows.cliTools,
    catalog: {},
    cliModels: [],
    generation,
  };
  expect(detectionStore.publish({ result, request })).toBe(true);
}

function failedDiscovery(request: DiscoveryRefreshRequest, generation: number): void {
  const failed = (source: 'readiness' | 'cli-models') => ({
    kind: 'failed' as const,
    source,
    contextKey: source === 'readiness' ? request.contexts.readiness : request.contexts.cliModels,
    generation,
    requestId: request.id,
    checkedAt: generation,
    error: { kind: 'request-failed' as const, message: 'Tool discovery failed.' },
  });
  const outcomes: DetectionRefreshOutcomes = {
    readiness: failed('readiness'),
    modelsDev: {
      kind: 'failed',
      source: 'models-dev',
      contextKey: request.contexts.modelsDev,
      generation,
      requestId: request.id,
      checkedAt: generation,
      failure: { kind: 'request-failed', message: 'Model discovery failed.' },
    },
    cliModels: failed('cli-models'),
  };
  const result: DetectionServiceResult = {
    providers: [],
    cliTools: [],
    catalog: null,
    cliModels: [],
    generation,
    outcomes,
  };
  expect(detectionStore.publish({ result, request })).toBe(true);
}

function report(checks: ReadinessCheck[]): ReadinessReport {
  const blocker = checks.filter((check) => check.severity === 'blocker').length;
  const warning = checks.filter((check) => check.severity === 'warning').length;
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: '/project',
    status: blocker > 0 ? 'blocked' : 'ready',
    counts: { ok: 0, info: 0, warning, blocker },
    nextAction:
      blocker > 0
        ? { kind: 'exit', label: 'Exit', reason: 'Resolve the blocker.' }
        : { kind: 'continue', label: 'Continue', reason: 'Ready.' },
    sections: [{ id: 'checks', title: 'Tools', checks }],
    metadata: {},
  };
}

function prioritizedReport(): ReadinessReport {
  return report([
    { id: 'warning.first', severity: 'warning', summary: 'A lower-priority warning.' },
    { id: 'blocker.first', severity: 'blocker', summary: 'The primary blocker.' },
    { id: 'warning.second', severity: 'warning', summary: 'Another warning.' },
    { id: 'blocker.second', severity: 'blocker', summary: 'Another blocker.' },
    { id: 'warning.third', severity: 'warning', summary: 'A hidden warning.' },
    { id: 'warning.fourth', severity: 'warning', summary: 'Another hidden warning.' },
  ]);
}

function preparedExecution(input: PrepareExecutionInput): PreparedExecution {
  if (!('projectDir' in input)) throw new Error('Setup must prepare a new session.');
  const readiness = report([]);
  const prepared = prepareNewSession({
    projectDir: input.projectDir,
    feature: input.feature,
    config: input.effectiveConfig,
    report: readiness,
  });
  if (prepared.kind === 'aborted') throw new Error('Expected the test session to be prepared.');
  return {
    purpose: 'new-workflow',
    config: input.effectiveConfig,
    preparationId: 'setup-preparation',
    report: readiness,
    gates: [],
    session: {
      kind: 'new',
      ...prepared.session,
    },
    runtime: {
      feature: input.feature,
      ...(input.plannerContext !== undefined && { plannerContext: input.plannerContext }),
      allowRepoRunners: input.policy.allowRepoRunners,
      allowHooks: input.policy.allowHooks,
    },
  };
}

function preparedOutcome(input: PrepareExecutionInput): PreparationOutcome {
  return { kind: 'prepared', execution: preparedExecution(input) };
}

// Upper bound on the rows the crew surface can ever offer; focusRow gives up past it.
const CREW_ROW_LIMIT = 12;
const CURSOR = `${glyph('liveBar')} `;
/** The panel border plus its two padding cells: what sits left of every content column. */
const PANEL_LEAD = 3;

/** Every row as the panel renders it, with the frame and the centring indent taken off. */
function contentRows(ui: ReturnType<typeof renderFeature>): string[] {
  const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
  const border = lines.find((line) => line.trim() !== '') ?? '';
  const edge = border.length - border.trimStart().length;
  return lines.map((line) => line.slice(edge + PANEL_LEAD));
}

function markedRows(ui: ReturnType<typeof renderFeature>): string[] {
  return contentRows(ui).filter((row) => row.startsWith(CURSOR));
}

async function focusRow(
  ui: ReturnType<typeof renderFeature>,
  key: string,
  label: string,
): Promise<void> {
  for (let step = 0; step < CREW_ROW_LIMIT; step += 1) {
    if (markedRows(ui).some((row) => row.includes(label))) return;
    ui.stdin.write(key);
    await tick(20);
  }
  throw new Error(`never reached the ${label} row`);
}

async function continueSetup(ui: ReturnType<typeof renderFeature>): Promise<void> {
  await focusRow(ui, DOWN, 'Continue');
  ui.stdin.write(ENTER);
  await tick(50);
  await flushEffects();
}

describe('SetupScreen', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    routerStore.init({ screen: 'setup' });
    overlayStore.reset();
    feedbackStore.reset();
    terminalSizeStore.reset();
    approvalPromptStore.__testReset();
  });

  afterEach(() => {
    terminalSizeStore.reset();
    approvalPromptStore.__testReset();
  });

  it('shows generic cold initialization and reaches the crew surface once discovery is actionable', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30 });
    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();

    const cold = ui.lastFrame() ?? '';
    expect(cold).toContain('Waking your crew…');
    expect(cold).toContain('first run — results are remembered');

    expect(cold).not.toContain('No planner');

    const request = beginDiscovery();
    freshDiscovery(request, 1);

    await vi.waitFor(() => {
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain(CREW_TITLE);
      const plan = frame.indexOf('PLAN');
      expect(plan).toBeGreaterThanOrEqual(0);
      expect(frame.indexOf('BUILD')).toBeGreaterThan(plan);
      expect(frame.indexOf('REVIEW')).toBeGreaterThan(frame.indexOf('BUILD'));
    });
    ui.unmount();
  });

  it('keeps remembered rows through warm refresh success and failure', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    expect(
      detectionStore.hydrate({
        ...INSTALLED_RUNNERS,
        fetchedAt: 10,
        validatedAt: 10,
        generation: 1,
        requestId: 1,
        contexts: DISCOVERY_CONTEXTS,
      }),
    ).toBe(true);
    const successRequest = beginDiscovery();

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain(CREW_TITLE);
    expect(ui.lastFrame() ?? '').toContain('Refreshing your tools…');
    expect(ui.lastFrame() ?? '').toContain('remembered results');
    expect((ui.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(24);

    freshDiscovery(successRequest, 2);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain(CREW_TITLE);
      expect(ui.lastFrame() ?? '').not.toContain('Refreshing your tools…');
    });

    const failureRequest = beginDiscovery();
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('Refreshing your tools…');
    failedDiscovery(failureRequest, 3);

    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain(CREW_TITLE);
      expect(frame).toContain('Refresh failed · remembered results');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 80)).toBe(true);
    });
    ui.unmount();
  });

  it('fits the crew surface into the smallest supported viewport', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    // Three ready CLI tools plus an escalation row: the widest ladder the floor viewport can be
    // handed, so the fit runs against the maximum preset and crew row count.
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        escalation: { intermediateProvider: 'ollama', intermediateModel: 'llama3.1' },
      }),
    });
    const request = beginDiscovery();
    freshDiscovery(request, 1, {
      cliTools: [
        cliDetectionFor('ready', 'claude-code'),
        cliDetectionFor('ready', 'codex'),
        cliDetectionFor('ready', 'opencode'),
      ],
      providers: [],
    });

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />, {
      cols: 60,
      rows: 18,
    });
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const lines = frame.split('\n').filter((line) => line.trim() !== '');
    ui.unmount();

    // The panel never spills: a row that wraps at 60 columns pushes its unbroken top or bottom
    // frame line off the render, so an intact frame inside the 18 rows is the fit check.
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.every((line) => getTerminalCellWidth(line) <= 60)).toBe(true);
    const unbroken = (line: string | undefined) => line !== undefined && !/\s/.test(line.trim());
    expect(unbroken(lines.at(0))).toBe(true);
    expect(unbroken(lines.at(-1))).toBe(true);
    expect(frame).toContain(CREW_TITLE);
    for (const seat of ['PLAN', 'BUILD', 'REVIEW']) expect(frame).toContain(seat);
    expect(frame).toContain('Continue');
  });

  it('spends the whole floor viewport on the default crew', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    const request = beginDiscovery();
    freshDiscovery(request, 1);

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />, {
      cols: 60,
      rows: 18,
    });
    await flushEffects();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    ui.unmount();

    // Two ready tools and no escalation: the panel fits inside the 18-row viewport, frame included.
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines).toHaveLength(18);
  });

  it('says what escape does and does it', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    const request = beginDiscovery();
    freshDiscovery(request, 1);

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('esc quit');

    const before = markedRows(ui);
    ui.stdin.write(ESC);
    await tick(20);
    await flushEffects();
    // The app is gone: its key handlers went with it, so the next arrow moves nothing.
    ui.stdin.write(DOWN);
    await tick(20);
    await flushEffects();
    expect(markedRows(ui)).toEqual(before);
    ui.unmount();
  });

  it('keeps the cursor where it is when backspace arrives on the unfilterable list', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    const request = beginDiscovery();
    freshDiscovery(request, 1);

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();
    await focusRow(ui, DOWN, 'REVIEW');

    ui.stdin.write(BACKSPACE);
    await tick(20);
    await flushEffects();
    expect(markedRows(ui).join('\n')).toContain('REVIEW');
    ui.unmount();
  });

  it('spends the widest viewport on the untruncated preset descriptions', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    const request = beginDiscovery();
    freshDiscovery(request, 1);

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />, {
      cols: 120,
      rows: 40,
    });
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    const [preset] = computeCrewPresets({
      config: makeConfig(),
      readyTools: ['claude-code', 'codex'],
    });
    if (preset === undefined)
      throw new Error('Expected a ready-made crew for the installed tools.');
    expect(preset.description.length).toBeGreaterThanOrEqual(70);
    expect(frame).toContain(preset.description);
    expect(frame).toContain(PRESET_SECTION);
  });

  it('yields the blank spacer rows, never a seat, and keeps a save error to one line at the smallest supported viewport', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex' },
        escalation: { intermediateProvider: 'ollama', intermediateModel: 'llama3.1' },
      }),
    });
    expect(
      detectionStore.hydrate({
        ...INSTALLED_RUNNERS,
        fetchedAt: 10,
        validatedAt: 10,
        generation: 1,
        requestId: 1,
        contexts: DISCOVERY_CONTEXTS,
      }),
    ).toBe(true);
    beginDiscovery();
    feedbackStore.setError(
      'Failed to save config: EACCES permission denied while writing splitbrief.yaml in this project',
    );

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />, {
      cols: 60,
      rows: 18,
    });
    await flushEffects();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    ui.unmount();

    const unbroken = (line: string | undefined) => line !== undefined && !/\s/.test(line.trim());
    expect(unbroken(lines.at(0))).toBe(true);
    expect(unbroken(lines.at(-1))).toBe(true);
    expect(lines.filter((line) => line.includes('Failed to save config'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('splitbrief.yaml');
    expect(lines.join('\n')).toContain('Continue');
    // The blank spacer rows are the last block to yield; the crews and the three seats never do.
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.join('\n')).toContain('Claude crew, Codex review');
    for (const seat of ['PLAN', 'BUILD', 'REVIEW']) expect(lines.join('\n')).toContain(seat);
  });

  it('strips terminal control sequences from a save error', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    const request = beginDiscovery();
    freshDiscovery(request, 1);
    feedbackStore.setError(HOSTILE_ERROR);

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    ui.unmount();

    expect(frame).not.toContain(OSC_LEAD);
    expect(frame).not.toContain('pwned');
    expect(frame).toContain('Failed to save config');
  });

  it('keeps the focus marker on the seat it is on when discovery publishes presets', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    const cold = beginDiscovery();
    freshDiscovery(cold, 1, {
      cliTools: [cliDetectionFor('unauthenticated', 'claude-code')],
      providers: [],
    });

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();
    expect(markedRows(ui)).toEqual([expect.stringContaining('PLAN')]);

    const warm = beginDiscovery();
    freshDiscovery(warm, 2);

    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Claude crew');
      expect(markedRows(ui)).toEqual([expect.stringContaining('PLAN')]);
    });
    ui.unmount();
  });

  it('cold discovery failure stays actionable without claiming tools are absent', async () => {
    const request = beginDiscovery();
    failedDiscovery(request, 1);

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Tool check failed');
    expect(frame).toContain('r retry');
    expect(frame).toContain('esc quit');
    expect(frame).toContain('s settings');
    expect(frame).not.toMatch(/no (planner|tool)/i);

    ui.stdin.write('s');
    await flushEffects();
    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  it('opens the picker of the seat under the cursor', async () => {
    const request = beginDiscovery();
    freshDiscovery(request, 1);

    const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
    await flushEffects();
    await focusRow(ui, DOWN, 'REVIEW');
    ui.stdin.write(ENTER);

    await vi.waitFor(() => expect(overlayStore.get().active).toBe('reviewer-picker'));
    ui.unmount();
  });

  it('keeps the crew surface reachable after a real config save rejection', async () => {
    await withTempDir('setup-invalid', async (projectDir) => {
      configStore.load(projectDir);
      writeFileSync(join(projectDir, SPLITBRIEF_DIR), 'blocks the canonical config directory');
      const request = beginDiscovery();
      freshDiscovery(request, 1);
      routerStore.init({ screen: 'setup', onComplete: 'home' });

      const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
      await flushEffects();
      await continueSetup(ui);

      await vi.waitFor(() =>
        expect(feedbackStore.get()).toMatchObject({
          isError: true,
          message: expect.stringContaining('Failed to save config'),
        }),
      );
      await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('Failed to save config'));
      expect(ui.lastFrame() ?? '').toContain(CREW_TITLE);
      expect(routerStore.get().screen).toBe('setup');
      ui.unmount();
    });
  });

  it('applies a crew preset and completes to workflow with the canonical config', async () => {
    await withTempDir('setup-complete', async (projectDir) => {
      configStore.load(projectDir);
      const request = beginDiscovery();
      freshDiscovery(request, 1);
      routerStore.init({
        screen: 'setup',
        onComplete: 'workflow',
        feature: 'Keep setup behavior',
        plannerContext: 'Use the selected planner',
        allowRepoRunners: true,
      });
      terminalSizeStore.__testReset({ cols: 80, rows: 24 });
      const prepare = vi.fn(async (input: PrepareExecutionInput) => preparedOutcome(input));

      const ui = renderFeature(<SetupScreen prepare={prepare} />);
      await flushEffects();

      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 80)).toBe(true);

      await focusRow(ui, UP, 'Claude crew, Codex review');
      ui.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(loadConfig(projectDir).config.reviewer).toMatchObject({
          kind: 'cli',
          tool: 'codex',
        });
      });
      await continueSetup(ui);

      let routedExecution: PreparedExecution | undefined;
      await vi.waitFor(() => {
        const route = routerStore.get();
        expect(route.screen).toBe('workflow');
        if (route.screen === 'workflow' && route.execution.kind === 'local') {
          routedExecution = route.execution.prepared;
          expect(route.execution.prepared.runtime).toMatchObject({
            feature: 'Keep setup behavior',
            plannerContext: 'Use the selected planner',
            allowRepoRunners: true,
          });
        }
      });
      expect(prepare).toHaveBeenCalledOnce();
      const preparationInput = prepare.mock.calls[0]?.[0];
      expect(preparationInput?.effectiveConfig).toBe(configStore.get().config);
      expect(preparationInput?.policy).toMatchObject({
        purpose: 'new-workflow',
        interaction: 'interactive',
        allowRepoRunners: true,
        allowHooks: false,
        unverifiedAuth: 'disclosed',
        onTieredApproval: openApprovalPrompt,
      });
      if (routedExecution?.session.kind !== 'new') {
        throw new Error('Expected a routed new-session execution.');
      }
      const routedSessionDir = sessionDir(
        routedExecution.session.ref.projectDir,
        routedExecution.session.ref.sessionId,
      );
      expect(existsSync(routedSessionDir)).toBe(true);
      expect(existsSync(join(routedSessionDir, '.prepare-owner.json'))).toBe(false);
      expect(readActive(projectDir)).toBe(routedExecution.session.ref.sessionId);
      expect(configPath(projectDir)).toBe(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE));
      expect(existsSync(configPath(projectDir))).toBe(true);
      expect(readdirSync(join(projectDir, SPLITBRIEF_DIR))).toEqual(
        expect.arrayContaining([CONFIG_FILE, 'active', 'sessions']),
      );

      const persisted = loadConfig(projectDir).config;
      expect(persisted).toMatchObject({
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex' },
      });
      ui.unmount();
    });
  });

  it('completes to home for the init entry point, which carries no pending feature', async () => {
    await withTempDir('setup-init', async (projectDir) => {
      configStore.load(projectDir);
      const request = beginDiscovery();
      freshDiscovery(request, 1);
      // What `splitbrief init` routes to before rendering the app.
      routerStore.init({ screen: 'setup', onComplete: 'home' });

      const ui = renderFeature(<SetupScreen prepare={async (input) => preparedOutcome(input)} />);
      await flushEffects();
      expect(routerStore.get().screen).toBe('setup');
      expect(ui.lastFrame() ?? '').toContain(CREW_TITLE);

      await continueSetup(ui);

      await vi.waitFor(() => expect(routerStore.get().screen).toBe('home'));
      expect(existsSync(configPath(projectDir))).toBe(true);
      ui.unmount();
    });
  });

  it('blocked preparation retries with config saved in Settings', async () => {
    await withTempDir('setup-blocked', async (projectDir) => {
      configStore.load(projectDir);
      const request = beginDiscovery();
      freshDiscovery(request, 1);
      routerStore.init({ screen: 'setup', onComplete: 'workflow', feature: 'Blocked start' });
      const blocked = prioritizedReport();
      const prepare = vi.fn(
        async (_input: PrepareExecutionInput): Promise<PreparationOutcome> => ({
          kind: 'blocked',
          report: blocked,
        }),
      );
      const ui = renderFeature(<SetupScreen prepare={prepare} />);
      await flushEffects();
      await continueSetup(ui);

      await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('Start is blocked'));
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('2 checks hidden');
      expect(frame.indexOf('blocker.first')).toBeLessThan(frame.indexOf('warning.first'));
      expect(frame).toContain('r retry');
      expect(frame).toContain('esc back');
      expect(frame).toContain('s settings');
      expect(routerStore.get().screen).toBe('setup');

      ui.stdin.write('s');
      await flushEffects();
      expect(overlayStore.get().active).toBe('settings');
      const settingsConfig = makeConfig({
        planner: { kind: 'cli', tool: 'codex', authChannel: 'session' },
      });
      await expect(configStore.save(settingsConfig)).resolves.toMatchObject({ kind: 'saved' });
      overlayStore.close();
      await flushEffects();
      ui.stdin.write('r');
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
      expect(prepare.mock.calls[1]?.[0].effectiveConfig).toEqual(settingsConfig);
      ui.stdin.write(ESC);
      await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain(CREW_TITLE));
      expect(routerStore.get().screen).toBe('setup');
      ui.unmount();
    });
  });

  it.each(['Escape', 'unmount'] as const)(
    'reports a real stale cleanup failure after %s without navigating',
    async (exitMode) => {
      await withTempDir(`setup-cleanup-${exitMode.toLowerCase()}`, async (projectDir) => {
        configStore.load(projectDir);
        const request = beginDiscovery();
        freshDiscovery(request, 1);
        routerStore.init({ screen: 'setup', onComplete: 'workflow', feature: 'Late result' });
        const pending = Promise.withResolvers<PreparationOutcome>();
        let signal: AbortSignal | undefined;
        const prepare = vi.fn((input: PrepareExecutionInput) => {
          signal = input.signal;
          return pending.promise;
        });
        const ui = renderFeature(<SetupScreen prepare={prepare} />);
        await flushEffects();

        await continueSetup(ui);
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('Preparing your tools'));

        if (exitMode === 'Escape') {
          ui.stdin.write(ESC);
          await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain(CREW_TITLE));
        } else {
          ui.unmount();
        }
        expect(signal?.aborted).toBe(true);

        const input = prepare.mock.calls[0]?.[0];
        if (!input) throw new Error('Expected a preparation input.');
        const late = preparedOutcome(input);
        if (late.kind !== 'prepared' || late.execution.session.kind !== 'new') {
          throw new Error('Expected a newly prepared late result.');
        }
        const lateSessionDir = sessionDir(
          late.execution.session.ref.projectDir,
          late.execution.session.ref.sessionId,
        );
        unlinkSync(join(lateSessionDir, '.prepare-owner.json'));
        pending.resolve(late);

        await vi.waitFor(() => {
          expect(feedbackStore.get()).toMatchObject({
            isError: true,
            message: expect.stringContaining('Could not clean up tool preparation'),
          });
        });
        expect(existsSync(lateSessionDir)).toBe(true);
        expect(routerStore.get().screen).toBe('setup');
        if (exitMode === 'Escape') ui.unmount();
      });
    },
  );

  it('failed preparation stays in Setup with generic retry back settings and prioritized blockers', async () => {
    await withTempDir('setup-failed', async (projectDir) => {
      configStore.load(projectDir);
      const request = beginDiscovery();
      freshDiscovery(request, 1);
      routerStore.init({ screen: 'setup', onComplete: 'workflow', feature: 'Failed start' });
      const failedReport = prioritizedReport();
      const prepare = vi.fn(
        async (): Promise<PreparationOutcome> => ({
          kind: 'failed',
          report: failedReport,
          error: new Error('The runner check did not complete.'),
        }),
      );
      const ui = renderFeature(<SetupScreen prepare={prepare} />);
      await flushEffects();
      await continueSetup(ui);

      await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('Preparation failed'));
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('The runner check did not complete.');
      expect(frame.indexOf('blocker.first')).toBeLessThan(frame.indexOf('warning.first'));
      expect(frame).toContain('r retry');
      expect(frame).toContain('esc back');
      expect(frame).toContain('s settings');
      expect(routerStore.get().screen).toBe('setup');
      ui.unmount();
    });
  });
});
