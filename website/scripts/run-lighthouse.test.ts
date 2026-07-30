// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  lighthouseAssertionViolations,
  lighthouseAuditPlan,
  LIGHTHOUSE_ASSERTIONS,
  LIGHTHOUSE_ROUTES,
  LIGHTHOUSE_RUNS_PER_ROUTE,
  type LighthouseMeasurement,
} from './lighthouse-config.js';
import {
  chromeLaunchOptions,
  cleanupLighthouseResources,
  installLighthouseSignalCleanup,
} from './run-lighthouse.js';

type MeasurementValues = {
  readonly accessibility: number | null;
  readonly cls: number;
  readonly colorContrast: number | null;
  readonly consoleErrors: number | null;
  readonly fcp: number;
  readonly headingOrder: number | null;
  readonly lcp: number;
  readonly performance: number | null;
  readonly tbt: number;
};

function measurement(overrides: Partial<MeasurementValues> = {}): LighthouseMeasurement {
  const values: MeasurementValues = {
    accessibility: 1,
    cls: 0.05,
    colorContrast: 1,
    consoleErrors: 1,
    fcp: 1_500,
    headingOrder: 1,
    lcp: 2_000,
    performance: 0.95,
    tbt: 200,
    ...overrides,
  };

  return {
    audits: {
      'color-contrast': { score: values.colorContrast },
      'cumulative-layout-shift': { numericValue: values.cls, score: 1 },
      'errors-in-console': { score: values.consoleErrors },
      'first-contentful-paint': { numericValue: values.fcp, score: 1 },
      'heading-order': { score: values.headingOrder },
      'largest-contentful-paint': { numericValue: values.lcp, score: 1 },
      'total-blocking-time': { numericValue: values.tbt, score: 1 },
    },
    categories: {
      accessibility: { score: values.accessibility },
      performance: { score: values.performance },
    },
  };
}

describe('Lighthouse contract', () => {
  it('plans exactly three desktop audits for each of the six release routes', () => {
    const plan = lighthouseAuditPlan('http://127.0.0.1:4173');

    expect(LIGHTHOUSE_ROUTES).toHaveLength(6);
    expect(LIGHTHOUSE_RUNS_PER_ROUTE).toBe(3);
    expect(plan).toHaveLength(18);
    expect(new Set(plan.map(({ reportBasename }) => reportBasename))).toHaveLength(18);
    for (const route of LIGHTHOUSE_ROUTES) {
      expect(plan.filter((audit) => audit.route === route)).toHaveLength(3);
    }
  });

  it('preserves median performance thresholds and pessimistic accessibility checks', () => {
    const medianPasses = [
      measurement({ fcp: 2_100, performance: 0.89 }),
      measurement({ fcp: 1_800, performance: 0.91 }),
      measurement({ fcp: 1_900, performance: 0.95 }),
    ];
    expect(lighthouseAssertionViolations('/', medianPasses)).toEqual([]);

    const pessimisticFailures = [
      measurement(),
      measurement(),
      measurement({ accessibility: 0.99, headingOrder: 0 }),
    ];
    expect(lighthouseAssertionViolations('/', pessimisticFailures)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Accessibility pessimistic'),
        expect.stringContaining('Heading order pessimistic'),
      ]),
    );
    expect(LIGHTHOUSE_ASSERTIONS).toHaveLength(9);
  });

  it('fails incomplete runs and missing audit results', () => {
    expect(lighthouseAssertionViolations('/', [measurement()])).toEqual([
      '/: expected 3 Lighthouse runs, received 1',
    ]);
    expect(
      lighthouseAssertionViolations('/', [
        measurement({ consoleErrors: null }),
        measurement(),
        measurement(),
      ]),
    ).toContain('/: Console errors has a missing or unscored result');
  });

  it('uses a fresh headless browser profile and honors the CI Chrome path', () => {
    expect(chromeLaunchOptions({ CHROME_PATH: '/playwright/chromium' })).toEqual({
      chromeFlags: ['--headless=new'],
      chromePath: '/playwright/chromium',
      handleSIGINT: false,
      logLevel: 'warn',
    });
    expect(chromeLaunchOptions({})).not.toHaveProperty('chromePath');
  });

  it('cleans Chrome and the static server even when one cleanup operation fails', async () => {
    const calls: string[] = [];
    const resources = {
      chrome: {
        kill: () => {
          calls.push('chrome');
          throw new Error('Chrome cleanup failed');
        },
        port: 9_222,
      },
      server: {
        close: (callback: (error?: Error) => void) => {
          calls.push('server');
          callback();
        },
        listening: true,
      },
    };

    await expect(cleanupLighthouseResources(resources)).rejects.toThrow(
      'Lighthouse resource cleanup failed',
    );
    expect(calls).toEqual(['chrome', 'server']);
  });

  it('cleans once and re-raises termination signals', async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const reraised: NodeJS.Signals[] = [];
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const uninstall = installLighthouseSignalCleanup({
      cleanup,
      signalTarget: {
        kill: (_processId, signal) => {
          reraised.push(signal);
          return true;
        },
        once: (signal, listener) => {
          listeners.set(signal, listener);
        },
        pid: 42,
        removeListener: (signal) => {
          listeners.delete(signal);
        },
      },
    });

    listeners.get('SIGTERM')?.();
    await vi.waitFor(() => expect(reraised).toEqual(['SIGTERM']));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    uninstall();
  });
});
