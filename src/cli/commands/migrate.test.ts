import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { taskId } from '../../core/schemas/task.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../../core/paths.js';
import { maybeMigrateAndReport, registerMigrateCommand } from './migrate.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('migrate-command-test');
});

afterEach(() => {
  cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

async function runMigrate(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerMigrateCommand(program);
  await program.parseAsync(['node', 'diptych', 'migrate', ...args]);
}

function writeLegacySummary(sessionId: string): string {
  const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  const summaryPath = join(sessionDir, 'summary.json');
  const session = makeSession({
    id: sessionId,
    status: 'complete',
    summary: makeSummary({
      costPrediction: {
        estimatedTasks: 1,
        lowCost: 0,
        expectedCost: 0,
        highCost: 0,
        plannerTool: 'codex',
        implementerTool: 'codex',
        deterministic: {
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 0,
            contextDetected: 1,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: { priceKnown: 0, priceUnknown: 1, profileUnavailable: 0 },
          tasks: [
            {
              taskId: taskId('T001'),
              title: 'legacy task',
              estimatedPromptTokens: 10,
              selectedProfileId: 'default',
              contextFit: 'fits',
              contextConfidence: 'context-detected',
              priceConfidence: 'price-unknown',
              estimatedImplementerCost: null,
              hypotheticalPlannerCost: null,
            },
          ],
          totals: {
            knownActualEstimate: null,
            hypotheticalAllPlanner: null,
            estimatedSavings: null,
            unknownCostReason: ['implementer-price-unknown'],
          },
        },
      },
    }),
  });
  const raw = JSON.parse(JSON.stringify(session)) as {
    summary: {
      costPrediction: {
        deterministic: {
          contextConfidenceCounts: { contextDetected?: number };
        };
      };
    };
  };
  delete raw.summary.costPrediction.deterministic.contextConfidenceCounts.contextDetected;
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(raw));
  return summaryPath;
}

function writeCurrentSummary(sessionId: string): void {
  const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'summary.json'),
    JSON.stringify(makeSession({ id: sessionId, status: 'complete', summary: makeSummary() })),
  );
}

describe('migrate command', () => {
  it('prints nothing for automatic startup checks when migration and repair are idle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await maybeMigrateAndReport(tmp, {});

    expect(logSpy.mock.calls).toHaveLength(0);
    expect(warnSpy.mock.calls).toHaveLength(0);
  });

  it('prints nothing to migrate when migration and repair are both idle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runMigrate(['--project', tmp]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Nothing to migrate.');
    expect(warnSpy.mock.calls).toHaveLength(0);
  });

  it('prints nothing to migrate when existing summaries are already current', async () => {
    writeCurrentSummary('2024-01-01-current-summary');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runMigrate(['--project', tmp]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Nothing to migrate.');
    expect(warnSpy.mock.calls).toHaveLength(0);
  });

  it('repairs legacy summaries without printing only nothing to migrate', async () => {
    const sessionId = '2024-01-01-cli-repair';
    const summaryPath = writeLegacySummary(sessionId);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runMigrate(['--project', tmp]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).not.toContain('Nothing to migrate.');
    expect(output).toContain('Repaired 1 legacy session summary file(s).');
    expect(warnSpy.mock.calls).toHaveLength(0);
    const repaired = JSON.parse(readFileSync(summaryPath, 'utf-8')) as {
      summary: {
        costPrediction: {
          deterministic: {
            contextConfidenceCounts: { contextDetected?: number };
          };
        };
      };
    };
    expect(
      repaired.summary.costPrediction.deterministic.contextConfidenceCounts.contextDetected,
    ).toBe(1);
  });

  it('reports skipped unreadable summaries without printing only nothing to migrate', async () => {
    const sessionId = '2024-01-01-cli-invalid';
    const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'summary.json'), '{not-json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runMigrate(['--project', tmp]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const warnings = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).not.toContain('Nothing to migrate.');
    expect(warnings).toContain('Skipped 1 unreadable session summary file(s).');
  });

  it('reports skipped invalid-schema summaries without printing only nothing to migrate', async () => {
    const sessionId = '2024-01-01-cli-schema';
    const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'summary.json'), JSON.stringify({ not: 'a session' }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runMigrate(['--project', tmp]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const warnings = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).not.toContain('Nothing to migrate.');
    expect(warnings).toContain('Skipped 1 invalid session summary file(s).');
  });
});
