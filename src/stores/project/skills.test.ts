import { beforeEach, describe, expect, it } from 'vitest';
import { skillsStore } from './skills.js';
import type { SkillMeta } from '../../core/skills/types.js';

const skills: SkillMeta[] = [
  {
    id: 'review',
    name: 'Review',
    description: 'Review code',
    path: '/tmp/review/SKILL.md',
    scope: 'project',
  },
  {
    id: 'test',
    name: 'Test',
    description: 'Test code',
    path: '/tmp/test/SKILL.md',
    scope: 'global',
  },
];

describe('skillsStore', () => {
  beforeEach(() => {
    skillsStore.reset();
  });

  it('clones selected skill ids on ingress', () => {
    const selected = new Set(['review']);
    skillsStore.setSelected(selected);

    selected.add('test');

    expect([...skillsStore.get().selected]).toEqual(['review']);
  });

  it('clones available skills on ingress and prunes unavailable selections', () => {
    skillsStore.setSelected(new Set(['review', 'missing']));
    skillsStore.setAvailable(skills);

    skills[0]!.name = 'Mutated';

    expect(skillsStore.get().available[0]?.name).toBe('Review');
    expect([...skillsStore.get().selected]).toEqual(['review']);
  });
});
