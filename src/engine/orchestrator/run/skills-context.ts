import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { Phase } from '../../../core/schemas/enums.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { ProjectContext } from '../../../core/state/types.js';
import { checkIgnoredPaths } from '../../../lib/git/files.js';
import { countNoun, pluralize } from '../../../utils/pluralize.js';
import type { EventBus } from '../../events/types.js';
import {
  buildSkillsSection,
  discoverSkills,
  realpathOrNull,
  skillRoot,
} from '../../skill-discovery.js';
import { publishWarning } from '../events.js';

async function resolveSkills(
  selected: SkillMeta[] | undefined,
  persisted: readonly string[] | undefined,
  projectDir: string,
): Promise<{ skills: SkillMeta[]; unresolved: string[] }> {
  if (selected && selected.length > 0) return { skills: selected, unresolved: [] };
  const saved = persisted ?? [];
  const available = saved.length > 0 ? await discoverSkills(projectDir) : [];
  const found = new Set(available.map((s) => s.id));
  return {
    skills: available.filter((s) => saved.includes(s.id)),
    unresolved: saved.filter((id) => !found.has(id)),
  };
}

/**
 * Where each seat reaches a skill from. A global skill whose files live in the project — a run on
 * the repository that holds it — is read like a project skill, from the seat's own copy of the
 * project, and opens no zone. A project skill git ignores is in no isolation copy, so every seat
 * reads the checkout's files by their absolute path, as it reads a global skill; the read stays
 * confined to the project.
 */
async function seatReach(skills: SkillMeta[], projectDir: string): Promise<SkillMeta[]> {
  const root = await realpath(projectDir);
  const placed = skills.map(
    (skill): SkillMeta =>
      skill.scope === 'global' && skill.path.startsWith(root + sep)
        ? { ...skill, scope: 'project', projectDir }
        : skill,
  );
  // A skill whose files are gone places nowhere; the section reports it unread.
  const inProject = await Promise.all(
    placed.map(async (skill) => {
      const real = skill.scope === 'project' ? await realpathOrNull(skillRoot(skill)) : null;
      return real === null ? null : relative(root, real);
    }),
  );
  const ignored = new Set(
    await checkIgnoredPaths(
      projectDir,
      inProject.filter((path): path is string => path !== null),
    ),
  );
  return placed.map((skill, index) => {
    const path = inProject[index];
    return path != null && ignored.has(path) ? { ...skill, scope: 'global' } : skill;
  });
}

/**
 * The run's skills block, built once for every seat: the skills this process was handed,
 * or the ids the run saved when it started, so a continued run carries what it began with.
 * A project skill is read from the seat's own copy of the project; a global one lives
 * outside it, so its root is named for the implementer's isolation boundary. The ids of
 * the skills the block carries go to the run's record.
 */
export async function buildSkillsContext(opts: {
  projectDir: string;
  bus: EventBus;
  phase: Phase;
  selected: SkillMeta[] | undefined;
  persisted: readonly string[] | undefined;
}): Promise<Pick<ProjectContext, 'skillsContext' | 'skillRoots'> & { skillIds?: string[] }> {
  const resolved = await resolveSkills(opts.selected, opts.persisted, opts.projectDir);
  if (resolved.unresolved.length > 0) {
    publishWarning({
      bus: opts.bus,
      phase: opts.phase,
      message: `Saved ${pluralize(resolved.unresolved.length, 'skill')} not found, left out: ${resolved.unresolved.join(', ')}`,
      safety: { category: 'skills', code: 'skills_unresolved' },
    });
  }
  if (resolved.skills.length === 0) return {};
  const skills = await seatReach(resolved.skills, opts.projectDir);
  const { section, omitted, unread } = await buildSkillsSection(skills);
  if (unread.length > 0) {
    publishWarning({
      bus: opts.bus,
      phase: opts.phase,
      message: `${pluralize(unread.length, 'Skill')} could not be read, left out: ${unread.map((skill) => skill.name).join(', ')}`,
      safety: { category: 'skills', code: 'skills_unresolved' },
    });
  }
  if (omitted.length > 0) {
    publishWarning({
      bus: opts.bus,
      phase: opts.phase,
      message: `${countNoun(omitted.length, 'skill')} over the skills budget, named by path: ${omitted.join(', ')}`,
      safety: { category: 'skills', code: 'skills_truncated' },
    });
  }
  if (section === '') return {};
  const carried = skills.filter((skill) => !unread.includes(skill));
  const skillRoots = carried.filter((skill) => skill.scope === 'global').map(skillRoot);
  return {
    skillsContext: section,
    ...(skillRoots.length > 0 && { skillRoots }),
    skillIds: carried.map((skill) => skill.id),
  };
}
