import type { RunRecord } from '../../../core/sessions/run-record.js';
import { writeRunPatch } from '../../../engine/orchestrator/apply/patch.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { labelError } from '../../../utils/format-errors.js';
import { editorDisplayLabel, resolveViewerArgv } from '../editor-command.js';
import { runEditor, spawnEditorProcess, type SpawnEditor } from '../review-parser.js';

export async function showRunDiff(
  record: RunRecord,
  spawnEditor: SpawnEditor = spawnEditorProcess,
): Promise<void> {
  const state = record.hydration.kind === 'loaded' ? record.hydration.state : null;
  const workspace = state?.workspace;
  if (workspace === undefined || workspace.kind === 'checkout') {
    feedbackStore.setError('No run workspace to diff.');
    return;
  }
  try {
    const path = await writeRunPatch(record.ref, workspace);
    if (path === null) {
      feedbackStore.setMessage('No run changes to show.');
      return;
    }
    const viewer = resolveViewerArgv();
    const { code, signal } = await runEditor({ ...viewer, filePath: path, spawnEditor });
    if (code !== 0 || signal !== null) {
      feedbackStore.setError(
        `${editorDisplayLabel(viewer.command)} exited with ${signal ?? `code ${code}`}`,
      );
    }
  } catch (err) {
    feedbackStore.setError(labelError('show diff', err));
  }
}
