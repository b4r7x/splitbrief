import { z } from 'zod';
import type { Dirent } from 'node:fs';
import { readFile, readdir, access, stat, realpath } from 'node:fs/promises';
import { join, basename, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import type { SkillMeta } from '../core/skills/types.js';
import { GLOBAL_SKILL_SCAN_PATHS, PROJECT_SKILL_SCAN_PATHS } from '../core/skills/scan-paths.js';
import { extractFrontmatter } from '../utils/frontmatter.js';
import { countNoun } from '../utils/pluralize.js';

import { isENOENT } from '../lib/process/errors.js';
import { warnError, warnStderr } from '../lib/warn.js';
import { readProjectFileConfined } from '../lib/fs.js';

const MAX_SKILL_CHARS = 16_000;
const MAX_SCAN_DEPTH = 4;
const REFERENCES_DIR = 'references';

const SkillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().default(''),
});

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

const FRONTMATTER_FIELD_RE = /^(name|description):[ \t]*(.*)$/;

// Only a skill a run loads is named, because discovery parses every skill in every scan root.
// A run loads its skills again at each continue, so each malformed skill is named once.
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
function parseFrontmatter(raw: string): { fields: SkillFrontmatter; recovered: boolean } | null {
  const { frontmatter, body } = extractFrontmatter(raw);
  if (frontmatter !== null) {
    const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
    if (parsed.success) return { fields: parsed.data, recovered: false };
  }
  // extractFrontmatter hands back the input untouched only when there is no `---` block at all.
  if (body === raw) return null;
  return { fields: scanFrontmatterFields(raw.slice(0, raw.length - body.length)), recovered: true };
}

type ScanContext = {
  scope: SkillMeta['scope'];
  projectDir: string | undefined;
  realProjectDir: string | undefined;
};

export async function realpathOrNull(path: string): Promise<string | null> {
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
  dir,
}: {
  id: string;
  path: string;
  ctx: ScanContext;
  dir?: string | undefined;
}): Promise<SkillMeta | null> {
  const raw = await readSkillFile(ctx, path);
  if (raw === null) {
    if (ctx.projectDir !== undefined) warnError(`Failed to read confined skill ${path}`);
    return null;
  }
  const fm = parseFrontmatter(raw)?.fields;
  if (fm === undefined) return null;
  const name = fm.name?.trim();
  return {
    id,
    name: name === undefined || name === '' ? id : name,
    description: fm.description,
    path,
    scope: ctx.scope,
    ...(ctx.projectDir !== undefined && { projectDir: ctx.projectDir }),
    ...(dir !== undefined && { dir }),
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
      const skill = await readSkill({ id: entry.name, path: skillMd, ctx, dir: target });
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
  const fm = parseFrontmatter(raw)?.fields;
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
    if (seen.has(skill.id) || ORCHESTRATION_SKILL_IDS.has(skill.id)) continue;
    seen.add(skill.id);
    skills.push(skill);
  }
  return skills;
}

// The portable splitbrief skills tell a host session to spawn its own implementer and
// reviewer, and `splitbrief-babysit` tells it to supervise this CLI; injected into this run's
// seats they would describe the pipeline they are already running. The repo's own dev skills
// (`splitbrief-dev`, …) are not in this set.
const ORCHESTRATION_SKILL_IDS = new Set([
  'splitbrief',
  'splitbrief-brief',
  'splitbrief-run',
  'splitbrief-review',
  'splitbrief-babysit',
]);

export type SkillContent = { content: string; omitted: string[]; unread: SkillMeta[] };

async function readSkillText(skill: SkillMeta, path: string): Promise<string | null> {
  if (skill.projectDir !== undefined) {
    const confined = readProjectFileConfined(skill.projectDir, relative(skill.projectDir, path));
    if (confined === null) warnError(`Failed to read confined skill ${path}`);
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
      warnStderr(
        `Skill frontmatter is not valid YAML, recovered by line scan: ${skill.path}`,
        'log-only',
      );
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
