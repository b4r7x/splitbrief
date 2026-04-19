import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { useInputMode, type UseInputModeResult } from '../../../src/features/workflow/hooks/use-input-mode.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';

interface HarnessProps {
  capture: { current: UseInputModeResult | null };
}

function Harness({ capture }: HarnessProps) {
  const inputMode = useInputMode();
  useEffect(() => {
    capture.current = inputMode;
  });
  return (
    <Box>
      {inputMode.mode === 'normal' ? null : <Text>{inputMode.hint}</Text>}
    </Box>
  );
}

function mount() {
  const capture: HarnessProps['capture'] = { current: null };
  const instance = render(<Harness capture={capture} />);
  return { ref: capture, instance };
}

async function tick() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function requireRef(ref: { current: UseInputModeResult | null }): UseInputModeResult {
  if (!ref.current) throw new Error('expected useInputMode harness ref to be populated');
  return ref.current;
}

describe('workflow input-mode integration', () => {
  beforeEach(() => {
    controlsStore.reset();
  });

  afterEach(() => {
    controlsStore.reset();
  });

  it('enters review mode when the engine requests approval, and returns to normal when the user approves', async () => {
    const { ref, instance } = mount();
    await tick();
    const inputMode = requireRef(ref);

    // Engine calls onApprovalNeeded -> setReviewMode.
    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve / quit?').then((v) => {
      approvalResult = v;
    });

    await tick();
    expect(controlsStore.get().inputMode).toBe('review');
    expect(instance.lastFrame()).toContain('approve / quit?');

    // User types "approve" -> workflow review-input dispatcher calls resolve({ approved: true, comment }).
    requireRef(ref).resolve({ approved: true, comment: 'lgtm' });
    await pending;

    expect(approvalResult).toEqual({ approved: true, comment: 'lgtm' });
    expect(controlsStore.get().inputMode).toBe('normal');
    instance.unmount();
  });

  it('resolves the approval promise as rejected when the user quits', async () => {
    const { ref, instance } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve / quit?').then((v) => {
      approvalResult = v;
    });
    await tick();

    requireRef(ref).resolve({ approved: false });
    await pending;

    expect(approvalResult).toEqual({ approved: false });
    expect(controlsStore.get().inputMode).toBe('normal');
    instance.unmount();
  });

  it('enters question mode and delivers the user answer back to the engine', async () => {
    const { ref, instance } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let answer: string | undefined;
    const pending = inputMode.setQuestionMode('Which framework?').then((v) => {
      answer = v;
    });

    await tick();
    expect(controlsStore.get().inputMode).toBe('question');
    expect(instance.lastFrame()).toContain('Which framework?');

    requireRef(ref).resolve('react');
    await pending;

    expect(answer).toBe('react');
    expect(controlsStore.get().inputMode).toBe('normal');
    instance.unmount();
  });

  it('cancelling the workflow (resetMode) resolves a pending review promise as rejected', async () => {
    const { ref, instance } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve?').then((v) => {
      approvalResult = v;
    });
    await tick();

    requireRef(ref).resetMode();
    await pending;

    expect(approvalResult).toEqual({ approved: false });
    expect(controlsStore.get().inputMode).toBe('normal');
    instance.unmount();
  });

  it('cancelling the workflow resolves a pending question promise with an empty answer', async () => {
    const { ref, instance } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let answer: string | undefined;
    const pending = inputMode.setQuestionMode('Which DB?').then((v) => {
      answer = v;
    });
    await tick();

    requireRef(ref).resetMode();
    await pending;

    expect(answer).toBe('');
    instance.unmount();
  });

  it('unmounting the workflow screen resolves any pending review promise so the engine does not hang', async () => {
    const { ref, instance } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let approvalResult: { approved: boolean; comment?: string | undefined } | undefined;
    const pending = inputMode.setReviewMode('approve?').then((v) => {
      approvalResult = v;
    });
    await tick();

    instance.unmount();
    await pending;

    expect(approvalResult).toEqual({ approved: false });
  });

  it('unmounting resolves any pending question promise with an empty answer', async () => {
    const { ref, instance } = mount();
    await tick();
    const inputMode = requireRef(ref);

    let answer: string | undefined;
    const pending = inputMode.setQuestionMode('Which DB?').then((v) => {
      answer = v;
    });
    await tick();

    instance.unmount();
    await pending;

    expect(answer).toBe('');
  });
});
