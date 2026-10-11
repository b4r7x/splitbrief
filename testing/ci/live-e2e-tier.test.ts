import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATRIX_TIERS,
  type LiveSeat,
  appendLiveManifestRow,
  beginLiveManifest,
  gateLiveMatrixRow,
  liveModelPin,
  liveRowGateDecision,
  liveSkipAllowList,
  liveTierEnabled,
  releaseMatrixConfig,
  runLiveScenario,
  runLiveToolRow,
  runReleaseMatrixRow,
} from '../e2e/helpers/live-harness.js';
import {
  RELEASE_MATRIX,
  resolveReleaseMatrixRun,
  resolveReleaseMatrixSeat,
} from '../e2e/live/matrix.js';
import { CLI_TOOL_IDS, defaultCliAuthChannel } from '../../src/core/runners/cli-tool-catalog.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

const detectAvailableCliToolsMock = vi.hoisted(() => vi.fn());
const runWorkflowMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/engine/detection/detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/detection/detect.js')>()),
  detectAvailableCliTools: detectAvailableCliToolsMock,
}));
vi.mock('../../src/engine/orchestrator/run/workflow.js', () => ({
  runWorkflow: runWorkflowMock,
}));

const REPO_ROOT = join(import.meta.dirname, '../..');
const LIVE_SCENARIO_DIR = join(REPO_ROOT, 'testing/e2e/scenarios/live');
const LIVE_ROW_DIR = join(REPO_ROOT, 'testing/e2e/live');

function scenarioCeilings(name: string): readonly string[] {
  const source = readFileSync(join(LIVE_SCENARIO_DIR, name), 'utf-8');
  const rowTables = readdirSync(LIVE_ROW_DIR)
    .filter((table) => source.includes(`../../live/${basename(table, '.ts')}.js`))
    .map((table) => readFileSync(join(LIVE_ROW_DIR, table), 'utf-8'));
  const declared = [source, ...rowTables].flatMap((text) =>
    [...text.matchAll(/\b\d[\d_]*_\d{3}\b/g)].map((match) => match[0]),
  );
  return [...new Set(declared)].sort();
}

function docSection(heading: string): string {
  const doc = readFileSync(join(REPO_ROOT, 'docs/TESTING.md'), 'utf-8');
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`docs/TESTING.md is missing ${heading.trim()}`);
  const rest = doc.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  detectAvailableCliToolsMock.mockReset();
  runWorkflowMock.mockReset();
});

function guardScenario(model: string | undefined) {
  return {
    tool: 'claude-code',
    model,
    feature: 'guard scenario that must never reach a real call',
    validateScript: '',
    implementerContextLength: 4096,
    tempPrefix: 'live-guard',
    timeoutMs: 300_000,
  };
}

function failIfRun(): never {
  throw new Error('the guarded scenario reached its assertions');
}

const MATRIX_MODEL_PINS: Readonly<Record<string, string>> = {
  SPLITBRIEF_REAL_CLI_CLAUDE_CODE_MODEL: 'haiku',
  SPLITBRIEF_REAL_CLI_CODEX_MODEL: 'gpt-5.6-luna',
  SPLITBRIEF_REAL_CLI_OPENCODE_MODEL: 'opencode/free-model',
  SPLITBRIEF_REAL_CLI_COMMAND_CODE_MODEL: 'deepseek/deepseek-v4-flash',
  SPLITBRIEF_REAL_CLI_KILO_CODE_MODEL: 'kilo/kilo-auto/free',
  SPLITBRIEF_REAL_CLI_CURSOR_MODEL: 'gpt-5.3-codex-low-fast',
  SPLITBRIEF_REAL_CLI_COPILOT_MODEL: 'claude-haiku-4.5',
  SPLITBRIEF_REAL_CLI_ANTIGRAVITY_MODEL: 'gemini-3-pro',
};

