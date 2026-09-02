import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  liveModelPin,
  liveTierEnabled,
  liveToolBlocker,
  runLiveScenario,
} from '../e2e/helpers/live-harness.js';

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
