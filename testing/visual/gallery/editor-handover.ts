import { mountShowDiffEditor } from '../../helpers/show-diff-editor.js';
import { scenarioId, type ScenarioId } from '../contracts/identifiers.js';
import { waitForCheckpoint } from './checkpoints.js';
import type { GalleryCaptureHandle, MountGalleryScenarioOptions } from './mount.js';

type Editor = Parameters<typeof mountShowDiffEditor>[0]['editor'];

export const editorHandoverScenarios: ReadonlyMap<ScenarioId, Editor> = new Map([
  [scenarioId('workflow-external-editor'), 'cursor'],
  [scenarioId('workflow-external-editor-macos'), 'open'],
]);

export async function mountEditorHandover(
  options: MountGalleryScenarioOptions,
  launcher: Editor,
  restoreEnvironment: () => void,
): Promise<GalleryCaptureHandle> {
  const editor = await mountShowDiffEditor({
    editor: launcher,
    exitCode: 0,
    fullscreen: true,
    viewport: options.viewport,
  });
  const unmount = async () => {
    try {
      await editor.unmount();
    } finally {
      restoreEnvironment();
    }
  };
  try {
    await editor.openDiff();
    await editor.waitForText(options.checkpoint.marker);
    await editor.waitForRedraw();
    if (!editor.editorStarted() || editor.didExit()) {
      throw new Error('The gallery editor did not remain open');
    }
  } catch (error) {
    await unmount();
    throw error;
  }
  return {
    ...options,
    stdin: { write: editor.child.write },
    lastFrame: editor.screen,
    frameHistory: () => [...editor.frames],
    waitForCheckpoint: async (waitOptions = {}) => {
      try {
        return await waitForCheckpoint({
          ...options,
          ...waitOptions,
          lastFrame: editor.screen,
        });
      } catch (error) {
        await unmount();
        throw error;
      }
    },
    unmount,
  };
}