describe('live e2e tier gating', () => {
  beforeEach(() => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '1');
  });

  it('stays disabled while the master switch is unset', () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_TIER', 'all');

    expect(liveTierEnabled('easy')).toBe(false);
    expect(liveTierEnabled('heavy')).toBe(false);
  });

  it('selects one tier at a time and both under all', () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '1');

    vi.stubEnv('SPLITBRIEF_REAL_CLI_TIER', undefined);
    expect(liveTierEnabled('easy')).toBe(true);
    expect(liveTierEnabled('heavy')).toBe(false);

    vi.stubEnv('SPLITBRIEF_REAL_CLI_TIER', 'heavy');
    expect(liveTierEnabled('heavy')).toBe(true);
    expect(liveTierEnabled('easy')).toBe(false);

    vi.stubEnv('SPLITBRIEF_REAL_CLI_TIER', 'all');
    expect(liveTierEnabled('easy')).toBe(true);
    expect(liveTierEnabled('heavy')).toBe(true);
  });

  it.each(['claude-opus-4-6', 'claude-fable-5', 'gpt-5.6-sol'])(
    'refuses a model pin above the cost ceiling: %s',
    (pin) => {
      expect(() => liveModelPin({ tool: 'claude-code', fallback: pin })).toThrow();
    },
  );

  it('refuses an over-ceiling pin that arrives through the env override', () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_CLAUDE_CODE_MODEL', 'claude-opus-4-6');

    expect(() => liveModelPin({ tool: 'claude-code', fallback: 'haiku' })).toThrow();
  });

  it.each([
    { tool: 'claude-code', fallback: 'haiku' },
    { tool: 'codex', fallback: 'gpt-5.6-luna' },
    { tool: 'command-code', fallback: 'deepseek/deepseek-v4-flash' },
    { tool: 'opencode', fallback: 'openrouter/qwen3:free' },
  ])('accepts the cheap pins the tier ships with: $tool', ({ tool, fallback }) => {
    expect(liveModelPin({ tool, fallback })).toBe(fallback);
  });

  it('leaves an unpinned tool unpinned', () => {
    expect(liveModelPin({ tool: 'codex', fallback: undefined })).toBeUndefined();
  });

  it('refuses to run a scenario while the master switch is unset', async () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '');

    await expect(runLiveScenario(guardScenario('haiku'), failIfRun)).rejects.toThrow(
      /SPLITBRIEF_REAL_CLI_E2E=1/,
    );
  });

  it('refuses to run a scenario with no model pin, before any real call', async () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '1');

    await expect(runLiveScenario(guardScenario(undefined), failIfRun)).rejects.toThrow(
      /no model pin/,
    );
  });

  it('refuses to run a scenario whose model is above the cost ceiling', async () => {
    vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '1');

    await expect(runLiveScenario(guardScenario('claude-opus-4-6'), failIfRun)).rejects.toThrow(
      /cost ceiling/,
    );
  });

  it('skips a tool that is absent from the CLI catalog instead of failing', async () => {
    await expect(
      runLiveToolRow({ tool: 'not-a-cli-tool', timeoutMs: 300_000, run: async () => failIfRun() }),
    ).resolves.toEqual({ kind: 'skip', reason: 'not-a-cli-tool is not in the CLI tool catalog' });
  });

  it("names the tool's own declared auth channel so detection does not withhold it", async () => {
    detectAvailableCliToolsMock.mockResolvedValue([cliDetectionFor('ready', 'command-code')]);

    await runLiveToolRow({ tool: 'command-code', timeoutMs: 300_000, run: async () => {} });

    expect(detectAvailableCliToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['command-code'],
        authChannels: { 'command-code': defaultCliAuthChannel('command-code').id },
      }),
    );
    expect(defaultCliAuthChannel('command-code').id).toBe('session');
  });

  it('clears an installed, authenticated tool with no blocker', async () => {
    detectAvailableCliToolsMock.mockResolvedValue([cliDetectionFor('ready', 'command-code')]);
    let completed = false;
    await expect(
      runLiveToolRow({
        tool: 'command-code',
        timeoutMs: 300_000,
        run: async () => {
          completed = true;
        },
      }),
    ).resolves.toEqual({ kind: 'run' });
    expect(completed).toBe(true);
  });

  it('still blocks a catalog tool that is genuinely absent from the machine', async () => {
    detectAvailableCliToolsMock.mockResolvedValue([cliDetectionFor('unavailable', 'command-code')]);

    await expect(
      runLiveToolRow({ tool: 'command-code', timeoutMs: 300_000, run: async () => failIfRun() }),
    ).resolves.toEqual({ kind: 'skip', reason: 'command-code is not ready (unavailable)' });
  });

  it('reports an unavailable tool as a scenario skip before executing the workflow', async () => {
    detectAvailableCliToolsMock.mockResolvedValue([cliDetectionFor('unavailable', 'claude-code')]);
    await expect(runLiveScenario(guardScenario('haiku'), failIfRun)).resolves.toEqual({
      kind: 'skip',
      reason: 'claude-code is not ready (unavailable)',
    });
  });

  it('cuts a delayed readiness probe at the row deadline before running the scenario', async () => {
    vi.useFakeTimers();
    detectAvailableCliToolsMock.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve([cliDetectionFor('ready', 'claude-code')]),
            40_000,
          );
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const startedAt = Date.now();
    let settledAt: number | undefined;
    const row = runLiveScenario(
      { ...guardScenario('haiku'), timeoutMs: 30_000 },
      failIfRun,
    ).finally(() => {
      settledAt = Date.now() - startedAt;
    });
    const rejected = expect(row).rejects.toThrow('Live row timed out after 20000ms.');
    await vi.advanceTimersByTimeAsync(40_000);
    await rejected;
    expect(settledAt).toBe(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('live e2e tier documentation', () => {
  const tierDoc = docSection('\n## Live CLI e2e tier\n');

  it('defines the release gate and keeps the matrix manifest out of the public release', () => {
    const releasing = readFileSync(join(REPO_ROOT, 'docs/RELEASING.md'), 'utf-8');
    const skip = 'SPLITBRIEF_LIVE_SKIP=cursor,copilot,kilo-code,command-code';
    for (const doc of [releasing, tierDoc]) {
      expect(doc).toContain(skip);
      expect(doc).toContain('.release-records/<x>/manifest.json');
      expect(doc).not.toContain('not verified live');
      expect(doc).toContain('opencode-go/deepseek-v4.1-flash');
      expect(doc).toContain('gemini-3.8-flash-low');
    }
    const rule = releasing.slice(
      releasing.indexOf('## The release rule'),
      releasing.indexOf('## Pre-publish smoke'),
    );
    for (const tool of ['claude-code', 'codex', 'opencode', 'antigravity'])
      expect(rule).toContain(tool);
    expect(rule).toContain('publish smoke');
    expect(rule).toContain('reason');
    const releaseCreate = releasing.split('\n').find((line) => line.includes('gh release create'));
    expect(releaseCreate).toBeDefined();
    expect(releaseCreate).not.toContain('manifest.json');
  });

  it('promises only the timeouts the scenarios carry', () => {
    const scenarios = readdirSync(LIVE_SCENARIO_DIR).filter((name) => name.endsWith('.test.ts'));
    expect(scenarios.length).toBeGreaterThan(0);
    for (const name of scenarios) {
      const ceilings = scenarioCeilings(name);
      expect(ceilings.length, name).toBeGreaterThan(0);
      const allowed = name.startsWith('easy-')
        ? ['300_000']
        : name.startsWith('heavy-')
          ? ['900_000']
          : ['300_000', '900_000'];
      expect(allowed, name).toEqual(expect.arrayContaining([...ceilings]));
    }
    expect(tierDoc).toContain('300 s');
    expect(tierDoc).toContain('900 s');

    expect(tierDoc).not.toMatch(/\d+(–\d+)? minutes?/);
  });
});

describe('release matrix invariants', () => {
  beforeEach(() => {
    for (const [envName, model] of Object.entries(MATRIX_MODEL_PINS)) {
      vi.stubEnv(envName, model);
    }
  });

  it('covers every tier and rejects duplicate row ids', () => {
    expect(new Set(RELEASE_MATRIX.map((row) => row.tier))).toEqual(
      new Set(Object.keys(MATRIX_TIERS)),
    );
    expect(new Set(RELEASE_MATRIX.map((row) => row.id)).size).toBe(RELEASE_MATRIX.length);
  });

  it('pairs at least four cross-vendor rows', () => {
    expect(RELEASE_MATRIX.filter((row) => row.plan !== row.build).length).toBeGreaterThanOrEqual(4);
  });

  it('keeps one same-tool canary per CLI tool', () => {
    const canaries = RELEASE_MATRIX.filter(
      (row) => row.plan === row.build && row.review === undefined,
    );

    expect(canaries.map((row) => row.plan).sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it('runs every row on its tier task', () => {
    for (const row of RELEASE_MATRIX) {
      expect(row.task, row.id).toBe(MATRIX_TIERS[row.tier].task);
    }
  });

  it('runs at least one row with a reviewer seat of its own', () => {
    expect(RELEASE_MATRIX.some((row) => row.review !== undefined)).toBe(true);
  });

  it('resolves the default pin per tool through liveModelPin', () => {
    expect(resolveReleaseMatrixSeat('claude-code')).toEqual({
      tool: 'claude-code',
      model: 'haiku',
    });

    vi.stubEnv('SPLITBRIEF_REAL_CLI_CODEX_MODEL', 'gpt-5.6-mini');

    expect(resolveReleaseMatrixSeat('codex').model).toBe('gpt-5.6-mini');
  });

  it('resolving every matrix seat spawns no tool subprocess', () => {
    for (const row of RELEASE_MATRIX) {
      const run = resolveReleaseMatrixRun(row);
      const seats = [run.plan, run.build, ...(run.review === undefined ? [] : [run.review])];
      for (const seat of seats) {
        const envName = `SPLITBRIEF_REAL_CLI_${seat.tool.toUpperCase().replaceAll('-', '_')}_MODEL`;
        const pinned = MATRIX_MODEL_PINS[envName];
        if (pinned === undefined) throw new Error(`no env pin for ${seat.tool}`);
        expect(seat.model, `${row.id}:${seat.tool}`).toBe(pinned);
      }
    }
  });

  it('skips model resolution for an excluded row before checking any seat pin', () => {
    vi.stubEnv('SPLITBRIEF_LIVE_SKIP', 'cursor');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_CURSOR_MODEL', 'gpt-5.6-sol');
    vi.stubEnv('SPLITBRIEF_REAL_CLI_CODEX_MODEL', 'gpt-5.6-sol');
    const row = RELEASE_MATRIX.find((entry) => entry.id === 'one-file-cross-codex-cursor');
    if (row === undefined) throw new Error('missing cross-tool row');
    const run = resolveReleaseMatrixRun(row);
    expect(run.plan).toEqual({ tool: 'codex', model: undefined });
    expect(run.build).toEqual({ tool: 'cursor', model: undefined });
    expect(
      liveRowGateDecision({
        readiness: [run.plan, run.build].map(({ tool }) => ({ tool, state: 'ready' })),
        allowList: liveSkipAllowList('cursor'),
      }),
    ).toEqual({ kind: 'skip', reason: 'listed in SPLITBRIEF_LIVE_SKIP' });
    vi.stubEnv('SPLITBRIEF_LIVE_SKIP', '');
    expect(() => resolveReleaseMatrixRun(row)).toThrow(/cost ceiling/);
  });
});

describe('release matrix readiness gate', () => {
  it('parses the skip allow-list tolerantly', () => {
    expect(liveSkipAllowList(undefined).size).toBe(0);
    expect([...liveSkipAllowList('codex, cursor,,')].sort()).toEqual(['codex', 'cursor']);
  });

  it('runs only when every seat tool is ready', () => {
    const readiness = [
      { tool: 'codex', state: 'ready' },
      { tool: 'cursor', state: 'ready' },
    ];

    expect(liveRowGateDecision({ readiness, allowList: new Set<string>() })).toEqual({
      kind: 'run',
    });
  });

  it.each(['ready', 'unavailable', 'no detection record'])(
    'skips a listed tool regardless of readiness: %s',
    (state) => {
      const gate = liveRowGateDecision({
        readiness: [{ tool: 'codex', state }],
        allowList: liveSkipAllowList('codex'),
      });
      expect(gate).toEqual({ kind: 'skip', reason: 'listed in SPLITBRIEF_LIVE_SKIP' });
    },
  );

  it('skips a cross-tool row before checking an unlisted unavailable seat', () => {
    expect(
      liveRowGateDecision({
        readiness: [
          { tool: 'codex', state: 'unavailable' },
          { tool: 'cursor', state: 'ready' },
        ],
        allowList: liveSkipAllowList('cursor'),
      }),
    ).toEqual({ kind: 'skip', reason: 'listed in SPLITBRIEF_LIVE_SKIP' });
  });

  it('ignores skip entries for tools outside the row', () => {
    expect(
      liveRowGateDecision({
        readiness: [{ tool: 'codex', state: 'ready' }],
        allowList: liveSkipAllowList('cursor'),
      }),
    ).toEqual({ kind: 'run' });
  });

  it('skips a listed row before any readiness probe', async () => {
    vi.stubEnv('SPLITBRIEF_LIVE_SKIP', 'cursor');
    detectAvailableCliToolsMock.mockRejectedValue(new Error('unexpected readiness probe'));
    await expect(
      gateLiveMatrixRow(['codex', 'cursor'], new AbortController().signal),
    ).resolves.toEqual({
      kind: 'skip',
      reason: 'listed in SPLITBRIEF_LIVE_SKIP',
    });
  });

  it('fails a not-ready tool outside the allow-list', () => {
    const readiness = [{ tool: 'codex', state: 'unavailable' }];

    expect(() => liveRowGateDecision({ readiness, allowList: new Set<string>() })).toThrow(
      /SPLITBRIEF_LIVE_SKIP/,
    );
  });

  it('probes every seat tool with its declared auth channel', async () => {
    const signal = new AbortController().signal;
    detectAvailableCliToolsMock.mockResolvedValue([
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'cursor'),
    ]);

    await expect(gateLiveMatrixRow(['codex', 'cursor'], signal)).resolves.toEqual({ kind: 'run' });

    expect(detectAvailableCliToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['codex', 'cursor'],
        signal,
        authChannels: {
          codex: defaultCliAuthChannel('codex').id,
          cursor: defaultCliAuthChannel('cursor').id,
        },
      }),
    );
  });

  it('rejects an aborted probe even when it returns ready records', async () => {
    const controller = new AbortController();
    const reason = new Error('matrix readiness cancelled');
    detectAvailableCliToolsMock.mockImplementation(async () => {
      controller.abort(reason);
      return [cliDetectionFor('ready', 'codex')];
    });

    await expect(gateLiveMatrixRow(['codex'], controller.signal)).rejects.toBe(reason);
  });

  it('cuts a delayed matrix readiness probe at the row deadline before running the workflow', async () => {
    await withTempDir('live-matrix-probe-deadline', async (root) => {
      const originalCwd = process.cwd();
      process.chdir(root);
      try {
        vi.stubEnv('SPLITBRIEF_REAL_CLI_E2E', '1');
        vi.stubEnv('SPLITBRIEF_LIVE_SKIP', '');
        vi.useFakeTimers();
        detectAvailableCliToolsMock.mockImplementation(
          ({ signal }: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve([cliDetectionFor('ready', 'codex')]), 40_000);
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
        );
        const timeoutMs = 30_000;
        const startedAt = Date.now();
        let settledAt: number | undefined;
        const row = runReleaseMatrixRow(
          {
            id: 'probe-deadline',
            tier: 'one-file',
            task: MATRIX_TIERS['one-file'].task,
            plan: { tool: 'codex', model: 'pin' },
            build: { tool: 'codex', model: 'pin' },
          },
          timeoutMs,
        ).finally(() => {
          settledAt = Date.now() - startedAt;
        });
        const rejected = expect(row).rejects.toThrow('Live row timed out after 20000ms.');
        await vi.advanceTimersByTimeAsync(timeoutMs - 10_001);
        expect(settledAt).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settledAt).toBe(timeoutMs - 10_000);
        await rejected;
        expect(runWorkflowMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});

describe('release matrix manifest and config', () => {
  type ManifestFile = Readonly<{
    generatedAt: string;
    rows: readonly Readonly<{ id: string; reason?: string | undefined }>[];
  }>;

  const seat = (tool: string): LiveSeat => ({ tool, model: 'pin' });
  const readManifest = (path: string): ManifestFile => JSON.parse(readFileSync(path, 'utf-8'));

  beforeEach(() => {
    for (const [envName, model] of Object.entries(MATRIX_MODEL_PINS)) {
      vi.stubEnv(envName, model);
    }
  });

  it('resets the manifest on begin and appends rows in order', async () => {
    await withTempDir('live-manifest-reset', async (root) => {
      const manifestPath = beginLiveManifest(root);
      const fresh = readManifest(manifestPath);

      expect(fresh.rows.length).toBe(0);
      expect(typeof fresh.generatedAt).toBe('string');

      appendLiveManifestRow(
        {
          id: 'r1',
          tier: 'one-file',
          plan: seat('codex'),
          build: seat('cursor'),
          review: null,
          outcome: 'pass',
          durationMs: 1,
        },
        root,
      );
      appendLiveManifestRow(
        {
          id: 'r2',
          tier: 'two-files',
          plan: seat('claude-code'),
          build: seat('kilo-code'),
          review: null,
          outcome: 'skip',
          reason: 'kilo-code is not ready (unavailable)',
          durationMs: 2,
        },
        root,
      );

      const manifest = readManifest(manifestPath);
      expect(manifest.rows.map((row) => row.id)).toEqual(['r1', 'r2']);
      expect(manifest.rows.at(1)?.reason).toBe('kilo-code is not ready (unavailable)');
    });
  });

  it('appends without a prior begin on a fresh root', async () => {
    await withTempDir('live-manifest-append', async (root) => {
      appendLiveManifestRow(
        {
          id: 'only',
          tier: 'one-file',
          plan: seat('codex'),
          build: seat('codex'),
          review: null,
          outcome: 'fail',
          reason: 'boom',
          durationMs: 3,
        },
        root,
      );

      const manifestPath = join(root, 'manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      expect(readManifest(manifestPath).rows.length).toBe(1);
    });
  });

  it('assembles a one-file row config with no reviewer seat', () => {
    const row = RELEASE_MATRIX.find((r) => r.id === 'one-file-canary-codex');
    if (row === undefined) throw new Error('missing row');

    const config = releaseMatrixConfig(resolveReleaseMatrixRun(row), MATRIX_TIERS['one-file']);
    if (config.planner.kind !== 'cli') throw new Error('unreachable');
    if (config.implementer.kind !== 'cli') throw new Error('unreachable');

    expect(config.planner.tool).toBe('codex');
    expect(config.implementer.contextLength).toBe(4096);
    expect(config.reviewer).toBeUndefined();
    expect(config.workflow.mode).toBeUndefined();
  });

  it('assembles a question-round row config with the reviewer seat and an answer', () => {
    const row = RELEASE_MATRIX.find((r) => r.id === 'question-round-cross-opencode-command-code');
    if (row === undefined) throw new Error('missing row');

    const config = releaseMatrixConfig(
      resolveReleaseMatrixRun(row),
      MATRIX_TIERS['question-round'],
    );
    const reviewer = config.reviewer;
    if (reviewer === undefined || reviewer.kind !== 'cli') throw new Error('unreachable');

    expect(reviewer.tool).toBe('codex');
    expect(config.workflow.mode).toBeUndefined();
    expect(MATRIX_TIERS['question-round'].plannerAnswer).toContain('src/live-question.ts');
    expect(MATRIX_TIERS['one-file'].plannerAnswer).toBeUndefined();
  });

  it('keeps tier artifacts and validate scripts defined for every tier', () => {
    for (const tier of Object.values(MATRIX_TIERS)) {
      expect(tier.task).not.toBe('');
      expect(tier.validateScript).not.toBe('');
      expect(tier.artifact.path.startsWith('src/')).toBe(true);
    }
  });
});
