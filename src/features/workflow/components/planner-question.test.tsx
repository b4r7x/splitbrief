import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { questionPromptStore as store } from '../../../stores/question-prompt/prompt.js';
import { PlannerQuestion } from './planner-question.js';

const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

const down = '\u001b[B';
afterEach(() => {
  store.reset();
  vi.restoreAllMocks();
});

function colorOf(frame: string, text: string): string | undefined {
  const before = frame.split(text)[0];
  return before?.split('\u001B[').at(-1)?.split('m')[0];
}

function colorsOf(frame: string, text: string): string[] {
  return frame
    .split(text)
    .slice(0, -1)
    .map((before) => before.split('\u001B[').at(-1)?.split('m')[0] ?? '');
}

function legendOf(frame: string): string {
  return (
    stripAnsiStyles(frame)
      .split('\n')
      .map((line) =>
        line
          .replace(/^[│┃|]\s*/, '')
          .replace(/\s*[│┃|]$/, '')
          .trim(),
      )
      .find((line) => line.includes('⏎') || line.includes('↑↓') || line.includes('paused')) ?? ''
  );
}

function renderQuestion(width = 80, height = 12) {
  return renderFeature(
    <PlannerQuestion
      width={width}
      height={height}
      disabled={false}
      onAnswer={() => {}}
      onCompose={() => {}}
      onPrevious={() => {}}
    />,
  );
}

it('guards typeahead and reads rapid navigation synchronously before confirming', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  store.setQuestions([
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
  ]);
  const onAnswer = vi.fn();
  const ui = renderFeature(
    <PlannerQuestion
      width={60}
      height={12}
      disabled={false}
      onAnswer={onAnswer}
      onCompose={() => {}}
      onPrevious={() => {}}
    />,
  );
  await flushEffects();
  ui.stdin.write('\r');
  await flushEffects();
  expect(onAnswer).not.toHaveBeenCalled();
  now += 200;
  ui.stdin.write(down);
  ui.stdin.write('\r');
  await flushEffects();
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('Builder');
  ui.unmount();
});

it('pages through an option taller than the panel without changing its selection', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  store.setQuestions([
    {
      id: 'long',
      type: 'choice',
      text: 'Choose scope',
      options: [Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n') + '\nEND OF OPTION'],
    },
  ]);
  const ui = renderFeature(
    <PlannerQuestion
      width={60}
      height={12}
      disabled={false}
      onAnswer={() => {}}
      onCompose={() => {}}
      onPrevious={() => {}}
    />,
  );
  await flushEffects();
  now += 200;
  const seen: string[] = [];
  for (let i = 0; i < 10; i++) {
    seen.push(stripAnsiStyles(ui.lastFrame()));
    ui.stdin.write('\u001b[6~');
    await flushEffects();
  }
  expect(seen.join('\n')).toContain('END OF OPTION');
  for (let i = 0; i < 40; i++) expect(seen.join('\n')).toContain(`Line ${i}`);
  expect(store.get().drafts[0]?.selected).toBe(0);
  ui.unmount();
});

it('yields keyboard ownership when disabled and preserves selection on resize', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  store.setQuestions([
    {
      id: 'seat',
      type: 'choice',
      text: 'Which seat?',
      options: ['Planner', 'Builder'],
      default: 'Builder',
    },
  ]);
  const onAnswer = vi.fn();
  const props = { height: 12, onAnswer, onCompose: () => {}, onPrevious: () => {} };
  const ui = renderFeature(<PlannerQuestion {...props} width={80} disabled />);
  await flushEffects();
  now += 200;
  ui.stdin.write('\u001b[A');
  ui.stdin.write('\r');
  await flushEffects();
  expect(onAnswer).not.toHaveBeenCalled();
  ui.rerender(<PlannerQuestion {...props} width={60} disabled={false} />);
  await flushEffects();
  expect(stripAnsiStyles(ui.lastFrame())).toContain('Builder default');
  ui.stdin.write('\r');
  await flushEffects();
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('Builder');
  ui.unmount();
});

