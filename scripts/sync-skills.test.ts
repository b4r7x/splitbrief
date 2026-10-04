import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGenerated,
  applySync,
  mentionedReferences,
  mentionedScripts,
  parseFrontmatter,
  planGenerated,
  planSync,
  renderGeneratedRegions,
  runSyncCli,
  validateFrontmatter,
} from './sync-skills.js';

const GEN = (id: string): string | null => (id === 'known' ? 'FRESH' : null);
const region = (id: string, body: string): string =>
  `<!-- generated: ${id} -->\n${body}<!-- /generated -->`;

const dirs: string[] = [];

function makeSkillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sync-skills-'));
  dirs.push(root);
  return root;
}

function writeSkill(
  root: string,
  name: string,
  body: string,
  refs: Record<string, string> = {},
): void {
  const dir = join(root, name);
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >\n  Use when testing.\nmetadata:\n  argument-hint: "<task>"\n---\n${body}\n`,
  );
  for (const [file, text] of Object.entries(refs)) {
    writeFileSync(join(dir, 'references', file), text);
  }
}

function writeScript(root: string, skill: string, name: string, body: string): void {
  const dir = join(root, skill, 'scripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('reads a scalar description and the argument hint', () => {
    const fm = parseFrontmatter(
      '---\nname: a-b\ndescription: One line.\nmetadata:\n  author: x\n  argument-hint: "[flag] <task>"\n---\nbody',
    );
    expect(fm).toEqual({ name: 'a-b', description: 'One line.', argumentHint: '[flag] <task>' });
  });

  it('joins a folded description block', () => {
    const fm = parseFrontmatter('---\nname: a\ndescription: >\n  first\n  second\n---\n');
    expect(fm?.description).toBe('first second');
  });

  it('joins a literal block with a chomping indicator and a plain multi-line scalar', () => {
    expect(
      parseFrontmatter('---\nname: a\ndescription: |-\n  first\n  second\n---\n')?.description,
    ).toBe('first second');
    expect(parseFrontmatter('---\nname: a\ndescription: first\n  second\n---\n')?.description).toBe(
      'first second',
    );
  });

  it('returns null without a frontmatter block', () => {
    expect(parseFrontmatter('# no frontmatter')).toBeNull();
  });
});

describe('validateFrontmatter', () => {
  it('rejects a name that differs from the directory', () => {
    const issues = validateFrontmatter('splitbrief-run', {
      name: 'splitbrief',
      description: 'x',
      argumentHint: 'y',
    });
    expect(issues.map((i) => i.message)).toEqual(['name "splitbrief" does not match directory']);
  });

  it('rejects uppercase names, long descriptions and a missing argument hint', () => {
    const issues = validateFrontmatter('Bad_Name', {
      name: 'Bad_Name',
      description: 'x'.repeat(1025),
      argumentHint: null,
    });
    expect(issues.map((i) => i.message)).toEqual([
      'name "Bad_Name" is not lowercase-kebab',
      'description is longer than 1024 characters',
      'metadata.argument-hint is missing',
    ]);
  });

  it('reports a missing frontmatter block', () => {
    expect(validateFrontmatter('x', null)).toEqual([
      { skill: 'x', message: 'no frontmatter block' },
    ]);
  });
});

describe('mentionedReferences', () => {
  it('collects unique sorted references/<file>.md mentions', () => {
    expect(
      mentionedReferences(
        'see references/gates.md and references/brief-format.md, references/gates.md',
      ),
    ).toEqual(['brief-format.md', 'gates.md']);
  });
});

describe('planSync + applySync', () => {
  it('reports missing references and scripts named by their source skills', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'references/missing.md');
    writeSkill(root, 'splitbrief-run', 'scripts/missing.sh');
    expect(planSync(root).issues).toEqual([
      { skill: 'splitbrief', message: 'references/missing.md is not in the splitbrief library' },
      {
        skill: 'splitbrief-run',
        message: 'scripts/missing.sh is not in the splitbrief-run library',
      },
    ]);
  });

  it('copies mentioned library files, flags stale mirrors and missing sources', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'uses references/gates.md only', {
      'gates.md': 'GATES',
      'family-map.md': 'MAP',
    });
    writeSkill(root, 'splitbrief-run', 'uses references/gates.md and references/nope.md', {
      'old.md': 'STALE',
    });

    const report = planSync(root);
    expect(report.issues).toEqual([
      { skill: 'splitbrief-run', message: 'references/nope.md is not in the splitbrief library' },
    ]);
    expect(report.actions).toEqual([
      { skill: 'splitbrief-run', file: 'gates.md', kind: 'copy' },
      { skill: 'splitbrief-run', file: 'old.md', kind: 'stale' },
    ]);
    expect(report.drift).toEqual([
      'splitbrief-run/references/gates.md',
      'splitbrief-run/references/old.md',
    ]);
    expect(report.warnings).toEqual([
      'splitbrief: references/family-map.md is never mentioned in SKILL.md',
    ]);

    applySync(root, report);
    expect(readFileSync(join(root, 'splitbrief-run/references/gates.md'), 'utf8')).toBe('GATES');
    expect(existsSync(join(root, 'splitbrief-run/references/old.md'))).toBe(false);
    expect(planSync(root).drift).toEqual([]);
  });

  it('refuses to plan any deletion when the library directory is missing', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief-run', 'references/gates.md', { 'gates.md': 'MIRROR' });
    const report = planSync(root);
    expect(report.issues).toEqual([
      { skill: 'splitbrief', message: 'references library directory is missing' },
    ]);
    expect(report.actions).toEqual([]);
    expect(runSyncCli(root, false, () => {})).toBe(1);
    expect(existsSync(join(root, 'splitbrief-run/references/gates.md'))).toBe(true);
  });

  it('reports drift when a mirror differs from the library', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'references/gates.md', { 'gates.md': 'NEW' });
    writeSkill(root, 'splitbrief-run', 'references/gates.md', { 'gates.md': 'OLD' });
    expect(planSync(root).drift).toEqual(['splitbrief-run/references/gates.md']);
  });

  it("copies only each entry point's explicit reference list", () => {
    const root = makeSkillsRoot();
    const library = {
      'family-map.md': 'MAP',
      'planning.md': 'PLAN',
      'run-protocol.md': 'RUN',
      'recovery.md': 'RECOVER',
      'review-format.md': 'REVIEW',
    };
    writeSkill(
      root,
      'splitbrief',
      Object.keys(library)
        .map((file) => `references/${file}`)
        .join('\n'),
      library,
    );
    const entries = {
      'splitbrief-brief': ['family-map.md', 'planning.md'],
      'splitbrief-run': ['family-map.md', 'run-protocol.md', 'recovery.md', 'review-format.md'],
      'splitbrief-review': ['family-map.md', 'recovery.md', 'review-format.md'],
    };
    for (const [skill, refs] of Object.entries(entries)) {
      writeSkill(root, skill, refs.map((file) => `references/${file}`).join('\n'), {
        'old.md': 'STALE',
      });
    }
    expect(runSyncCli(root, false, () => {})).toBe(0);
    for (const [skill, refs] of Object.entries(entries)) {
      expect(readdirSync(join(root, skill, 'references')).sort()).toEqual([...refs].sort());
      for (const file of refs) {
        expect(readFileSync(join(root, skill, 'references', file), 'utf8')).toBe(
          readFileSync(join(root, 'splitbrief', 'references', file), 'utf8'),
        );
      }
    }
    expect(runSyncCli(root, true, () => {})).toBe(0);
  });

  it('installs each pipeline skill alone with its complete reference and script dependencies', () => {
    const source = new URL('../skills/', import.meta.url);
    expect(readdirSync(new URL('splitbrief/references/', source)).sort()).toEqual([
      'brief-format.md',
      'family-map.md',
      'gates.md',
      'implementer-prompt.md',
      'planning.md',
      'recovery.md',
      'review-format.md',
      'run-protocol.md',
      'tool-recipes.md',
    ]);
    const root = makeSkillsRoot();
    for (const skill of ['splitbrief', 'splitbrief-brief', 'splitbrief-run', 'splitbrief-review']) {
      const installed = join(root, skill);
      cpSync(new URL(skill, source), installed, { recursive: true });
      const entry = readFileSync(join(installed, 'SKILL.md'), 'utf8');
      const refs = mentionedReferences(entry);
      const scripts = mentionedScripts(entry);
      expect(readdirSync(join(installed, 'references')).sort()).toEqual(refs);
      const texts = [
        entry,
        ...refs.map((file) => readFileSync(join(installed, 'references', file), 'utf8')),
      ];
      for (const text of texts) {
        for (const file of mentionedReferences(text)) {
          expect(refs, `${skill}: references/${file}`).toContain(file);
        }
        for (const file of mentionedScripts(text)) {
          expect(scripts, `${skill}: scripts/${file}`).toContain(file);
        }
      }
      for (const file of scripts) {
        const script = join(installed, 'scripts', file);
        const original = new URL(`splitbrief-run/scripts/${file}`, source);
        expect(readFileSync(script)).toEqual(readFileSync(original));
        expect(statSync(script).mode & 0o111).toBe(statSync(original).mode & 0o111);
      }
    }
  });
});

describe('generated regions', () => {
  it('rewrites a stale region, keeps a fresh one, and reports unknown ids untouched', () => {
    const text = `intro\n${region('known', 'OLD\n')}\nmid\n${region('mystery', 'X\n')}\n`;
    const result = renderGeneratedRegions(text, GEN);
    expect(result.changed).toEqual(['known']);
    expect(result.unknown).toEqual(['mystery']);
    expect(result.text).toBe(
      `intro\n${region('known', 'FRESH\n')}\nmid\n${region('mystery', 'X\n')}\n`,
    );
    expect(renderGeneratedRegions(result.text, GEN).changed).toEqual([]);
  });

  it('plans stale library blocks and applies them before mirroring', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'references/gates.md', {
      'gates.md': `head\n${region('known', 'OLD\n')}\n`,
    });
    writeSkill(root, 'splitbrief-run', 'references/gates.md', {
      'gates.md': `head\n${region('known', 'OLD\n')}\n`,
    });
    expect(planGenerated(root, GEN)).toEqual({
      issues: [],
      stale: ['splitbrief/references/gates.md#known'],
    });
    applyGenerated(root, GEN);
    expect(readFileSync(join(root, 'splitbrief/references/gates.md'), 'utf8')).toBe(
      `head\n${region('known', 'FRESH\n')}\n`,
    );
    expect(planGenerated(root, GEN).stale).toEqual([]);
    expect(planSync(root).drift).toEqual(['splitbrief-run/references/gates.md']);
  });

  it('fails the check on a stale block or an unknown id, and sync repairs the stale one', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'references/gates.md and references/x.md', {
      'gates.md': region('known', 'OLD\n'),
      'x.md': region('mystery', 'X\n'),
    });
    const lines: string[] = [];
    expect(runSyncCli(root, true, (l) => lines.push(l), GEN)).toBe(1);
    expect(lines).toContain('  ✗ splitbrief/references/gates.md#known out of date');
    expect(lines).toContain(
      '  ✗ splitbrief: references/x.md has no renderer for generated block "mystery"',
    );
    expect(runSyncCli(root, false, () => {}, GEN)).toBe(1);
    expect(readFileSync(join(root, 'splitbrief/references/gates.md'), 'utf8')).toBe(
      region('known', 'FRESH\n'),
    );
  });
});

describe('SKILL.md and script regions', () => {
  it('SKILL.md generated regions are checked', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', `intro\n${region('known', 'FRESH\n')}\n`);
    expect(planGenerated(root, GEN).stale).toEqual([]);
    writeSkill(root, 'splitbrief', `intro\n${region('mystery', 'X\n')}\n`);
    expect(planGenerated(root, GEN).issues).toEqual([
      {
        skill: 'splitbrief',
        message: 'SKILL.md has no renderer for generated block "mystery"',
      },
    ]);
  });

  it('stale generated region in SKILL.md fails --check', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', `intro\n${region('known', 'OLD\n')}\n`);
    const lines: string[] = [];
    expect(runSyncCli(root, true, (l) => lines.push(l), GEN)).toBe(1);
    expect(lines).toContain('  ✗ splitbrief/SKILL.md#known out of date');
    expect(runSyncCli(root, false, () => {}, GEN)).toBe(0);
    expect(readFileSync(join(root, 'splitbrief/SKILL.md'), 'utf8')).toContain(
      region('known', 'FRESH\n'),
    );
  });

  it('scripts mirror like references', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'runs scripts/wait.sh');
    writeSkill(root, 'splitbrief-run', 'owns scripts/wait.sh');
    writeScript(root, 'splitbrief-run', 'wait.sh', '#!/bin/sh\nexit 0\n');

    expect(planSync(root).actions).toContainEqual({
      skill: 'splitbrief',
      file: 'scripts/wait.sh',
      kind: 'copy',
    });
    expect(planSync(root).drift).toContain('splitbrief/scripts/wait.sh');

    expect(runSyncCli(root, false, () => {})).toBe(0);
    const mirror = join(root, 'splitbrief/scripts/wait.sh');
    expect(readFileSync(mirror, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(statSync(mirror).mode & 0o111).toBe(0o111);
    expect(runSyncCli(root, true, () => {})).toBe(0);
  });

  it('repairs a script mirror that lost its executable bits', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'scripts/wait.sh');
    writeSkill(root, 'splitbrief-run', 'scripts/wait.sh');
    writeScript(root, 'splitbrief-run', 'wait.sh', '#!/bin/sh\nexit 0\n');
    expect(runSyncCli(root, false, () => {})).toBe(0);
    const mirror = join(root, 'splitbrief/scripts/wait.sh');
    chmodSync(mirror, 0o644);
    expect(runSyncCli(root, true, () => {})).toBe(1);
    expect(runSyncCli(root, false, () => {})).toBe(0);
    expect(statSync(mirror).mode & 0o111).toBe(0o111);
  });

  it('shell generated regions are checked', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief-run', 'owns scripts/wait.sh');
    writeScript(root, 'splitbrief-run', 'wait.sh', '# generated: known\nOLD\n# /generated\n');
    writeSkill(root, 'splitbrief', 'no refs');
    const lines: string[] = [];
    expect(runSyncCli(root, true, (l) => lines.push(l), GEN)).toBe(1);
    expect(lines).toContain('  ✗ splitbrief-run/scripts/wait.sh#known out of date');
    applyGenerated(root, GEN);
    expect(readFileSync(join(root, 'splitbrief-run/scripts/wait.sh'), 'utf8')).toBe(
      '# generated: known\nFRESH\n# /generated\n',
    );
  });
});

describe('runSyncCli', () => {
  it('returns 1 in check mode when mirrors drift and 0 after syncing', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'references/gates.md', { 'gates.md': 'G' });
    writeSkill(root, 'splitbrief-brief', 'references/gates.md');
    const lines: string[] = [];
    expect(runSyncCli(root, true, (l) => lines.push(l))).toBe(1);
    expect(lines).toContain('  ✗ splitbrief-brief/references/gates.md out of sync');
    expect(runSyncCli(root, false, () => {})).toBe(0);
    expect(runSyncCli(root, true, () => {})).toBe(0);
  });

  it('returns 1 on a frontmatter issue even when mirrors are clean', () => {
    const root = makeSkillsRoot();
    writeSkill(root, 'splitbrief', 'no refs');
    mkdirSync(join(root, 'wrong'));
    writeFileSync(join(root, 'wrong/SKILL.md'), '---\nname: other\ndescription: x\n---\n');
    expect(runSyncCli(root, true, () => {})).toBe(1);
  });
});
