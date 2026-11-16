import { useEffect } from 'react';
import { getActiveFilteredStdin } from '../lib/terminal/filtered-stdin/active.js';
import type {
  FilteredStdin,
  MouseAction,
  MouseEvent,
} from '../lib/terminal/filtered-stdin/types.js';
import { clickAt, hitTopmostZone } from '../lib/terminal/mouse-zones.js';
import { ROW_ZONE_Z_OVERLAY } from '../components/pickers/row-zone.js';
import { routerStore } from '../stores/navigation/router.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { editorStore } from '../stores/ui/editor.js';
import {
  clearWorkflowHover,
  handleWorkflowMouseMove,
  handleWorkflowMousePress,
  handleWorkflowPromptMousePress,
} from '../features/workflow/hooks/use-mouse-pointer.js';
import {
  handleWorkflowMouseWheel,
  modalPromptOwnsInput,
  promptOwnsInput,
} from '../features/workflow/hooks/use-mouse-scroll.js';

// A click is read against the frame on screen and acts on what it showed, or on nothing. A wheel
// step and a move act at their turn on the state that the input before them left.
export function wireAppMouse(filteredStdin: FilteredStdin): () => void {
  return filteredStdin.onMouse((event) => {
    if (event.type === 'wheel-up' || event.type === 'wheel-down') return () => handleWheel(event);
    if (event.type === 'move') return () => handleMove(event);
    if (event.type === 'press') return readPress(event);
    return undefined;
  });
}

export function useAppMouse(): void {
  useEffect(() => {
    const filteredStdin = getActiveFilteredStdin();
    if (!filteredStdin) return;
    return wireAppMouse(filteredStdin);
  }, []);
}

const WHEEL_STEP = 1;

// A scroll of the editor or of the run screen only writes a store, so the wheel step behind it can
// share its turn. A list row of an overlay runs a handler of its last render, so it cannot.
function handleWheel(event: MouseEvent): boolean {
  if (overlayStore.get().active === 'editor') {
    editorStore.scrollBy(event.type === 'wheel-up' ? -WHEEL_STEP : WHEEL_STEP);
    return true;
  }
  if (overlayStore.get().active !== 'none') {
    hitTopmostZone(event.x, event.y, { minZ: ROW_ZONE_Z_OVERLAY })?.onWheel?.(
      event.type === 'wheel-up' ? 'up' : 'down',
    );
    return false;
  }
  if (routerStore.get().screen !== 'workflow') return false;
  if (modalPromptOwnsInput()) return false;
  handleWorkflowMouseWheel(event);
  return true;
}

function handleMove(event: MouseEvent): void {
  if (
    overlayStore.get().active !== 'none' ||
    routerStore.get().screen !== 'workflow' ||
    promptOwnsInput()
  ) {
    clearWorkflowHover();
    return;
  }
  handleWorkflowMouseMove(event);
}

function readPress(event: MouseEvent): MouseAction | undefined {
  if (overlayStore.get().active !== 'none') {
    return clickAt(event.x, event.y, { minZ: ROW_ZONE_Z_OVERLAY });
  }
  if (routerStore.get().screen !== 'workflow') return clickAt(event.x, event.y);
  if (promptOwnsInput()) return handleWorkflowPromptMousePress(event);
  return handleWorkflowMousePress(event);
}
