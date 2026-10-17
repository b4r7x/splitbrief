import { Box } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { taskId } from '../../../core/schemas/task.js';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import {
  makeView,
  endedInBuild,
  endedInPlanning,
} from '#testing/helpers/factories/summary-view.js';
import { getRailStages } from '../../../core/rail-stages.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import { glyph } from '../../../lib/glyphs.js';
import { deriveSummaryView } from './view-model.js';
import { closedBlockRows } from './block.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeTaskComplete, makeTaskStart } from '#testing/helpers/events/task.js';
import { groupEventsIntoSections } from '../../../core/sections/event-sections.js';
import { taskTargetLabel } from '../../../stores/workflow/tasks.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import { ConversationRowView } from '../components/conversation-flow/row-view.js';
import { closedTranscriptBlock } from './block.js';

const originalColorLevel = chalk.level;
afterEach(() => {
  chalk.level = originalColorLevel;
});

function closedRows(width: number): ScrollableDocumentRow[] {
  resetAllStores();
  const view = deriveSummaryView({
    record: makeRunRecord({
      ref: { projectDir: '/tmp/closed-block', sessionId: 'block-session' },
      summary: makeSummary({
        feature: 'Add email validation with tests',
        totalTasks: 1,
        completedByLocal: 1,
        reviewPacket: {
          jsonPath: 'review-packet.json',
          markdownPath: 'review-packet.md',
          generatedAt: '2026-09-14T00:00:00.000Z',
          finalReviewStatus: 'written',
          finalReviewVerdict: 'pass',
          finalReviewFindingCounts: { critical: 0, warning: 0, note: 0 },
          driftPassed: true,
          evidenceValidatedTasks: 1,
          evidenceTotalTasks: 1,
          missingArtifactCount: 0,
        },
        changedFiles: ['src/validate.ts'],
        taskBreakdown: [
          {
            taskId: taskId('T001'),
            taskTitle: 'Add the validator',
            method: 'local',
            implementerTokens: 10,
            escalationTokens: 0,
            retryCount: 0,
          },
        ],
      }),
      status: { kind: 'closed', as: 'complete' },
    }),
  });
  if (view === null) throw new Error('expected a closed run to have a view');
  return closedBlockRows({ view, width, theme: defaultTheme, crewNamed: true });
}

function renderRows(rows: ScrollableDocumentRow[], width: number) {
  return renderFeature(
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.key}>{row.node}</Box>
      ))}
    </Box>,
    { cols: width, rows: 30 },
  );
}

function renderRow(row: ScrollableDocumentRow, width: number): string {
  const ui = renderRows([row], width);
  const line = stripAnsiStyles(ui.lastFrame() ?? '').split('\n')[0] ?? '';
  ui.unmount();
  return line;
}

function firstLineStartingWith(frame: string, needle: string): string {
  return (
    stripAnsiStyles(frame)
      .split('\n')
      .find((line) => line.startsWith(needle)) ?? ''
  );
}

