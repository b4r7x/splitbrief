import type { TerminalHandoverConfig } from '../../lib/terminal/editor-handover.js';
import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';

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
