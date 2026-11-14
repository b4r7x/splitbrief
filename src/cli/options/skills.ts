import { InvalidArgumentError } from 'commander';
import {
  PROJECT_SKILL_SCAN_PATH_LABELS,
  GLOBAL_SKILL_SCAN_PATH_LABELS,
} from '../../core/skills/scan-paths.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { discoverSkills } from '../../engine/skills/discover.js';
import { cliError } from '../errors.js';

export function parseSkillIdsOption(value: string): string[] {
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) {
    throw new InvalidArgumentError(`'${value}' names no skill ids.`);
  }
  return ids;
}

/**
 * `--skills` names ids, and an id that no scan root carries would otherwise
 * reach the planner as silence. Resolved before preparation so the run fails
 * with the roots it looked in rather than planning without the skill.
 */
export async function resolveSelectedSkills(
  projectDir: string,
  ids: readonly string[] | undefined,
): Promise<SkillMeta[] | undefined> {
  if (ids === undefined || ids.length === 0) return undefined;
  const available = await discoverSkills(projectDir);
  const roots = [...PROJECT_SKILL_SCAN_PATH_LABELS, ...GLOBAL_SKILL_SCAN_PATH_LABELS];
  return ids.map((id) => {
    const skill = available.find((candidate) => candidate.id === id);
    if (skill === undefined) {
      throw cliError(`Unknown skill: ${id} (scanned: ${roots.join(', ')})`, 2);
    }
    return skill;
  });
}
