import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { warnError } from '../utils/warn.js';

export async function renderApp(appElement: ReturnType<typeof createElement>, fullscreen: boolean): Promise<void> {
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  // These terminals support Kitty protocol but Ink's auto mode doesn't detect them
  const kittyMode: 'auto' | 'enabled' =
    termProgram === 'iTerm.app' || termProgram === 'zed' ? 'enabled' : 'auto';
  const kittyKeyboard = { mode: kittyMode, flags: ['disambiguateEscapeCodes' as const] };

  const renderFallback = () => render(appElement, { incrementalRendering: true, maxFps: 30, kittyKeyboard });

  if (fullscreen) {
    try {
      const ink = withFullScreen(appElement, { exitOnCtrlC: false, kittyKeyboard });
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
}
