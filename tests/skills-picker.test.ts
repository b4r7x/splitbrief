import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterSkills } from '../src/ui/skills-picker.js';
import type { SkillMeta } from '../src/types.js';

const skill = (id: string, name: string, desc: string, scope: 'global' | 'project' = 'global'): SkillMeta => ({
  id, name, description: desc, path: `/fake/${id}.md`, scope,
});

describe('filterSkills', () => {
  const skills: SkillMeta[] = [
    skill('a', 'auth-helper', 'Authentication utilities'),
    skill('b', 'db-migrate', 'Database migration tool'),
    skill('c', 'lint-rules', 'Custom ESLint rules'),
  ];

  it('returns all skills when filter is empty', () => {
    assert.deepStrictEqual(filterSkills(skills, ''), skills);
  });

  it('filters by name (case-insensitive)', () => {
    const result = filterSkills(skills, 'AUTH');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'a');
  });

  it('filters by description', () => {
    const result = filterSkills(skills, 'migration');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'b');
  });

  it('returns empty array when nothing matches', () => {
    assert.deepStrictEqual(filterSkills(skills, 'zzz'), []);
  });

  it('matches partial strings', () => {
    const result = filterSkills(skills, 'lint');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'c');
  });
});
