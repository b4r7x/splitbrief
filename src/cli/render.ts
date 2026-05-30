import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { warnError } from '../lib/warn.js';
import {
  createFilteredStdin,
  type FilteredStdin,
  setActiveFilteredStdin,
} from '../lib/terminal/mouse.js';
import { detectKittyKeyboardFlags } from '../lib/terminal/kitty-keyboard.js';

interface RenderOptions {
  fullscreen: boolean;
  mouse?: boolean;
}

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
): Promise<void> {
  const { fullscreen, mouse } = options;
  const kittyKeyboard = detectKittyKeyboardFlags();

  const useMouse = mouse !== false && fullscreen;
  let filteredStdin: FilteredStdin | undefined;

  if (useMouse) {
    filteredStdin = createFilteredStdin(process.stdin);
    setActiveFilteredStdin(filteredStdin);
  }

  const renderFallback = () => {
    const inkStdin = filteredStdin?.stdin;
    return render(appElement, {
      incrementalRendering: true,
      maxFps: 30,
      kittyKeyboard,
      ...(inkStdin ? { stdin: inkStdin } : {}),
    });
  };

  try {
    if (fullscreen) {
      try {
        const inkStdin = filteredStdin?.stdin;
        const ink = withFullScreen(appElement, {
          exitOnCtrlC: false,
          kittyKeyboard,
          ...(inkStdin ? { stdin: inkStdin } : {}),
        });
        await ink.start();
        await ink.waitUntilExit();
      } catch (err) {
        warnError('Fullscreen init failed, falling back to inline mode', err);
        const inst = renderFallback();
        await inst.waitUntilExit();
      }
    } else {
      const inst = renderFallback();
      await inst.waitUntilExit();
    }
  } finally {
    setActiveFilteredStdin(undefined);
    filteredStdin?.disable();
  }
}