describe('closedBlockRows', () => {
  it.each(['done', 'failed', 'skipped'] as const)(
    'spells the same target label on the transcript and closed ledger for a %s brief',
    (status) => {
      resetAllStores();
      const task = makeTask({
        title: 'Update report',
        status,
        action: 'modify',
        suggestedFiles: ['src/report.js', 'src/report.test.js'],
      });
      const started = makeTaskStart({
        taskId: task.id,
        title: task.title,
        file: task.suggestedFiles[0],
        files: task.suggestedFiles,
        action: task.action,
        ts: 0,
      });
      const completed = makeTaskComplete({
        taskId: task.id,
        title: task.title,
        method: status === 'done' ? makeTaskComplete().method : status,
        duration: 120_000,
        ts: 120_000,
      });
      const view = deriveSummaryView({
        record: makeRunRecord({
          status: { kind: 'closed', as: 'complete' },
          hydration: {
            kind: 'loaded',
            state: makeWorkflowState({ phase: 'complete', tasks: [task] }),
          },
          summary: makeSummary({ totalTasks: 1, completedByLocal: status === 'done' ? 1 : 0 }),
          ledger: {
            version: 1,
            sessionId: 'block-session',
            feature: 'Update report',
            generatedAt: '2026-10-10T00:00:00.000Z',
            tasks: [
              {
                id: task.id,
                title: task.title,
                file: started.file,
                status,
                method: completed.method,
                retries: 0,
                durationMs: completed.duration,
                changedFiles: task.suggestedFiles,
                escalated: false,
              },
            ],
            validationSummary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
          },
        }),
      });
      const label = taskTargetLabel({ ...task, file: started.file, files: task.suggestedFiles });
      for (const width of [60, 80, 120]) {
        const result = computeConversationRowScroll({
          sections: groupEventsIntoSections([started, completed]),
          expandedDiffs: new Set(),
          expandedActivityBatches: new Set(),
          cols: width,
          viewportHeight: 40,
          rawScrollOffset: 0,
          renderableCountAtScroll: 0,
          heightAtScroll: 0,
          streaming: { taskId: null, lines: [], active: false },
          tail: [closedTranscriptBlock({ view, width, theme: defaultTheme, crewNamed: true })],
        });
        const ui = renderFeature(
          <Box flexDirection="column">
            {result.rows.map((row) => (
              <ConversationRowView key={row.key} row={row} />
            ))}
          </Box>,
          { cols: width, rows: 40 },
        );
        const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
        const briefLines = lines.filter((line) => line.includes(`${task.id} ${task.title}`));
        expect(briefLines).toHaveLength(2);
        for (const line of briefLines) {
          expect(line).toContain(width === 60 ? '· +1 file' : label);
        }
        expect(briefLines[0]).toBe(briefLines[1]);
        ui.unmount();
      }
    },
  );

  it('keeps an earlier brief target from its ledger when the current plan reuses its id', () => {
    resetAllStores();
    const view = deriveSummaryView({
      record: makeRunRecord({
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({ tasks: [makeTask({ title: 'New report' })] }),
        },
        summary: makeSummary(),
        ledger: {
          version: 1,
          sessionId: 'block-session',
          feature: 'Update report',
          generatedAt: '2026-10-10T00:00:00.000Z',
          tasks: [
            {
              id: taskId('T001'),
              title: 'Old report',
              file: 'src/old-report.js',
              status: 'done',
              retries: 0,
              changedFiles: [],
              escalated: false,
            },
          ],
          validationSummary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
        },
      }),
    });
    expect(view?.briefs.earlierRows[0]?.file).toBe('src/old-report.js');
    const rows = closedBlockRows({ view, width: 120, theme: defaultTheme, crewNamed: true });
    const ui = renderRows(rows, 120);
    const line = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .find((row) => row.includes('Old report'));
    expect(line).toContain('src/old-report.js');
    expect(line).not.toContain('(create)');
    ui.unmount();
  });

  it.each(['failed', 'skipped'] as const)('keeps the file on the closed %s brief row', (method) => {
    const view = makeView({
      briefs: {
        ...makeView().briefs,
        rows: [
          {
            id: taskId('T001'),
            title: 'Receive stock',
            state: method,
            method,
            retries: 0,
            durationMs: null,
            file: 'src/orders.js',
            partialFiles: 0,
          },
        ],
        earlierRows: [],
      },
    });
    const rows = closedBlockRows({ view, width: 80, theme: defaultTheme, crewNamed: true });
    const brief = rows.find((row) => row.key.startsWith('brief:'));
    if (brief === undefined) throw new Error('Missing closed brief row');
    const line = renderRow(brief, 80);
    expect(line).toContain('T001 Receive stock');
    expect(line).toContain(method);
    expect(line).toContain('src/orders.js');
  });

  it('paints a pending stage word from its own structured seat', () => {
    chalk.level = 3;
    const view = endedInPlanning({
      rail: [
        { stage: 'plan', status: 'done' },
        { stage: 'build', status: 'pending' },
        { stage: 'review', status: 'pending' },
      ],
    });
    const row = closedBlockRows({ view, width: 200, theme: defaultTheme, crewNamed: true }).find(
      (candidate) => candidate.key === 'closed:outcome',
    );
    if (row === undefined) throw new Error('expected an outcome row');
    const ui = renderRows([row], 200);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.implementer, 'Build').replace('\u001b[39m', ''),
    );
    ui.unmount();
  });
  it.each(['dark', 'light'] as const)(
    'keeps ended stage words in their seat tones in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      for (const [phase, label, tone] of [
        ['reviewing-plan', 'Plan', 'planner'],
        ['implementing', 'Build', 'implementer'],
        ['final-review', 'Review', 'reviewer'],
      ] as const) {
        const base = endedInPlanning();
        const view = endedInPlanning({
          rail: getRailStages(phase, { halted: 'cancelled' }),
          briefs: { ...base.briefs, total: 3 },
          files: { ...base.files, changed: [] },
        });
        for (const width of [200, 22, 8]) {
          const row = closedBlockRows({ view, width, theme, crewNamed: true }).find(
            (candidate) => candidate.key === 'closed:outcome',
          );
          if (row === undefined) throw new Error('expected an outcome row');
          const ui = renderRows([row], width);
          const frame = ui.lastFrame() ?? '';
          if (width === 8) {
            expect(stripAnsiStyles(frame)).toBe(` ${glyph('statusCancelled')} Ended`);
          } else {
            expect(frame).toContain(
              paint(theme[tone], label).replace('\u001b[39m', '') +
                paint(theme.textDim, ' 0/3').replace('\u001b[39m', ''),
            );
            expect(frame).toContain(paint(theme.textDim, ' · ').replace('\u001b[39m', ''));
            expect(frame).toContain(paint(theme.textDim, ' 0/3').replace('\u001b[39m', ''));
            expect(stripAnsiStyles(frame)).toBe(
              ` ${glyph('statusCancelled')} Ended · ${label} 0/3${width === 200 ? ' · nothing built' : ''}`,
            );
          }
          ui.unmount();
        }
      }
    },
  );

  it.each(['dark', 'light'] as const)(
    'dims the absence after an unrecorded ending in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const row = closedBlockRows({ view: null, width: 200, theme, crewNamed: false }).find(
        (candidate) => candidate.key === 'closed:outcome',
      );
      if (row === undefined) throw new Error('expected an outcome row');
      const ui = renderRows([row], 200);
      expect(ui.lastFrame()).toContain(
        paint(theme.warning, ` ${glyph('statusCancelled')} Ended`).replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(paint(theme.textDim, ' · no run record was written'));
      ui.unmount();
    },
  );

  it.each(['dark', 'light'] as const)(
    'paints recorded crew, state and metadata in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const rows = closedBlockRows({ view: makeView(), width: 200, theme, crewNamed: false });
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <Box flexDirection="column">
            {rows.map((row) => (
              <Box key={row.key}>{row.node}</Box>
            ))}
          </Box>
        </ThemeProvider>,
        { cols: 200, rows: 50 },
      );
      const frame = ui.lastFrame();
      for (const [text, tone] of [
        ['PLAN claude-sonnet-4', 'planner'],
        ['BUILD qwen2.5-coder:7b', 'implementer'],
        ['REVIEW = PLAN', 'reviewer'],
        ['Review', 'reviewer'],
        ['pass with notes', 'success'],
        ['clean', 'success'],
        [' · 0 blocking, 1 note · 3/3 briefs validated', 'textDim'],
        ['planning 2m 50s', 'textDim'],
        ['2026-09-14-add-email-validation-with-tests', 'textDim'],
        [' · ', 'textDim'],
      ] as const) {
        expect(frame).toContain(paint(theme[tone], text).replace('\u001b[39m', ''));
      }
      const outcome = rows.find((row) => row.key === 'closed:outcome');
      const lead = rows.find((row) => row.key === 'run-heading');
      const outcomeUi = renderRows(outcome === undefined ? [] : [outcome], 200);
      expect(outcomeUi.lastFrame()).toContain(
        paint(theme.success, ` ${glyph('stageDone')} Complete`).replace('\u001b[39m', ''),
      );
      expect(outcomeUi.lastFrame()).toContain(
        paint(theme.textDim, ' · 3/3 briefs passed').replace('\u001b[39m', ''),
      );
      outcomeUi.unmount();
      const ruleUi = renderFeature(<ThemeProvider theme={theme}>{lead?.node}</ThemeProvider>);
      expect(ruleUi.lastFrame()).toContain(paint(theme.text, 'Run').replace('\u001b[39m', ''));
      expect(ruleUi.lastFrame()).toContain(
        paint(theme.border, ` ${glyph('divider')}`).replace('\u001b[39m', ''),
      );
      ruleUi.unmount();
      ui.unmount();
    },
  );

  it('keeps stopped outcomes and scope issues warning, and failed review error', () => {
    chalk.level = 3;
    const review = makeView().review;
    if (review.kind !== 'written') throw new Error('expected a written review');
    const view = endedInBuild({
      review: { ...review, verdict: 'fail' },
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 0 },
    });
    const ui = renderRows(
      closedBlockRows({ view, width: 200, theme: defaultTheme, crewNamed: true }),
      200,
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.warning, ` ${glyph('statusCancelled')} Ended`).replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.error, 'failed').replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(paint(defaultTheme.error, '1 error'));
    ui.unmount();
  });

  it("opens every ledger row on the transcript's own two columns", () => {
    const width = 60;
    const rows = closedRows(width);
    const ui = renderRows(rows, width);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // One column short of the full width: the rule stops before the column the composer's right
    // stroke stands in rather than overhanging it.
    const closedRule = firstLineStartingWith(frame, '   Closed ');
    expect(closedRule).toContain(glyph('divider'));
    expect(closedRule.trimEnd().length).toBe(width - 1);

    expect(frame).toContain('   Add email validation with tests');
    expect(frame).toContain(` ${glyph('stageDone')} Complete · 1/1 briefs passed`);
    expect(frame).toContain(` ${glyph('stageDone')} T001 Add the validator`);

    const runRule = firstLineStartingWith(frame, '   Run ');
    expect(runRule).toContain(glyph('divider'));
    expect(runRule.trimEnd().length).toBe(width - 1);

    expect(firstLineStartingWith(frame, '   Review  ')).not.toBe('');

    ui.unmount();

    // A ledger row is either marked — the outcome and the brief rows, whose mark lands on column 1
    // — or bare text on column 3. A spacer row carries no ink, so it is left out rather than
    // counted as a row that opens in column 0.
    const inked = rows.map((row) => renderRow(row, width).search(/\S/)).filter((ink) => ink !== -1);
    expect(inked.length).toBeGreaterThan(0);
    expect(inked.every((ink) => ink === 1 || ink === 3)).toBe(true);
    expect(inked).toContain(1);
    expect(inked).toContain(3);
  });
});
