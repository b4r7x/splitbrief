import { render, type Instance } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import { createElement, Fragment } from 'react';
import { warnError } from '../../lib/warn.js';
import { isBrokenOutputError } from '../../lib/terminal/control.js';
import {
  setActiveTerminalHandover,
  type TerminalHandoverConfig,
} from '../../lib/terminal/editor-handover.js';
import { setActiveFilteredStdin } from '../../lib/terminal/filtered-stdin/active.js';
import { createFilteredStdin } from '../../lib/terminal/filtered-stdin/create.js';
import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';
import type { detectKittyKeyboardFlags } from '../../lib/terminal/kitty-keyboard.js';
import { InputTurns } from './input-turns.js';
import { disableTuiInput } from './stdin.js';
import type { EditorOutput, TuiInput } from './types.js';

type AppElement = ReturnType<typeof createElement>;

interface TuiMount {
  fullscreen: boolean;
  kittyKeyboard: ReturnType<typeof detectKittyKeyboardFlags>;
  output: EditorOutput;
  input: TuiInput;
  unmountSignal: AbortSignal | undefined;
}

export async function startFullscreenThenActivateHandover(deps: {
  start: () => Promise<void>;
  publishFilteredStdin: () => void;
  activateFilteredStdin: () => void;
  handover: TerminalHandoverConfig;
  setHandover: (config: TerminalHandoverConfig | undefined) => void;
}): Promise<void> {
  deps.publishFilteredStdin();
  await deps.start();
  deps.activateFilteredStdin();
  deps.setHandover(deps.handover);
}

export function prepareInlineFallbackAfterFullscreenFailure(deps: {
  clearTerminalHandover: () => void;
  clearFilteredStdin: () => void;
  disableFilteredStdin: () => void;
  createInlineStdin: () => FilteredStdin;
}): FilteredStdin {
  deps.clearTerminalHandover();
  deps.clearFilteredStdin();
  deps.disableFilteredStdin();
  return deps.createInlineStdin();
}

function withInputTurns(appElement: AppElement, input: FilteredStdin): AppElement {
  return createElement(
    Fragment,
    null,
    appElement,
    createElement(InputTurns, { holdInput: input.holdInput }),
  );
}

function unmountWhenSignalled(
  instance: Instance,
  signal: AbortSignal | undefined,
  beforeUnmount?: () => void,
): void {
  if (!signal) return;
  const unmount = () => {
    beforeUnmount?.();
    instance.unmount();
  };
  if (signal.aborted) {
    unmount();
    return;
  }
  signal.addEventListener('abort', unmount, { once: true });
}

// No `incrementalRendering`: Ink 6.8's incremental writer assumes the cursor rests on the
// last rendered line, but Ink writes a frame shorter than the terminal with a trailing
// newline and the cursor a row below it (log-update.js:164 against ink.js:320-321), so every
// repaint of a short frame lands one row low. Ink 7.0.0 fixed that arithmetic, but the
// manifest pins `^6.8.0`, so restoring this needs a major bump the repo has not taken. The
// cost is a whole-frame rewrite per repaint, which Ink brackets in DEC 2026 synchronized
// output on a TTY outside CI (ink/build/write-synchronized.js) and leaves unbracketed on a
// pipe. Under CI there is no cost at all: Ink drops every non-static redraw (ink.js:262).
function renderInline(appElement: AppElement, mount: TuiMount): Instance {
  const { output, input } = mount;
  setActiveTerminalHandover({
    fullscreen: false,
    mouse: false,
    sourceStdin: process.stdin,
    beforeSuspend: output.suspend,
    beforeResume: output.resume,
    keyboardPush: output.keyboardPush,
  });
  const instance = render(withInputTurns(appElement, input.stdin), {
    exitOnCtrlC: false,
    maxFps: 30,
    kittyKeyboard: mount.kittyKeyboard,
    stdout: output.stdout,
    stdin: input.stdin.stdin,
  });
  input.stdin.activate();
  return instance;
}

async function mountInlineFallback(appElement: AppElement, mount: TuiMount): Promise<void> {
  const { input } = mount;
  input.stdin = prepareInlineFallbackAfterFullscreenFailure({
    clearTerminalHandover: () => setActiveTerminalHandover(undefined),
    clearFilteredStdin: () => setActiveFilteredStdin(undefined),
    disableFilteredStdin: () => disableTuiInput(input),
    createInlineStdin: () => createFilteredStdin(process.stdin, { activate: false, mouse: false }),
  });
  const instance = renderInline(appElement, mount);
  unmountWhenSignalled(instance, mount.unmountSignal);
  try {
    await instance.waitUntilExit();
  } catch (err) {
    if (!isBrokenOutputError(err)) throw err;
  }
}

async function mountFullscreen(appElement: AppElement, mount: TuiMount): Promise<void> {
  const { output, input } = mount;
  const fullscreenStdin = input.stdin;
  let ink: ReturnType<typeof withFullScreen>;
  try {
    const fullscreenInk = withFullScreen(withInputTurns(appElement, fullscreenStdin), {
      exitOnCtrlC: false,
      kittyKeyboard: mount.kittyKeyboard,
      stdout: output.stdout,
      stdin: fullscreenStdin.stdin,
    });
    ink = fullscreenInk;
    await startFullscreenThenActivateHandover({
      start: () => fullscreenInk.start(),
      publishFilteredStdin: () => {
        setActiveFilteredStdin(fullscreenStdin);
      },
      activateFilteredStdin: () => {
        fullscreenStdin.activate();
      },
      handover: {
        fullscreen: true,
        mouse: input.modes.useMouse,
        hover: input.modes.useHover,
        sourceStdin: process.stdin,
        beforeSuspend: () => {
          output.suspend();
          input.selection?.suspend();
        },
        beforeResume: () => {
          output.resume();
          input.selection?.resume();
        },
        keyboardPush: output.keyboardPush,
      },
      setHandover: setActiveTerminalHandover,
    });
  } catch (err) {
    if (isBrokenOutputError(err)) return;
    warnError('Fullscreen init failed, falling back to inline mode', err);
    await mountInlineFallback(appElement, mount);
    return;
  }
  unmountWhenSignalled(ink.instance, mount.unmountSignal, input.selection?.suspend);
  try {
    await ink.waitUntilExit();
  } catch (err) {
    if (!isBrokenOutputError(err)) throw err;
  }
}

/** Mounts the app and settles once Ink exits. A fullscreen start that fails mounts it inline. */
export async function mountTui(appElement: AppElement, mount: TuiMount): Promise<void> {
  if (mount.fullscreen) {
    await mountFullscreen(appElement, mount);
    return;
  }
  const instance = renderInline(appElement, mount);
  unmountWhenSignalled(instance, mount.unmountSignal);
  await instance.waitUntilExit();
}
