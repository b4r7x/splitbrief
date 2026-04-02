import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('SkillsPicker', () => {
  it('exports a named SkillsPicker component', async () => {
    const mod = await import('../src/ui/skills-picker.js');
    assert.equal(typeof mod.SkillsPicker, 'function');
  });

  it('does not export filterSkills (internal helper)', async () => {
    const mod = await import('../src/ui/skills-picker.js');
    assert.equal((mod as Record<string, unknown>).filterSkills, undefined);
  });
});
