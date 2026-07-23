import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { detectAvailablePlanners } from './detect.js';
import { CLI_TOOLS } from '../runners/cli-tools.js';
import type { Config } from '../../core/schemas/config.js';
import type { CliToolId } from '../../core/schemas/enums.js';
import type { Planner } from '../planners/types.js';

type PlannerFactory = (config: Config) => Promise<Planner>;

function makeCliPlannerFactory(opts: {
  available?: boolean;
  versions?: Partial<Record<CliToolId, string>>;
}): PlannerFactory {
  return async (config) => {
    if (config.planner.kind !== 'cli') throw new Error('expected cli planner config');
    const version =
      opts.versions?.[config.planner.tool] ?? CLI_TOOLS[config.planner.tool].testedVersion;
    return makePlanner({
      isAvailable: vi.fn().mockResolvedValue(opts.available ?? true),
      getVersion: vi.fn().mockResolvedValue(version),
    });
  };
}

describe('detectAvailablePlanners', () => {
  const providerResults = [
    { provider: 'openrouter', available: false, isLocal: false, hasKey: false },
  ] as const;
  const createPlanner = makeCliPlannerFactory({ available: false });

  it('shell planner is always available', async () => {
    const results = await detectAvailablePlanners({
      providerResults: [...providerResults],
      createPlanner,
    });
    const shell = results.find((r) => r.tool === 'shell');
    expect(shell).toMatchObject({ type: 'shell', available: true, description: 'Custom command' });
  });

  it('anthropic API planner available when ANTHROPIC_API_KEY is set', async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const results = await detectAvailablePlanners({
        providerResults: [...providerResults],
        createPlanner,
      });
      const anthropic = results.find((r) => r.tool === 'anthropic');
      expect(anthropic).toMatchObject({
        available: true,
        type: 'api',
        description: 'Anthropic API',
      });
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it('openrouter API planner not available when /models endpoint returns no data', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('openrouter.ai')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    try {
      const results = await detectAvailablePlanners({
        providerResults: [...providerResults],
        createPlanner,
      });
      const openrouter = results.find((r) => r.tool === 'openrouter');
      expect(openrouter).toMatchObject({
        available: false,
        type: 'api',
        description: 'OpenRouter API',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('detectAvailablePlanners CLI version matrix', () => {
  const providerResults = [
    { provider: 'openrouter', available: false, isLocal: false, hasKey: false },
  ] as const;

  let stderr: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = '';
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('records version compatibility without writing startup stderr', async () => {
    const testedMajor = Number(CLI_TOOLS.codex.testedVersion.split('.')[0]);
    const installed = `${testedMajor + 9}.0.0`;
    const createPlanner = makeCliPlannerFactory({
      versions: { codex: installed },
    });

    const codex = (
      await detectAvailablePlanners({ providerResults: [...providerResults], createPlanner })
    ).find((r) => r.tool === 'codex');

    expect(codex).toMatchObject({ available: true, version: installed });
    expect(codex).not.toHaveProperty('error');
    expect(codex).toMatchObject({
      compatibility: {
        kind: 'major-version-mismatch',
        installedVersion: installed,
        testedVersion: CLI_TOOLS.codex.testedVersion,
      },
    });
    expect(stderr).not.toContain('differs in major version');
  });

  it('does not warn when the installed CLI major version matches the tested one', async () => {
    const createPlanner = makeCliPlannerFactory({
      versions: { codex: CLI_TOOLS.codex.testedVersion },
    });

    const codex = (
      await detectAvailablePlanners({ providerResults: [...providerResults], createPlanner })
    ).find((r) => r.tool === 'codex');

    expect(codex).toMatchObject({ available: true, version: CLI_TOOLS.codex.testedVersion });
    expect(stderr).not.toContain('differs in major version');
  });
});
