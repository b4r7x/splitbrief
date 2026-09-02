import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillMeta } from '../core/skills/types.js';
import { SPLITBRIEF_DIR } from '../core/paths.js';

const TMP = join(import.meta.dirname, '.tmp-skills-test');
const FAKE_HOME = join(TMP, '__home__');

let originalHome: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
});

afterAll(() => {
  process.env.HOME = originalHome;
});

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(FAKE_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// Dynamic import after HOME is set so homedir() picks it up
const { discoverSkills, loadSkillContent, buildSkillsSection } = await import(
  './skill-discovery.js'
);

const OUTSIDE = join(import.meta.dirname, '.tmp-skills-outside');

afterEach(() => {
  rmSync(OUTSIDE, { recursive: true, force: true });
});

function projectRoot(tool: string): string {
  return join(TMP, tool, 'skills');
}

function globalRoot(...segments: string[]): string {
  return join(FAKE_HOME, ...segments, 'skills');
}

function writeFlatSkill(root: string, id: string, frontmatter: string, body = 'Content'): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\n${frontmatter}\n---\n${body}`);
}

function writeSkillDir(parent: string, id: string, frontmatter: string, body = 'Content'): string {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

describe('discoverSkills', () => {
  it('discovers project skills from every project root', async () => {
    writeFlatSkill(projectRoot(SPLITBRIEF_DIR), 'sb-skill', 'name: SB\ndescription: d');
    writeFlatSkill(projectRoot('.claude'), 'cc-skill', 'name: CC\ndescription: d');
    writeFlatSkill(projectRoot('.agents'), 'ag-skill', 'name: AG\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id).sort()).toEqual(['ag-skill', 'cc-skill', 'sb-skill']);
    expect(skills.every((s: SkillMeta) => s.scope === 'project')).toBe(true);
  });

  it('discovers global skills from every global root', async () => {
    writeFlatSkill(globalRoot(SPLITBRIEF_DIR), 'g-sb', 'name: SB\ndescription: d');
    writeFlatSkill(globalRoot('.claude'), 'g-cc', 'name: CC\ndescription: d');
    writeFlatSkill(globalRoot('.agents'), 'g-ag', 'name: AG\ndescription: d');
    writeFlatSkill(globalRoot('.codex'), 'g-cx', 'name: CX\ndescription: d');
    writeFlatSkill(globalRoot('.config', 'opencode'), 'g-oc', 'name: OC\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id).sort()).toEqual([
      'g-ag',
      'g-cc',
      'g-cx',
      'g-oc',
      'g-sb',
    ]);
    expect(skills.every((s: SkillMeta) => s.scope === 'global')).toBe(true);
  });

  it('project scope outranks global for the same id', async () => {
    writeFlatSkill(globalRoot('.claude'), 'shared', 'name: Global Version\ndescription: g');
    writeFlatSkill(projectRoot('.claude'), 'shared', 'name: Project Version\ndescription: p');

    const skills = await discoverSkills(TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.scope).toBe('project');
    expect(skills[0]?.name).toBe('Project Version');
  });

  it('splitbrief outranks claude outranks agents within a scope', async () => {
    writeFlatSkill(projectRoot(SPLITBRIEF_DIR), 'first', 'name: P Splitbrief\ndescription: d');
    writeFlatSkill(projectRoot('.claude'), 'first', 'name: P Claude\ndescription: d');
    writeFlatSkill(projectRoot('.agents'), 'first', 'name: P Agents\ndescription: d');
    writeFlatSkill(projectRoot('.claude'), 'second', 'name: P Claude 2\ndescription: d');
    writeFlatSkill(projectRoot('.agents'), 'second', 'name: P Agents 2\ndescription: d');

    writeFlatSkill(globalRoot(SPLITBRIEF_DIR), 'g-first', 'name: G Splitbrief\ndescription: d');
    writeFlatSkill(globalRoot('.claude'), 'g-first', 'name: G Claude\ndescription: d');
    writeFlatSkill(globalRoot('.agents'), 'g-first', 'name: G Agents\ndescription: d');
    writeFlatSkill(globalRoot('.codex'), 'g-second', 'name: G Codex\ndescription: d');
    writeFlatSkill(
      globalRoot('.config', 'opencode'),
      'g-second',
      'name: G Opencode\ndescription: d',
    );

    const skills = await discoverSkills(TMP);
    const byId = new Map(skills.map((s: SkillMeta) => [s.id, s.name]));
    expect(skills.length).toBe(4);
    expect(byId.get('first')).toBe('P Splitbrief');
    expect(byId.get('second')).toBe('P Claude 2');
    expect(byId.get('g-first')).toBe('G Splitbrief');
    expect(byId.get('g-second')).toBe('G Codex');
  });

  it('orders project entries before global entries', async () => {
    writeFlatSkill(globalRoot('.claude'), 'g-one', 'name: G One\ndescription: d');
    writeFlatSkill(globalRoot('.agents'), 'g-two', 'name: G Two\ndescription: d');
    writeFlatSkill(projectRoot('.claude'), 'p-one', 'name: P One\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.scope)).toEqual(['project', 'global', 'global']);
  });

  it('tags discovered project skills with the project directory and reads them confined', async () => {
    writeFlatSkill(
      projectRoot('.claude'),
      'confined',
      'name: Confined\ndescription: Read via confinement',
      'Confined body',
    );

    const skills = await discoverSkills(TMP);
    expect(skills[0]?.projectDir).toBe(TMP);

    const content = await loadSkillContent(skills);
    expect(content).toContain('### Confined');
    expect(content).toContain('Confined body');
  });

  it('keeps a SKILL.md that declares only a description, naming it after its directory', async () => {
    writeSkillDir(projectRoot('.claude'), 'desc-only', 'description: only a description');

    const skills = await discoverSkills(TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe('desc-only');
    expect(skills[0]?.name).toBe('desc-only');
    expect(skills[0]?.description).toBe('only a description');
  });

  it('uses empty description when frontmatter omits description', async () => {
    writeFlatSkill(projectRoot('.claude'), 'no-desc', 'name: No Desc');

    const skills = await discoverSkills(TMP);
    expect(skills[0]?.name).toBe('No Desc');
    expect(skills[0]?.description).toBe('');
  });

  it('skips files without any frontmatter block', async () => {
    const root = projectRoot('.claude');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'bad.md'), '# No frontmatter');
    writeFlatSkill(root, 'good', 'name: Good\ndescription: Valid');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['good']);
  });

  it('keeps a skill whose frontmatter is not valid YAML, warning about the fallback', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      writeSkillDir(
        projectRoot('.claude'),
        'jargon-leak',
        'name: Jargon Leak\ndescription: Use when auditing prose. Triggers: "jargon", "buzzword"',
      );

      const skills = await discoverSkills(TMP);
      expect(skills.map((s: SkillMeta) => s.id)).toEqual(['jargon-leak']);
      expect(skills[0]?.name).toBe('Jargon Leak');
      expect(skills[0]?.description).toBe(
        'Use when auditing prose. Triggers: "jargon", "buzzword"',
      );
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('finds a nested plugin-style skill', async () => {
    writeSkillDir(
      join(projectRoot('.claude'), 'pack'),
      'nested-skill',
      'name: Nested\ndescription: d',
    );

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['nested-skill']);
  });

  it('finds a skill nested at the deepest scanned level', async () => {
    writeSkillDir(
      join(projectRoot('.claude'), 'a', 'b', 'c'),
      'deep-skill',
      'name: Deep\ndescription: d',
    );

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['deep-skill']);
  });

  it('stops before a skill nested one level past the scan depth', async () => {
    writeSkillDir(
      join(projectRoot('.claude'), 'a', 'b', 'c', 'd'),
      'too-deep',
      'name: Too Deep\ndescription: d',
    );

    expect(await discoverSkills(TMP)).toEqual([]);
  });

  it('stops descending into a directory that is itself a skill', async () => {
    const outer = writeSkillDir(projectRoot('.claude'), 'outer', 'name: Outer\ndescription: d');
    writeSkillDir(outer, 'inner', 'name: Inner\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['outer']);
  });

  it('ignores nested loose .md files', async () => {
    const root = projectRoot('.claude');
    writeFlatSkill(root, 'flat', 'name: Flat\ndescription: d');
    writeFlatSkill(join(root, 'pack'), 'README', 'name: Readme\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['flat']);
  });

  it('skips node_modules and dot-directories inside a root', async () => {
    const root = projectRoot('.claude');
    writeSkillDir(join(root, 'node_modules'), 'vendored', 'name: Vendored\ndescription: d');
    writeSkillDir(join(root, '.hidden'), 'buried', 'name: Buried\ndescription: d');
    writeSkillDir(root, 'visible', 'name: Visible\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['visible']);
  });

  it('follows a symlinked skill directory in a global root', async () => {
    const realDir = writeSkillDir(join(TMP, '__real'), 'target', 'name: Symlinked\ndescription: d');
    const root = globalRoot('.claude');
    mkdirSync(root, { recursive: true });
    symlinkSync(realDir, join(root, 'symlinked-skill'));

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['symlinked-skill']);
    expect(skills[0]?.scope).toBe('global');
  });

  it('drops a project symlink that resolves outside the project', async () => {
    const realDir = writeSkillDir(
      OUTSIDE,
      'escaped',
      'name: Escaped\ndescription: d',
      'Escaped body',
    );
    const root = projectRoot('.claude');
    mkdirSync(root, { recursive: true });
    symlinkSync(realDir, join(root, 'linked-out'));

    expect(await discoverSkills(TMP)).toEqual([]);
  });

  it('drops a project skill root that is itself a symlink out of the project', async () => {
    mkdirSync(OUTSIDE, { recursive: true });
    writeSkillDir(OUTSIDE, 'escaped', 'name: Escaped\ndescription: d', 'Escaped body');
    mkdirSync(join(TMP, '.claude'), { recursive: true });
    symlinkSync(OUTSIDE, projectRoot('.claude'));

    expect(await discoverSkills(TMP)).toEqual([]);
  });

  it('keeps a project symlink that resolves inside the project confined', async () => {
    const realDir = writeSkillDir(join(TMP, '__real'), 'inside', 'name: Inside\ndescription: d');
    const root = projectRoot('.claude');
    mkdirSync(root, { recursive: true });
    symlinkSync(realDir, join(root, 'linked-in'));

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['linked-in']);
    expect(skills[0]?.projectDir).toBe(TMP);
  });

  it('emits the AGENTS.md pseudo-entry when the file exists', async () => {
    writeFileSync(
      join(TMP, 'AGENTS.md'),
      '---\nname: Agent Rules\ndescription: Root rules\n---\nC',
    );

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['agents-root']);
    expect(skills[0]?.scope).toBe('project');
    expect(skills[0]?.name).toBe('Agent Rules');
  });

  it('lets a real skill named agents-root win over the AGENTS.md pseudo-entry', async () => {
    writeFileSync(
      join(TMP, 'AGENTS.md'),
      '---\nname: Agent Rules\ndescription: Root rules\n---\nC',
    );
    writeFlatSkill(projectRoot('.claude'), 'agents-root', 'name: Real Root\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['agents-root']);
    expect(skills[0]?.name).toBe('Real Root');
  });

  it('returns an empty array when nothing exists', async () => {
    expect(await discoverSkills(TMP)).toEqual([]);
  });
});

describe('loadSkillContent', () => {
  it('returns empty string for no skills', async () => {
    expect(await loadSkillContent([])).toBe('');
  });

  it('loads skill content stripping frontmatter', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'test.md'),
      '---\nname: Test\ndescription: Desc\n---\n# Content here',
    );

    const skills: SkillMeta[] = [
      {
        id: 'test',
        name: 'Test',
        description: 'Desc',
        path: join(skillsDir, 'test.md'),
        scope: 'project',
      },
    ];

    const content = await loadSkillContent(skills);
    expect(content).toContain('### Test');
    expect(content).toContain('# Content here');
    expect(content).not.toContain('---');
  });

  it('truncates when exceeding budget', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bigContent = 'x'.repeat(20_000);
    writeFileSync(
      join(skillsDir, 'big.md'),
      `---\nname: Big\ndescription: Huge\n---\n${bigContent}`,
    );

    const skills: SkillMeta[] = [
      {
        id: 'big',
        name: 'Big',
        description: 'Huge',
        path: join(skillsDir, 'big.md'),
        scope: 'project',
      },
    ];

    const content = await loadSkillContent(skills);
    expect(content).toContain('[... truncated]');
    expect(content.length).toBeLessThan(20_000);
  });

  it('discloses skills fully dropped after the budget break', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bigContent = 'x'.repeat(16_000);
    writeFileSync(
      join(skillsDir, 'first.md'),
      `---\nname: First\ndescription: Fills budget\n---\n${bigContent}`,
    );
    writeFileSync(
      join(skillsDir, 'second.md'),
      '---\nname: Second\ndescription: Dropped\n---\nSecond body',
    );
    writeFileSync(
      join(skillsDir, 'third.md'),
      '---\nname: Third\ndescription: Dropped\n---\nThird body',
    );

    const mk = (id: string, name: string): SkillMeta => ({
      id,
      name,
      description: '',
      path: join(skillsDir, `${id}.md`),
      scope: 'project',
    });
    const skills: SkillMeta[] = [
      mk('first', 'First'),
      mk('second', 'Second'),
      mk('third', 'Third'),
    ];

    const content = await loadSkillContent(skills);
    expect(content).toContain('### First');
    expect(content).not.toContain('Second body');
    expect(content).not.toContain('Third body');
    expect(content).toContain('2 more selected skills omitted');
    expect(content).toContain('budget 16000 chars');
    expect(content).toContain('Second, Third');
  });

  it('names the partially-truncated skill plus the rest in the omission marker', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // First skill leaves >MIN_TRUNCATED_CHARS room so the second is partially truncated.
    writeFileSync(
      join(skillsDir, 'a.md'),
      `---\nname: Alpha\ndescription: ''\n---\n${'a'.repeat(15_000)}`,
    );
    writeFileSync(
      join(skillsDir, 'b.md'),
      `---\nname: Beta\ndescription: ''\n---\n${'b'.repeat(5_000)}`,
    );
    writeFileSync(join(skillsDir, 'c.md'), "---\nname: Gamma\ndescription: ''\n---\nGamma body");

    const mk = (id: string, name: string): SkillMeta => ({
      id,
      name,
      description: '',
      path: join(skillsDir, `${id}.md`),
      scope: 'project',
    });
    const skills: SkillMeta[] = [mk('a', 'Alpha'), mk('b', 'Beta'), mk('c', 'Gamma')];

    const content = await loadSkillContent(skills);
    expect(content).toContain('### Beta');
    expect(content).toContain('[... truncated]');
    expect(content).toContain('1 more selected skills omitted');
    expect(content).toContain('Gamma');
    expect(content).not.toContain('Gamma body');
  });
});

describe('buildSkillsSection', () => {
  it('returns empty string for no skills', async () => {
    expect(await buildSkillsSection([])).toBe('');
  });

  it('wraps content in Active Project Skills heading', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'test.md'), '---\nname: Test\ndescription: Desc\n---\nBody');

    const skills: SkillMeta[] = [
      {
        id: 'test',
        name: 'Test',
        description: 'Desc',
        path: join(skillsDir, 'test.md'),
        scope: 'project',
      },
    ];

    const section = await buildSkillsSection(skills);
    expect(section).toMatch(/^## Active Project Skills/);
    expect(section).toContain('### Test');
    expect(section).toContain('Body');
  });
});
