import type { TerminalHandoverConfig } from '../../lib/terminal/editor-handover.js';

export async function startFullscreenThenActivateHandover(deps: {
  start: () => Promise<void>;
  publishFilteredStdin?: (() => void) | undefined;
  activateFilteredStdin?: (() => void) | undefined;
  handover: TerminalHandoverConfig;
  setHandover: (config: TerminalHandoverConfig | undefined) => void;
}): Promise<void> {
  deps.publishFilteredStdin?.();
  await deps.start();
  deps.activateFilteredStdin?.();
  deps.setHandover(deps.handover);
}

export function prepareInlineFallbackAfterFullscreenFailure(deps: {
  sourceStdin: NodeJS.ReadStream;
  clearTerminalHandover: () => void;
  clearFilteredStdin: () => void;
  disableFilteredStdin: () => void;
}): NodeJS.ReadStream {
  deps.clearTerminalHandover();
  deps.clearFilteredStdin();
  deps.disableFilteredStdin();
  return deps.sourceStdin;
}
