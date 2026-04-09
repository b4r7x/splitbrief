import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlannerTool, SkillMeta } from '../types.js';
import { skillsStore } from './skills.js';

const discoverSkillsMock = vi.fn<(tool: PlannerTool, projectDir: string) => Promise<SkillMeta[]>>();

const makeSkill = (overrides?: Partial<SkillMeta>): SkillMeta => ({
  id: 'review',
  name: 'review',
  description: 'Review skill',
  path: '/tmp/skills/review.md',
  scope: 'project',
  ...overrides,
});

describe('skillsStore', () => {
  beforeEach(() => {
    discoverSkillsMock.mockReset();
    skillsStore.reset();
  });

  it('starts with empty available list and no selection', () => {
    const s = skillsStore.get();
    expect(s.available).toEqual([]);
    expect(s.selected.size).toBe(0);
  });

  it('discover() populates available skills via the resolver', async () => {
    const skills = [makeSkill({ id: 'a' }), makeSkill({ id: 'b' })];
    discoverSkillsMock.mockResolvedValue(skills);

    await skillsStore.discover(discoverSkillsMock, 'claude-code' as PlannerTool, '/tmp/proj');

    expect(discoverSkillsMock).toHaveBeenCalledWith('claude-code', '/tmp/proj');
    expect(skillsStore.get().available).toBe(skills);
  });

  it('discover() preserves existing selection', async () => {
    discoverSkillsMock.mockResolvedValue([makeSkill({ id: 'keep' })]);
    skillsStore.setSelected(new Set(['keep']));
    await skillsStore.discover(discoverSkillsMock, 'claude-code' as PlannerTool, '/tmp/proj');

    expect(skillsStore.get().selected.has('keep')).toBe(true);
  });

  it('setSelected() replaces the current selection set', () => {
    skillsStore.setSelected(new Set(['a', 'b']));
    expect(skillsStore.get().selected).toEqual(new Set(['a', 'b']));

    skillsStore.setSelected(new Set(['c']));
    expect(skillsStore.get().selected).toEqual(new Set(['c']));
  });

  it('reset() clears available and selection back to initial', async () => {
    discoverSkillsMock.mockResolvedValue([makeSkill()]);
    await skillsStore.discover(discoverSkillsMock, 'claude-code' as PlannerTool, '/tmp');
    skillsStore.setSelected(new Set(['review']));

    skillsStore.reset();

    const s = skillsStore.get();
    expect(s.available).toEqual([]);
    expect(s.selected.size).toBe(0);
  });
});
