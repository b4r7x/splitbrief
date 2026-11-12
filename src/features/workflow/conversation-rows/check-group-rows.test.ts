import { describe, expect, it } from 'vitest';
import { SOFT_SEP } from '../../../core/separators.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { checkGroupKey, checkGroupRowBlock } from './check-group-rows.js';
import { fullSuiteRowBlock } from './event-rows/execution.js';
import { rowText } from './row-format/rows.js';
import type { ConversationRow, ConversationRowBlock } from './types.js';

type Check = EngineEventOf<'full_suite'>;

const REUSED_AT = '2026-11-10T09:00:00.000Z';
const LONG_COMMAND =
  'npx vitest run --project unit src/features/workflow/conversation-rows/check-group-rows.test.ts';

function check(id: string, outcome: Partial<Check> = {}): Check {
  return {
    type: 'full_suite',
    ts: 0,
    phase: 'final-review',
    status: 'done',
    moment: 'plan',
    id,
    command: `npm test -- ${id}`,
    ...outcome,
  };
}

const pass = (id: string, duration = 1_000) => check(id, { passed: true, duration });
const fail = (id: string, duration = 12_100) => check(id, { passed: false, duration });
const reused = (id: string, passed = true) => check(id, { passed, reusedAt: REUSED_AT });
const running = (id: string) => check(id, { status: 'running' });
const notRun = (id: string) => check(id, { status: 'not-run', detail: 'V1 failed' });
const render = (scenario: string, duration = 500) =>
  check(`S-${scenario}`, { scenario, command: '', passed: true, duration });
const gateNotRun = (id: string) =>
  check(id, {
    moment: 'pre-review',
    command: 'npm run test:e2e',
    status: 'not-run',
    detail: 'an earlier gate command failed',
  });
const newFailures = (id: string) =>
  check(id, {
    moment: 'pre-review',
    command: 'npm test',
    passed: false,
    newFailures: 2,
    preExisting: 0,
    newKeys: ['src/a.test.ts > a', 'src/b.test.ts > b'],
    duration: 3_000,
  });

function group(
  checks: readonly Check[],
  options: { open: boolean; expanded?: boolean; width?: number; firstIndex?: number },
): ConversationRowBlock {
  return checkGroupRowBlock({
    checks,
    firstIndex: options.firstIndex ?? 7,
    expanded: options.expanded ?? false,
    open: options.open,
    width: options.width ?? 120,
  });
}

function rows(block: ConversationRowBlock): ConversationRow[] {
  return block.createRows(0, block.rowCount);
}

const texts = (block: ConversationRowBlock) => rows(block).map(rowText);
const kinds = (block: ConversationRowBlock) => rows(block).map((row) => row.kind);

function header(block: ConversationRowBlock): ConversationRow {
  const [first] = rows(block);
  if (first === undefined) throw new Error('Expected a header row');
  return first;
}

/** The words of the header, each with its tone, without the gaps and separators between them. */
function headerWords(block: ConversationRowBlock): [string, string][] {
  return header(block)
    .segments.filter((segment) => segment.text.trim() !== '' && segment.text !== SOFT_SEP)
    .map((segment) => [segment.text, segment.tone]);
}

function flatTexts(event: Check, width: number): string[] {
  const block = fullSuiteRowBlock('flat', event, width);
  if (block === null) throw new Error('Expected a check row');
  return block.createRows(0, block.rowCount).map(rowText);
}

