import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import type { Summary } from '../../../../core/schemas/summary.js';
import { defaultTheme } from '../../../../components/theme.js';
import { paint } from '../../../../core/theme/paint.js';
import { resolveTheme } from '../../../../core/theme/resolve.js';
import { formatScoreSummaryParts } from '../../../../core/formatting.js';
import { truncateTerminalDisplayTextMiddle } from '../../../../utils/display-text.js';
import { makeView } from '#testing/helpers/factories/summary-view.js';
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

const originalColorLevel = chalk.level;
afterEach(() => {
  chalk.level = originalColorLevel;
});

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
    theme: defaultTheme,
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
  driftSummary: { passed: true, errorCount: 0, warningCount: 0 },
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
  it('keeps the link color on an ellipsis that cuts the Packet path', () => {
    chalk.level = 3;
    const row = runSectionRows({
      view: makeView(),
      width: 34,
      theme: defaultTheme,
      crewNamed: true,
    }).find((candidate) => candidate.key === 'run:Packet');
    if (row === undefined) throw new Error('expected a Packet row');
    const ui = renderFeature(<Box>{row.node}</Box>, { cols: 34, rows: 1 });
    const cut = truncateTerminalDisplayTextMiddle(
      '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/review-packet.md',
      21,
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.markdown.link, cut));
    ui.unmount();
  });
  it.each(['dark', 'light'] as const)(
    'paints quality scores, findings and separators by concept in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      for (const passed of [true, false]) {
        const quality = { score: 0.92, passed, errorCount: passed ? 0 : 2, warningCount: 3 };
        const row = runSectionRows({
          view: makeView({ quality }),
          width: 100,
          theme,
          crewNamed: true,
        }).find((candidate) => candidate.key === 'run:Briefs');
        if (row === undefined) throw new Error('expected a quality row');
        const ui = renderFeature(<Box>{row.node}</Box>, { cols: 100, rows: 1 });
        const frame = ui.lastFrame() ?? '';
        expect(frame).toContain(
          paint(passed ? theme.textDim : theme.warning, 'quality 0.92').replace('\u001b[39m', ''),
        );
        expect(frame).toContain(
          paint(theme.textDim, passed ? 'quality 0.92 · ' : ' · ').replace('\u001b[39m', ''),
        );
        expect(frame).toContain(paint(theme.warning, '3 warnings'));
        if (!passed) {
          expect(frame).toContain(
            paint(theme.error, '2 errors').replace('\u001b[39m', '') +
              paint(theme.textDim, ' · ').replace('\u001b[39m', ''),
          );
        }
        expect(stripAnsiStyles(frame)).toBe(
          `   Briefs    ${formatScoreSummaryParts(quality.score, quality, 'quality')
            .map((part) => part.text)
            .join('')}`,
        );
        ui.unmount();
      }
    },
  );

  it('cuts the quality fact as one unit at the same cell and preserves the surviving tones', () => {
    chalk.level = 3;
    const quality = { score: 0.92, passed: false, errorCount: 2, warningCount: 3 };
    const row = runSectionRows({
      view: makeView({ quality }),
      width: 34,
      theme: defaultTheme,
      crewNamed: true,
    }).find((candidate) => candidate.key === 'run:Briefs');
    if (row === undefined) throw new Error('expected a quality row');
    const ui = renderFeature(<Box>{row.node}</Box>, { cols: 34, rows: 1 });
    const frame = ui.lastFrame() ?? '';
    const cut = truncateTerminalDisplayTextMiddle(
      formatScoreSummaryParts(quality.score, quality, 'quality')
        .map((part) => part.text)
        .join(''),
      21,
    );
    expect(cut).toBe('quality 0.…3 warnings');
    expect(stripAnsiStyles(frame)).toBe(`   Briefs    ${cut}`);
    expect(frame).toContain(paint(defaultTheme.warning, 'quality 0.…').replace('\u001b[39m', ''));
    expect(frame).toContain(paint(defaultTheme.warning, 'quality 0.…3 warnings'));
    ui.unmount();
  });

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
    // A codex seat that named no model: the rail's own short form says `auto`.
    expect(crewLine).toContain('PLAN auto');
    expect(crewLine).toContain('BUILD Qwen Small');
    unnamed.unmount();
  });

  it('sheds whole facts from the tail before it cuts the one left standing', () => {
    const wide = stripAnsiStyles(
      renderRun({ summary: priced, width: 100, crewNamed: true }).lastFrame() ?? '',
    );
    const narrow = stripAnsiStyles(
      renderRun({ summary: priced, width: 34, crewNamed: true }).lastFrame() ?? '',
    );

    expect(wide).toContain('2026-09-14-add-email-validation');
    expect(wide).not.toContain('standard');
    expect(narrow).toContain('2026-09-14…validation');
    for (const line of narrow.split('\n')) expect(line.length).toBeLessThanOrEqual(34);
  });

  it('wraps a long failed-review finding at words, under its text, and never cuts it', () => {
    const finding =
      'slugify does not fold accented Latin letters to their base letters: src/slug.js line 3 removes them, but nothing maps é to e.';
    const view = makeView({
      failedReviews: [{ label: 'Review T001', blocking: [{ id: 'F1', text: finding }] }],
    });
    const rows = runSectionRows({ view, width: 80, theme: defaultTheme, crewNamed: true });
    const ui = renderFeature(
      <Box flexDirection="column">
        {rows.map((row) => (
          <Box key={row.key}>{row.node}</Box>
        ))}
      </Box>,
      { cols: 80, rows: 30 },
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    ui.unmount();

    const first = lines.findIndex((line) => line.includes('  F1 slugify'));
    const head = lines[first] ?? '';
    const column = head.indexOf('slugify');
    // A wrapped line repeats the row's lead and indents to the text after `  F1 `.
    const under = head.slice(0, column).replace('  F1 ', '     ');
    const block = [head];
    for (const line of lines.slice(first + 1)) {
      if (!line.startsWith(under)) break;
      block.push(line);
    }
    expect(block.length).toBeGreaterThan(1);
    for (const line of block) expect(line.length).toBeLessThanOrEqual(80);
    expect(block.map((line) => line.slice(column).trimEnd()).join(' ')).toBe(finding);
    expect(block.join('\n')).not.toContain('…');
  });
});
