import { writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { mountWorkflowScreen } from '#testing/helpers/workflow-screen.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../stores/project/config.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import type { ClarificationQuestion, PlannerReplyAnswer } from '../../../core/schemas/question.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
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
const shiftDown = '\u001b[1;2B';
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

it('leaves the answer selection and focus on shift+down, the transcript scroll key', async () => {
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
  now += 200;
  for (let press = 0; press < 4; press++) ui.stdin.write(shiftDown);
  await flushEffects();
  expect(store.get().focus).toBe('menu');
  ui.stdin.write('\r');
  await flushEffects();
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('Planner');
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

  expect(legendOf(ui.lastFrame() ?? '')).toBe('↑↓ select · ⏎ next · esc type a reply · tab write');

  store.answer(plainUserMessage('Planner'));
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

  expect(legendOf(ui.lastFrame() ?? '')).toBe('⏎ next · esc type a reply · ↓/tab instruction');
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

  expect(legendOf(ui.lastFrame() ?? '')).toBe(
    '⏎ next · ↑/tab options · esc type a reply · ↓ instruction',
  );
  ui.unmount();
});

it.each<[string, ClarificationQuestion]>([
  ['choice', { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] }],
  ['confirm', { id: 'ready', type: 'confirm', text: 'Proceed?', default: true }],
  [
    'free-text with a default',
    { id: 'files', type: 'input', text: 'Which files?', default: 'src/' },
  ],
])(
  'teaches the same keys on the rows and in the field of a %s question',
  async (_kind, question) => {
    store.setQuestions([question]);
    const ui = renderQuestion();
    await flushEffects();
    expect(legendOf(ui.lastFrame() ?? '')).toBe(
      '↑↓ select · ⏎ send answers · esc type a reply · tab write',
    );

    store.setFocus('answer');
    await flushEffects();
    expect(legendOf(ui.lastFrame() ?? '')).toBe(
      '⏎ send answers · ↑/tab options · esc type a reply · ↓ instruction',
    );
    ui.unmount();
  },
);

it.each([120, 80, 60])(
  'names tab and esc on the paused panel in the words of the rows, %i columns wide',
  async (width) => {
    store.setQuestions([
      { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
    ]);
    store.setFocus('composer');
    const ui = renderQuestion(width);
    await flushEffects();
    expect(legendOf(ui.lastFrame() ?? '')).toBe(
      'Questions paused · tab to return · esc type a reply',
    );
    ui.unmount();
  },
);

it('paints the navigation rows dim until they are highlighted', async () => {
  store.setQuestions([
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
    { id: 'scope', type: 'choice', text: 'Scope?', options: ['Small', 'Large'] },
  ]);
  const ui = renderQuestion();
  await flushEffects();
  store.answer(plainUserMessage('Planner'));
  await flushEffects();
  const frame = ui.lastFrame() ?? '';

  expect(colorOf(frame, 'Previous question')).toBeDefined();
  expect(colorOf(frame, 'Previous question')).toBe(colorOf(frame, 'Write your own answer…'));
  expect(colorOf(frame, 'Previous question')).not.toBe(colorOf(frame, 'Large'));
  ui.unmount();
});

it('prepares panel answers once and preserves the batch, draft and images after refusal', async () => {
  resetAllStores();
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const projectDir = createTempDir('panel-project');
  const outside = createTempDir('panel-outside');
  const path = join(outside, 'context.txt');
  writeFileSync(path, 'attached body');
  const delivered = vi.fn<(reply: UserMessageInput | PlannerReplyAnswer | undefined) => void>();
  const ui = mountWorkflowScreen({
    projectDir,
    deps: {
      runWorkflow: async (opts) => {
        void opts.callbacks
          .onPlannerReply?.({
            call: 'research',
            text: '',
            questions: [
              { id: 'q1', type: 'input', text: 'Which file?' },
              { id: 'q2', type: 'input', text: 'Any more?' },
            ],
            answers: [],
            answered: false,
          })
          .then(delivered);
        return new Promise(() => {});
      },
    },
  });
  try {
    await flushEffects();
    await vi.waitFor(() => expect(store.get().questions).toHaveLength(2));
    now += 200;
    store.setFocus('answer', `use @${path}`);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(store.get().index).toBe(1);
    expect(store.get().answers[0]).toEqual({
      text: `use @${path}\n\n--- @${path} ---\nattached body`,
      displayText: `use @${path}`,
      images: [],
      attachedInputs: [{ kind: 'text', path: realpathSync(path) }],
    });
    const pending = {
      id: 'pending',
      kind: 'image' as const,
      path: '/outside/pending.png',
      mimeType: 'image/png' as const,
      sizeBytes: 1,
    };
    attachmentsStore.replacePendingImages([pending]);
    store.setFocus('answer', 'use @/definitely-missing/context.txt');
    await flushEffects();
    const previous = store.get();
    ui.stdin.write('\r');
    await flushEffects();
    expect(store.get()).toBe(previous);
    expect(attachmentsStore.peek()).toEqual([pending]);
    expect(delivered).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual({
      message: 'Cannot send: file not found. Check the path and try again. File: context.txt.',
      isError: true,
    });
    expect(stripAnsiStyles(ui.lastFrame())).toContain('Cannot send');
    const imagePath = join(outside, 'image.png');
    writeFileSync(imagePath, 'png');
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'agent', command: 'no-vision-planner' } }),
    });
    store.setFocus('answer', `look @${imagePath}`);
    await flushEffects();
    const beforeNoVision = store.get();
    ui.stdin.write('\r');
    await flushEffects();
    expect(store.get()).toBe(beforeNoVision);
    expect(attachmentsStore.peek()).toEqual([pending]);
    expect(feedbackStore.get().message).toContain('cannot see images');
    expect(delivered).not.toHaveBeenCalled();
    writeFileSync(path, 'changed body');
    store.setFocus('answer', 'done');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    expect(delivered.mock.calls[0]?.[0]).toEqual({
      message: {
        text: `1. Which file?\nuse @${path}\n\n--- @${path} ---\nattached body\n\n2. Any more?\ndone`,
        displayText: `1. Which file?\nuse @${path}\n\n2. Any more?\ndone`,
        images: [],
        attachedInputs: [{ kind: 'text', path: realpathSync(path) }],
      },
      qa: [
        { question: 'Which file?', answer: `use @${path}` },
        { question: 'Any more?', answer: 'done' },
      ],
    });
  } finally {
    ui.unmount();
    resetAllStores();
    cleanupTempDir(projectDir);
    cleanupTempDir(outside);
  }
});

