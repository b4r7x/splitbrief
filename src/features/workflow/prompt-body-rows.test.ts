import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { stateTone } from '../../core/theme/state-tone.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { PromptBody } from './components/prompt-body.js';
import { QuestionPrompt } from './components/question-prompt.js';
import {
  clipPromptBodyRows,
  countPromptBodyRows,
  fitRecommendedText,
  promptBodyRows,
  type PromptBodyLine,
  splitActionRow,
} from './prompt-body-rows.js';
import {
  getQuestionPromptRows,
  QUESTION_PROMPT_HORIZONTAL_CHROME,
} from './prompt-rows/question.js';
import {
  passHeadlinePrefix,
  promptRowsToString,
  recoveryPromptSummaryRows,
} from './recovery-prompt.js';

const PANEL_WIDTH = 80;
const BODY_WIDTH = PANEL_WIDTH - QUESTION_PROMPT_HORIZONTAL_CHROME;
const LONG_TOKEN = 'x'.repeat(BODY_WIDTH + 32);
const trailingControlSummary = recoveryPromptSummaryRows(
  makeRecoveryIssue({
    reason: 'seat-protocol-error',
    seat: 'review',
    message: 'Provider refused request',
    attempts: undefined,
    taskId: undefined,
    taskTitle: undefined,
    files: [],
    affectedTaskIds: [],
    details: ['abcdefghijklmnopqr   \u001b[0m'],
  }),
  20,
);

function frameRows(frame: string): string[] {
  return stripAnsiStyles(frame).split('\n');
}

function renderedPromptBodyRows(prompt: string, count: number): string[] {
  const ui = renderFeature(createElement(PromptBody, { prompt, height: count, width: BODY_WIDTH }));
  const rows = frameRows(ui.lastFrame() ?? '');
  ui.unmount();
  return rows;
}

