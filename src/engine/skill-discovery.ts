import { z } from 'zod';
import { readFileSync, type Dirent } from 'node:fs';
import { readFile, readdir, access, stat } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import type { PlannerToolId } from '../core/schemas/enums.js';
import type { SkillMeta } from '../core/skills/types.js';
import { parseSimpleYamlFrontmatter, extractFrontmatter } from '../utils/frontmatter.js';

import { DIPTYCH_DIR, CODEX_DIR, SKILLS_DIR, getDiptychPath } from '../core/paths.js';
import { isENOENT } from '../lib/process/errors.js';
import { warnError } from '../lib/warn.js';
import { readProjectFileConfined } from '../lib/fs.js';

const MAX_SKILL_CHARS = 16_000;
const MIN_TRUNCATED_CHARS = 200;

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
});

export function parseFrontmatter(raw: string): { name: string; description: string } | null {
  const fm = parseSimpleYamlFrontmatter(raw);
  if (!fm) return null;
  const result = SkillFrontmatterSchema.safeParse(fm);
  return result.success ? result.data : null;
}

function readSkillFile(projectDir: string | undefined, filePath: string): string | null {
  if (projectDir === undefined) {
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
  return readProjectFileConfined(projectDir, relative(projectDir, filePath));
}

async function discoverFromDir(
  dir: string,
  scope: SkillMeta['scope'],
  projectDir?: string,
): Promise<SkillMeta[]> {
  try {
    await access(dir);
  } catch {
    return [];
  }
  const skills: SkillMeta[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = join(dir, entry.name);

    if (scope === 'project' && entry.isSymbolicLink()) {
      continue;
    }

    let isFile = entry.isFile();
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink() && scope !== 'project') {
      try {
        const targetStat = await stat(fullPath);
        isFile = targetStat.isFile();
        isDir = targetStat.isDirectory();
      } catch {
        continue;
      }
    }

    if (isFile && entry.name.endsWith('.md')) {
      const raw = readSkillFile(scope === 'project' ? projectDir : undefined, fullPath);
      if (raw === null) {
        if (scope === 'project') {
          warnError(`Failed to read confined skill ${fullPath}`);
        }
        continue;
      }
      const fm = parseFrontmatter(raw);
      if (fm) {
        skills.push({
          id: basename(entry.name, '.md'),
          path: fullPath,
          scope,
          ...(scope === 'project' && projectDir !== undefined && { projectDir }),
          ...fm,
        });
      }
    } else if (isDir) {
      const skillMd = join(fullPath, 'SKILL.md');
      try {
        await access(skillMd);
        const raw = readSkillFile(scope === 'project' ? projectDir : undefined, skillMd);
        if (raw === null) {
          if (scope === 'project') {
            warnError(`Failed to read confined skill ${skillMd}`);
          }
          continue;
        }
        const fm = parseFrontmatter(raw);
        if (fm) {
          skills.push({
            id: entry.name,
            path: skillMd,
            scope,
            ...(scope === 'project' && projectDir !== undefined && { projectDir }),
            ...fm,
          });
        }
      } catch {
        /* no SKILL.md */
      }
    }
  }

  return skills;
}

async function discoverAgentsMd(projectDir: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];

  const globalSkillsDir = join(homedir(), CODEX_DIR, SKILLS_DIR);
  skills.push(...(await discoverFromDir(globalSkillsDir, 'global')));

  const rootAgents = join(projectDir, 'AGENTS.md');
  const raw = readProjectFileConfined(projectDir, 'AGENTS.md');
  if (raw !== null) {
    const fm = parseFrontmatter(raw);
    skills.push({
      id: 'agents-root',
      name: fm?.name ?? 'AGENTS.md',
      description: fm?.description ?? 'Root agent instructions',
      path: rootAgents,
      scope: 'project',
      projectDir,
    });
  }

  return skills;
}

async function discoverConventions(projectDir: string): Promise<SkillMeta[]> {
  const convPath = join(projectDir, 'CONVENTIONS.md');
  const raw = readProjectFileConfined(projectDir, 'CONVENTIONS.md');
  if (raw === null) {
    try {
      await access(convPath);
      warnError(`discover-conventions: ${convPath}`);
    } catch {}
    return [];
  }
  const fm = parseFrontmatter(raw);
  return [
    {
      id: 'conventions',
      name: fm?.name ?? 'CONVENTIONS.md',
      description: fm?.description ?? 'Project conventions',
      path: convPath,
      scope: 'project',
      projectDir,
    },
  ];
}

function mergeSkills(global: SkillMeta[], project: SkillMeta[]): SkillMeta[] {
  const projectIds = new Set(project.map((s) => s.id));
  const uniqueGlobal = global.filter((s) => !projectIds.has(s.id));
  return [...project, ...uniqueGlobal];
}

function getGlobalDir(tool: PlannerToolId): string {
  return tool === 'claude-code'
    ? join(homedir(), '.claude', 'skills')
    : join(homedir(), DIPTYCH_DIR, SKILLS_DIR);
}

function getProjectDir(tool: PlannerToolId, projectDir: string): string {
  return tool === 'claude-code'
    ? join(projectDir, '.claude', 'skills')
    : getDiptychPath(projectDir, SKILLS_DIR);
}

export async function discoverSkills(
  tool: PlannerToolId,
  projectDir: string,
): Promise<SkillMeta[]> {
  if (tool === 'codex') return discoverAgentsMd(projectDir);
  if (tool === 'aider') return discoverConventions(projectDir);

  const globalDir = getGlobalDir(tool);
  const projDir = getProjectDir(tool, projectDir);

  const [global, project] = await Promise.all([
    discoverFromDir(globalDir, 'global'),
    discoverFromDir(projDir, 'project', projectDir),
  ]);

  return mergeSkills(global, project);
}

export async function loadSkillContent(skills: SkillMeta[]): Promise<string> {
  if (skills.length === 0) return '';

  const sections: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    if (skill === undefined) continue;
    let raw: string;
    if (skill.scope === 'project' && skill.projectDir !== undefined) {
      const confined = readProjectFileConfined(
        skill.projectDir,
        relative(skill.projectDir, skill.path),
      );
      if (confined === null) {
        warnError(`Failed to read confined skill ${skill.path}`);
        continue;
      }
      raw = confined;
    } else {
      try {
        raw = await readFile(skill.path, 'utf-8');
      } catch (err) {
        if (!isENOENT(err)) warnError(`Failed to read skill ${skill.path}`, err);
        continue;
      }
    }
    const { body } = extractFrontmatter(raw);

    if (totalChars + body.length > MAX_SKILL_CHARS) {
      const remaining = MAX_SKILL_CHARS - totalChars;
      const partial = remaining > MIN_TRUNCATED_CHARS;
      if (partial) {
        sections.push(`### ${skill.name}\n${body.slice(0, remaining)}\n[... truncated]`);
      }
      const dropped = skills.slice(partial ? i + 1 : i);
      if (dropped.length > 0) {
        const names = dropped.map((s) => s.name).join(', ');
        sections.push(
          `[${dropped.length} more selected skills omitted: budget ${MAX_SKILL_CHARS} chars — ${names}]`,
        );
      }
      break;
    }

    sections.push(`### ${skill.name}\n${body}`);
    totalChars += body.length;
  }

  return sections.join('\n\n');
}

export async function buildSkillsSection(skills: SkillMeta[]): Promise<string> {
  const content = await loadSkillContent(skills);
  if (!content) return '';
  return `## Active Project Skills\n\n${content}`;
}