it('parks accumulated answer images in question order after successful preparation', async () => {
  resetAllStores();
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const projectDir = createTempDir('panel-images');
  const firstPath = join(projectDir, 'first.png');
  const secondPath = join(projectDir, 'second.png');
  writeFileSync(firstPath, 'first');
  writeFileSync(secondPath, 'second');
  const delivered = vi.fn<(reply: UserMessageInput | PlannerReplyAnswer | undefined) => void>();
  const ui = mountWorkflowScreen({
    projectDir,
    deps: {
      runWorkflow: async (opts) => {
        void opts.callbacks
          .onPlannerReply?.({
            call: 'research',
            text: '',
            questions: [
              { id: 'first', type: 'input', text: 'First?' },
              { id: 'second', type: 'input', text: 'Second?' },
            ],
            answers: [],
            answered: false,
          })
          .then(delivered);
        return new Promise(() => {});
      },
    },
  });
  try {
    await vi.waitFor(() => expect(store.get().questions).toHaveLength(2));
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    now += 200;
    store.setFocus('answer', `look @${firstPath}`);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(store.get().index).toBe(1);
    const firstImages = store.get().answers.flatMap((answer) => answer.images);
    expect(attachmentsStore.peek()).toEqual(firstImages);
    expect(firstImages.map((image) => image.path)).toEqual([realpathSync(firstPath)]);
    store.setFocus('answer', `and @${secondPath}`);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    const answer = delivered.mock.calls[0]?.[0];
    if (answer === undefined || !('message' in answer)) throw new Error('expected batch');
    expect(answer.message.images.map((image) => image.path)).toEqual([
      realpathSync(firstPath),
      realpathSync(secondPath),
    ]);
    expect(answer.message.images[0]).toEqual(firstImages[0]);
    expect(answer.message.attachedInputs).toEqual([
      { kind: 'image', path: realpathSync(firstPath) },
      { kind: 'image', path: realpathSync(secondPath) },
    ]);
    expect(attachmentsStore.peek()).toEqual(answer.message.images);
  } finally {
    ui.unmount();
    resetAllStores();
    cleanupTempDir(projectDir);
  }
});

it.each<[ClarificationQuestion, string]>([
  [{ id: 'cache', type: 'input', text: 'Which cache key must the repair preserve?' }, ''],
  [
    { id: 'cache', type: 'input', text: 'Which cache key must the repair preserve?' },
    'src/cache.ts',
  ],
  [{ id: 'consult-store', type: 'input', text: 'Which store?' }, ''],
  [{ id: 'consult-store', type: 'input', text: 'Which store?' }, 'src/cache.ts'],
])(
  'keeps focus and draft in the answer field on ↑ for a question with no rows',
  async (question, draft) => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    store.setQuestions([question]);
    const ui = renderQuestion();
    await flushEffects();
    now += 200;
    if (draft !== '') {
      ui.stdin.write(draft);
      await flushEffects();
    }
    ui.stdin.write('\u001b[A');
    await flushEffects();
    expect(store.get().focus).toBe('answer');
    expect(store.get().drafts[0]?.text).toBe(draft);
    ui.unmount();
  },
);

it('moves focus to the composer on ↓ in a question with no rows', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  store.setQuestions([
    { id: 'cache', type: 'input', text: 'Which cache key must the repair preserve?' },
  ]);
  const ui = renderQuestion();
  await flushEffects();
  now += 200;
  ui.stdin.write('\u001b[B');
  await flushEffects();
  expect(store.get().focus).toBe('composer');
  ui.unmount();
});

it('moves focus from the answer field to the menu on ↑ in a choice question', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  store.setQuestions([
    { id: 'seat', type: 'choice', text: 'Which seat?', options: ['Planner', 'Builder'] },
  ]);
  store.setFocus('answer');
  const ui = renderQuestion();
  await flushEffects();
  now += 200;
  ui.stdin.write('\u001b[A');
  await flushEffects();
  expect(store.get().focus).toBe('menu');
  ui.unmount();
});
