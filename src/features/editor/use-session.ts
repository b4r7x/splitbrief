import { useState } from 'react';
import { basename, dirname } from 'node:path';
import { parsePlanJson } from '../../core/sessions/plan-file.js';
import { writeSpecFile } from '../../core/sessions/spec-files.js';
import { blocksPlan, checkPlan } from '../../engine/spec/plan/checks.js';
import { confinedExists } from '../../lib/fs/confined.js';
import { pathConfinementError } from '../../lib/fs/confinement.js';
import { configStore } from '../../stores/project/config.js';
import { editorStore } from '../../stores/ui/editor.js';
import { externalEditRequestStore } from '../../stores/ui/external-edit-request.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { labelError } from '../../utils/format/errors.js';

/**
 * Why an edited plan.json cannot be saved, or nothing when it can. The context fit needs the
 * BUILD model and the files on disk, so the engine checks it after the save; every other check
 * runs here, through the same functions. The edit is made at the plan card, so the user approves
 * the plan and its npm scripts.
 */
function planSaveErrors(text: string, projectDir: string): readonly string[] {
  const parsed = parsePlanJson(text);
  if ('errors' in parsed) return parsed.errors;
  return checkPlan(parsed.plan, projectDir, new Map(), undefined, true)
    .filter(blocksPlan)
    .map((error) => error.message);
}

function saveRefusal(errors: readonly string[]): string {
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  return `Not saved: ${errors[0]}${more}`;
}

export function usePlanEditorSession() {
  const projectDir = configStore.use((s) => s.projectDir);
  const [refusal, setRefusal] = useState<string | null>(null);

  const writeBuffer = (filePath: string, value: string): boolean => {
    const sessionId = basename(dirname(filePath));
    try {
      writeSpecFile({ projectDir, sessionId }, basename(filePath), value, null);
      return true;
    } catch (err) {
      setRefusal(labelError('Not saved', err));
      return false;
    }
  };

  const onSave = () => {
    const state = editorStore.get();
    if (
      state.status !== 'open' ||
      state.filePath === null ||
      reviewStore.get().ownerToken !== state.ownerToken
    ) {
      overlayStore.close();
      return;
    }
    if (!confinedExists(projectDir, '.')) {
      setRefusal(labelError('Not saved', pathConfinementError.rootMissing(projectDir)));
      return;
    }
    const errors = planSaveErrors(state.value, projectDir);
    if (errors.length > 0) {
      setRefusal(saveRefusal(errors));
      return;
    }
    if (!writeBuffer(state.filePath, state.value)) return;
    const fileName = basename(state.filePath);
    overlayStore.close();
    // plan.md is rendered from plan.json: the engine checks the context fit and compiles it.
    editorStore.close();
    feedbackStore.setInfo(`Saved ${fileName} — applying changes`);
    externalEditRequestStore.requestApply(state.ownerToken);
  };

  const onCancel = () => {
    overlayStore.close();
  };

  const onOpenExternal = () => {
    const state = editorStore.get();
    if (state.status !== 'open') return;
    const token = state.ownerToken;
    if (state.filePath !== null && reviewStore.get().ownerToken === token) {
      if (!writeBuffer(state.filePath, state.value)) return;
    }
    overlayStore.close();
    editorStore.close();
    externalEditRequestStore.request(token, state.opened);
  };

  return { refusal, onSave, onCancel, onOpenExternal };
}
