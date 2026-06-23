import { describe, it, expect } from 'vitest';
import { getPlanEditorHelpRows } from './footer.js';

describe('PlanEditorHelpOverlay', () => {
  it('documents plan editor keys from the contextual footer binding source', () => {
    const rows = getPlanEditorHelpRows();

    expect(rows).toContainEqual({ context: 'Tasks', key: 'E', label: 'raw edit' });
    expect(rows).toContainEqual({ context: 'Tasks', key: 'c', label: 'copy' });
    expect(rows).toContainEqual({ context: 'Sections', key: 'j/k', label: 'section' });
    expect(rows).toContainEqual({ context: 'Sections', key: 'e', label: 'edit section' });
    expect(rows).toContainEqual({ context: 'Sections', key: 'c', label: 'copy section' });
    expect(rows).toContainEqual({ context: 'Editing', key: 'Ctrl+Enter', label: 'save field' });
    expect(rows).toContainEqual({ context: 'Tasks', key: 'Y', label: 'approve checks' });
    expect(rows).toContainEqual({ context: 'Regen', key: 'enter', label: 'regen flagged' });
  });
});
