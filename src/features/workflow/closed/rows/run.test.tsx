import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import type { Summary } from '../../../../core/schemas/summary.js';
import { terminalTheme } from '../../../../components/theme.js';
import { glyph } from '../../../../lib/glyphs.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import type { RunnerCallCounterCoverage } from '../../../../core/runner-call-contract.js';
import { deriveUsageDetails, formatUsageMoney } from '../../usage-details-model.js';
import { deriveSummaryView } from '../view-model.js';
import { runSectionRows } from './run.js';

const FULL_COVERAGE: RunnerCallCounterCoverage = {
  input: 'reported',
  output: 'reported',
  cacheRead: 'reported',
  cacheCreate: 'reported',
  reasoning: 'reported',
};

function renderRun(input: { summary: Summary; width: number; crewNamed: boolean }) {
  const view = deriveSummaryView({
    record: makeRunRecord({
      ref: { projectDir: '/tmp/closed-rows', sessionId: '2026-09-14-add-email-validation' },
      summary: input.summary,
      ledger: null,
    }),
  });
  if (view === null) throw new Error('expected a closed run to have a view');
  const rows = runSectionRows({
    view,
    width: input.width,
    theme: terminalTheme,
    crewNamed: input.crewNamed,
  });
  return renderFeature(
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>,
    { cols: input.width, rows: 20 },
  );
}

const priced = makeSummary({
  plannerTool: 'codex',
  implementerTool: 'ollama',
  implementerModel: 'qwen-small',
  mode: 'standard',
  totalTasks: 3,
  completedByLocal: 3,
  driftSummary: { passed: true, score: 1, errorCount: 0, warningCount: 0 },
  tokenUsage: makeUsage({
    plannerInput: 31_200,
    implementerInput: 204_500,
    reviewerInput: 18_700,
    plannerCoverage: FULL_COVERAGE,
    implementerCoverage: FULL_COVERAGE,
    reviewerCoverage: FULL_COVERAGE,
  }),
  costBreakdown: {
    actualPlannerCost: 0.2,
    actualImplementerCost: 0.22,
    totalActualCost: 0.42,
    hasPricedUsage: true,
    isActualPlannerCostKnown: true,
    isActualImplementerCostKnown: true,
    isTotalActualCostKnown: true,
  },
});

describe('runSectionRows', () => {
  it('lays every fact out in one label column under a labelled rule', () => {
    const ui = renderRun({ summary: priced, width: 100, crewNamed: true });
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

    expect(lines[0]).toContain(`   Run ${glyph('divider')}`);
    const labelled = lines.filter((line) => /^ {3}[A-Z][a-z]+ {2,}/.test(line));
    expect(labelled.length).toBeGreaterThan(2);
    for (const line of labelled) expect(line.slice(11, 13)).toBe('  ');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('saved');
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('2026-09-14-add-email-validation');

    ui.unmount();
  });

  it('names neither the money nor the tokens the run recorded', () => {
    const ui = renderRun({ summary: priced, width: 100, crewNamed: true });
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.split('\n').some((line) => line.startsWith('Cost'))).toBe(false);
    expect(frame.split('\n').some((line) => line.startsWith('Tokens'))).toBe(false);
    expect(frame).not.toContain('$');
    expect(frame).not.toContain('0.42');
    expect(frame).not.toContain('31.2k');
    expect(frame).not.toMatch(/token/i);

    ui.unmount();
  });

  it('keeps both on the record, where /usage reads them', () => {
    const usage = deriveUsageDetails({
      tokenUsage: priced.tokenUsage,
      costBreakdown: priced.costBreakdown ?? null,
    });

    expect(formatUsageMoney(usage.money)).toBe('$0.42');
    const input = usage.counters.find((row) => row.counter === 'input');
    expect(input?.amount).toEqual({ kind: 'reported', tokens: 254_400 });
  });

  it('states the crew only when the header could not', () => {
    const named = renderRun({ summary: priced, width: 100, crewNamed: true });
    expect(stripAnsiStyles(named.lastFrame() ?? '')).not.toContain('Crew');
    named.unmount();

    const unnamed = renderRun({ summary: priced, width: 100, crewNamed: false });
    const crewLine =
      stripAnsiStyles(unnamed.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.startsWith('   Crew')) ?? '';
    expect(crewLine).toContain('PLAN OpenAI Codex CLI');
    expect(crewLine).toContain('BUILD qwen-small');
    unnamed.unmount();
  });

  it('sheds whole facts from the tail before it cuts the one left standing', () => {
    const wide = stripAnsiStyles(
      renderRun({ summary: priced, width: 100, crewNamed: true }).lastFrame() ?? '',
    );
    const narrow = stripAnsiStyles(
      renderRun({ summary: priced, width: 34, crewNamed: true }).lastFrame() ?? '',
    );

    expect(wide).toContain('2026-09-14-add-email-validation · standard');
    expect(narrow).not.toContain('standard');
    expect(narrow).toContain('2026-09-14…validation');
    for (const line of narrow.split('\n')) expect(line.length).toBeLessThanOrEqual(34);
  });
});
