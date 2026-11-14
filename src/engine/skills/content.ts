import { readFile, readdir } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import type { SkillMeta } from '../../core/skills/types.js';
import { readProjectFileConfined } from '../../lib/fs/read.js';
import { warnError, warnStderr } from '../../lib/warn.js';
import { isENOENT } from '../../utils/errno.js';
import { extractFrontmatter } from '../../utils/frontmatter.js';
import { countNoun } from '../../utils/pluralize.js';
import { realpathOrNull } from './discover.js';
import { parseFrontmatter } from './frontmatter.js';

const MAX_SKILL_CHARS = 16_000;
const REFERENCES_DIR = 'references';

// Only a skill a run loads is named, because discovery parses every skill in every scan root.
// A run loads its skills again at each continue, so each malformed skill is named once.
const warnedMalformed = new Set<string>();

export type SkillContent = { content: string; omitted: string[]; unread: SkillMeta[] };

async function readSkillText(skill: SkillMeta, path: string): Promise<string | null> {
  if (skill.projectDir !== undefined) {
    const confined = readProjectFileConfined(skill.projectDir, relative(skill.projectDir, path));
    if (confined === null) warnError(`Failed to read skill ${path}`);
    return confined;
  }
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if (!isENOENT(err)) warnError(`Failed to read skill ${path}`, err);
    return null;
  }
}

// Every seat reaches a project skill from its own working directory — the checkout or an
// isolation worktree — so a project path is spelled from the project root, never absolute.
async function skillPathLabel(skill: SkillMeta, path: string): Promise<string> {
  if (skill.scope !== 'project' || skill.projectDir === undefined) return path;
  const [root, real] = await Promise.all([realpathOrNull(skill.projectDir), realpathOrNull(path)]);
  return relative(root ?? skill.projectDir, real ?? path) || '.';
}

/** What a skill owns on disk: its directory, or a loose `.md` skill's (and AGENTS.md's) own file. */
export function skillRoot(skill: SkillMeta): string {
  return skill.dir ?? skill.path;
}

async function locationLine(skill: SkillMeta): Promise<string> {
  const root = skillRoot(skill);
  const line = `${root === skill.path ? 'File' : 'Base directory'}: ${await skillPathLabel(skill, root)}`;
  return skill.scope === 'project' && skill.projectDir !== undefined
    ? `${line} (relative to the project root)`
    : line;
}

// Only a skill directory owns a `references/`; a loose `.md` skill and AGENTS.md sit beside others.
async function referencePaths(skill: SkillMeta): Promise<string[]> {
  if (skill.dir === undefined) return [];
  const dir = join(skill.dir, REFERENCES_DIR);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => `${REFERENCES_DIR}/${entry.name}`)
      .sort();
  } catch (err) {
    if (!isENOENT(err)) warnError(`Failed to list skill references ${dir}`, err);
    return [];
  }
}

/**
 * The selected skills under one character budget: every `SKILL.md` body whole, in selection
 * order, then each inlined skill's `references/*.md` whole while it fits. A file that does not
 * fit is named by path, never cut. `omitted` names each skill whose body was named instead;
 * references named by path are the normal case. `unread` holds each skill whose file could not
 * be read, which the block leaves out.
 */
export async function loadSkillContent(skills: SkillMeta[]): Promise<SkillContent> {
  if (skills.length === 0) return { content: '', omitted: [], unread: [] };

  const bodies: { skill: SkillMeta; body: string | null }[] = [];
  const unread: SkillMeta[] = [];
  let totalChars = 0;

  for (const skill of skills) {
    const raw = await readSkillText(skill, skill.path);
    if (raw === null) {
      unread.push(skill);
      continue;
    }
    if (parseFrontmatter(raw)?.recovered && !warnedMalformed.has(skill.path)) {
      warnedMalformed.add(skill.path);
      warnStderr(`Skill frontmatter is not valid YAML, recovered by line scan: ${skill.path}`);
    }
    const { body } = extractFrontmatter(raw);
    const fits = totalChars + body.length <= MAX_SKILL_CHARS;
    bodies.push({ skill, body: fits ? body : null });
    if (fits) totalChars += body.length;
  }

  const omitted: string[] = [];
  const sections: string[] = [];
  for (const { skill, body } of bodies) {
    const parts = [`### ${skill.name}\n${await locationLine(skill)}`];
    const notInlined: string[] = [];
    if (body === null) {
      omitted.push(skill.name);
      notInlined.push(basename(skill.path), ...(await referencePaths(skill)));
    } else {
      parts.push(body);
      for (const path of await referencePaths(skill)) {
        if (totalChars >= MAX_SKILL_CHARS) {
          notInlined.push(path);
          continue;
        }
        const text = await readSkillText(skill, join(skillRoot(skill), path));
        if (text === null) continue;
        if (totalChars + text.length > MAX_SKILL_CHARS) {
          notInlined.push(path);
          continue;
        }
        parts.push(`#### ${path}\n${text}`);
        totalChars += text.length;
      }
    }
    if (notInlined.length > 0) {
      parts.push(
        `[${countNoun(notInlined.length, 'file')} not inlined: budget ${MAX_SKILL_CHARS} chars — ${notInlined.join(', ')}]`,
      );
    }
    sections.push(parts.join('\n\n'));
  }

  return { content: sections.join('\n\n'), omitted, unread };
}

export async function buildSkillsSection(
  skills: SkillMeta[],
): Promise<{ section: string; omitted: string[]; unread: SkillMeta[] }> {
  const { content, omitted, unread } = await loadSkillContent(skills);
  if (content === '') return { section: '', omitted, unread };
  return { section: `## Active Project Skills\n\n${content}`, omitted, unread };
}
