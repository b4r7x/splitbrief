import { expect, it } from 'vitest';
import { findVisualScenario } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { mountGalleryScenario } from './gallery/mount.js';

it.each([
  {
    id: 'workflow-external-editor',
    message: 'run.patch open in cursor. Close the file to return.',
  },
  {
    id: 'workflow-external-editor-macos',
    message: 'run.patch open in open. Quit the editor app to return.',
  },
  {
    id: 'workflow-external-pager',
    message: 'run.patch open in less. Press q to return.',
  },
])('captures the production Show diff handover for $id', async ({ id, message }) => {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined) throw new Error(`Missing checkpoint for ${id}`);
  const handle = await mountGalleryScenario({
    scenario,
    checkpoint,
    viewport: viewport({ cols: 80, rows: 24 }),
  });
  try {
    expect(handle.frameHistory().some((frame) => frame.includes('Ready to apply'))).toBe(true);
    expect(await handle.waitForCheckpoint()).toContain(message);
    expect(handle.lastFrame()).not.toContain('Ready to apply');
    expect(handle.lastFrame()).not.toContain('Offline Show diff test');
  } finally {
    await handle.unmount();
  }
});
