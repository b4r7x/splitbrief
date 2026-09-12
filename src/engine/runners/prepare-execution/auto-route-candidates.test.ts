import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import type { Config } from '../../../core/schemas/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { saveDetectionCache } from '../../detection/cache.js';
import { buildAutoRouteCandidates, loadAutoRouteCandidates } from './auto-route-candidates.js';

const PROBED_AT = 1_786_000_000_000;

const kiloPro: DetectedModel = {
  id: 'kilo/kilo-auto/pro',
  contextLength: 200_000,
  pricingInput: 0.25,
  pricingOutput: 1,
};
const kiloMax: DetectedModel = {
  id: 'kilo/kilo-auto/max',
  contextLength: 400_000,
  pricingInput: 2,
  pricingOutput: 10,
};
const kiloUnpriced: DetectedModel = { id: 'kilo/kilo-auto/mini', contextLength: 64_000 };
const kiloHidden: DetectedModel = {
  id: 'kilo/kilo-auto/internal',
  contextLength: 900_000,
  pricingInput: 0.01,
  pricingOutput: 0.01,
  nativeHidden: true,
};
const commandFlash: DetectedModel = { id: 'deepseek/deepseek-v4.1-flash', contextLength: 128_000 };

const autoCheapestSeat: Config = {
  ...createDefaultConfig(),
  implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto:cheapest' },
};

const kiloCatalog = {
  tool: 'kilo-code',
  models: [kiloMax, kiloUnpriced, kiloPro],
  probedAt: PROBED_AT,
} as const;
const commandCatalog = {
  tool: 'command-code',
  models: [commandFlash],
  probedAt: PROBED_AT,
} as const;

describe('buildAutoRouteCandidates', () => {
  it('keeps the cheapest and the widest priced row per ready tool, never an unpriced row', () => {
    const candidates = buildAutoRouteCandidates({
      config: autoCheapestSeat,
      cliTools: [cliDetectionFor('ready', 'kilo-code'), cliDetectionFor('ready', 'command-code')],
      cliCatalogs: [kiloCatalog, commandCatalog],
    });

    expect(candidates.map((candidate) => candidate.config.model)).toEqual([
      'kilo/kilo-auto/pro',
      'kilo/kilo-auto/max',
    ]);
    expect(candidates[0]).toMatchObject({
      config: { kind: 'cli', tool: 'kilo-code', contextLength: 200_000 },
      pricingInput: 0.25,
      pricingOutput: 1,
    });
  });

  it('drops a catalog whose tool the last readiness pass did not find ready', () => {
    const candidates = buildAutoRouteCandidates({
      config: autoCheapestSeat,
      cliTools: [cliDetectionFor('unavailable', 'kilo-code')],
      cliCatalogs: [kiloCatalog],
    });

    expect(candidates).toEqual([]);
  });

  it('returns one row when the cheapest priced row is also the widest', () => {
    const candidates = buildAutoRouteCandidates({
      config: autoCheapestSeat,
      cliTools: [cliDetectionFor('ready', 'kilo-code')],
      cliCatalogs: [
        { tool: 'kilo-code', models: [kiloPro, kiloUnpriced], probedAt: PROBED_AT } as const,
      ],
    });

    expect(candidates.map((candidate) => candidate.config.model)).toEqual(['kilo/kilo-auto/pro']);
  });

  it('carries the configured seat fields onto a row that names the same tool', () => {
    const candidates = buildAutoRouteCandidates({
      config: {
        ...createDefaultConfig(),
        implementer: {
          kind: 'cli',
          tool: 'kilo-code',
          model: 'auto:cheapest',
          timeout: 120_000,
          args: ['--yes'],
        },
      },
      cliTools: [cliDetectionFor('ready', 'kilo-code')],
      cliCatalogs: [kiloCatalog],
    });

    expect(candidates[0]?.config).toMatchObject({ timeout: 120_000, args: ['--yes'] });
  });

  it('yields nothing when the seat carries no auto:cheapest marker', () => {
    const candidates = buildAutoRouteCandidates({
      config: createDefaultConfig(),
      cliTools: [cliDetectionFor('ready', 'kilo-code')],
      cliCatalogs: [kiloCatalog],
    });

    expect(candidates).toEqual([]);
  });

  it('skips a priced row the tool hides from its own listing', () => {
    const candidates = buildAutoRouteCandidates({
      config: autoCheapestSeat,
      cliTools: [cliDetectionFor('ready', 'kilo-code')],
      cliCatalogs: [
        {
          tool: 'kilo-code',
          models: [{ ...kiloPro, nativeHidden: true }, kiloMax],
          probedAt: PROBED_AT,
        } as const,
      ],
    });

    expect(candidates.map((candidate) => candidate.config.model)).toEqual(['kilo/kilo-auto/max']);
  });

  it('yields nothing when the remembered snapshot has no catalogs', () => {
    const candidates = buildAutoRouteCandidates({
      config: autoCheapestSeat,
      cliTools: [cliDetectionFor('ready', 'kilo-code')],
    });

    expect(candidates).toEqual([]);
  });
});

describe('loadAutoRouteCandidates', () => {
  async function rememberKiloCatalog(projectDir: string, fetchedAt: number): Promise<void> {
    await saveDetectionCache({
      projectDir,
      snapshot: {
        contextKey: 'readiness-context-v1',
        fetchedAt,
        validatedAt: fetchedAt,
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [cliDetectionFor('ready', 'kilo-code')],
        cliCatalogs: [
          { tool: 'kilo-code', models: [...kiloCatalog.models, kiloHidden], probedAt: PROBED_AT },
        ],
      },
    });
  }

  it('routes on prices the real cache writer put on disk', async () => {
    await withTempDir('auto-route-candidates', async (projectDir) => {
      await rememberKiloCatalog(projectDir, Date.now());

      const candidates = await loadAutoRouteCandidates({ projectDir, config: autoCheapestSeat });

      expect(candidates.map((candidate) => candidate.config.model)).toEqual([
        'kilo/kilo-auto/pro',
        'kilo/kilo-auto/max',
      ]);
      expect(candidates[0]).toMatchObject({ pricingInput: 0.25, pricingOutput: 1 });
    });
  });

  it('yields nothing when the record is past the readiness freshness bound', async () => {
    await withTempDir('auto-route-candidates', async (projectDir) => {
      await rememberKiloCatalog(projectDir, Date.now() - 60 * 60 * 1_000);

      await expect(
        loadAutoRouteCandidates({ projectDir, config: autoCheapestSeat }),
      ).resolves.toEqual([]);
    });
  });

  it('yields nothing when no earlier pass remembered a snapshot', async () => {
    await withTempDir('auto-route-candidates', async (projectDir) => {
      await expect(
        loadAutoRouteCandidates({ projectDir, config: autoCheapestSeat }),
      ).resolves.toEqual([]);
    });
  });
});
