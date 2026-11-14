import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { parseSkillIdsOption } from './skills.js';
import { parseWorkflowOptions } from '#testing/helpers/workflow-options.js';

describe('parseSkillIdsOption', () => {
  it("--skills a,b parses to ['a','b']", () => {
    expect(parseSkillIdsOption('a,b')).toEqual(['a', 'b']);
    expect(parseSkillIdsOption(' a , b ')).toEqual(['a', 'b']);
  });

  it('rejects a list that names nothing', () => {
    expect(() => parseSkillIdsOption(' , ')).toThrow(InvalidArgumentError);
  });

  it('registers --skills on the workflow options', () => {
    expect(parseWorkflowOptions(['--skills', 'a,b'])).toMatchObject({ skills: ['a', 'b'] });
  });
});
