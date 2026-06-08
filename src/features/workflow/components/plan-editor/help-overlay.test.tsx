import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PlanEditorHelpOverlay', () => {
  it('documents flag and regenerate keys implemented by handlePlanEditorInput', () => {
    const source = readFileSync(join(import.meta.dirname, 'help-overlay.tsx'), 'utf-8');
    expect(source).toContain("['x',");
    expect(source).toContain("['R',");
  });
});
