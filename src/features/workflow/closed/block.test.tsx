import { Box } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  makeView,
  endedInBuild,
  endedInPlanning,
} from '#testing/helpers/factories/summary-view.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeTaskComplete, makeTaskStart } from '#testing/helpers/events/task.js';
import { taskId } from '../../../core/schemas/task.js';
import type { RunnerCallCounterCoverage } from '../../../core/runner-call-contract.js';
import { groupEventsIntoSections } from '../../../core/sections/event-sections.js';
import { glyph } from '../../../lib/glyphs.js';
import { configStore } from '../../../stores/project/config.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { ConversationRowView } from '../components/conversation-flow/row-view.js';
import { rowText } from '../conversation-rows/row-format/rows.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import type { ConversationRow } from '../conversation-rows/types.js';
import { closedBlockKey, closedTranscriptBlock } from './block.js';
import { deriveSummaryView, type BriefRow, type SummaryView } from './view-model.js';

const KEY = closedBlockKey('block-session');
const LABEL_CELLS = 9;
const LEADING_CELLS = 3;

type BlockOptions = Readonly<{
  width?: number;
  viewportRows?: number;
  expanded?: boolean;
  crewNamed?: boolean;
}>;

function block(view: SummaryView | null, options: BlockOptions = {}) {
  return closedTranscriptBlock({
    key: KEY,
    view,
    width: options.width ?? 120,
    viewportRows: options.viewportRows ?? 40,
    crewNamed: options.crewNamed ?? true,
    expanded: options.expanded ?? false,
  });
}

function blockRows(view: SummaryView | null, options: BlockOptions = {}): ConversationRow[] {
  const built = block(view, options);
  return built.createRows(0, built.rowCount);
}

function brief(id: string, title: string, overrides: Partial<BriefRow> = {}): BriefRow {
  return {
    id: taskId(id),
    title,
    state: 'local',
    method: 'local',
    retries: 0,
    durationMs: 60_000,
    file: `src/${title}.ts`,
    partialFiles: 0,
    ...overrides,
  };
}

const NOTE =
  'The JSDoc of the validator now sits above the new const, so it documents the wrong symbol, and a reader who trusts that comment calls the wrong function in every new caller.';

const rich = makeView({
  outcome: { kind: 'applied' },
  briefs: {
    total: 2,
    passed: 2,
    failed: 0,
    rows: [brief('T001', 'validate'), brief('T002', 'form')],
    earlierRows: [],
  },
  digest: {
    ...makeView().digest,
    plannedBriefs: 2,
    planCriteria: 3,
    criteria: { passed: 3, total: 3 },
    notes: [{ id: 'R1', file: 'src/validate.ts', text: NOTE }],
    leadFiles: ['src/form.ts', 'src/validate.ts', 'src/form.test.ts'],
  },
});

const FULL_COVERAGE: RunnerCallCounterCoverage = {
  input: 'reported',
  output: 'reported',
  cacheRead: 'reported',
  cacheCreate: 'reported',
  reasoning: 'reported',
};

beforeEach(() => {
  resetAllStores();
});

