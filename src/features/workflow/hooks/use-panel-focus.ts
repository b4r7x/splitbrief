import { useLayoutEffect, useState } from 'react';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';

// A panel above the composer takes the keys when it opens, unless the user is typing: then a
// letter or ⏎ meant for the draft would choose one of its rows. `open` says that the panel exists,
// painted or not: a panel below an overlay stays open and keeps its focus.
export function usePanelFocus(key: string, open: boolean) {
  const [focus, setFocus] = useState<{ key: string; menu: boolean } | null>(null);
  useLayoutEffect(() => {
    const menu = composerLiveStore.get().empty;
    setFocus((previous) => {
      if (!open) return null;
      return previous?.key === key ? previous : { key, menu };
    });
  }, [key, open]);
  const focused = open && (focus?.key === key ? focus.menu : composerLiveStore.get().empty);
  return { focused, setMenu: (menu: boolean) => setFocus({ key, menu }) };
}
