import { useInput } from 'ink';
import { readSessionFileConfined } from '../../core/sessions/confinement.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { focusStore } from '../../stores/ui/focus.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { useStores } from '../../stores/use-stores.js';
import { labelError } from '../../utils/format-errors.js';
import type { EditorLayout } from '../../core/editor/editor-state.js';

interface UseInlineEditTriggerOptions {
  isActive: boolean;
  sessionDirPath: string | undefined;
}

function editorLayout(): EditorLayout {
  const { cols, rows } = terminalSizeStore.get();
  return { columns: cols, rows };
}

async function openRawInline(
  filePath: string,
  ownerToken: number,
  layout: EditorLayout,
  sessionDirPath: string,
): Promise<void> {
  try {
    const value = await readSessionFileConfined(sessionDirPath, filePath);
    if (value === null) {
      feedbackStore.setError(`Cannot edit: file not found (${filePath})`);
      return;
    }
    if (reviewStore.get().ownerToken !== ownerToken) return;
    editorStore.openRaw({ filePath, value, ownerToken, layout });
    overlayStore.open('editor');
  } catch (err) {
    feedbackStore.setError(labelError('open editor', err));
  }
}

export function useInlineEditTrigger({ isActive, sessionDirPath }: UseInlineEditTriggerOptions) {
  const phase = lifecycleStore.use((s) => s.phase);
  const inReviewMode = controlsStore.use((c) => c.inputMode === 'review');
  const [overlay] = useStores(overlayStore);
  const isReviewPhase =
    phase === 'reviewing-spec' || phase === 'reviewing-plan' || phase === 'reviewing-briefs';
  const overlayOpen = overlay.active !== 'none';

  useInput(
    (input, key) => {
      if (!(key.ctrl && input === 'e')) return;
      if (sessionDirPath === undefined) return;
      const review = reviewStore.get();
      const ownerToken = review.ownerToken;
      const layout = editorLayout();
      if (phase === 'reviewing-briefs') {
        const focus = focusStore.get();
        if (focus === null || focus.region !== 'brief') return;
        // The field editor operates over the PARSED brief model, not a session file: open an
        // empty field session here and let BriefFieldEditor seed the buffer from the focused
        // Task via readField. task.file is a repo path, not a session artifact, so no confined
        // read happens on this surface (CON-C).
        editorStore.openField({ filePath: null, value: '', ownerToken, layout });
        return;
      }
      const filePath = review.filePath;
      if (filePath === null) return;
      void openRawInline(filePath, ownerToken, layout, sessionDirPath);
    },
    { isActive: isActive && inReviewMode && isReviewPhase && !overlayOpen && !overlay.exclusive },
  );
}
