import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { PromptBody } from './components/prompt-body.js';
import { QuestionPrompt } from './components/question-prompt.js';
import { clipPromptBodyRows, countPromptBodyRows, promptBodyRows } from './prompt-body-rows.js';
import {
  getQuestionPromptRows,
  QUESTION_PROMPT_HORIZONTAL_CHROME,
} from './prompt-rows/question.js';
import { passHeadlinePrefix } from './recovery-prompt.js';

const PANEL_WIDTH = 80;
const BODY_WIDTH = PANEL_WIDTH - QUESTION_PROMPT_HORIZONTAL_CHROME;
const LONG_TOKEN = 'x'.repeat(BODY_WIDTH + 32);

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
  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
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
    expect(clipped[1]).toMatchObject({ kind: 'facts-line' });
    expect(clipped[2]?.kind).toBe('blank');

    const rendered = renderedPromptBodyRows(prompt, 7);
    expect(rendered.some((row) => row.includes('[a]  abort'))).toBe(true);
    expect(rendered.some((row) => row.includes('resets 17:00'))).toBe(true);
  });

  it('leaves a prompt that fits its panel untouched', () => {
    const prompt = 'recovery needed · halt\n\nresets 17:00\n\n[a]  abort';
    const rows = promptBodyRows(prompt, BODY_WIDTH);

    expect(clipPromptBodyRows(rows, rows.length + 4)).toEqual(rows);
  });
});