it('sanitizes controls and secrets in structured content', () => {
  store.setQuestions([
    {
      id: 'safe',
      type: 'choice',
      text: 'Choose\u001b]52;c;clipboard\u0007 scope',
      options: ['token=abcdefghijklmnopqrstuvwxyz1234567890abcdef'],
    },
  ]);
  const ui = renderFeature(
    <PlannerQuestion
      width={80}
      height={12}
      disabled
      onAnswer={() => {}}
      onCompose={() => {}}
      onPrevious={() => {}}
    />,
  );
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toContain('Choose scope');
  expect(frame).toContain('token=***REDACTED***');
  expect(frame).not.toContain('clipboard');
  expect(frame).not.toContain('abcdefghijklmnopqrstuvwxyz');
  ui.unmount();
});

it('marks the last wrapped line of the default option once, even when its label ends in default', async () => {
  store.setQuestions([
    {
      id: 'cleanup',
      type: 'choice',
      text: 'Scope?',
      options: ['Keep the default'],
      default: 'Keep the default',
    },
  ]);
  const ui = renderQuestion(21, 12);
  await flushEffects();
  const frame = ui.lastFrame() ?? '';
  const dim = colorsOf(frame, 'Question 1 of 1').at(0);
  const after = frame.slice(frame.indexOf('Keep the'));

  expect(dim).toBeDefined();
  expect(after).toContain('default');
  expect(colorsOf(after, 'default').filter((color) => color === dim)).toHaveLength(1);
  ui.unmount();
});

it('reserves the default marker where the label already fills its last row', async () => {
  store.setQuestions([
    {
      id: 'narrow',
      type: 'choice',
      text: 'Scope?',
      options: ['123456789012345'],
      default: '123456789012345',
    },
  ]);
  const ui = renderQuestion(21, 12);
  await flushEffects();
  const frame = ui.lastFrame() ?? '';
  const dim = colorsOf(frame, 'Question 1 of 1').at(0);

  expect(dim).toBeDefined();
  const plain = stripAnsiStyles(frame).replace(/[^a-z0-9]/giu, '');
  expect(plain).toContain('123456789012345');
  expect(plain).toContain('123456789012345default');
  expect(colorsOf(frame, 'default').filter((color) => color === dim)).toHaveLength(1);
  ui.unmount();
});

it('drops whole legend keys instead of wrapping them on a narrow panel', async () => {
  store.setQuestions([
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
  ]);
  const ui = renderQuestion(21, 12);
  await flushEffects();

  expect(legendOf(ui.lastFrame() ?? '')).toBe('↑↓ select');
  ui.unmount();
});

it('teaches select, next and write while the menu owns the keyboard', async () => {
  store.setQuestions([
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
    { id: 'scope', type: 'choice', text: 'Scope?', options: ['Small', 'Large'] },
  ]);
  const ui = renderQuestion();
  await flushEffects();

  expect(legendOf(ui.lastFrame() ?? '')).toBe('↑↓ select · ⏎ next · tab write');

  store.answer('Planner');
  await flushEffects();
  expect(legendOf(ui.lastFrame() ?? '')).toContain('⏎ send answers');
  ui.unmount();
});

it('teaches the composer-only writing keys when the first question has no options', async () => {
  store.setQuestions([
    { id: 'note', type: 'input', text: 'Anything to add?' },
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
  ]);
  const ui = renderQuestion();
  await flushEffects();

  expect(legendOf(ui.lastFrame() ?? '')).toBe('⏎ next · ↓/tab instruction');
  ui.unmount();
});

it('splits the writing keys between the instruction and the options once choices exist', async () => {
  store.setQuestions([
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
    { id: 'scope', type: 'choice', text: 'Scope?', options: ['Small', 'Large'] },
  ]);
  store.setFocus('answer');
  const ui = renderQuestion();
  await flushEffects();

  expect(legendOf(ui.lastFrame() ?? '')).toBe('⏎ next · ↓ instruction · tab options');
  ui.unmount();
});

it('paints the navigation rows dim until they are highlighted', async () => {
  store.setQuestions([
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
    { id: 'scope', type: 'choice', text: 'Scope?', options: ['Small', 'Large'] },
  ]);
  const ui = renderQuestion();
  await flushEffects();
  store.answer('Planner');
  await flushEffects();
  const frame = ui.lastFrame() ?? '';

  expect(colorOf(frame, 'Previous question')).toBeDefined();
  expect(colorOf(frame, 'Previous question')).toBe(colorOf(frame, 'Write an answer…'));
  expect(colorOf(frame, 'Previous question')).not.toBe(colorOf(frame, 'Large'));
  ui.unmount();
});
