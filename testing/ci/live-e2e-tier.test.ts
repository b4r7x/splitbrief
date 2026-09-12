import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATRIX_TIERS,
  type LiveMatrixTier,
  type LiveSeat,
  appendLiveManifestRow,
  beginLiveManifest,
  gateLiveMatrixRow,
  liveModelPin,
  liveRowGateDecision,
  liveSkipAllowList,
  liveTierEnabled,
  liveToolBlocker,
  releaseMatrixConfig,
  runLiveScenario,
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
vi.mock('../../src/engine/detection/detect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/detection/detect.js')>()),
  detectAvailableCliTools: detectAvailableCliToolsMock,
}));

const REPO_ROOT = join(import.meta.dirname, '../..');
const LIVE_SCENARIO_DIR = join(REPO_ROOT, 'testing/e2e/scenarios/live');

function docSection(heading: string): string {
  const doc = readFileSync(join(REPO_ROOT, 'docs/TESTING.md'), 'utf-8');
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`docs/TESTING.md is missing ${heading.trim()}`);
  const rest = doc.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

afterEach(() => {
  vi.unstubAllEnvs();
  detectAvailableCliToolsMock.mockReset();
});

function guardScenario(model: string | undefined) {
  return {
    tool: 'claude-code',
    model,
    mode: 'quick' as const,
    feature: 'guard scenario that must never reach a real call',
    validateScript: '',
    implementerContextLength: 4096,
    maxRetries: 0,
    tempPrefix: 'live-guard',
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
};

describe('live e2e tier gating', () => {
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
    const blocker = await liveToolBlocker('not-a-cli-tool');

    expect(blocker).toContain('not-a-cli-tool');
    expect(blocker).toContain('catalog');
  });

  it("names the tool's own declared auth channel so detection does not withhold it", async () => {
    detectAvailableCliToolsMock.mockResolvedValue([cliDetectionFor('ready', 'command-code')]);

    await liveToolBlocker('command-code');

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

    expect(await liveToolBlocker('command-code')).toBeNull();
  });

  it('still blocks a catalog tool that is genuinely absent from the machine', async () => {
    detectAvailableCliToolsMock.mockResolvedValue([cliDetectionFor('unavailable', 'command-code')]);

    expect(await liveToolBlocker('command-code')).toBe('command-code is not ready (unavailable)');
  });
});

describe('live e2e tier documentation', () => {
  const tierDoc = docSection('\n## Live CLI e2e tier\n');
  const harness = readFileSync(join(REPO_ROOT, 'testing/e2e/helpers/live-harness.ts'), 'utf-8');

  it('promises only the ceilings the harness and the scenarios carry', () => {
    expect(tierDoc).toContain('$0.05');
    expect(tierDoc).toContain('$0.50');
    expect(harness).toMatch(/quick: 0\.05,/);
    expect(harness).toMatch(/standard: 0\.5,/);
    expect(harness).toContain('maxBudget: MAX_BUDGET_USD[scenario.mode]');

    const scenarios = readdirSync(LIVE_SCENARIO_DIR).filter((name) => name.endsWith('.test.ts'));
    expect(scenarios.length).toBeGreaterThan(0);
    for (const name of scenarios) {
      const source = readFileSync(join(LIVE_SCENARIO_DIR, name), 'utf-8');
      expect(source, name).toContain(name.startsWith('easy-') ? '300_000,' : '900_000,');
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

  it('covers every workflow mode and rejects duplicate row ids', () => {
    expect(new Set(RELEASE_MATRIX.map((row) => row.mode))).toEqual(
      new Set(['quick', 'standard', 'speckit']),
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

  it('runs every row on its mode tier task', () => {
    for (const row of RELEASE_MATRIX) {
      expect(row.task, row.id).toBe(MATRIX_TIERS[row.mode].task);
    }
  });

  it('resolves the cheapest pin per tool through liveModelPin', () => {
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

  it('skips a not-ready tool that the allow-list names', () => {
    const gate = liveRowGateDecision({
      readiness: [{ tool: 'codex', state: 'unavailable' }],
      allowList: liveSkipAllowList('codex'),
    });
    if (gate.kind !== 'skip') throw new Error('unreachable');

    expect(gate.reason).toContain('codex');
    expect(gate.reason).toContain('unavailable');
  });

  it('fails a not-ready tool outside the allow-list', () => {
    const readiness = [{ tool: 'codex', state: 'unavailable' }];

    expect(() => liveRowGateDecision({ readiness, allowList: new Set<string>() })).toThrow(
      /SPLITBRIEF_LIVE_SKIP/,
    );
  });

  it('probes every seat tool with its declared auth channel', async () => {
    detectAvailableCliToolsMock.mockResolvedValue([
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'cursor'),
    ]);

    await expect(gateLiveMatrixRow(['codex', 'cursor'])).resolves.toEqual({ kind: 'run' });

    expect(detectAvailableCliToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['codex', 'cursor'],
        authChannels: {
          codex: defaultCliAuthChannel('codex').id,
          cursor: defaultCliAuthChannel('cursor').id,
        },
      }),
    );
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
          mode: 'quick',
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
          mode: 'standard',
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
          mode: 'quick',
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

  it('assembles a quick row config with no reviewer seat', () => {
    const row = RELEASE_MATRIX.find((r) => r.id === 'quick-canary-codex');
    if (row === undefined) throw new Error('missing row');

    const config = releaseMatrixConfig(resolveReleaseMatrixRun(row), MATRIX_TIERS.quick);
    if (config.planner.kind !== 'cli') throw new Error('unreachable');
    if (config.implementer.kind !== 'cli') throw new Error('unreachable');

    expect(config.planner.tool).toBe('codex');
    expect(config.implementer.contextLength).toBe(4096);
    expect(config.reviewer).toBeUndefined();
    expect(config.workflow.mode).toBe('quick');
    expect(config.workflow.maxBudget).toBe(0.05);
  });

  it('assembles a speckit row config with the reviewer seat', () => {
    const row = RELEASE_MATRIX.find((r) => r.id === 'speckit-cross-opencode-command-code');
    if (row === undefined) throw new Error('missing row');

    const config = releaseMatrixConfig(resolveReleaseMatrixRun(row), MATRIX_TIERS.speckit);
    const reviewer = config.reviewer;
    if (reviewer === undefined || reviewer.kind !== 'cli') throw new Error('unreachable');

    expect(reviewer.tool).toBe('codex');
    expect(config.workflow.mode).toBe('speckit');
    expect(config.workflow.maxBudget).toBe(1);

    const contextMd = MATRIX_TIERS.speckit.contextMd;
    if (contextMd === undefined) throw new Error('unreachable');
    expect(contextMd.length).toBeGreaterThan(0);
    expect(MATRIX_TIERS.quick.contextMd).toBeUndefined();
  });

  it('keeps tier artifacts and validate scripts defined for every mode', () => {
    for (const mode of ['quick', 'standard', 'speckit'] as const) {
      const tier: LiveMatrixTier = MATRIX_TIERS[mode];
      expect(tier.task).not.toBe('');
      expect(tier.validateScript).not.toBe('');
      expect(tier.artifact.path.startsWith('src/')).toBe(true);
    }
  });
});
