import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';

function resolveKittyMode(): 'auto' | 'enabled' {
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  // These terminals support Kitty protocol but Ink's auto mode doesn't detect them
  if (termProgram === 'iTerm.app' || termProgram === 'zed') return 'enabled';
  return 'auto';
}

export async function renderApp(appElement: ReturnType<typeof createElement>, fullscreen: boolean): Promise<void> {
  const kittyKeyboard = { mode: resolveKittyMode(), flags: ['disambiguateEscapeCodes' as const] };

  if (fullscreen) {
    try {
      const ink = withFullScreen(appElement, { exitOnCtrlC: false, kittyKeyboard });
      await ink.start();
      await ink.waitUntilExit();
    } catch {
      render(appElement, { incrementalRendering: true, maxFps: 30, kittyKeyboard });
    }
  } else {
    render(appElement, { incrementalRendering: true, maxFps: 30, kittyKeyboard });
  }
}