describe('promptBodyRows', () => {
  it('matches string rows for a recovery detail ending in spaces and a terminal reset', () => {
    const rows = promptBodyRows(trailingControlSummary, 20);
    expect(rows).toEqual([
      {
        kind: 'headline',
        row: {
          kind: 'headline',
          tone: 'attention',
          text: 'Seat down · Provider refused request',
          parts: [
            { text: 'Seat down', tone: stateTone('attention') },
            { text: ' · ', tone: 'textDim' },
            { text: 'Provider refused request', tone: 'text' },
          ],
        },
      },
      { kind: 'blank' },
      { kind: 'facts-line', text: '  abcdefghijklmnopqr' },
      { kind: 'facts-line', text: '  ', continuation: true },
    ]);
    expect(rows.slice(1)).toEqual(
      promptBodyRows(promptRowsToString(trailingControlSummary), 20).slice(1),
    );
  });

  it('counts four recovery summary rows when the final detail ends in a terminal reset', () => {
    expect(countPromptBodyRows(trailingControlSummary, 20)).toBe(4);
    expect(countPromptBodyRows(trailingControlSummary, 20)).toBe(
      countPromptBodyRows(promptRowsToString(trailingControlSummary), 20),
    );
  });

  it('keeps first-line spans and hangs non-blank headline continuations as facts', () => {
    expect(
      promptBodyRows(
        [
          {
            kind: 'headline',
            tone: 'attention',
            text: 'Review · first\n\n  second\n  ',
            parts: [
              { text: 'Review', tone: 'reviewer' },
              { text: ' · ', tone: 'textDim' },
              { text: 'first\n\n  second\n  ', tone: 'text' },
            ],
          },
        ],
        30,
      ),
    ).toEqual([
      {
        kind: 'headline',
        row: {
          kind: 'headline',
          tone: 'attention',
          text: 'Review · first',
          parts: [
            { text: 'Review', tone: 'reviewer' },
            { text: ' · ', tone: 'textDim' },
            { text: 'first', tone: 'text' },
          ],
        },
      },
      { kind: 'blank' },
      { kind: 'facts-line', text: '    second' },
    ]);
  });

  it.each([20, 76])('matches HEAD recovery continuation rows and tones at width %s', (width) => {
    const issue = makeRecoveryIssue({
      reason: 'seat-protocol-error',
      seat: 'review',
      attempts: undefined,
      taskId: undefined,
      taskTitle: undefined,
      files: [],
      affectedTaskIds: [],
      details: [],
      message: 'Provider refused request\n  try another tool',
    });
    const prompt = recoveryPromptSummaryRows(issue, width);
    const headline = {
      kind: 'headline',
      row: {
        kind: 'headline',
        tone: 'attention',
        text: 'Seat down · Provider refused request',
        parts: [
          { text: 'Seat down', tone: stateTone('attention') },
          { text: ' · ', tone: 'textDim' },
          { text: 'Provider refused request', tone: 'text' },
        ],
      },
    };
    expect(promptBodyRows(prompt, width)).toEqual([
      headline,
      { kind: 'blank' },
      { kind: 'facts-line', text: '    try another tool' },
    ]);
    expect(countPromptBodyRows(prompt, width)).toBe(3);

    const withFacts = recoveryPromptSummaryRows(
      makeRecoveryIssue({ ...issue, files: ['src/example.ts'], details: ['Validation: npm test'] }),
      width,
    );
    expect(promptBodyRows(withFacts, width)).toEqual([
      headline,
      { kind: 'blank' },
      { kind: 'facts-line', text: '    try another tool' },
      ...(width === 20
        ? [
            { kind: 'facts-line', text: '  Files …/example.ts' },
            { kind: 'facts-line', text: '  Last check npm ' },
            { kind: 'facts-line', text: '  test', continuation: true },
          ]
        : [
            { kind: 'facts-line', text: '  Files src/example.ts' },
            { kind: 'facts-line', text: '  Last check npm test' },
          ]),
    ]);
    expect(countPromptBodyRows(withFacts, width)).toBe(width === 20 ? 6 : 5);
  });

  it.each([20, 76])('drops empty recovery fact lines at width %s', (width) => {
    const prompt = recoveryPromptSummaryRows(
      makeRecoveryIssue({
        reason: 'seat-protocol-error',
        seat: 'review',
        message: 'Provider refused request',
        attempts: undefined,
        taskId: undefined,
        taskTitle: undefined,
        files: [],
        affectedTaskIds: [],
        details: ['First\n\nsecond'],
      }),
      width,
    );
    const rows = promptBodyRows(prompt, width);
    const facts = rows.filter((row) => row.kind === 'facts-line');

    expect(facts.every((row) => row.text.trim().length > 0)).toBe(true);
    const first = rows.findIndex((row) => row.kind === 'facts-line' && row.text === '  First');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(rows.slice(first, first + 2)).toEqual([
      { kind: 'facts-line', text: '  First' },
      { kind: 'facts-line', text: '  second' },
    ]);
    expect(countPromptBodyRows(prompt, width)).toBe(4);
    expect(countPromptBodyRows(prompt, width)).toBe(
      countPromptBodyRows(promptRowsToString(prompt), width),
    );
  });

  it.each([20, 52, 76])('matches serialized summary layout and tones at width %s', (width) => {
    const headline =
      'Provider refused request because the answer did not include any usable evidence from the required checks';
    const issue = makeRecoveryIssue({
      reason: 'seat-protocol-error',
      seat: 'review',
      message: 'Provider refused request',
      attempts: undefined,
      taskId: undefined,
      taskTitle: undefined,
      files: [],
      affectedTaskIds: [],
      details: [],
    });
    const project = (row: PromptBodyLine) => ({
      kind: row.kind,
      text: row.kind === 'headline' ? row.row.text : 'text' in row ? row.text : undefined,
    });
    for (const overrides of [
      { details: ['First\n\nsecond'] },
      { message: headline, details: ['   '] },
      { details: ['First   ', 'second   '] },
      { details: ['First \n\nsecond   '] },
      { message: 'Provider refused request\n\n  try another tool\n  ', details: ['First'] },
      { message: 'Provider refused request\n\n  try another tool   \n  ', details: [] },
      { message: `${headline}   `, details: [] },
    ]) {
      const prompt = recoveryPromptSummaryRows(
        makeRecoveryIssue({ ...issue, ...overrides }),
        width,
      );
      const rows = promptBodyRows(prompt, width);
      expect(rows.map(project)).toEqual(
        promptBodyRows(promptRowsToString(prompt), width).map(project),
      );
      const parts = rows.flatMap((row) =>
        row.kind === 'headline'
          ? (row.row.parts ?? [])
          : row.kind === 'message-line'
            ? (row.parts ?? [])
            : [],
      );
      expect(parts).toContainEqual({ text: 'Seat down', tone: stateTone('attention') });
      expect(parts).toContainEqual({ text: ' · ', tone: 'textDim' });
      expect(parts.some((part) => part.tone === 'text')).toBe(true);
    }
  });

  it('keeps trailing fact spaces in a string prompt', () => {
    expect(
      promptBodyRows('Question\n\nFirst   \nsecond   ', 76)
        .filter((row) => row.kind === 'facts-line')
        .map((row) => row.text),
    ).toEqual(['  First   ', '  second   ']);
  });

  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  it('splits the serialized action row into its key and text', () => {
    expect(splitActionRow('[c]  continue')).toEqual({ key: 'c', text: 'continue' });
    expect(splitActionRow('[w2] switch BUILD')).toEqual({ key: 'w2', text: 'switch BUILD' });
    expect(splitActionRow('plain')).toEqual({ key: '', text: 'plain' });
  });

  it('fits a recommended text by dropping trailing middot parts before truncating', () => {
    expect(fitRecommendedText('end run · closes this run, changes kept', 20)).toBe('end run');
    expect(fitRecommendedText('continue', 20)).toBe('continue');
  });

  it('counts one row per action after the serialized key is split', () => {
    const prompt = [
      'recovery needed',
      '',
      '[r]  retry same worker',
      '[s]  skip task',
      '[a]  abort',
    ].join('\n');
    expect(countPromptBodyRows(prompt, 80)).toBe(5);
  });

  it('counts a one-line prompt body plus chrome for question panel height', () => {
    expect(
      getQuestionPromptRows('Task interrupted. Enter instructions to continue:', PANEL_WIDTH),
    ).toBe(3);
  });

  it('keeps count and rendered rows aligned for a long unbroken facts item', () => {
    const prompt = ['recovery needed', '', `file ${LONG_TOKEN}`].join('\n');
    const rows = promptBodyRows(prompt, BODY_WIDTH);
    const count = countPromptBodyRows(prompt, BODY_WIDTH);

    expect(count).toBe(rows.length);
    expect(rows.filter((row) => row.kind === 'facts-line').length).toBeGreaterThan(1);

    const renderedRows = renderedPromptBodyRows(prompt, count);
    expect(renderedRows).toHaveLength(count);
    expect(renderedRows[0]?.startsWith('r')).toBe(true);
  });

  it('hangs a wrapped fact under its own first line', () => {
    const sentence = 'Pick a plan seat with a larger context in /crew plan, then choose Try again.';
    const prompt = ['recovery needed', '', sentence].join('\n');
    const rows = promptBodyRows(prompt, 48);
    const factLines = rows.filter((row) => row.kind === 'facts-line');

    expect(factLines.length).toBeGreaterThan(1);
    for (const line of factLines) {
      expect(line.text.startsWith('  ')).toBe(true);
      expect(line.text.startsWith('   ')).toBe(false);
    }
    expect(factLines.map((line) => line.text.trim()).join(' ')).toBe(sentence);
  });

  it('starts a wrapped fact line on its word when the break falls on a space', () => {
    const rows = promptBodyRows(['recovery needed', '', 'alpha beta'].join('\n'), 7);
    const factLines = rows.filter((row) => row.kind === 'facts-line').map((row) => row.text);

    expect(factLines).toEqual(['  alpha', '  beta']);
  });

  it('wraps an odd trailing grid fact through the same counted body rows', () => {
    const headline = `${passHeadlinePrefix()}t3 ready for review`;
    const prompt = [
      headline,
      '',
      'status passed',
      'checks 3/3 green',
      `artifact ${LONG_TOKEN}`,
    ].join('\n');
    const rows = promptBodyRows(prompt, BODY_WIDTH);
    const count = countPromptBodyRows(prompt, BODY_WIDTH);

    expect(count).toBe(rows.length);
    expect(rows.some((row) => row.kind === 'facts-grid-pair')).toBe(true);
    expect(rows.filter((row) => row.kind === 'facts-line').length).toBeGreaterThan(1);

    const renderedRows = renderedPromptBodyRows(prompt, count);
    expect(renderedRows).toHaveLength(count);
    expect(renderedRows[0]?.startsWith(passHeadlinePrefix())).toBe(true);

    const panelRows = getQuestionPromptRows(prompt, PANEL_WIDTH);
    const ui = renderFeature(
      createElement(QuestionPrompt, {
        hint: prompt,
        width: PANEL_WIDTH,
        clampedBoxRows: panelRows,
      }),
    );
    const panelFrameRows = frameRows(ui.lastFrame() ?? '');
    ui.unmount();

    expect(panelRows).toBe(count + 2);
    expect(panelFrameRows).toHaveLength(panelRows);
    expect(panelFrameRows[1]).toContain(passHeadlinePrefix());
  });

  it('keeps every action row when the panel is shorter than the prompt', () => {
    const prompt = [
      'recovery needed · Ollama hit its usage limit.',
      '',
      'resets 17:00',
      'task T901 · Project deterministic workflow activity',
      'files src/a.ts',
      'worker local-fixture',
      '',
      '[r]  retry same worker',
      '[w1]  switch BUILD to OpenCode CLI',
      '[w2]  switch BUILD to OpenAI Codex CLI · gpt-5-codex',
      '[a]  abort',
    ].join('\n');
    const rows = promptBodyRows(prompt, BODY_WIDTH);
    const clipped = clipPromptBodyRows(rows, 7);

    expect(clipped).toHaveLength(7);
    expect(clipped.filter((row) => row.kind === 'action')).toHaveLength(4);
    expect(clipped[0]?.kind).toBe('headline');
    expect(clipped[1]).toEqual({ kind: 'facts-line', text: '  … 4 more lines' });
    expect(clipped[2]?.kind).toBe('blank');

    const rendered = renderedPromptBodyRows(prompt, 7);
    expect(rendered.some((row) => row.includes('a    abort'))).toBe(true);
    expect(rendered.some((row) => row.includes('… 4 more lines'))).toBe(true);
  });

  it('marks the facts a panel cuts above its action rows on the last kept fact row', () => {
    const prompt = [
      'recovery needed · Ollama hit its usage limit.',
      '',
      'resets 17:00',
      'task T901 · Project deterministic workflow activity',
      'files src/a.ts',
      'worker local-fixture',
      '',
      '[r]  retry same worker',
      '[a]  abort',
    ].join('\n');
    const clipped = clipPromptBodyRows(promptBodyRows(prompt, BODY_WIDTH), 7);

    expect(clipped).toEqual([
      expect.objectContaining({ kind: 'headline' }),
      { kind: 'facts-line', text: '  resets 17:00' },
      { kind: 'facts-line', text: '  task T901 · Project deterministic workflow activity' },
      { kind: 'facts-line', text: '  … 2 more lines' },
      { kind: 'blank' },
      expect.objectContaining({ kind: 'action', key: 'r' }),
      expect.objectContaining({ kind: 'action', key: 'a' }),
    ]);
  });

  it('shows the headline, then the mark, and no partial fact at a height that would split the first fact', () => {
    const prompt = [
      'recovery needed · halt',
      '',
      `first fact ${LONG_TOKEN}`,
      `second fact ${LONG_TOKEN}`,
      '',
      '[r]  retry same worker',
      '[a]  abort',
    ].join('\n');
    const rows = promptBodyRows(prompt, BODY_WIDTH);
    const clipped = clipPromptBodyRows(rows, 6);

    expect(clipped).toHaveLength(6);
    expect(clipped).toEqual([
      expect.objectContaining({ kind: 'headline' }),
      { kind: 'facts-line', text: '  … 4 more lines' },
      { kind: 'blank' },
      { kind: 'blank' },
      expect.objectContaining({ kind: 'action', key: 'r' }),
      expect.objectContaining({ kind: 'action', key: 'a' }),
    ]);
    const summaryRows = clipped
      .slice(
        0,
        clipped.findIndex((row) => row.kind === 'action'),
      )
      .filter((row) => row.kind !== 'blank');
    expect(summaryRows.at(-1)).toEqual({ kind: 'facts-line', text: '  … 4 more lines' });

    const rendered = renderedPromptBodyRows(prompt, 6);
    expect(rendered.some((row) => row.includes('… 4 more lines'))).toBe(true);
    expect(rendered.some((row) => row.includes('first fact'))).toBe(false);
  });

  it('puts the mark right under the last kept fact when the cut splits a later fact', () => {
    const prompt = ['halt', '', 'a short fact', `second fact ${LONG_TOKEN}`, 'third fact'].join(
      '\n',
    );
    const clipped = clipPromptBodyRows(promptBodyRows(prompt, BODY_WIDTH), 4);

    expect(clipped).toHaveLength(4);
    expect(clipped.map((row) => row.kind)).toEqual([
      'headline',
      'facts-line',
      'facts-line',
      'blank',
    ]);
    expect(clipped[1]).toEqual({ kind: 'facts-line', text: '  a short fact' });
    expect(clipped[2]).toEqual(
      expect.objectContaining({ text: expect.stringMatching(/^ {2}… \d+ more lines$/) }),
    );
  });

  it('shows the first fact whole and then the mark at a height that fits it whole', () => {
    const prompt = [
      'recovery needed · halt',
      '',
      `first fact ${LONG_TOKEN}`,
      `second fact ${LONG_TOKEN}`,
      '',
      '[r]  retry same worker',
      '[a]  abort',
    ].join('\n');
    const rows = promptBodyRows(prompt, BODY_WIDTH);
    const facts = rows.filter(
      (row): row is Extract<PromptBodyLine, { kind: 'facts-line' }> => row.kind === 'facts-line',
    );
    const clipped = clipPromptBodyRows(rows, 7);

    expect(clipped).toHaveLength(7);
    expect(clipped).toEqual([
      expect.objectContaining({ kind: 'headline' }),
      facts[0],
      facts[1],
      { kind: 'facts-line', text: '  … 2 more lines' },
      { kind: 'blank' },
      expect.objectContaining({ kind: 'action', key: 'r' }),
      expect.objectContaining({ kind: 'action', key: 'a' }),
    ]);
    const summaryRows = clipped.slice(0, clipped.findIndex((row) => row.kind === 'action') - 1);
    expect(summaryRows.at(-1)).toEqual({ kind: 'facts-line', text: '  … 2 more lines' });

    const rendered = renderedPromptBodyRows(prompt, 7);
    expect(rendered.some((row) => row.includes('… 2 more lines'))).toBe(true);
    expect(rendered.some((row) => row.includes('first fact'))).toBe(true);
  });

  it('marks the bottom rows a summary with no action rows loses, and keeps its headline', () => {
    const summary = recoveryPromptSummaryRows(
      makeRecoveryIssue({
        message: 'T901 failed',
        details: [
          'Last error: activity.ts(42,18): error TS2339',
          'Attempts: 4',
          'Implementer said: one',
        ],
      }),
      BODY_WIDTH,
    );
    const rows = promptBodyRows(summary, BODY_WIDTH);
    const clipped = clipPromptBodyRows(rows, 4);

    expect(rows.length).toBeGreaterThan(4);
    expect(clipped).toHaveLength(4);
    expect(clipped[0]?.kind).toBe('headline');
    expect(clipped.slice(1, 3).every((row) => row.kind === 'facts-line')).toBe(true);
    expect(clipped[3]).toEqual({
      kind: 'facts-line',
      text: `  … ${rows.filter((row) => row.kind === 'facts-line').length - 2} more lines`,
    });
  });

  it('gives up the blank under the headline before it cuts a fact', () => {
    const prompt = 'recovery needed · halt\n\nresets 17:00\ntask T901\nfiles src/a.ts';
    const clipped = clipPromptBodyRows(promptBodyRows(prompt, BODY_WIDTH), 3);

    expect(clipped.at(-1)).toEqual({ kind: 'facts-line', text: '  … 2 more lines' });
    expect(clipPromptBodyRows(promptBodyRows(prompt, BODY_WIDTH), 4)).toEqual([
      expect.objectContaining({ kind: 'headline' }),
      { kind: 'facts-line', text: '  resets 17:00' },
      { kind: 'facts-line', text: '  task T901' },
      { kind: 'facts-line', text: '  files src/a.ts' },
    ]);
    const four = 'recovery needed · halt\n\nresets 17:00\ntask T901\nfiles src/a.ts\nworker w';
    expect(clipPromptBodyRows(promptBodyRows(four, BODY_WIDTH), 4).at(-1)).toEqual({
      kind: 'facts-line',
      text: '  … 2 more lines',
    });
    expect(clipPromptBodyRows(promptBodyRows(four, BODY_WIDTH), 5).at(-1)).toEqual({
      kind: 'facts-line',
      text: '  worker w',
    });
  });

  it('counts the cut lines on the headline when the panel has room for the headline only', () => {
    const prompt = 'recovery needed · halt\n\nresets 17:00\ntask T901\nfiles src/a.ts';

    expect(clipPromptBodyRows(promptBodyRows(prompt, BODY_WIDTH), 1)).toEqual([
      expect.objectContaining({ kind: 'headline', mark: '… 3 more lines' }),
    ]);
    const withActions = `${prompt}\n\n[r]  retry same worker\n[a]  abort`;
    expect(clipPromptBodyRows(promptBodyRows(withActions, BODY_WIDTH), 3)).toEqual([
      expect.objectContaining({ kind: 'headline', mark: '… 3 more lines' }),
      expect.objectContaining({ kind: 'action', key: 'r' }),
      expect.objectContaining({ kind: 'action', key: 'a' }),
    ]);
  });

  it('counts one cut line in the singular', () => {
    const prompt = 'recovery needed · halt\n\nresult.tasks: Required';

    expect(clipPromptBodyRows(promptBodyRows(prompt, BODY_WIDTH), 1)).toEqual([
      expect.objectContaining({ kind: 'headline', mark: '… 1 more line' }),
    ]);
  });

  it('keeps the count on a headline too long for its row and cuts the headline instead', () => {
    const prompt = `recovery needed · ${'a long halt headline '.repeat(6)}\n\nresets 17:00\ntask T901`;
    const [row] = renderedPromptBodyRows(prompt, 1);

    expect(row).toMatch(/^recovery needed · a long halt.*… 2 more lines$/);
    expect(getTerminalCellWidth(row ?? '')).toBeLessThanOrEqual(BODY_WIDTH);
  });

  it('leaves a prompt that fits its panel untouched', () => {
    const prompt = 'recovery needed · halt\n\nresets 17:00\n\n[a]  abort';
    const rows = promptBodyRows(prompt, BODY_WIDTH);

    expect(clipPromptBodyRows(rows, rows.length + 4)).toEqual(rows);
  });
});
