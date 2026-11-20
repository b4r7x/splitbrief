import { expect, it } from 'vitest';
import { findVisualScenario } from './catalog.js';
import { viewport } from './contracts/geometry.js';
import { mountGalleryScenario } from './gallery/mount.js';

it.each([
  {
    id: 'workflow-external-editor',
    message: 'run.patch open in cursor. Close the file to finish viewing.',
    keepsMenu: true,
  },
  {
    id: 'workflow-external-editor-macos',
    message: 'run.patch open in open. Quit the editor app to finish viewing.',
    keepsMenu: true,
  },
  {
    id: 'workflow-external-pager',
    message: 'run.patch open in less. Press q to return.',
    keepsMenu: false,
  },
])('captures the production Show diff handover for $id', async ({ id, message, keepsMenu }) => {
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
    const frame = await handle.waitForCheckpoint();
    expect(frame).toContain(message);
    expect(frame.includes('Ready to apply')).toBe(keepsMenu);
    expect(frame).not.toContain('Offline Show diff test');
  } finally {
    await handle.unmount();
  }
});
