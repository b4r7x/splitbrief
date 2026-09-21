import { afterEach, expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { questionPromptStore as store } from '../../../stores/question-prompt/prompt.js';
import { PlannerQuestion } from './planner-question.js';

const down = '\u001b[B';
afterEach(() => {
  store.reset();
  vi.restoreAllMocks();
});

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
  expect(stripAnsiStyles(ui.lastFrame())).toContain('Builder (default)');
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
