import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';

export async function renderApp(appElement: ReturnType<typeof createElement>, fullscreen: boolean): Promise<void> {
  if (fullscreen) {
    try {
      const ink = withFullScreen(appElement, { exitOnCtrlC: false });
      await ink.start();
      await ink.waitUntilExit();
    } catch {
      render(appElement, { incrementalRendering: true, maxFps: 30 });
    }
  } else {
    render(appElement, { incrementalRendering: true, maxFps: 30 });
  }
}
