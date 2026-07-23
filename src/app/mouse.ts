import { useEffect } from 'react';
import { getActiveFilteredStdin } from '../lib/terminal/filtered-stdin/active.js';
import type { FilteredStdin, MouseEvent } from '../lib/terminal/filtered-stdin/types.js';
import { hitTopmostZone } from '../lib/terminal/mouse-zones.js';
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
  promptOwnsInput,
} from '../features/workflow/hooks/use-mouse-scroll.js';

export function wireAppMouse(filteredStdin: FilteredStdin): () => void {
  return filteredStdin.onMouse((event) => {
    if (event.type === 'wheel-up' || event.type === 'wheel-down') {
      handleWheel(event);
      return;
    }

    if (overlayStore.get().active !== 'none') {
      handleOverlayMouse(event);
      return;
    }

    if (routerStore.get().screen !== 'workflow') {
      handleNonWorkflowMouse(event);
      return;
    }

    if (promptOwnsInput()) {
      handlePromptMouse(event);
      return;
    }

    if (fieldSessionOwnsInput()) {
      if (event.type === 'move') clearWorkflowHover();
      return;
    }

    handleWorkflowPointer(event);
  });
}

function fieldSessionOwnsInput(): boolean {
  const editor = editorStore.get();
  return editor.status === 'open' && editor.surface === 'field';
}

export function useAppMouse(): void {
  useEffect(() => {
    const filteredStdin = getActiveFilteredStdin();
    if (!filteredStdin) return;
    return wireAppMouse(filteredStdin);
  }, []);
}

const WHEEL_STEP = 1;

function handleWheel(event: MouseEvent): void {
  if (overlayStore.get().active === 'editor') {
    editorStore.scrollBy(event.type === 'wheel-up' ? -WHEEL_STEP : WHEEL_STEP);
    return;
  }
  if (routerStore.get().screen !== 'workflow') return;
  if (overlayStore.get().active !== 'none') return;
  if (promptOwnsInput()) return;
  if (fieldSessionOwnsInput()) return;
  handleWorkflowMouseWheel(event);
}

function handleOverlayMouse(event: MouseEvent): void {
  if (event.type === 'press') {
    hitTopmostZone(event.x, event.y, { minZ: ROW_ZONE_Z_OVERLAY })?.onClick?.();
  } else if (event.type === 'move') {
    clearWorkflowHover();
  }
}

function handleNonWorkflowMouse(event: MouseEvent): void {
  if (event.type === 'press') {
    hitTopmostZone(event.x, event.y)?.onClick?.();
  } else if (event.type === 'move') {
    clearWorkflowHover();
  }
}

function handlePromptMouse(event: MouseEvent): void {
  if (event.type === 'press') {
    handleWorkflowPromptMousePress(event);
  } else if (event.type === 'move') {
    clearWorkflowHover();
  }
}

function handleWorkflowPointer(event: MouseEvent): void {
  if (event.type === 'move') {
    handleWorkflowMouseMove(event);
    return;
  }
  if (event.type === 'press') handleWorkflowMousePress(event);
}
