import { z } from 'zod';
import type { Dirent } from 'node:fs';
import { readFile, readdir, access, stat, realpath } from 'node:fs/promises';
import { join, basename, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import type { SkillMeta } from '../core/skills/types.js';
import { GLOBAL_SKILL_SCAN_PATHS, PROJECT_SKILL_SCAN_PATHS } from '../core/skills/scan-paths.js';
import { extractFrontmatter } from '../utils/frontmatter.js';

import { isENOENT } from '../lib/process/errors.js';
import { warnError } from '../lib/warn.js';
import { readProjectFileConfined } from '../lib/fs.js';

const MAX_SKILL_CHARS = 16_000;
const MIN_TRUNCATED_CHARS = 200;
const MAX_SCAN_DEPTH = 4;

const SkillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().default(''),
});

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

const FRONTMATTER_FIELD_RE = /^(name|description):[ \t]*(.*)$/;

// Discovery reruns on every skills-overlay open; one line per malformed skill is a diagnostic,
// one line per open is noise smeared across the TUI.
const warnedMalformed = new Set<string>();

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.slice(0, 1);
  const quoted = (quote === '"' || quote === "'") && trimmed.length > 1 && trimmed.endsWith(quote);
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function scanFrontmatterFields(block: string): SkillFrontmatter {
  const fm: SkillFrontmatter = { description: '' };
  for (const line of block.split('\n')) {
    const match = line.match(FRONTMATTER_FIELD_RE);
    if (match === null) continue;
    const value = unquote(match[2] ?? '');
    if (match[1] === 'name') fm.name = value;
    else fm.description = value;
  }
  return fm;
}

// YAML rejects an unquoted value containing `: ` — the `description: Use when … Triggers: …`
// convention most skills are authored with — so a block that fails to parse is line-scanned
// instead of dropping a real skill.
function parseFrontmatter(raw: string, path: string): SkillFrontmatter | null {
  const { frontmatter, body } = extractFrontmatter(raw);
  if (frontmatter !== null) {
    const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
    if (parsed.success) return parsed.data;
  }
  // extractFrontmatter hands back the input untouched only when there is no `---` block at all.
  if (body === raw) return null;
  if (!warnedMalformed.has(path)) {
    warnedMalformed.add(path);
    warnError(`Skill frontmatter is not valid YAML, recovered by line scan: ${path}`);
  }
  return scanFrontmatterFields(raw.slice(0, raw.length - body.length));
}

type ScanContext = {
  scope: SkillMeta['scope'];
  projectDir: string | undefined;
  realProjectDir: string | undefined;
};

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function insideProject(ctx: ScanContext, target: string): boolean {
  const { realProjectDir } = ctx;
  if (realProjectDir === undefined) return false;
  return target === realProjectDir || target.startsWith(realProjectDir + sep);
}

// Project scope never leaves the project: an entry resolving outside it is dropped rather than
// read de-confined, so no project row ever carries content from off-project.
function escapesProject(ctx: ScanContext, target: string): boolean {
  return ctx.scope === 'project' && !insideProject(ctx, target);
}

// Reads stay off the render loop: discovery rescans on every skills-overlay open. A project-scope
// file that resolves outside the project (a symlinked SKILL.md) is refused rather than read.
async function readSkillFile(ctx: ScanContext, path: string): Promise<string | null> {
  if (ctx.projectDir !== undefined) {
    const real = await realpathOrNull(path);
    if (real === null || !insideProject(ctx, real)) return null;
  }
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function readSkill({
  id,
  path,
  ctx,
}: {
  id: string;
  path: string;
  ctx: ScanContext;
}): Promise<SkillMeta | null> {
  const raw = await readSkillFile(ctx, path);
  if (raw === null) {
    if (ctx.projectDir !== undefined) warnError(`Failed to read confined skill ${path}`);
    return null;
  }
  const fm = parseFrontmatter(raw, path);
  if (fm === null) return null;
  const name = fm.name?.trim();
  return {
    id,
    name: name === undefined || name === '' ? id : name,
    description: fm.description,
    path,
    scope: ctx.scope,
    ...(ctx.projectDir !== undefined && { projectDir: ctx.projectDir }),
  };
}

async function walkDir(dir: string, depth: number, ctx: ScanContext): Promise<SkillMeta[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    let target = join(dir, entry.name);
    let isFile = entry.isFile();
    let isDir = entry.isDirectory();

    if (entry.isSymbolicLink()) {
      const real = await realpathOrNull(target);
      if (real === null || escapesProject(ctx, real)) continue;
      target = real;
      try {
        const targetStat = await stat(target);
        isFile = targetStat.isFile();
        isDir = targetStat.isDirectory();
      } catch {
        continue;
      }
    }

    if (isFile) {
      if (depth !== 0 || !entry.name.endsWith('.md')) continue;
      const skill = await readSkill({
        id: basename(entry.name, '.md'),
        path: target,
        ctx,
      });
      if (skill) skills.push(skill);
      continue;
    }
    if (!isDir) continue;

    const skillMd = join(target, 'SKILL.md');
    if (await exists(skillMd)) {
      const skill = await readSkill({ id: entry.name, path: skillMd, ctx });
      if (skill) skills.push(skill);
      continue;
    }
    if (depth + 1 < MAX_SCAN_DEPTH) {
      skills.push(...(await walkDir(target, depth + 1, ctx)));
    }
  }

  return skills;
}

async function scanRoot(dir: string, ctx: ScanContext): Promise<SkillMeta[]> {
  const realDir = await realpathOrNull(dir);
  if (realDir === null || escapesProject(ctx, realDir)) return [];
  return walkDir(realDir, 0, ctx);
}

function agentsMdEntry(projectDir: string): SkillMeta | null {
  const path = join(projectDir, 'AGENTS.md');
  const raw = readProjectFileConfined(projectDir, 'AGENTS.md');
  if (raw === null) return null;
  const fm = parseFrontmatter(raw, path);
  const name = fm?.name?.trim();
  return {
    id: 'agents-root',
    name: name === undefined || name === '' ? 'AGENTS.md' : name,
    description: fm?.description ?? 'Root agent instructions',
    path,
    scope: 'project',
    projectDir,
  };
}

export async function discoverSkills(projectDir: string): Promise<SkillMeta[]> {
  const realProjectDir = (await realpathOrNull(projectDir)) ?? projectDir;
  const home = homedir();
  const projectCtx: ScanContext = { scope: 'project', projectDir, realProjectDir };
  const globalCtx: ScanContext = {
    scope: 'global',
    projectDir: undefined,
    realProjectDir: undefined,
  };

  const [projectScans, globalScans] = await Promise.all([
    Promise.all(PROJECT_SKILL_SCAN_PATHS.map((p) => scanRoot(join(projectDir, p), projectCtx))),
    Promise.all(GLOBAL_SKILL_SCAN_PATHS.map((p) => scanRoot(join(home, p), globalCtx))),
  ]);

  const ordered: SkillMeta[] = [...projectScans.flat()];
  const agents = agentsMdEntry(projectDir);
  if (agents !== null) ordered.push(agents);
  ordered.push(...globalScans.flat());

  const seen = new Set<string>();
  const skills: SkillMeta[] = [];
  for (const skill of ordered) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    skills.push(skill);
  }
  return skills;
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
