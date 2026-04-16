import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { warnError } from '../utils/warn.js';
import { createFilteredStdin, type FilteredStdin } from '../utils/mouse.js';
import { wireWorkflowMouseScroll } from './mouse-scroll.js';

interface RenderOptions {
  fullscreen: boolean;
  mouse?: boolean;
}

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
): Promise<void> {
  const { fullscreen, mouse } = options;
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  const kittyMode: 'auto' | 'enabled' =
    termProgram === 'iTerm.app' || termProgram === 'zed' ? 'enabled' : 'auto';
  const kittyKeyboard = { mode: kittyMode, flags: ['disambiguateEscapeCodes' as const] };

  const useMouse = mouse !== false && fullscreen;
  let filteredStdin: FilteredStdin | undefined;
  let unsubMouse: (() => void) | undefined;

  if (useMouse) {
    filteredStdin = createFilteredStdin(process.stdin);
    unsubMouse = wireWorkflowMouseScroll(filteredStdin);
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
    unsubMouse?.();
    filteredStdin?.disable();
  }
}
