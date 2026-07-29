import { useEffect } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { questionPromptStore } from '../../../stores/question-prompt/prompt.js';
import { useInputMode, type UseInputModeResult } from './use-input-mode.js';

function Harness({ capture }: { capture: { current: UseInputModeResult | null } }) {
  const inputMode = useInputMode();
  const viewport = terminalSizeStore.use((state) => `${state.cols}x${state.rows}`);
  useEffect(() => {
    capture.current = inputMode;
  });
  return (
    <Text>
      {`${viewport}:${inputMode.mode}:${inputMode.hint}:question-${inputMode.questionEpoch}`}
    </Text>
  );
}

async function waitForMode(
  capture: { current: UseInputModeResult | null },
  mode: UseInputModeResult['mode'],
  hint?: string,
) {
  for (let i = 0; i < 5; i += 1) {
    await tick();
    if (capture.current?.mode === mode && (hint === undefined || capture.current.hint === hint)) {
      return;
    }
  }
}

describe('useInputMode', () => {
  beforeEach(() => {
    controlsStore.reset();
    questionPromptStore.reset();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  });

  it('preserves the current question resolver and epoch through viewport rerenders', async () => {
    const capture: { current: UseInputModeResult | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const first = capture.current?.setQuestionMode('first question');
    if (!first) throw new Error('expected first question promise');
    await waitForMode(capture, 'question');

    expect(ui.lastFrame()).toContain('120x40:question:first question:question-1');

    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    await tick();
    expect(ui.lastFrame()).toContain('80x24:question:first question:question-1');

    const second = capture.current?.setQuestionMode('second question');
    if (!second) throw new Error('expected second question promise');
    await expect(first).resolves.toBe('');
    await waitForMode(capture, 'question', 'second question');

    expect(capture.current?.mode).toBe('question');
    expect(capture.current?.hint).toBe('second question');
    expect(capture.current?.questionEpoch).toBe(2);
    expect(controlsStore.get().inputMode).toBe('question');
    expect(questionPromptStore.get().hint).toBe('second question');

    const resolveAtCompact = requireRef(capture).resolve;
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    await tick();
    expect(ui.lastFrame()).toContain('60x18:question:second question:question-2');

    resolveAtCompact('answer');
    await expect(second).resolves.toBe('answer');
    await waitForMode(capture, 'normal');

    expect(capture.current?.mode).toBe('normal');
    expect(capture.current?.questionEpoch).toBe(2);
    expect(controlsStore.get().inputMode).toBe('normal');
    expect(questionPromptStore.get().hint).toBeNull();
    expect(ui.lastFrame()).toContain('60x18:normal::question-2');
    ui.unmount();
  });

  it('resolves a superseded review when a question prompt replaces it', async () => {
    const capture: { current: UseInputModeResult | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const review = capture.current?.setReviewMode('review prompt');
    if (!review) throw new Error('expected review promise');
    await tick();

    const question = capture.current?.setQuestionMode('question prompt');
    if (!question) throw new Error('expected question promise');
    await expect(review).resolves.toEqual({ approved: false });
    await waitForMode(capture, 'question');

    expect(ui.lastFrame()).toContain('question:question prompt');

    capture.current?.resolve('answer');
    await expect(question).resolves.toBe('answer');
    ui.unmount();
  });

  it('clears the question geometry hint when review mode supersedes a question', async () => {
    const capture: { current: UseInputModeResult | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const question = capture.current?.setQuestionMode('question prompt');
    if (!question) throw new Error('expected question promise');
    await waitForMode(capture, 'question');
    expect(questionPromptStore.get().hint).toBe('question prompt');

    const review = capture.current?.setReviewMode('review prompt');
    if (!review) throw new Error('expected review promise');
    await expect(question).resolves.toBe('');
    await waitForMode(capture, 'review');

    expect(questionPromptStore.get().hint).toBeNull();
    capture.current?.resolve({ approved: false });
    await review;
    ui.unmount();
  });
});

function mount() {
  const capture: { current: UseInputModeResult | null } = { current: null };
  const ui = renderFeature(<Harness capture={capture} />);
  return { ref: capture, ui };
}

function requireRef(ref: { current: UseInputModeResult | null }): UseInputModeResult {
  if (!ref.current) throw new Error('expected useInputMode harness ref to be populated');
  return ref.current;
}

describe('useInputMode — mode transitions', () => {
  beforeEach(() => {
    controlsStore.reset();
    questionPromptStore.reset();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  });

  afterEach(() => {
    controlsStore.reset();
    questionPromptStore.reset();
  });

  it('enters review mode when the engine requests approval, and returns to normal when the user approves', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean } | undefined;
    const pending = inputMode.setReviewMode('approve / quit?').then((v) => {
      approvalResult = v;
    });

    await waitForMode(ref, 'review');
    expect(controlsStore.get().inputMode).toBe('review');
    expect(ui.lastFrame()).toContain('approve / quit?');

    const resolveAtWide = requireRef(ref).resolve;
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    await tick();
    expect(ui.lastFrame()).toContain('80x24:review:approve / quit?');
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    await tick();
    expect(ui.lastFrame()).toContain('60x18:review:approve / quit?');

    resolveAtWide({ approved: true });
    await pending;

    expect(approvalResult).toEqual({ approved: true });
    expect(controlsStore.get().inputMode).toBe('normal');
    ui.unmount();
  });

  it('resolves the approval promise as rejected when the user quits', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve / quit?').then((v) => {
      approvalResult = v;
    });
    await waitForMode(ref, 'review');

    requireRef(ref).resolve({ approved: false });
    await pending;

    expect(approvalResult).toEqual({ approved: false });
    expect(controlsStore.get().inputMode).toBe('normal');
    ui.unmount();
  });

  it('enters question mode and delivers the user answer back to the engine', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let answer: string | undefined;
    const pending = inputMode.setQuestionMode('Which framework?').then((v) => {
      answer = v;
    });

    await waitForMode(ref, 'question');
    expect(controlsStore.get().inputMode).toBe('question');
    expect(questionPromptStore.get().hint).toBe('Which framework?');
    expect(ui.lastFrame()).toContain('Which framework?');

    requireRef(ref).resolve('react');
    await pending;

    expect(answer).toBe('react');
    expect(controlsStore.get().inputMode).toBe('normal');
    expect(questionPromptStore.get().hint).toBeNull();
    ui.unmount();
  });

  it('cancelling the workflow (resetMode) resolves a pending review promise as rejected', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve?').then((v) => {
      approvalResult = v;
    });
    await waitForMode(ref, 'review');

    requireRef(ref).resetMode();
    await pending;

    expect(approvalResult).toEqual({ approved: false });
    expect(controlsStore.get().inputMode).toBe('normal');
    ui.unmount();
  });

  it('cancelling the workflow resolves a pending question promise with an empty answer', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let answer: string | undefined;
    const pending = inputMode.setQuestionMode('Which DB?').then((v) => {
      answer = v;
    });
    await waitForMode(ref, 'question');

    requireRef(ref).resetMode();
    await pending;

    expect(answer).toBe('');
    expect(questionPromptStore.get().hint).toBeNull();
    ui.unmount();
  });

  it('unmounting resolves any pending review promise so the engine does not hang', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve?').then((v) => {
      approvalResult = v;
    });
    await waitForMode(ref, 'review');

    ui.unmount();
    await pending;

    expect(approvalResult).toEqual({ approved: false });
  });

  it('unmounting resolves any pending question promise with an empty answer', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let answer: string | undefined;
    const pending = inputMode.setQuestionMode('Which DB?').then((v) => {
      answer = v;
    });
    await waitForMode(ref, 'question');

    ui.unmount();
    await pending;

    expect(answer).toBe('');
    expect(questionPromptStore.get().hint).toBeNull();
  });
});
