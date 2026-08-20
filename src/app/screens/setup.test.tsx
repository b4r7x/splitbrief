import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import type { CliToolDetection, ProviderDetection } from '../../core/discovery/detection.js';
import type { ReadinessCheck, ReadinessReport } from '../../core/readiness/types.js';
import { configPath, loadConfig } from '../../core/config/load/io.js';
import { CONFIG_FILE, sessionDir, SPLITBRIEF_DIR } from '../../core/paths.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { prepareNewSession } from '../../core/sessions/prepare.js';
import type {
  DetectionRefreshOutcomes,
  DetectionServiceResult,
} from '../../engine/detection/service.js';
import type { PrepareExecutionInput } from '../../engine/runners/prepare-execution.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { ToolModelPicker } from '../overlays/runners.js';
import { approvalPromptStore, openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import type {
  DiscoveryRefreshRequest,
  DiscoverySourceContexts,
} from '../../stores/discovery/model-cache.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { SetupScreen, type SetupToolPickerArgs } from './setup.js';

const ENTER = '\r';
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

async function chooseRunner(
  ui: ReturnType<typeof renderFeature>,
  runnerId: 'claude-code' | 'codex',
): Promise<void> {
  await flushEffects();
  ui.stdin.write(runnerId);
  await flushEffects();
  ui.stdin.write(ENTER);
  await flushEffects();
  ui.stdin.write(ENTER);
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

  it('shows generic cold initialization and advances when discovery becomes actionable', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 30 });
    const ui = renderFeature(
      <SetupScreen
        renderToolPicker={({ stepLabel }) => <Text>{stepLabel}</Text>}
        prepare={async (input) => preparedOutcome(input)}
      />,
    );
    await flushEffects();

    const cold = ui.lastFrame() ?? '';
    expect(cold).toContain('Initializing your tools…');
    expect(cold).toContain('Checking your configured tools for the first time. Results will be');
    expect(cold).toContain('remembered locally.');
    expect(cold).not.toContain('No planner');

    const request = beginDiscovery();
    freshDiscovery(request, 1);

    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Choose planner · 1 of 2');
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

    const ui = renderFeature(
      <SetupScreen
        renderToolPicker={({ role, stepLabel, onConfirm, onCancel }) => (
          <ToolModelPicker
            role={role}
            stepLabel={stepLabel}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        )}
        prepare={async (input) => preparedOutcome(input)}
      />,
    );
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('Claude Code');
    expect(ui.lastFrame() ?? '').toContain('Refreshing your tools…');
    expect(ui.lastFrame() ?? '').toContain('remembered results');
    expect((ui.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(24);

    freshDiscovery(successRequest, 2);
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Claude Code');
      expect(ui.lastFrame() ?? '').not.toContain('Refreshing your tools…');
    });

    const failureRequest = beginDiscovery();
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('Refreshing your tools…');
    failedDiscovery(failureRequest, 3);

    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Claude Code');
      expect(frame).toContain('Refresh failed · remembered results');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 80)).toBe(true);
    });
    ui.unmount();
  });

  it('cold discovery failure stays actionable without claiming tools are absent', async () => {
    const request = beginDiscovery();
    failedDiscovery(request, 1);

    const ui = renderFeature(
      <SetupScreen
        renderToolPicker={() => null}
        prepare={async (input) => preparedOutcome(input)}
      />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Tool check failed');
    expect(frame).toContain('r retry');
    expect(frame).toContain('esc back');
    expect(frame).toContain('s settings');
    expect(frame).not.toMatch(/no (planner|tool)/i);

    ui.stdin.write('s');
    await flushEffects();
    expect(overlayStore.get().active).toBe('settings');
    ui.unmount();
  });

  it('keeps planner confirmation reachable after a real config save rejection', async () => {
    await withTempDir('setup-invalid', async (projectDir) => {
      configStore.load(projectDir);
      writeFileSync(join(projectDir, SPLITBRIEF_DIR), 'blocks the canonical config directory');
      const request = beginDiscovery();
      freshDiscovery(request, 1);
      routerStore.init({ screen: 'setup', onComplete: 'home' });

      let picker: SetupToolPickerArgs | undefined;
      const ui = renderFeature(
        <SetupScreen
          renderToolPicker={(args) => {
            picker = args;
            return <Text>{args.stepLabel}</Text>;
          }}
          prepare={async (input) => preparedOutcome(input)}
        />,
      );
      await flushEffects();
      expect(picker?.role).toBe('planner');
      await picker?.onConfirm(makeConfig());
      await flushEffects();

      expect(feedbackStore.get()).toMatchObject({
        isError: true,
        message: expect.stringContaining('Failed to save config'),
      });
      expect(ui.lastFrame() ?? '').toContain('Choose planner · 1 of 2');
      expect(routerStore.get().screen).toBe('setup');
      ui.unmount();
    });
  });

  it('resets the real picker between roles and completes to workflow with canonical config', async () => {
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

      const ui = renderFeature(
        <SetupScreen
          renderToolPicker={({ role, stepLabel, onConfirm, onCancel }) => (
            <ToolModelPicker
              role={role}
              stepLabel={stepLabel}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          )}
          prepare={prepare}
        />,
      );
      await flushEffects();
      await chooseRunner(ui, 'claude-code');

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Choose model · 2 of 2');
      });

      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('Implementer');
      expect(frame).toContain('Ollama · api');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 80)).toBe(true);

      ui.stdin.write('\u001b');
      await flushEffects();
      expect(ui.lastFrame() ?? '').toContain('Choose planner · 1 of 2');

      await chooseRunner(ui, 'claude-code');
      await chooseRunner(ui, 'codex');

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
      if (!routedExecution || routedExecution.session.kind !== 'new') {
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
        implementer: { kind: 'cli', tool: 'codex' },
      });
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
      let picker: SetupToolPickerArgs | undefined;
      const ui = renderFeature(
        <SetupScreen
          renderToolPicker={(args) => {
            picker = args;
            return <Text>{args.stepLabel}</Text>;
          }}
          prepare={prepare}
        />,
      );
      await flushEffects();

      await picker?.onConfirm(makeConfig());
      await flushEffects();
      expect(picker?.role).toBe('implementer');
      await picker?.onConfirm(makeConfig());
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Start is blocked');
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
      ui.stdin.write('\u001b');
      await flushEffects();
      expect(ui.lastFrame() ?? '').toContain('Choose model · 2 of 2');
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
        let picker: SetupToolPickerArgs | undefined;
        const ui = renderFeature(
          <SetupScreen
            renderToolPicker={(args) => {
              picker = args;
              return <Text>{args.stepLabel}</Text>;
            }}
            prepare={prepare}
          />,
        );
        await flushEffects();

        await picker?.onConfirm(makeConfig());
        await flushEffects();
        await picker?.onConfirm(makeConfig());
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('Preparing your tools'));

        if (exitMode === 'Escape') {
          ui.stdin.write('\u001b');
          await flushEffects();
          expect(ui.lastFrame() ?? '').toContain('Choose model · 2 of 2');
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
      let picker: SetupToolPickerArgs | undefined;
      const ui = renderFeature(
        <SetupScreen
          renderToolPicker={(args) => {
            picker = args;
            return <Text>{args.stepLabel}</Text>;
          }}
          prepare={prepare}
        />,
      );
      await flushEffects();

      await picker?.onConfirm(makeConfig());
      await flushEffects();
      await picker?.onConfirm(makeConfig());
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Preparation failed');
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
