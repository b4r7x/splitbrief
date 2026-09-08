import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CANONICAL_SKILL = 'splitbrief';
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const MAX_DESCRIPTION = 1024;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/u;
const REFERENCE_RE = /references\/([A-Za-z0-9._-]+\.md)/gu;
const GENERATED_RE = /<!-- generated: ([A-Za-z0-9:_-]+) -->\n([\s\S]*?)<!-- \/generated -->/gu;

export type Frontmatter = {
  name: string;
  description: string;
  argumentHint: string | null;
};

export type SkillIssue = { skill: string; message: string };
export type MirrorAction = { skill: string; file: string; kind: 'copy' | 'stale' };
export type SyncReport = {
  issues: SkillIssue[];
  actions: MirrorAction[];
  drift: string[];
  warnings: string[];
};
export type RenderBlock = (id: string) => string | null;
export type GeneratedReport = { issues: SkillIssue[]; stale: string[] };

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/u.exec(trimmed);
  return quoted?.[2] ?? trimmed;
}

export function parseFrontmatter(text: string): Frontmatter | null {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null || match[1] === undefined) return null;
  const lines = match[1].split('\n');
  let name = '';
  let description = '';
  let argumentHint: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('name:')) name = line.slice('name:'.length).trim();
    if (line.startsWith('description:')) {
      const scalar = line.slice('description:'.length).trim();
      const parts = /^([|>][+-]?)?$/u.test(scalar) ? [] : [stripQuotes(scalar)];
      for (let i = index + 1; i < lines.length; i++) {
        const next = lines[i];
        if (next === undefined || !/^\s+\S/u.test(next)) break;
        parts.push(next.trim());
      }
      description = parts.join(' ');
    }
    const hint = /^\s+argument-hint:(.*)$/u.exec(line);
    if (hint?.[1] !== undefined) argumentHint = stripQuotes(hint[1]);
  }
  return { name, description, argumentHint };
}

export function validateFrontmatter(skill: string, fm: Frontmatter | null): SkillIssue[] {
  if (fm === null) return [{ skill, message: 'no frontmatter block' }];
  const issues: SkillIssue[] = [];
  if (fm.name !== skill) {
    issues.push({ skill, message: `name "${fm.name}" does not match directory` });
  }
  if (!NAME_RE.test(fm.name)) {
    issues.push({ skill, message: `name "${fm.name}" is not lowercase-kebab` });
  }
  if (fm.description.length === 0) issues.push({ skill, message: 'description is empty' });
  if (fm.description.length > MAX_DESCRIPTION) {
    issues.push({ skill, message: `description is longer than ${MAX_DESCRIPTION} characters` });
  }
  if (fm.argumentHint === null) {
    issues.push({ skill, message: 'metadata.argument-hint is missing' });
  }
  return issues;
}

export function mentionedReferences(body: string): string[] {
  return [...new Set([...body.matchAll(REFERENCE_RE)].map((m) => m[1] ?? ''))]
    .filter((file) => file.length > 0)
    .sort();
}

export function renderGeneratedRegions(
  text: string,
  render: RenderBlock,
): { text: string; unknown: string[]; changed: string[] } {
  const unknown: string[] = [];
  const changed: string[] = [];
  const next = text.replace(GENERATED_RE, (match, id: string, current: string) => {
    const rendered = render(id);
    if (rendered === null) {
      unknown.push(id);
      return match;
    }
    const body = `${rendered}\n`;
    if (body !== current) changed.push(id);
    return `<!-- generated: ${id} -->\n${body}<!-- /generated -->`;
  });
  return { text: next, unknown, changed };
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort();
}

