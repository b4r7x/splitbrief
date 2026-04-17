import { z } from 'zod';
import { readFile, readdir, stat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { PlannerTool } from '../../core/types/config-options.js';
import { parseSimpleYamlFrontmatter, extractFrontmatter } from '../../utils/frontmatter.js';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
}
import { DIPTYCH_DIR, CODEX_DIR, SKILLS_DIR, getDiptychPath } from '../../core/paths.js';
import { isENOENT } from '../../lib/process/errors.js';
import { warnError } from '../../lib/warn.js';

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

async function discoverFromDir(dir: string, scope: SkillMeta['scope']): Promise<SkillMeta[]> {
  try { await access(dir); } catch { return []; }
  const skills: SkillMeta[] = [];

  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = join(dir, entry.name);

    let isFile = entry.isFile();
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        const s = await stat(fullPath);
        isFile = s.isFile();
        isDir = s.isDirectory();
      } catch { continue; }
    }

    if (isFile && entry.name.endsWith('.md')) {
      let raw: string;
      try { raw = await readFile(fullPath, 'utf-8'); } catch { continue; }
      const fm = parseFrontmatter(raw);
      if (fm) {
        skills.push({ id: basename(entry.name, '.md'), path: fullPath, scope, ...fm });
      }
    } else if (isDir) {
      const skillMd = join(fullPath, 'SKILL.md');
      try {
        await access(skillMd);
        let raw: string;
        try { raw = await readFile(skillMd, 'utf-8'); } catch { continue; }
        const fm = parseFrontmatter(raw);
        if (fm) {
          skills.push({ id: entry.name, path: skillMd, scope, ...fm });
        }
      } catch { /* no SKILL.md */ }
    }
  }

  return skills;
}

async function discoverAgentsMd(projectDir: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];

  const globalSkillsDir = join(homedir(), CODEX_DIR, SKILLS_DIR);
  skills.push(...await discoverFromDir(globalSkillsDir, 'global'));

  const rootAgents = join(projectDir, 'AGENTS.md');
  try {
    await access(rootAgents);
    const raw = await readFile(rootAgents, 'utf-8');
    const fm = parseFrontmatter(raw);
    skills.push({
      id: 'agents-root',
      name: fm?.name ?? 'AGENTS.md',
      description: fm?.description ?? 'Root agent instructions',
      path: rootAgents,
      scope: 'project',
    });
  } catch (err) {
    if (!isENOENT(err)) {
      warnError('Failed to read AGENTS.md', err);
    }
  }

  return skills;
}

async function discoverConventions(projectDir: string): Promise<SkillMeta[]> {
  const convPath = join(projectDir, 'CONVENTIONS.md');
  let raw: string;
  try { raw = await readFile(convPath, 'utf-8'); } catch { return []; }
  const fm = parseFrontmatter(raw);
  return [{
    id: 'conventions',
    name: fm?.name ?? 'CONVENTIONS.md',
    description: fm?.description ?? 'Project conventions',
    path: convPath,
    scope: 'project',
  }];
}

function mergeSkills(global: SkillMeta[], project: SkillMeta[]): SkillMeta[] {
  const projectIds = new Set(project.map(s => s.id));
  const uniqueGlobal = global.filter(s => !projectIds.has(s.id));
  return [...project, ...uniqueGlobal];
}

function getGlobalDir(tool: PlannerTool): string | null {
  switch (tool) {
    case 'claude-code': return join(homedir(), '.claude', 'skills');
    case 'codex': return null;
    case 'aider': return null;
    default: return join(homedir(), DIPTYCH_DIR, SKILLS_DIR);
  }
}

function getProjectDir(tool: PlannerTool, projectDir: string): string | null {
  switch (tool) {
    case 'claude-code': return join(projectDir, '.claude', 'skills');
    case 'codex': return null;
    case 'aider': return null;
    default: return getDiptychPath(projectDir, SKILLS_DIR);
  }
}

export async function discoverSkills(tool: PlannerTool, projectDir: string): Promise<SkillMeta[]> {
  if (tool === 'codex') return discoverAgentsMd(projectDir);
  if (tool === 'aider') return discoverConventions(projectDir);

  const globalDir = getGlobalDir(tool);
  const projDir = getProjectDir(tool, projectDir);

  const [global, project] = await Promise.all([
    globalDir ? discoverFromDir(globalDir, 'global') : [],
    projDir ? discoverFromDir(projDir, 'project') : [],
  ]);

  return mergeSkills(global, project);
}

export async function loadSkillContent(skills: SkillMeta[]): Promise<string> {
  if (skills.length === 0) return '';

  const sections: string[] = [];
  let totalChars = 0;

  for (const skill of skills) {
    let raw: string;
    try { raw = await readFile(skill.path, 'utf-8'); } catch { continue; }
    const { body } = extractFrontmatter(raw);

    if (totalChars + body.length > MAX_SKILL_CHARS) {
      const remaining = MAX_SKILL_CHARS - totalChars;
      if (remaining > MIN_TRUNCATED_CHARS) {
        sections.push(`### ${skill.name}\n${body.slice(0, remaining)}\n[... truncated]`);
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