describe('closedTranscriptBlock', () => {
  it('reads as one tree: the outcome, a row per stage, the fold, then the session', () => {
    const rows = blockRows(rich);
    const texts = rows.map(rowText);

    expect(rows.every((row) => row.node === undefined)).toBe(true);
    expect(rows[0]?.kind).toBe('activity');
    expect(texts[0]).toBe('Applied to your checkout  4 files · 12m 7s');
    expect(rows[0]?.segments[0]).toMatchObject({ text: 'Applied to your checkout', bold: true });

    const stages = rows.filter((row) => row.kind === 'activity-child').map(rowText);
    expect(stages).toEqual([
      'Plan     2 briefs · 3 criteria · 2m 50s',
      'Build    2/2 briefs passed · 8m 12s',
      'Review   pass with notes · 1 note · 3/3 criteria · 1m 5s',
      'Files    4 files · 2 test files',
    ]);
    expect(texts).toContain('         R1 src/validate.ts');
    expect(texts).toContain('         src/form.ts');

    const fold = rows.at(-2);
    expect(fold?.kind).toBe('activity-more');
    expect(fold?.key).toBe(`${KEY}-hidden`);
    expect(rowText(fold as ConversationRow)).toBe('+2 briefs · 1 file');
    expect(block(rich).foldRowKey).toBe(`${KEY}-hidden`);
    expect(rows.at(-1)?.kind).toBe('activity-child-last');
    expect(texts.at(-1)).toBe('Session  2026-09-14-add-email-validation-with-tests');
    expect(
      rows
        .slice(1, -2)
        .every((row) => row.kind === 'activity-child' || row.kind === 'callout-body'),
    ).toBe(true);
  });

  it('opens the whole record under the same header, with collapse on top', () => {
    const collapsed = blockRows(rich);
    const expanded = blockRows(rich, { expanded: true });
    const texts = expanded.map(rowText);

    expect(texts[0]).toBe('Applied to your checkout  4 files · 12m 7s');
    expect(expanded[1]?.kind).toBe('activity-more');
    expect(expanded[1]?.key).toBe(`${KEY}-hidden`);
    expect(texts[1]).toBe('collapse');
    expect(block(rich, { expanded: true }).foldRowKey).toBe(`${KEY}-hidden`);
    expect(expanded.filter((row) => row.kind === 'activity-more')).toHaveLength(1);

    const briefRows = texts.filter((text) => /^ {9}T00\d /u.test(text));
    expect(briefRows).toHaveLength(2);
    expect(briefRows[0]).toContain('T001 validate');
    expect(briefRows[0]).toContain('passed');
    for (const path of rich.files.changed ?? []) expect(texts).toContain(`         ${path}`);
    expect(texts).toContain(
      'Packet   .splitbrief/sessions/2026-09-14-add-email-validation-with-tests/review-packet.md',
    );
    expect(texts).toContain('Ran      12m 7s');
    expect(texts.at(-1)).toBe('Session  2026-09-14-add-email-validation-with-tests');

    expect(block(rich).toggledRowCount).toBe(expanded.length);
    expect(block(rich, { expanded: true }).toggledRowCount).toBe(collapsed.length);
  });

  it('counts on the fold what the record adds: briefs, files and earlier reviews', () => {
    const foldText = (view: SummaryView, width = 120) =>
      rowText(blockRows(view, { width }).at(-2) as ConversationRow);
    const reviewed = {
      ...rich,
      briefs: { ...rich.briefs, earlierRows: [brief('T001', 'validate')] },
      failedReviews: [
        {
          label: 'Final review',
          blocking: [{ id: 'R1', text: 'The form accepts an empty address.' }],
          setAside: [],
        },
      ],
    };

    expect(foldText(reviewed)).toBe('+3 briefs · 1 file · 1 review');
    expect(foldText(reviewed, 30)).toBe('+3 briefs · 1 file');
    expect(foldText(reviewed, 24)).toBe('+3 briefs');
    expect(
      foldText({
        ...rich,
        briefs: { ...rich.briefs, rows: [] },
        digest: { ...rich.digest, leadFiles: rich.files.changed ?? [] },
      }),
    ).toBe('more');
  });

  it('paints a stage label in the tone of its seat and every other label dim', () => {
    const rows = blockRows(rich, { expanded: true, crewNamed: false });
    const labelTone = (label: string) =>
      rows.find((row) => row.segments[0]?.text.trim() === label)?.segments[0]?.tone;

    expect(labelTone('Plan')).toBe('planner');
    expect(labelTone('Build')).toBe('implementer');
    expect(labelTone('Review')).toBe('reviewer');
    for (const label of ['Crew', 'Files', 'Packet', 'Scope', 'Ran', 'Session']) {
      expect(labelTone(label), label).toBe('textDim');
    }
  });

  it('sets the count that leads a fact apart from its words, on a labelled row only', () => {
    const bright = (lead: string) =>
      blockRows(rich)
        .find((row) => rowText(row).startsWith(lead))
        ?.segments.filter((segment) => segment.tone === 'text')
        .map((segment) => segment.text);

    expect(bright('Plan')).toEqual(['2', '3']);
    expect(bright('Review')).toEqual(['1', '3/3']);
    expect(bright('Files')).toEqual(['4', '2']);
    expect(bright('         R1 src/validate.ts')).toEqual([]);
    expect(bright('Session')).toEqual([]);
  });

  it('dims the brief titles of the record, so the stage rows stay its headings', () => {
    const briefRow = blockRows(rich, { expanded: true }).find((row) =>
      rowText(row).includes('T001 validate'),
    );

    expect(briefRow?.segments[1]).toEqual({ text: 'T001 validate', tone: 'textDim' });
  });

  it('keeps only the labelled rows when the summary is taller than the view', () => {
    const tall = blockRows(rich);
    const short = block(rich, { viewportRows: tall.length - 1 });
    const rows = short.createRows(0, short.rowCount);

    expect(rows.map(rowText)).toEqual([
      'Applied to your checkout  4 files · 12m 7s',
      'Plan     2 briefs · 3 criteria · 2m 50s',
      'Build    2/2 briefs passed · 8m 12s',
      'Review   pass with notes · 1 note · 3/3 criteria · 1m 5s',
      'Files    4 files · 2 test files',
      '+2 briefs · 4 files · 1 note',
      'Session  2026-09-14-add-email-validation-with-tests',
    ]);
    expect(rows.at(-1)?.kind).toBe('activity-child-last');
    expect(short.toggledRowCount).toBe(blockRows(rich, { expanded: true }).length);
    expect(block(rich, { viewportRows: tall.length }).rowCount).toBe(tall.length);
    expect(block(rich, { viewportRows: tall.length - 1, expanded: true }).toggledRowCount).toBe(
      rows.length,
    );
  });

  it('drops labelled rows from the bottom up when the labelled rows are taller than the view, and the fold closes the tree', () => {
    const short = block(rich, { viewportRows: 6 });
    const rows = short.createRows(0, short.rowCount);

    expect(short.rowCount).toBeLessThanOrEqual(6);
    expect(rows[0]?.key).toBe(`${KEY}:outcome`);
    expect(rows.at(-1)?.key).toBe(`${KEY}-hidden`);
    expect(rows.map(rowText)).toEqual([
      'Applied to your checkout  4 files · 12m 7s',
      'Plan     2 briefs · 3 criteria · 2m 50s',
      'Build    2/2 briefs passed · 8m 12s',
      'Review   pass with notes · 1 note · 3/3 criteria · 1m 5s',
      'Files    4 files · 2 test files',
      '+2 briefs · 4 files · 1 note',
    ]);
    expect(rows.at(-1)?.kind).toBe('activity-child-last');
    expect(rows.at(-2)?.kind).toBe('activity-child');
    expect(short.toggledRowCount).toBe(blockRows(rich, { expanded: true }).length);
    expect(block(rich, { viewportRows: 6, expanded: true }).toggledRowCount).toBe(rows.length);
  });

  it('drops the crew first when the view is one row short of the labelled rows', () => {
    const rows = blockRows(rich, { viewportRows: 7, crewNamed: false });

    expect(rows.map(rowText)).toEqual([
      'Applied to your checkout  4 files · 12m 7s',
      'Plan     2 briefs · 3 criteria · 2m 50s',
      'Build    2/2 briefs passed · 8m 12s',
      'Review   pass with notes · 1 note · 3/3 criteria · 1m 5s',
      'Files    4 files · 2 test files',
      '+2 briefs · 4 files · 1 note',
      'Session  2026-09-14-add-email-validation-with-tests',
    ]);
    expect(
      rowText(blockRows(rich, { viewportRows: 8, crewNamed: false })[1] as ConversationRow),
    ).toMatch(/^Crew /u);
  });

  it('keeps the outcome and the fold alone in a view of two rows, and the fold closes the tree', () => {
    const rows = blockRows(rich, { viewportRows: 2 });

    expect(rows.map((row) => row.key)).toEqual([`${KEY}:outcome`, `${KEY}-hidden`]);
    expect(rows.at(-1)?.kind).toBe('activity-child-last');
    expect(block(rich, { viewportRows: 2 }).toggledRowCount).toBe(
      blockRows(rich, { expanded: true }).length,
    );
    expect(block(rich, { viewportRows: 2, expanded: true }).toggledRowCount).toBe(2);
  });

  it.each([0, 1])(
    'keeps the outcome and the fold alone in a view shorter than two rows: %i',
    (viewportRows) => {
      const rows = blockRows(rich, { viewportRows });

      expect(rows.map((row) => row.key)).toEqual([`${KEY}:outcome`, `${KEY}-hidden`]);
      expect(rows.at(-1)?.kind).toBe('activity-child-last');
    },
  );

  it('quotes a review note in two rows and keeps it whole on the record', () => {
    const collapsed = blockRows(rich, { width: 80 }).map(rowText);
    const expanded = blockRows(rich, { width: 80, expanded: true }).map(rowText);
    const noteLines = (texts: string[]) => {
      const head = texts.indexOf('         R1 src/validate.ts');
      const end = texts.findIndex((text, index) => index > head && !text.startsWith('         '));
      return texts.slice(head + 1, end).map((text) => text.trim());
    };

    expect(noteLines(collapsed)).toHaveLength(2);
    expect(noteLines(collapsed).at(-1)?.endsWith('…')).toBe(true);
    expect(noteLines(expanded).join(' ')).toBe(NOTE);
  });

  it.each([
    ['applied', undefined, 'success'],
    ['complete', undefined, 'success'],
    ['needs-attention', 'attention', 'warning'],
    ['ended', 'cancelled', 'warning'],
    ['discarded', 'cancelled', 'warning'],
  ] as const)('marks a %s run on its header', (kind, doneAs, tone) => {
    const [header] = blockRows(makeView({ outcome: { kind } }));

    expect(header?.doneAs).toBe(doneAs);
    expect(header?.markerTone).toBe(tone);
  });

  it('paints the attention mark of a run that needs attention', () => {
    const [header] = blockRows(makeView({ outcome: { kind: 'needs-attention' } }));
    if (header === undefined) throw new Error('expected a header row');
    const ui = renderFeature(
      <Box flexDirection="column">
        <ConversationRowView row={header} />
      </Box>,
      { cols: 120, rows: 4 },
    );

    expect(stripAnsiStyles(ui.lastFrame() ?? '').split('\n')[0]).toBe(
      ` ${glyph('statusWarning')} Needs attention  3/3 briefs passed · review 1 note · scope clean · 4 files changed`,
    );
    ui.unmount();
  });

  it('says only how it ended when the run left no record', () => {
    const rows = blockRows(null);

    expect(rows.map(rowText)).toEqual(['Ended  no run record was written']);
    expect(rows[0]?.kind).toBe('activity');
    expect(rows[0]?.doneAs).toBe('cancelled');
  });

  it('counts a brief the planner built in the Build row, in the tone of its transcript row', () => {
    const view = makeView({
      briefs: {
        total: 2,
        passed: 1,
        failed: 0,
        rows: [
          brief('T001', 'validate'),
          brief('T002', 'form', { state: 'escalated', method: 'escalated-full', retries: 2 }),
        ],
        earlierRows: [],
      },
    });
    const build = blockRows(view).find((row) => rowText(row).startsWith('Build'));

    expect(rowText(build as ConversationRow)).toMatch(
      /^Build {4}1\/2 briefs passed · 1 escalated · 2 retries\b/u,
    );
    expect(build?.segments.find((segment) => segment.text === '1 escalated')?.tone).toBe('warning');
  });

  it('counts a brief the run skipped in the Build row, in the tone of its brief row', () => {
    const view = makeView({
      briefs: {
        total: 2,
        passed: 1,
        failed: 0,
        rows: [
          brief('T001', 'validate'),
          brief('T002', 'form', { state: 'skipped', method: 'skipped' }),
        ],
        earlierRows: [],
      },
    });
    const build = blockRows(view).find((row) => rowText(row).startsWith('Build'));

    expect(rowText(build as ConversationRow)).toMatch(
      /^Build {4}1\/2 briefs passed · 1 skipped\b/u,
    );
    expect(build?.segments.find((segment) => segment.text === ' skipped')?.tone).toBe('textDim');
  });

  it('keeps a scope check with nothing to act on out of the summary and states it on the record', () => {
    const labels = (view: SummaryView, expanded: boolean) =>
      blockRows(view, { expanded }).map((row) => rowText(row).split(' ')[0]);
    const unchecked = makeView({ scope: { kind: 'not-run' } });
    const dirty = makeView({ scope: { kind: 'checked', passed: false, errors: 1, warnings: 0 } });

    expect(labels(unchecked, false)).not.toContain('Scope');
    expect(labels(rich, false)).not.toContain('Scope');
    expect(labels(unchecked, true)).toContain('Scope');
    expect(blockRows(dirty).map(rowText)).toContain('Scope    1 error');
  });

  it('paints a stage word of the outcome in its seat tone', () => {
    const view = endedInPlanning({
      rail: [
        { stage: 'plan', status: 'done' },
        { stage: 'build', status: 'pending' },
        { stage: 'review', status: 'pending' },
      ],
    });

    expect(blockRows(view)[0]?.segments).toContainEqual(
      expect.objectContaining({ text: 'Build', tone: 'implementer' }),
    );
  });

  it.each([120, 80, 60, 30])('keeps every row inside %i columns', (width) => {
    for (const expanded of [false, true]) {
      for (const row of blockRows(rich, { width, expanded })) {
        expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(width - LEADING_CELLS);
      }
    }
  });

  it('sheds a middle fact before the time of a stage', () => {
    const review = blockRows(rich, { width: 50 })
      .map(rowText)
      .find((text) => text.startsWith('Review'));

    expect(review).toBe('Review   pass with notes · 1 note · 1m 5s');
  });

  it('names the crew only when the header could not', () => {
    expect(blockRows(rich).map(rowText).join('\n')).not.toContain('Crew');

    const crew = blockRows(rich, { crewNamed: false })[1];
    expect(crew?.kind).toBe('activity-child');
    expect(rowText(crew as ConversationRow).startsWith('Crew     PLAN claude-sonnet-4')).toBe(true);
    for (const [text, tone] of [
      ['PLAN claude-sonnet-4', 'planner'],
      ['BUILD qwen2.5-coder:7b', 'implementer'],
      ['REVIEW = PLAN', 'reviewer'],
    ] as const) {
      expect(crew?.segments).toContainEqual(expect.objectContaining({ text, tone }));
    }
  });

  it('marks a file the run half wrote and links each path into the project', () => {
    configStore.__testReset({ projectDir: '/repo' });
    const rows = blockRows(endedInBuild(), { expanded: true });
    const partial = rows.find((row) => rowText(row).includes('src/routes/signup.ts'));

    expect(rowText(partial as ConversationRow)).toBe('         src/routes/signup.ts · partial');
    expect(partial?.kind).toBe('callout-body');
    expect(partial?.segments.at(-1)).toMatchObject({ text: 'partial', tone: 'warning' });
    expect(partial?.segments).toContainEqual(
      expect.objectContaining({
        text: 'src/routes/signup.ts',
        tone: 'textDim',
        href: 'file:///repo/src/routes/signup.ts',
      }),
    );
    const whole = rows.find((row) => rowText(row).includes('src/validate.ts'));
    expect(rowText(whole as ConversationRow)).toBe('         src/validate.ts');

    configStore.__testReset({ projectDir: '' });
    const unlinked = blockRows(endedInBuild(), { expanded: true });
    expect(unlinked.flatMap((row) => row.segments).some((part) => part.href !== undefined)).toBe(
      false,
    );
  });

  it('keeps both ends of a path the column cannot seat', () => {
    const view = makeView({
      files: {
        ...makeView().files,
        changed: ['src/features/summary/components/very-long-file-name-here.tsx'],
      },
    });
    const path = blockRows(view, { width: 30, expanded: true })
      .map(rowText)
      .find((text) => text.includes('.tsx'));

    expect(path?.startsWith('         src/')).toBe(true);
    expect(path).toContain('…');
    expect(path?.endsWith('.tsx')).toBe(true);
    expect(path).not.toContain('very-long-file-name-here');
  });

  it('wraps a long failed-review finding at words, under its text, and never cuts it', () => {
    const finding =
      'slugify does not fold accented Latin letters to their base letters: src/slug.js line 3 removes them, but nothing maps é to e.';
    const view = makeView({
      failedReviews: [
        { label: 'Review T001', blocking: [{ id: 'F1', text: finding }], setAside: [] },
      ],
    });
    const rows = blockRows(view, { width: 80, expanded: true });
    const texts = rows.map(rowText);

    const first = texts.findIndex((text) => text.includes('  F1 slugify'));
    const head = texts[first] ?? '';
    const column = head.indexOf('slugify');
    const under = ' '.repeat(column);
    const lines = [head];
    for (const text of texts.slice(first + 1)) {
      if (!text.startsWith(under)) break;
      lines.push(text);
    }
    expect(column).toBe(LABEL_CELLS + '  F1 '.length);
    expect(lines.length).toBeGreaterThan(1);
    expect(rows[first + 1]?.kind).toBe('callout-body');
    expect(lines.map((line) => line.slice(column).trimEnd()).join(' ')).toBe(finding);
    expect(lines.join('\n')).not.toContain('…');
  });

  it('names neither the money nor the tokens the run recorded', () => {
    const view = deriveSummaryView({
      record: makeRunRecord({
        ref: { projectDir: '/tmp/closed-rows', sessionId: '2026-09-14-add-email-validation' },
        ledger: null,
        summary: makeSummary({
          totalTasks: 3,
          completedByLocal: 3,
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
        }),
      }),
    });
    const text = [false, true]
      .flatMap((expanded) => blockRows(view, { expanded }).map(rowText))
      .join('\n');

    expect(text).toContain('2026-09-14-add-email-validation');
    expect(text).not.toContain('$');
    expect(text).not.toContain('0.42');
    expect(text).not.toContain('31.2k');
    expect(text).not.toMatch(/token|cost/iu);
  });

  it.each(['done', 'failed', 'skipped'] as const)(
    'spells a %s brief on the record the way the transcript settles it',
    (status) => {
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
      const width = 140;
      const transcript = computeConversationRowScroll({
        sections: groupEventsIntoSections([started, completed]),
        expandedDiffs: new Set(),
        expandedActivityBatches: new Set(),
        cols: width,
        viewportHeight: 40,
        rawScrollOffset: 0,
        renderableCountAtScroll: 0,
        heightAtScroll: 0,
        streaming: { taskId: null, lines: [], active: false },
      });
      const ui = renderFeature(
        <Box flexDirection="column">
          {transcript.rows.map((row) => (
            <ConversationRowView key={row.key} row={row} />
          ))}
        </Box>,
        { cols: width, rows: 40 },
      );
      const settled = stripAnsiStyles(ui.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes(`${task.id} ${task.title}`));
      ui.unmount();
      const recorded = blockRows(view, { width, expanded: true })
        .map(rowText)
        .find((text) => text.includes(`${task.id} ${task.title}`));

      expect(settled).toBeDefined();
      expect(recorded?.slice(LABEL_CELLS)).toBe(settled?.slice(LEADING_CELLS).trimEnd());
    },
  );

  it('keeps an earlier brief target from its ledger when the current plan reuses its id', () => {
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
    const texts = blockRows(view, { expanded: true }).map(rowText);
    const earlier = texts.indexOf('         Earlier work');
    const line = texts.find((text) => text.includes('Old report'));

    expect(earlier).toBeGreaterThan(0);
    expect(texts.indexOf(line ?? '')).toBeGreaterThan(earlier);
    expect(line).toContain('src/old-report.js');
    expect(line).not.toContain('(create)');
  });
});
