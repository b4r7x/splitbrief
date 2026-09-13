import {
  chmodSync,
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
const SCRIPT_RE = /scripts\/([A-Za-z0-9._-]+)/gu;
const GENERATED_RE = /<!-- generated: ([A-Za-z0-9:_-]+) -->\n([\s\S]*?)<!-- \/generated -->/gu;
export const GENERATED_SH_RE = /# generated: ([A-Za-z0-9:_-]+)\n([\s\S]*?)# \/generated/gu;

/** The one skill that owns `scripts/`; every other skill mirrors from it. */
const SCRIPT_SOURCE_SKILL = 'splitbrief-run';

type GeneratedSyntax = Readonly<{
  re: RegExp;
  open: (id: string) => string;
  close: string;
}>;

const MARKDOWN_GENERATED: GeneratedSyntax = {
  re: GENERATED_RE,
  open: (id) => `<!-- generated: ${id} -->`,
  close: '<!-- /generated -->',
};

const SHELL_GENERATED: GeneratedSyntax = {
  re: GENERATED_SH_RE,
  open: (id) => `# generated: ${id}`,
  close: '# /generated',
};

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

function mentioned(body: string, pattern: RegExp): string[] {
  return [...new Set([...body.matchAll(pattern)].map((m) => m[1] ?? ''))]
    .filter((file) => file.length > 0)
    .sort();
}

export function mentionedReferences(body: string): string[] {
  return mentioned(body, REFERENCE_RE);
}

export function mentionedScripts(body: string): string[] {
  return mentioned(body, SCRIPT_RE);
}

export function renderGeneratedRegions(
  text: string,
  render: RenderBlock,
  syntax: GeneratedSyntax = MARKDOWN_GENERATED,
): { text: string; unknown: string[]; changed: string[] } {
  const unknown: string[] = [];
  const changed: string[] = [];
  const next = text.replace(syntax.re, (match, id: string, current: string) => {
    const rendered = render(id);
    if (rendered === null) {
      unknown.push(id);
      return match;
    }
    const body = `${rendered}\n`;
    if (body !== current) changed.push(id);
    return `${syntax.open(id)}\n${body}${syntax.close}`;
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

function libraryDirOf(root: string): string {
  return join(root, CANONICAL_SKILL, 'references');
}

function scriptDirOf(root: string): string {
  return join(root, SCRIPT_SOURCE_SKILL, 'scripts');
}

/** A `scripts/<name>` mirror keeps its path; a reference mirror lands in the skill's `references/`. */
function mirrorPaths(
  root: string,
  skill: string,
  file: string,
): { source: string; target: string } {
  return file.startsWith('scripts/')
    ? { source: join(root, SCRIPT_SOURCE_SKILL, file), target: join(root, skill, file) }
    : { source: join(libraryDirOf(root), file), target: join(root, skill, 'references', file) };
}

function mirrorDrifted(source: string, target: string): boolean {
  if (!existsSync(target)) return true;
  if (readFileSync(target, 'utf8') !== readFileSync(source, 'utf8')) return true;
  return (statSync(target).mode & 0o111) !== (statSync(source).mode & 0o111);
}

function listFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

type GeneratedFile = Readonly<{
  skill: string;
  name: string;
  path: string;
  syntax: GeneratedSyntax;
}>;

/** The canonical sources of generated regions: never a mirror, which `planSync` owns. */
function generatedFiles(root: string): GeneratedFile[] {
  const files: GeneratedFile[] = skillDirs(root).map((skill) => ({
    skill,
    name: 'SKILL.md',
    path: join(root, skill, 'SKILL.md'),
    syntax: MARKDOWN_GENERATED,
  }));
  for (const file of listMarkdown(libraryDirOf(root))) {
    files.push({
      skill: CANONICAL_SKILL,
      name: `references/${file}`,
      path: join(libraryDirOf(root), file),
      syntax: MARKDOWN_GENERATED,
    });
  }
  for (const file of listFiles(scriptDirOf(root))) {
    files.push({
      skill: SCRIPT_SOURCE_SKILL,
      name: `scripts/${file}`,
      path: join(scriptDirOf(root), file),
      syntax: SHELL_GENERATED,
    });
  }
  return files;
}

export function planGenerated(root: string, render: RenderBlock): GeneratedReport {
  const report: GeneratedReport = { issues: [], stale: [] };
  for (const file of generatedFiles(root)) {
    const { unknown, changed } = renderGeneratedRegions(
      readFileSync(file.path, 'utf8'),
      render,
      file.syntax,
    );
    for (const id of unknown) {
      report.issues.push({
        skill: file.skill,
        message: `${file.name} has no renderer for generated block "${id}"`,
      });
    }
    for (const id of changed) report.stale.push(`${file.skill}/${file.name}#${id}`);
  }
  return report;
}

export function applyGenerated(root: string, render: RenderBlock): void {
  for (const file of generatedFiles(root)) {
    const { text, changed } = renderGeneratedRegions(
      readFileSync(file.path, 'utf8'),
      render,
      file.syntax,
    );
    if (changed.length > 0) writeFileSync(file.path, text);
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
  const scripts = new Set(listFiles(scriptDirOf(root)));
  for (const skill of skillDirs(root)) {
    const text = readFileSync(join(root, skill, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(text);
    report.issues.push(...validateFrontmatter(skill, fm));
    const body = text.replace(FRONTMATTER_RE, '');
    const mentioned = mentionedReferences(body);
    if (skill !== SCRIPT_SOURCE_SKILL) {
      const wanted = mentionedScripts(body);
      for (const file of wanted) {
        if (!scripts.has(file)) {
          report.issues.push({
            skill,
            message: `scripts/${file} is not in the ${SCRIPT_SOURCE_SKILL} library`,
          });
          continue;
        }
        report.actions.push({ skill, file: `scripts/${file}`, kind: 'copy' });
        const paths = mirrorPaths(root, skill, `scripts/${file}`);
        if (mirrorDrifted(paths.source, paths.target)) {
          report.drift.push(`${skill}/scripts/${file}`);
        }
      }
      for (const file of listFiles(join(root, skill, 'scripts'))) {
        if (wanted.includes(file)) continue;
        report.actions.push({ skill, file: `scripts/${file}`, kind: 'stale' });
        report.drift.push(`${skill}/scripts/${file}`);
      }
    }
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
      if (mirrorDrifted(join(libraryDir, file), join(mirrorDir, file))) {
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
  for (const action of report.actions) {
    const { source, target } = mirrorPaths(root, action.skill, action.file);
    if (action.kind === 'stale') {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source, 'utf8'));
    chmodSync(target, statSync(source).mode);
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
    const label = action.file.startsWith('scripts/') ? action.file : `references/${action.file}`;
    log(`  ${action.kind === 'copy' ? '→' : '−'} ${action.skill}/${label}`);
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
