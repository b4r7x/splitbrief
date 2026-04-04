import { describe, it, expect, beforeEach, vi } from 'vitest';
import { skillsStore } from './skills.js';
import type { SkillMeta } from '../types.js';

const fakeSkills: SkillMeta[] = [
  { id: 'a', name: 'Skill A', description: 'desc', path: '/a', scope: 'project' },
  { id: 'b', name: 'Skill B', description: 'desc', path: '/b', scope: 'global' },
];

vi.mock('../engine/skills.js', () => ({
  discoverSkills: vi.fn(() => fakeSkills),
}));

describe('skillsStore', () => {
  beforeEach(() => skillsStore.reset());

  it('starts empty', () => {
    expect(skillsStore.get().available).toHaveLength(0);
    expect(skillsStore.get().selected.size).toBe(0);
  });

  it('discovers skills', () => {
    skillsStore.discover('claude-code', '/tmp');
    expect(skillsStore.get().available).toEqual(fakeSkills);
  });

  it('sets selected', () => {
    skillsStore.discover('claude-code', '/tmp');
    skillsStore.setSelected(new Set(['b']));
    const { available, selected } = skillsStore.get();
    expect(selected.has('b')).toBe(true);
    expect(available.filter(s => selected.has(s.id))).toEqual([fakeSkills[1]]);
  });

  it('clears selection', () => {
    skillsStore.discover('claude-code', '/tmp');
    skillsStore.setSelected(new Set(['a']));
    skillsStore.setSelected(new Set());
    expect(skillsStore.get().selected.size).toBe(0);
  });
});
