import type { Session } from '../../types.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { feedbackStore } from '../../stores/ui/feedback.js';

export function handleSelect(session: Session) {
  if (session.status === 'interrupted') {
    overlayStore.close();
    routerStore.navigate({ to: 'workflow', feature: session.feature });
    return;
  }
  if (session.summary) {
    overlayStore.close();
    routerStore.navigate({ to: 'summary', summary: session.summary });
    return;
  }
  feedbackStore.setMessage(`Session "${session.feature}" failed without a summary to display`);
}
