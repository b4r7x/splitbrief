import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGenerated,
  applySync,
  mentionedReferences,
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

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('reads a scalar description and the argument hint', () => {
    const fm = parseFrontmatter(
      '---\nname: a-b\ndescription: One line.\nmetadata:\n  author: x\n  argument-hint: "[mode] <task>"\n---\nbody',
    );
    expect(fm).toEqual({ name: 'a-b', description: 'One line.', argumentHint: '[mode] <task>' });
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