function skillDirs(root: string): string[] {
  return readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    .filter((entry) => existsSync(join(root, entry, 'SKILL.md')))
    .sort();
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function libraryDirOf(root: string): string {
  return join(root, CANONICAL_SKILL, 'references');
}

export function planGenerated(root: string, render: RenderBlock): GeneratedReport {
  const report: GeneratedReport = { issues: [], stale: [] };
  const libraryDir = libraryDirOf(root);
  for (const file of listMarkdown(libraryDir)) {
    const { unknown, changed } = renderGeneratedRegions(
      readFileSync(join(libraryDir, file), 'utf8'),
      render,
    );
    for (const id of unknown) {
      report.issues.push({
        skill: CANONICAL_SKILL,
        message: `references/${file} has no renderer for generated block "${id}"`,
      });
    }
    for (const id of changed) report.stale.push(`${CANONICAL_SKILL}/references/${file}#${id}`);
  }
  return report;
}

export function applyGenerated(root: string, render: RenderBlock): void {
  const libraryDir = libraryDirOf(root);
  for (const file of listMarkdown(libraryDir)) {
    const path = join(libraryDir, file);
    const { text, changed } = renderGeneratedRegions(readFileSync(path, 'utf8'), render);
    if (changed.length > 0) writeFileSync(path, text);
  }
}

export function planSync(root: string): SyncReport {
  const report: SyncReport = { issues: [], actions: [], drift: [], warnings: [] };
  const libraryDir = libraryDirOf(root);
  if (!existsSync(libraryDir)) {
    report.issues.push({
      skill: CANONICAL_SKILL,
      message: 'references library directory is missing',
    });
    return report;
  }
  const library = new Set(listMarkdown(libraryDir));
  for (const skill of skillDirs(root)) {
    const text = readFileSync(join(root, skill, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(text);
    report.issues.push(...validateFrontmatter(skill, fm));
    const body = text.replace(FRONTMATTER_RE, '');
    const mentioned = mentionedReferences(body);
    if (skill === CANONICAL_SKILL) {
      for (const file of library) {
        if (!mentioned.includes(file)) {
          report.warnings.push(`${skill}: references/${file} is never mentioned in SKILL.md`);
        }
      }
      continue;
    }
    const mirrorDir = join(root, skill, 'references');
    for (const file of mentioned) {
      if (!library.has(file)) {
        report.issues.push({
          skill,
          message: `references/${file} is not in the ${CANONICAL_SKILL} library`,
        });
        continue;
      }
      report.actions.push({ skill, file, kind: 'copy' });
      const source = readFileSync(join(libraryDir, file), 'utf8');
      if (readIfExists(join(mirrorDir, file)) !== source) {
        report.drift.push(`${skill}/references/${file}`);
      }
    }
    for (const file of listMarkdown(mirrorDir)) {
      if (!mentioned.includes(file)) {
        report.actions.push({ skill, file, kind: 'stale' });
        report.drift.push(`${skill}/references/${file}`);
      }
    }
  }
  return report;
}

export function applySync(root: string, report: SyncReport): void {
  const libraryDir = libraryDirOf(root);
  for (const action of report.actions) {
    const target = join(root, action.skill, 'references', action.file);
    if (action.kind === 'stale') {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(libraryDir, action.file), 'utf8'));
  }
}

export function runSyncCli(
  root: string,
  check: boolean,
  log: (line: string) => void,
  render: RenderBlock = () => null,
): number {
  const generated = planGenerated(root, render);
  for (const issue of generated.issues) log(`  ✗ ${issue.skill}: ${issue.message}`);
  if (check) {
    for (const path of generated.stale) log(`  ✗ ${path} out of date`);
  } else {
    applyGenerated(root, render);
    for (const path of generated.stale) log(`  ⟳ ${path}`);
  }
  const report = planSync(root);
  for (const warning of report.warnings) log(`  ! ${warning}`);
  for (const issue of report.issues) log(`  ✗ ${issue.skill}: ${issue.message}`);
  const issues = generated.issues.length + report.issues.length;
  if (check) {
    for (const path of report.drift) log(`  ✗ ${path} out of sync`);
    const failed = issues + generated.stale.length + report.drift.length;
    log(failed === 0 ? 'skills: in sync' : `skills: ${failed} problem(s)`);
    return failed === 0 ? 0 : 1;
  }
  applySync(root, report);
  for (const action of report.actions) {
    log(`  ${action.kind === 'copy' ? '→' : '−'} ${action.skill}/references/${action.file}`);
  }
  log(issues === 0 ? 'skills: synced' : `skills: synced with ${issues} issue(s)`);
  return issues === 0 ? 0 : 1;
}

function isMain(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const { renderBlock } = await import('./skill-blocks.js');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
  process.exit(runSyncCli(root, process.argv.includes('--check'), console.log, renderBlock));
}
