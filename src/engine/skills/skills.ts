import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { PlannerTool, SkillMeta } from '../../types.js';

const MAX_SKILL_CHARS = 16_000;

export function parseFrontmatter(raw: string): { name: string; description: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1];
  if (!frontmatter) return null;
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (!nameMatch?.[1]) return null;
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch[1].trim(),
    description: descMatch?.[1]?.trim() ?? '',
  };
}

function discoverFromDir(dir: string, scope: SkillMeta['scope']): SkillMeta[] {
  if (!existsSync(dir)) return [];
  const skills: SkillMeta[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = join(dir, entry.name);

    let isFile = entry.isFile();
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        const stat = statSync(fullPath);
        isFile = stat.isFile();
        isDir = stat.isDirectory();
      } catch { continue; }
    }

    if (isFile && entry.name.endsWith('.md')) {
      const raw = readFileSync(fullPath, 'utf-8');
      const fm = parseFrontmatter(raw);
      if (fm) {
        skills.push({ id: basename(entry.name, '.md'), path: fullPath, scope, ...fm });
      }
    } else if (isDir) {
      const skillMd = join(fullPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        const raw = readFileSync(skillMd, 'utf-8');
        const fm = parseFrontmatter(raw);
        if (fm) {
          skills.push({ id: entry.name, path: skillMd, scope, ...fm });
        }
      }
    }
  }

  return skills;
}

function discoverAgentsMd(projectDir: string): SkillMeta[] {
  const skills: SkillMeta[] = [];

  const globalSkillsDir = join(homedir(), '.codex', 'skills');
  skills.push(...discoverFromDir(globalSkillsDir, 'global'));

  const rootAgents = join(projectDir, 'AGENTS.md');
  if (existsSync(rootAgents)) {
    const raw = readFileSync(rootAgents, 'utf-8');
    const fm = parseFrontmatter(raw);
    skills.push({
      id: 'agents-root',
      name: fm?.name ?? 'AGENTS.md',
      description: fm?.description ?? 'Root agent instructions',
      path: rootAgents,
      scope: 'project',
    });
  }

  return skills;
}

function discoverConventions(projectDir: string): SkillMeta[] {
  const convPath = join(projectDir, 'CONVENTIONS.md');
  if (!existsSync(convPath)) return [];
  const raw = readFileSync(convPath, 'utf-8');
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
    default: return join(homedir(), '.tiny-spec', 'skills');
  }
}

function getProjectDir(tool: PlannerTool, projectDir: string): string | null {
  switch (tool) {
    case 'claude-code': return join(projectDir, '.claude', 'skills');
    case 'codex': return null;
    case 'aider': return null;
    default: return join(projectDir, '.tiny-spec', 'skills');
  }
}

export function discoverSkills(tool: PlannerTool, projectDir: string): SkillMeta[] {
  if (tool === 'codex') return discoverAgentsMd(projectDir);
  if (tool === 'aider') return discoverConventions(projectDir);

  const globalDir = getGlobalDir(tool);
  const projDir = getProjectDir(tool, projectDir);

  const global = globalDir ? discoverFromDir(globalDir, 'global') : [];
  const project = projDir ? discoverFromDir(projDir, 'project') : [];

  return mergeSkills(global, project);
}

export function loadSkillContent(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';

  const sections: string[] = [];
  let totalChars = 0;

  for (const skill of skills) {
    const raw = readFileSync(skill.path, 'utf-8');
    const body = raw.replace(/^---[\s\S]*?---\n*/, '');

    if (totalChars + body.length > MAX_SKILL_CHARS) {
      const remaining = MAX_SKILL_CHARS - totalChars;
      if (remaining > 200) {
        sections.push(`### ${skill.name}\n${body.slice(0, remaining)}\n[... truncated]`);
      }
      break;
    }

    sections.push(`### ${skill.name}\n${body}`);
    totalChars += body.length;
  }

  return sections.join('\n\n');
}

export function buildSkillsSection(skills: SkillMeta[]): string {
  const content = loadSkillContent(skills);
  if (!content) return '';
  return `## Active Project Skills\n\n${content}`;
}
