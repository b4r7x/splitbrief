import type { Session } from '../../core/schemas/session.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { loadState } from '../../core/state/persistence.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { overlayStore } from '../ui/overlay.js';
import { feedbackStore } from '../ui/feedback.js';
import { routerStore } from './router.js';

export function handleSessionSelect(session: Session, projectDir: string) {
  if (session.status === 'interrupted') {
    let resumeState: WorkflowState | null;
    try {
      resumeState = loadState({ projectDir, sessionId: session.id });
    } catch (err) {
      feedbackStore.setError(`Cannot resume "${session.feature}": ${toErrorMessage(err)}`);
      return;
    }
    if (!resumeState) {
      feedbackStore.setError(
        `Cannot resume "${session.feature}": saved workflow state is missing or invalid`,
      );
      return;
    }
    overlayStore.close();
    routerStore.navigate({
      to: 'workflow',
      feature: resumeState.feature,
      resumeState,
      sessionId: session.id,
    });
    return;
  }
  if (session.summary) {
    overlayStore.close();
    routerStore.navigate({ to: 'summary', summary: session.summary, sessionId: session.id });
    return;
  }
  feedbackStore.setMessage(`Session "${session.feature}" failed without a summary to display`);
}
