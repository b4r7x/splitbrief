import type { Session } from '../../core/schemas/session.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { loadState } from '../../core/state/persistence.js';
import { isResumable } from '../../core/phases.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { createStore, storeBase } from '../create-store.js';
import { overlayStore } from '../ui/overlay.js';
import { routerStore } from './router.js';

interface SessionSelectState {
  error: string | null;
}

const initial: SessionSelectState = { error: null };
const store = createStore<SessionSelectState>(initial);

function setSelectionError(error: string) {
  store.set({ error });
}

function clearSelectionError() {
  store.set((state) => (state.error === null ? state : initial));
}

export const sessionSelectStore = {
  ...storeBase(store),
  clearError: clearSelectionError,
};

function openSummary(session: Session, summary: Summary) {
  clearSelectionError();
  overlayStore.close();
  routerStore.navigate({
    to: 'summary',
    summary,
    sessionId: session.id,
    status: session.status,
  });
}

export function handleSessionSelect(session: Session, projectDir: string) {
  const feature = sanitizeTerminalDisplayText(session.feature);
  if (session.status === 'interrupted') {
    let resumeState: WorkflowState | null;
    let resumeError: string | null = null;
    try {
      resumeState = loadState({ projectDir, sessionId: session.id });
    } catch (err) {
      resumeState = null;
      resumeError = `Cannot resume "${feature}": ${toErrorMessage(err)}`;
    }

    if (resumeState && isResumable(resumeState)) {
      clearSelectionError();
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
      openSummary(session, session.summary);
      return;
    }

    if (resumeError) {
      setSelectionError(resumeError);
      return;
    }

    if (!resumeState) {
      setSelectionError('Cannot resume: saved workflow state is missing or invalid');
      return;
    }

    setSelectionError(
      `Cannot resume "${feature}": interrupted before it made progress — start it again.`,
    );
    return;
  }
  if (session.summary) {
    openSummary(session, session.summary);
    return;
  }
  setSelectionError(`Session "${feature}" failed without a summary to display`);
}
