import type { RunRecord } from '../../../core/sessions/run-record.js';
import { writeRunPatch } from '../../../engine/orchestrator/apply/patch.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { labelError } from '../../../utils/format-errors.js';
import { resolveEditorArgv } from '../editor-command.js';
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
    const { command, args } = resolveEditorArgv();
    const { code, signal } = await runEditor({ command, args, filePath: path, spawnEditor });
    if (code !== 0 || signal !== null) {
      feedbackStore.setError(`Editor exited with ${signal ?? `code ${code}`}`);
    }
  } catch (err) {
    feedbackStore.setError(labelError('show diff', err));
  }
}
