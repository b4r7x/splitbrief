import { useEffect } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { useInputMode, type UseInputModeResult } from './use-input-mode.js';

function Harness({ capture }: { capture: { current: UseInputModeResult | null } }) {
  const inputMode = useInputMode();
  useEffect(() => {
    capture.current = inputMode;
  });
  return <Text>{`${inputMode.mode}:${inputMode.hint}`}</Text>;
}

async function waitForMode(
  capture: { current: UseInputModeResult | null },
  mode: UseInputModeResult['mode'],
) {
  for (let i = 0; i < 5; i += 1) {
    await tick();
    if (capture.current?.mode === mode) return;
  }
}

describe('useInputMode', () => {
  beforeEach(() => {
    controlsStore.reset();
  });

  it('resolves a superseded question before installing the next question resolver', async () => {
    const capture: { current: UseInputModeResult | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    const first = capture.current?.setQuestionMode('first question');
    if (!first) throw new Error('expected first question promise');
    await tick();

    const second = capture.current?.setQuestionMode('second question');
    if (!second) throw new Error('expected second question promise');
    await expect(first).resolves.toBe('');
    await waitForMode(capture, 'question');

    expect(capture.current?.mode).toBe('question');
    expect(capture.current?.hint).toBe('second question');
    expect(controlsStore.get().inputMode).toBe('question');

    capture.current?.resolve('answer');
    await expect(second).resolves.toBe('answer');
    await waitForMode(capture, 'normal');

    expect(capture.current?.mode).toBe('normal');
    expect(controlsStore.get().inputMode).toBe('normal');
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

    expect(ui.lastFrame()).toBe('question:question prompt');

    capture.current?.resolve('answer');
    await expect(question).resolves.toBe('answer');
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
  });

  afterEach(() => {
    controlsStore.reset();
  });

  it('enters review mode when the engine requests approval, and returns to normal when the user approves', async () => {
    const { ref, ui } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve / quit?').then((v) => {
      approvalResult = v;
    });

    await waitForMode(ref, 'review');
    expect(controlsStore.get().inputMode).toBe('review');
    expect(ui.lastFrame()).toContain('approve / quit?');

    requireRef(ref).resolve({ approved: true, comment: 'lgtm' });
    await pending;

    expect(approvalResult).toEqual({ approved: true, comment: 'lgtm' });
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
    expect(ui.lastFrame()).toContain('Which framework?');

    requireRef(ref).resolve('react');
    await pending;

    expect(answer).toBe('react');
    expect(controlsStore.get().inputMode).toBe('normal');
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
  });
});
