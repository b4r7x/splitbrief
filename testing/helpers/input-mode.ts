import { createElement, useEffect } from 'react';
import type { InputMode } from '../../src/core/navigation/types.js';
import {
  useInputMode,
  type UseInputModeResult,
} from '../../src/features/workflow/hooks/use-input-mode.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';

function InputModeHarness({ capture }: { capture: { current: UseInputModeResult | null } }): null {
  const inputMode = useInputMode();
  useEffect(() => {
    capture.current = inputMode;
  });
  return null;
}

/**
 * Renders the input mode as the workflow screen does, so a question waits as it does live.
 * `inputMode` is the first render's result, which the screen hands to the run; `mode()` reads the
 * mode of the last render.
 */
export async function renderInputMode(): Promise<{
  inputMode: UseInputModeResult;
  mode: () => InputMode | undefined;
  unmount: () => void;
}> {
  const capture: { current: UseInputModeResult | null } = { current: null };
  const ui = renderFeature(createElement(InputModeHarness, { capture }));
  await tick();
  const inputMode = capture.current;
  if (inputMode === null) throw new Error('expected the input mode to render');
  return { inputMode, mode: () => capture.current?.mode, unmount: ui.unmount };
}