describe('checkGroupRowBlock', () => {
  it('folds every row of a done green group into one fold under the header', () => {
    const block = group(
      [
        pass('K1', 1_000),
        pass('K2', 2_000),
        reused('K3'),
        render('greet-card', 500),
        render('cart', 1_500),
      ],
      { open: false },
    );

    expect(texts(block)).toEqual(['Checks  3 passed · 2 rendered · 1 reused · 5.0s', '+5 checks']);
    expect(kinds(block)).toEqual(['activity', 'activity-child-last']);
    expect(header(block)).toMatchObject({ markerTone: 'success' });
    expect(header(block).doneAs).toBeUndefined();
    expect(header(block).segments[0]).toEqual({ text: 'Checks', tone: 'text', bold: true });
    expect(block.activeRowKey).toBeUndefined();
    expect(block.renderableUnits).toBe(5);
  });

  it('keeps the red rows of a done group, in their order, under the fold of the green ones', () => {
    const one = group([pass('K1'), pass('K2'), pass('K3'), pass('K4'), fail('K5')], {
      open: false,
    });

    expect(texts(one)).toEqual([
      'Checks  1 failed · 4 passed · 16.1s',
      '+4 passed',
      'Plan check K5 · npm test -- K5 · failed · 12.1s',
    ]);
    expect(kinds(one)).toEqual(['activity', 'activity-more', 'activity-child-last']);
    expect(header(one)).toMatchObject({ markerTone: 'error', doneAs: 'failed' });
    expect(one.activeRowKey).toBeUndefined();

    const two = group([fail('K1'), pass('K2'), pass('K3'), pass('K4'), fail('K5')], {
      open: false,
    });

    expect(texts(two)).toEqual([
      'Checks  2 failed · 3 passed · 27.2s',
      '+3 passed',
      'Plan check K1 · npm test -- K1 · failed · 12.1s',
      'Plan check K5 · npm test -- K5 · failed · 12.1s',
    ]);
    expect(kinds(two)).toEqual([
      'activity',
      'activity-more',
      'activity-child',
      'activity-child-last',
    ]);
  });

  it('keeps a not-run row of a done group, and marks the group for the reader', () => {
    const block = group([pass('K1'), pass('K2'), pass('K3'), pass('K4'), notRun('K5')], {
      open: false,
    });

    expect(texts(block)).toEqual([
      'Checks  1 not run · 4 passed · 4.0s',
      '+4 passed',
      'Plan check K5 · npm test -- K5 · not run · V1 failed',
    ]);
    expect(kinds(block)).toEqual(['activity', 'activity-more', 'activity-child-last']);
    expect(header(block)).toMatchObject({ markerTone: 'warning', doneAs: 'attention' });
  });

  it('shows the last three rows of a group in progress, and its header is the live row', () => {
    const block = group(
      [pass('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5'), running('K6')],
      { open: false },
    );

    expect(texts(block)).toEqual([
      'Checks  5 passed · 1 running · 5.0s',
      '+3 earlier',
      'Plan check K4 · npm test -- K4 · passed · 1.0s',
      'Plan check K5 · npm test -- K5 · passed · 1.0s',
      'Plan check K6 · npm test -- K6 · running',
    ]);
    expect(kinds(block)).toEqual([
      'activity',
      'activity-more',
      'activity-child',
      'activity-child',
      'activity-child-last',
    ]);
    expect(block.activeRowKey).toBe('checks:7-header');
    expect(header(block)).toMatchObject({ markerTone: 'accent' });
    expect(header(block).doneAs).toBeUndefined();
  });

  it('hides an earlier red row of a group in progress behind the window of the last three', () => {
    const block = group(
      [fail('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5'), running('K6')],
      { open: false },
    );

    expect(texts(block).slice(1)).toEqual([
      '+3 earlier',
      'Plan check K4 · npm test -- K4 · passed · 1.0s',
      'Plan check K5 · npm test -- K5 · passed · 1.0s',
      'Plan check K6 · npm test -- K6 · running',
    ]);
  });

  it('keeps the window of the last three rows between two checks of a review that still runs', () => {
    const block = group([pass('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5')], {
      open: true,
    });

    expect(texts(block)).toEqual([
      'Checks  5 passed · 5.0s',
      '+2 earlier',
      'Plan check K3 · npm test -- K3 · passed · 1.0s',
      'Plan check K4 · npm test -- K4 · passed · 1.0s',
      'Plan check K5 · npm test -- K5 · passed · 1.0s',
    ]);
    expect(kinds(block)).toEqual([
      'activity',
      'activity-more',
      'activity-child',
      'activity-child',
      'activity-child-last',
    ]);
    expect(block.activeRowKey).toBe('checks:7-header');
    expect(header(block)).toMatchObject({ markerTone: 'accent' });
    expect(header(block).doneAs).toBeUndefined();
  });

  it('marks a failure over the window of a review that still runs, with no live row', () => {
    const block = group([fail('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5')], {
      open: true,
    });

    expect(texts(block)).toEqual([
      'Checks  1 failed · 4 passed · 16.1s',
      '+2 earlier',
      'Plan check K3 · npm test -- K3 · passed · 1.0s',
      'Plan check K4 · npm test -- K4 · passed · 1.0s',
      'Plan check K5 · npm test -- K5 · passed · 1.0s',
    ]);
    expect(header(block)).toMatchObject({ markerTone: 'error', doneAs: 'failed' });
    expect(block.activeRowKey).toBeUndefined();
  });

  it('shows the done form of a group whose review no longer runs', () => {
    const block = group([pass('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5')], {
      open: false,
    });

    expect(texts(block)).toEqual(['Checks  5 passed · 5.0s', '+5 checks']);
    expect(kinds(block)).toEqual(['activity', 'activity-child-last']);
    expect(header(block)).toMatchObject({ markerTone: 'success' });
    expect(block.activeRowKey).toBeUndefined();
  });

  it.each([
    {
      state: 'a failure wins over running',
      checks: [fail('K1'), pass('K2'), pass('K3'), pass('K4'), running('K5')],
      open: false,
      markerTone: 'error',
      doneAs: 'failed',
      live: false,
    },
    {
      state: 'running wins over a not-run row',
      checks: [notRun('K1'), pass('K2'), pass('K3'), pass('K4'), running('K5')],
      open: false,
      markerTone: 'accent',
      doneAs: undefined,
      live: true,
    },
    {
      state: 'a review that still runs wins over a not-run row',
      checks: [notRun('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5')],
      open: true,
      markerTone: 'accent',
      doneAs: undefined,
      live: true,
    },
    {
      state: 'a not-run row wins over green',
      checks: [notRun('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5')],
      open: false,
      markerTone: 'warning',
      doneAs: 'attention',
      live: false,
    },
    {
      state: 'green',
      checks: [pass('K1'), pass('K2'), pass('K3'), pass('K4'), pass('K5')],
      open: false,
      markerTone: 'success',
      doneAs: undefined,
      live: false,
    },
  ])('marks the header: $state', ({ checks, open, markerTone, doneAs, live }) => {
    const block = group(checks, { open });

    expect(header(block).markerTone).toBe(markerTone);
    expect(header(block).doneAs).toBe(doneAs);
    expect(block.activeRowKey).toBe(live ? 'checks:7-header' : undefined);
  });

  it('opens with the collapse fold under the header, then every row', () => {
    const red = group([pass('K1'), pass('K2'), pass('K3'), pass('K4'), fail('K5')], {
      open: false,
      expanded: true,
    });

    expect(texts(red)).toEqual([
      'Checks  1 failed · 4 passed · 16.1s',
      'collapse',
      'Plan check K1 · npm test -- K1 · passed · 1.0s',
      'Plan check K2 · npm test -- K2 · passed · 1.0s',
      'Plan check K3 · npm test -- K3 · passed · 1.0s',
      'Plan check K4 · npm test -- K4 · passed · 1.0s',
      'Plan check K5 · npm test -- K5 · failed · 12.1s',
    ]);
    expect(kinds(red)).toEqual([
      'activity',
      'activity-more',
      'activity-child',
      'activity-child',
      'activity-child',
      'activity-child',
      'activity-child-last',
    ]);
    expect(red.foldRowKey).toBe('checks:7-hidden');

    const live = group([pass('K1'), pass('K2'), pass('K3'), pass('K4'), running('K5')], {
      open: false,
      expanded: true,
    });

    expect(texts(live).slice(1)).toEqual([
      'collapse',
      'Plan check K1 · npm test -- K1 · passed · 1.0s',
      'Plan check K2 · npm test -- K2 · passed · 1.0s',
      'Plan check K3 · npm test -- K3 · passed · 1.0s',
      'Plan check K4 · npm test -- K4 · passed · 1.0s',
      'Plan check K5 · npm test -- K5 · running',
    ]);
  });

  it('counts each outcome word in its tone, the failures first, then the words that need the reader', () => {
    const block = group(
      [
        pass('K1'),
        render('greet-card'),
        fail('K2'),
        check('K3', { passed: false, timedOut: true, duration: 30_000 }),
        check('R1', {
          moment: 'pre-review',
          passed: false,
          newFailures: 0,
          preExisting: 2,
          duration: 2_000,
        }),
        check('K4', { status: 'refused', detail: 'not allowed' }),
        check('K5', { status: 'stopped' }),
        pass('K6'),
        fail('K7'),
      ],
      { open: false, width: 200 },
    );

    expect(texts(block)[0]).toBe(
      'Checks  2 failed · 1 timed out · 1 pre-existing · 1 refused · 1 stopped · 2 passed · 1 rendered · 58.7s',
    );
    expect(headerWords(block)).toEqual([
      ['Checks', 'text'],
      ['2 failed', 'error'],
      ['1 timed out', 'error'],
      ['1 pre-existing', 'warning'],
      ['1 refused', 'warning'],
      ['1 stopped', 'warning'],
      ['2 passed', 'success'],
      ['1 rendered', 'success'],
      ['58.7s', 'textDim'],
    ]);
    expect(texts(block)[1]).toBe('+3 passed');
  });

  it('counts a re-run at the run base under the words of its row', () => {
    const preExisting = check('V3', {
      moment: 'pre-review',
      passed: false,
      newFailures: 0,
      preExisting: 1,
      duration: 10_000,
    });
    const baseRed = check('V3', { moment: 'base', passed: false, duration: 9_000 });
    const block = group(
      [
        check('V1', { moment: 'pre-review', passed: true, duration: 1_000 }),
        check('V2', { moment: 'pre-review', passed: true, duration: 1_000 }),
        check('V2', { moment: 'base', passed: true, duration: 5_000 }),
        preExisting,
        baseRed,
      ],
      { open: false, width: 160 },
    );

    expect(headerWords(block)).toEqual([
      ['Checks', 'text'],
      ['1 pre-existing', 'warning'],
      ['1 red at the run base', 'warning'],
      ['2 passed', 'success'],
      ['1 passes at the run base', 'success'],
      ['26.0s', 'textDim'],
    ]);
    expect(texts(block)[0]).not.toContain('failed');
    expect(texts(block).slice(1)).toEqual([
      '+3 passed',
      ...flatTexts(preExisting, 160),
      ...flatTexts(baseRed, 160),
    ]);
  });

  it('counts a word in its most telling tone, so a plan check does not dim the count of a reviewer check', () => {
    const preExisting = { passed: false, newFailures: 0, preExisting: 1, duration: 2_000 };
    const block = group(
      [
        pass('K1'),
        check('V1', { moment: 'plan', ...preExisting }),
        check('R1', { moment: 'pre-review', passed: true, duration: 1_000 }),
        check('V1', { moment: 'pre-review', ...preExisting }),
      ],
      { open: false },
    );

    expect(headerWords(block)).toEqual([
      ['Checks', 'text'],
      ['2 pre-existing', 'warning'],
      ['2 passed', 'success'],
      ['6.0s', 'textDim'],
    ]);
  });

  it('counts a red at the run base in the error tone when one of its rows splits new failures', () => {
    const block = group(
      [
        pass('K1'),
        check('V1', { moment: 'base', passed: false, duration: 2_000 }),
        pass('K2'),
        check('V2', {
          moment: 'base',
          passed: false,
          newFailures: 4,
          preExisting: 0,
          duration: 2_000,
        }),
        check('V3', { moment: 'base', passed: false, duration: 2_000 }),
      ],
      { open: false },
    );

    expect(headerWords(block)).toEqual([
      ['Checks', 'text'],
      ['3 red at the run base', 'error'],
      ['2 passed', 'success'],
      ['8.0s', 'textDim'],
    ]);
  });

  it('counts the reused results apart from the words of their outcomes', () => {
    const block = group([reused('K1'), reused('K2', false), pass('K3'), pass('K4'), pass('K5')], {
      open: false,
    });

    expect(texts(block)[0]).toBe('Checks  1 failed · 4 passed · 2 reused · 3.0s');
  });

  it('sums the times the rows show: no reused result, no check that did not run', () => {
    const block = group(
      [
        pass('K1', 100_000),
        pass('K2', 100_000),
        pass('K3', 52_000),
        check('K4', { passed: true, reusedAt: REUSED_AT, duration: 7_000 }),
        check('K5', { status: 'not-run', detail: 'V1 failed', duration: 9_000 }),
      ],
      { open: false },
    );

    expect(texts(block)[0]).toBe('Checks  1 not run · 4 passed · 1 reused · 4m 12s');
  });

  it('names no time for a group whose rows show none', () => {
    const block = group([reused('K1'), reused('K2'), reused('K3'), reused('K4')], { open: false });

    expect(texts(block)).toEqual(['Checks  4 passed · 4 reused', '+4 checks']);
  });

  it.each([
    {
      state: 'a done group that hides every row',
      checks: [pass('K1'), pass('K2'), pass('K3'), pass('K4')],
      expanded: false,
      fold: '+4 checks',
    },
    {
      state: 'a done group that keeps its red rows',
      checks: [pass('K1'), pass('K2'), pass('K3'), fail('K4')],
      expanded: false,
      fold: '+3 passed',
    },
    {
      state: 'a group in progress',
      checks: [pass('K1'), pass('K2'), pass('K3'), running('K4')],
      expanded: false,
      fold: '+1 earlier',
    },
    {
      state: 'an open group',
      checks: [pass('K1'), pass('K2'), pass('K3'), pass('K4')],
      expanded: true,
      fold: 'collapse',
    },
  ])('labels the fold of $state', ({ checks, expanded, fold }) => {
    const block = group(checks, { open: false, expanded });
    const foldRow = rows(block).find((row) => row.key === block.foldRowKey);

    expect(foldRow === undefined ? undefined : rowText(foldRow)).toBe(fold);
  });

  it('has no fold when a done group keeps every row', () => {
    const checks = [fail('K1'), fail('K2'), fail('K3'), fail('K4')];

    for (const expanded of [false, true]) {
      const block = group(checks, { open: false, expanded });
      expect(texts(block)).toEqual([
        'Checks  4 failed · 48.4s',
        'Plan check K1 · npm test -- K1 · failed · 12.1s',
        'Plan check K2 · npm test -- K2 · failed · 12.1s',
        'Plan check K3 · npm test -- K3 · failed · 12.1s',
        'Plan check K4 · npm test -- K4 · failed · 12.1s',
      ]);
      expect(kinds(block)).toEqual([
        'activity',
        'activity-child',
        'activity-child',
        'activity-child',
        'activity-child-last',
      ]);
      expect(block.foldRowKey).toBeUndefined();
    }
  });

  it('keys the group and its fold by the index of its first event, and each row by its check', () => {
    const checks = [fail('K1'), pass('K2'), pass('K3'), pass('K4'), newFailures('R5')];
    const closed = group(checks, { open: false, firstIndex: 12 });

    expect(checkGroupKey(12)).toBe('checks:12');
    expect(closed.key).toBe('checks:12');
    expect(closed.foldRowKey).toBe('checks:12-hidden');
    expect(rows(closed).map((row) => row.key)).toEqual([
      'checks:12-header',
      'checks:12-hidden',
      'checks:12-check-0-0',
      'checks:12-check-4-0',
      'checks:12-check-4-names-0-0',
      'checks:12-check-4-names-1-0',
    ]);
    expect(closed.createRows(1, 3).map((row) => row.key)).toEqual([
      'checks:12-hidden',
      'checks:12-check-0-0',
    ]);
    expect(
      rows(group(checks, { open: false, firstIndex: 12, expanded: true })).map((row) => row.key),
    ).toEqual([
      'checks:12-header',
      'checks:12-hidden',
      'checks:12-check-0-0',
      'checks:12-check-1-0',
      'checks:12-check-2-0',
      'checks:12-check-3-0',
      'checks:12-check-4-0',
      'checks:12-check-4-names-0-0',
      'checks:12-check-4-names-1-0',
    ]);
  });

  it('keeps the failing tests of a kept red row under it, as the flat row does', () => {
    const red = newFailures('R5');
    const block = group([pass('K1'), pass('K2'), pass('K3'), red], { open: false });

    expect(texts(block).slice(2)).toEqual(flatTexts(red, 120));
    expect(texts(block).slice(2)).toEqual([
      'Reviewer check R5 · npm test · 2 new, 0 pre-existing · 3.0s',
      '  new · src/a.test.ts > a',
      '        src/b.test.ts > b',
    ]);
    expect(kinds(block)).toEqual([
      'activity',
      'activity-more',
      'activity-child-last',
      'message',
      'message',
    ]);
  });

  it('puts the branch mark of a last check that wraps on its first line', () => {
    const last = gateNotRun('V5');
    const block = group([pass('K1'), pass('K2'), pass('K3'), pass('K4'), last], {
      open: false,
      width: 80,
    });

    expect(texts(block).slice(2)).toEqual(flatTexts(last, 80));
    expect(kinds(block)).toEqual(['activity', 'activity-more', 'activity-child-last', 'message']);
  });

  it('puts the branch mark of a last check with failing tests on its first line', () => {
    const block = group(
      [pass('K1'), pass('K2'), pass('K3'), newFailures('R4'), newFailures('R5')],
      { open: false },
    );

    expect(kinds(block)).toEqual([
      'activity',
      'activity-more',
      'activity-child',
      'callout-body',
      'callout-body',
      'activity-child-last',
      'message',
      'message',
    ]);
  });

  it('continues the tree on the wrapped lines of a middle check', () => {
    const middle = gateNotRun('V4');
    const block = group([pass('K1'), pass('K2'), pass('K3'), middle, fail('K5')], {
      open: false,
      width: 80,
    });

    expect(texts(block).slice(2, -1)).toEqual(flatTexts(middle, 80));
    expect(kinds(block)).toEqual([
      'activity',
      'activity-more',
      'activity-child',
      'callout-body',
      'activity-child-last',
    ]);
  });

  it.each([
    {
      width: 120,
      header: 'Checks  1 failed · 1 pre-existing · 3 passed · 2 rendered · 1 reused · 4m 12s',
      command: 48,
      kinds: ['activity', 'activity-more', 'activity-child', 'activity-child-last'],
    },
    {
      width: 80,
      header: 'Checks  1 failed · 1 pre-existing · 3 passed · 2 rendered · 1 reused · 4m 12s',
      command: 44,
      kinds: ['activity', 'activity-more', 'activity-child', 'callout-body', 'activity-child-last'],
    },
    {
      width: 60,
      header: 'Checks  1 failed · 1 pre-existing · 3 passed · 2 rendered',
      command: 24,
      kinds: ['activity', 'activity-more', 'activity-child', 'callout-body', 'activity-child-last'],
    },
  ])(
    'at $width columns drops whole counts from the right of the header, cuts the command and wraps a kept row',
    ({ width, header: headerText, command, kinds: rowKinds }) => {
      const preExisting = check('R1', {
        moment: 'pre-review',
        command: 'npm test',
        passed: false,
        newFailures: 0,
        preExisting: 2,
        duration: 2_000,
      });
      const block = group(
        [
          pass('K1', 50_000),
          pass('K2', 50_000),
          reused('K3'),
          render('greet-card', 50_000),
          render('cart', 50_000),
          preExisting,
          check('K5', { command: LONG_COMMAND, passed: false, duration: 50_000 }),
        ],
        { open: false, width },
      );

      expect(texts(block)).toEqual([
        headerText,
        '+5 passed',
        ...flatTexts(preExisting, width),
        `Plan check K5 · ${truncateTerminalDisplayText(LONG_COMMAND, command)} · failed · 50.0s`,
      ]);
      expect(kinds(block)).toEqual(rowKinds);
      for (const row of rows(block)) {
        expect(getTerminalCellWidth(rowText(row))).toBeLessThanOrEqual(width - 3);
      }
    },
  );
});
