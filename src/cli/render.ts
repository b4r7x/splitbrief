import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { warnError } from '../utils/warn.js';
import { enableMouseTracking, disableMouseTracking, type FilteredStdin } from '../utils/mouse.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { clickableRegionsStore } from '../stores/clickable-regions.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import { workflowStore } from '../stores/workflow.js';
import { getChromeHeight } from '../core/layout-constants.js';
import { estimateSectionHeight } from '../components/conversation-flow/section-heights.js';
import type { DynamicSection } from '../components/conversation-flow/viewport-trimming.js';

interface RenderOptions {
  fullscreen: boolean;
  mouse?: boolean;
}

const WHEEL_STEP = 1;

function wireMouseEvents(filteredStdin: FilteredStdin): () => void {
  return filteredStdin.onMouse(ev => {
    if (ev.type === 'wheel-up' || ev.type === 'wheel-down') {
      const { rows, cols } = terminalSizeStore.get();
      const viewportHeight = Math.max(0, rows - getChromeHeight());
      const events = workflowStore.get().events;
      const sections = workflowStore.get().sections;
      const expandedDiffs = conversationScrollStore.get().expandedDiffs;
      const dynamicSections = sections.filter((s): s is DynamicSection => s.type !== 'completed-task');
      const totalHeight = dynamicSections.reduce(
        (sum, s) => sum + estimateSectionHeight(s, expandedDiffs, cols), 0,
      );
      const maxOffset = Math.max(0, totalHeight - viewportHeight + 1);

      if (ev.type === 'wheel-up') {
        conversationScrollStore.scrollUp(maxOffset, events.length, WHEEL_STEP, totalHeight);
      } else {
        conversationScrollStore.scrollDown(WHEEL_STEP);
      }
    } else if (ev.type === 'click') {
      clickableRegionsStore.hitTest(ev.x, ev.y);
    }
  });
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
    filteredStdin = enableMouseTracking(process.stdin as NodeJS.ReadStream);
    unsubMouse = wireMouseEvents(filteredStdin);
  }

  const renderFallback = () => render(appElement, {
    incrementalRendering: true,
    maxFps: 30,
    kittyKeyboard,
    ...(filteredStdin ? { stdin: filteredStdin as unknown as NodeJS.ReadStream } : {}),
  });

  try {
    if (fullscreen) {
      try {
        const ink = withFullScreen(appElement, {
          exitOnCtrlC: false,
          kittyKeyboard,
          ...(filteredStdin ? { stdin: filteredStdin as unknown as NodeJS.ReadStream } : {}),
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
    disableMouseTracking();
  }
}
