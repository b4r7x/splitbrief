import { useLayoutEffect, useState } from 'react';
import { draftLength } from '../../../core/composer/document.js';
import { composerDraftStore } from '../../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';

// A panel above the composer takes the keys when it opens, unless the user is typing: then a
// letter or ⏎ meant for the draft would choose one of its rows. `open` says that the panel exists,
// painted or not: a panel below an overlay stays open and keeps its focus. The draft the composer
// holds as the panel opens decides the first owner, read after the composer published it, so a
// panel that opens over a draft leaves the keys there. A draft put back in the composer decides the
// owner only when a key gets its first owner. On a key that has an owner only an explicit hand-off
// moves the keys, and a close or a new key settles the owner again.
export function usePanelFocus(key: string, open: boolean) {
  const empty = composerLiveStore.use((state) => state.empty);
  const restoring = composerDraftStore.use(
    (state) => state.request?.kind === 'prepend' && draftLength(state.request.document) > 0,
  );
  const [focus, setFocus] = useState<{ key: string; menu: boolean } | null>(null);
  useLayoutEffect(() => {
    setFocus((previous) => {
      if (!open) return null;
      if (previous?.key === key) return previous;
      return { key, menu: composerLiveStore.get().empty && !restoring };
    });
  }, [key, open, restoring]);
  const focused = open && (focus?.key === key ? focus.menu : empty);
  return { focused, setMenu: (menu: boolean) => setFocus({ key, menu }) };
}
