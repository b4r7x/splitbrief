import type { Dirent } from 'node:fs';
import { readFile, readdir, access, stat, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { PROJECT_SKILL_SCAN_PATHS, GLOBAL_SKILL_SCAN_PATHS } from '../../core/skills/scan-paths.js';
import type { SkillMeta } from '../../core/skills/types.js';
import { readProjectFileConfined } from '../../lib/fs/read.js';
import { warnError } from '../../lib/warn.js';
import { isWithinRoot } from '../../utils/path/within.js';
import { parseFrontmatter } from './frontmatter.js';

const MAX_SCAN_DEPTH = 4;

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
  return isWithinRoot(realProjectDir, target);
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
    if (ctx.projectDir !== undefined) warnError(`Failed to read skill ${path}`);
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

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const skills: SkillMeta[] = [];
  for (const skill of ordered) {
    if (seenIds.has(skill.id) || seenNames.has(skill.name)) continue;
    if (ORCHESTRATION_SKILL_IDS.has(skill.id)) continue;
    seenIds.add(skill.id);
    seenNames.add(skill.name);
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
