import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillMeta } from '../core/skills/types.js';
import { SPLITBRIEF_DIR } from '../core/paths.js';
import { installDiagnosticSink } from '../lib/warn.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let ROOT: string;
let TMP: string;
let FAKE_HOME: string;
let OUTSIDE: string;
let originalHome: string | undefined;

beforeAll(() => {
  ROOT = createTempDir('skills-test');
  TMP = join(ROOT, 'project');
  FAKE_HOME = join(TMP, '__home__');
  OUTSIDE = join(ROOT, 'outside');
  originalHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
});

afterAll(() => {
  process.env.HOME = originalHome;
  cleanupTempDir(ROOT);
});

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(FAKE_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// Dynamic import after HOME is set so homedir() picks it up
const { discoverSkills, loadSkillContent, buildSkillsSection, skillRoot } = await import(
  './skill-discovery.js'
);

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

  // This repository links `.claude/skills/splitbrief-babysit` for Claude Code, so a run on it
  // would otherwise offer the skill that supervises the run.
  it('the four pipeline skills and the babysit skill are never discovered', async () => {
    for (const id of [
      'splitbrief',
      'splitbrief-brief',
      'splitbrief-run',
      'splitbrief-review',
      'splitbrief-babysit',
    ]) {
      writeSkillDir(projectRoot('.claude'), id, `name: ${id}\ndescription: d`);
    }
    writeFlatSkill(projectRoot('.claude'), 'keeper', 'name: Keeper\ndescription: d');

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['keeper']);
  });

  it('hides the portable splitbrief pipeline skills but keeps the repo dev skills', async () => {
    writeSkillDir(projectRoot('.claude'), 'splitbrief', 'name: splitbrief\ndescription: d');
    writeSkillDir(projectRoot('.agents'), 'splitbrief-run', 'name: splitbrief-run\ndescription: d');
    writeFlatSkill(
      projectRoot('.claude'),
      'splitbrief-dev',
      'name: splitbrief-dev\ndescription: d',
    );

    const skills = await discoverSkills(TMP);
    expect(skills.map((s: SkillMeta) => s.id)).toEqual(['splitbrief-dev']);
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

    const { content } = await loadSkillContent(skills);
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

  it('keeps a skill whose frontmatter is not valid YAML and logs the fallback once, only when it is loaded', async () => {
    const diagnostics: { message: string; presentation: string }[] = [];
    const release = installDiagnosticSink((message, presentation) => {
      diagnostics.push({ message, presentation });
    });
    try {
      writeSkillDir(
        projectRoot('.claude'),
        'jargon-leak',
        'name: Jargon Leak\ndescription: Use when auditing prose. Triggers: "jargon", "buzzword"',
      );
      writeSkillDir(projectRoot('.claude'), 'canary', 'name: Canary\ndescription: d');

      const skills = await discoverSkills(TMP);
      const jargon = skills.find((s: SkillMeta) => s.id === 'jargon-leak');
      const canary = skills.find((s: SkillMeta) => s.id === 'canary');
      if (jargon === undefined || canary === undefined) throw new Error('expected both skills');
      expect(jargon.name).toBe('Jargon Leak');
      expect(jargon.description).toBe('Use when auditing prose. Triggers: "jargon", "buzzword"');
      await loadSkillContent([canary]);
      expect(diagnostics).toEqual([]);

      await loadSkillContent([jargon]);
      await loadSkillContent([jargon]);
      expect(diagnostics).toEqual([
        {
          message: expect.stringContaining('recovered by line scan'),
          presentation: 'log-only',
        },
      ]);
    } finally {
      release();
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
    expect(await loadSkillContent([])).toEqual({ content: '', omitted: [], unread: [] });
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

    const { content } = await loadSkillContent(skills);
    expect(content).toContain('### Test');
    expect(content).toContain('# Content here');
    expect(content).not.toContain('---');
  });

  it('names a body over the budget by path and never cuts it', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'big.md'),
      `---\nname: Big\ndescription: Huge\n---\n${'x'.repeat(20_000)}`,
    );

    const { content, omitted } = await loadSkillContent([
      {
        id: 'big',
        name: 'Big',
        description: 'Huge',
        path: join(skillsDir, 'big.md'),
        scope: 'project',
      },
    ]);

    expect(content).toBe(
      `### Big\nFile: ${join(skillsDir, 'big.md')}\n\n[1 file not inlined: budget 16000 chars — big.md]`,
    );
    expect(omitted).toEqual(['Big']);
  });

  it('names every body that does not fit and reports its skill', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'first.md'),
      `---\nname: First\ndescription: Fills budget\n---\n${'x'.repeat(16_000)}`,
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

    const { content, omitted } = await loadSkillContent([
      mk('first', 'First'),
      mk('second', 'Second'),
      mk('third', 'Third'),
    ]);

    expect(omitted).toEqual(['Second', 'Third']);
    expect(content).toContain('### First');
    expect(content).not.toContain('Second body');
    expect(content).not.toContain('Third body');
    expect(content).toContain(
      `### Second\nFile: ${join(skillsDir, 'second.md')}\n\n[1 file not inlined: budget 16000 chars — second.md]`,
    );
  });

  it('inlines a later body that still fits after one that did not', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
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

    const { content, omitted } = await loadSkillContent([
      mk('a', 'Alpha'),
      mk('b', 'Beta'),
      mk('c', 'Gamma'),
    ]);

    expect(omitted).toEqual(['Beta']);
    expect(content).not.toContain('b'.repeat(100));
    expect(content).toContain('[1 file not inlined: budget 16000 chars — b.md]');
    expect(content).toContain('Gamma body');
  });
});

describe('loadSkillContent — base directory and references', () => {
  function projectSkill(id: string, name: string): SkillMeta {
    return {
      id,
      name,
      description: '',
      path: join(projectRoot('.claude'), id, 'SKILL.md'),
      scope: 'project',
      projectDir: TMP,
      dir: join(projectRoot('.claude'), id),
    };
  }

  function writeReference(skillDir: string, name: string, text: string): void {
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', name), text);
  }

  it('states a project skill base directory relative to the project root', async () => {
    writeSkillDir(projectRoot('.claude'), 'auth', 'name: AuthSkill\ndescription: d', 'AUTH-BODY');

    const { content } = await loadSkillContent([projectSkill('auth', 'AuthSkill')]);

    expect(content).toContain(
      '### AuthSkill\nBase directory: .claude/skills/auth (relative to the project root)\n\nAUTH-BODY',
    );
  });

  it('states a global skill base directory as its absolute path', async () => {
    const dir = writeSkillDir(globalRoot('.claude'), 'global', 'name: Global\ndescription: d', 'G');

    const { content } = await loadSkillContent(await discoverSkills(TMP));

    expect(content).toContain(`### Global\nBase directory: ${realpathSync(dir)}\n\nG`);
  });

  it('states a loose global skill by its own file, the one path it owns', async () => {
    writeFlatSkill(globalRoot('.claude'), 'loose', 'name: Loose\ndescription: d', 'LOOSE-BODY');

    const { content } = await loadSkillContent(await discoverSkills(TMP));

    const file = realpathSync(join(globalRoot('.claude'), 'loose.md'));
    expect(content).toContain(`### Loose\nFile: ${file}\n\nLOOSE-BODY`);
  });

  it('owns only its file when a loose SKILL.md sits at the top of a root', async () => {
    const root = globalRoot('.claude');
    writeFlatSkill(root, 'SKILL', 'name: Rooted\ndescription: d', 'ROOTED-BODY');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'references', 'sibling.md'), 'SIBLING-REFERENCE');

    const [rooted] = await discoverSkills(TMP);
    if (rooted === undefined) throw new Error('expected the loose SKILL.md skill');
    const { content } = await loadSkillContent([rooted]);

    const file = realpathSync(join(root, 'SKILL.md'));
    expect(skillRoot(rooted)).toBe(file);
    expect(content).toContain(`### Rooted\nFile: ${file}\n\nROOTED-BODY`);
    expect(content).not.toContain('SIBLING-REFERENCE');
  });

  it('inlines the markdown references after the body while they fit the budget', async () => {
    const dir = writeSkillDir(
      projectRoot('.claude'),
      'auth',
      'name: AuthSkill\ndescription: d',
      'B',
    );
    writeReference(dir, 'tokens.md', 'TOKENS-REFERENCE');
    writeReference(dir, 'api.md', 'API-REFERENCE');
    writeFileSync(join(dir, 'references', 'notes.txt'), 'NOT-MARKDOWN');

    const { content, omitted } = await loadSkillContent([projectSkill('auth', 'AuthSkill')]);

    expect(content).toContain(
      'B\n\n#### references/api.md\nAPI-REFERENCE\n\n#### references/tokens.md\nTOKENS-REFERENCE',
    );
    expect(content).not.toContain('NOT-MARKDOWN');
    expect(omitted).toEqual([]);
  });

  it('names a reference over the budget instead of inlining it, as the normal case', async () => {
    const dir = writeSkillDir(
      projectRoot('.claude'),
      'auth',
      'name: AuthSkill\ndescription: d',
      'B',
    );
    writeReference(dir, 'big.md', 'x'.repeat(16_000));
    writeReference(dir, 'small.md', 'SMALL-REFERENCE');

    const { content, omitted } = await loadSkillContent([projectSkill('auth', 'AuthSkill')]);

    expect(content).toContain('#### references/small.md\nSMALL-REFERENCE');
    expect(content).not.toContain('x'.repeat(100));
    expect(content).toContain('[1 file not inlined: budget 16000 chars — references/big.md]');
    expect(omitted).toEqual([]);
  });

  it('spends the budget on every selected body before any reference', async () => {
    const first = writeSkillDir(projectRoot('.claude'), 'first', 'name: First\ndescription: d');
    writeReference(first, 'guide.md', 'g'.repeat(10_000));
    writeSkillDir(
      projectRoot('.claude'),
      'second',
      'name: Second\ndescription: d',
      's'.repeat(8_000),
    );

    const { content, omitted } = await loadSkillContent([
      projectSkill('first', 'First'),
      projectSkill('second', 'Second'),
    ]);

    expect(content).toContain('s'.repeat(8_000));
    expect(content).toContain('[1 file not inlined: budget 16000 chars — references/guide.md]');
    expect(omitted).toEqual([]);
  });

  it('keeps a large body whole, then inlines references into what is left, then names the rest', async () => {
    const body = 'B'.repeat(9_500);
    const dir = writeSkillDir(projectRoot('.claude'), 'discipline', 'name: Discipline', body);
    writeReference(dir, 'a.md', 'x'.repeat(3_000));
    writeReference(dir, 'b.md', 'y'.repeat(5_000));
    writeReference(dir, 'c.md', 'z'.repeat(2_000));
    writeReference(dir, 'd.md', 'w'.repeat(21_000));

    const { content, omitted } = await loadSkillContent([projectSkill('discipline', 'Discipline')]);

    expect(content).not.toContain('[... truncated]');
    const order = [
      `${body}\n\n#### references/a.md`,
      '#### references/c.md',
      '[2 files not inlined: budget 16000 chars — references/b.md, references/d.md]',
    ].map((part) => content.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(content).not.toContain('y'.repeat(100));
    expect(omitted).toEqual([]);
  });

  it('names a body that does not fit and its references by path, and inlines none of them', async () => {
    const dir = writeSkillDir(projectRoot('.claude'), 'big', 'name: Big', 'B'.repeat(17_000));
    writeReference(dir, 'a.md', 'A-REFERENCE');

    const { content, omitted } = await loadSkillContent([projectSkill('big', 'Big')]);

    expect(content).toBe(
      '### Big\nBase directory: .claude/skills/big (relative to the project root)\n\n[2 files not inlined: budget 16000 chars — SKILL.md, references/a.md]',
    );
    expect(omitted).toEqual(['Big']);
  });

  it("warns when a skill's references cannot be listed, and loads the skill", async () => {
    const diagnostics: string[] = [];
    const release = installDiagnosticSink((message) => {
      diagnostics.push(message);
    });
    const dir = writeSkillDir(projectRoot('.claude'), 'auth', 'name: AuthSkill', 'AUTH-BODY');
    writeReference(dir, 'a.md', 'A-REFERENCE');
    chmodSync(join(dir, 'references'), 0o000);
    try {
      const { content } = await loadSkillContent([projectSkill('auth', 'AuthSkill')]);

      expect(content).toContain('AUTH-BODY');
      expect(diagnostics).toEqual([
        expect.stringContaining(`Failed to list skill references ${join(dir, 'references')}`),
      ]);
    } finally {
      chmodSync(join(dir, 'references'), 0o700);
      release();
    }
  });

  it('reads no references for a loose .md skill or for AGENTS.md', async () => {
    const root = projectRoot('.claude');
    writeFlatSkill(root, 'loose', 'name: Loose\ndescription: d', 'LOOSE-BODY');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'references', 'shared.md'), 'SHARED-REFERENCE');
    writeFileSync(join(TMP, 'AGENTS.md'), '---\nname: Agent Rules\ndescription: d\n---\nAGENTS');
    mkdirSync(join(TMP, 'references'), { recursive: true });
    writeFileSync(join(TMP, 'references', 'root.md'), 'ROOT-REFERENCE');

    const { content } = await loadSkillContent(await discoverSkills(TMP));

    expect(content).toContain(
      'File: .claude/skills/loose.md (relative to the project root)\n\nLOOSE-BODY',
    );
    expect(content).toContain('File: AGENTS.md (relative to the project root)\n\nAGENTS');
    expect(content).not.toContain('SHARED-REFERENCE');
    expect(content).not.toContain('ROOT-REFERENCE');
  });

  it('never inlines a project reference that resolves outside the project', async () => {
    const dir = writeSkillDir(
      projectRoot('.claude'),
      'auth',
      'name: AuthSkill\ndescription: d',
      'B',
    );
    mkdirSync(OUTSIDE, { recursive: true });
    writeFileSync(join(OUTSIDE, 'secret.md'), 'OUTSIDE-SECRET');
    symlinkSync(OUTSIDE, join(dir, 'references'));

    const { content } = await loadSkillContent([projectSkill('auth', 'AuthSkill')]);

    expect(content).toContain('### AuthSkill');
    expect(content).not.toContain('OUTSIDE-SECRET');
  });
});

describe('buildSkillsSection', () => {
  it('returns empty string for no skills', async () => {
    expect(await buildSkillsSection([])).toEqual({ section: '', omitted: [], unread: [] });
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

    const { section, omitted } = await buildSkillsSection(skills);
    expect(section).toMatch(/^## Active Project Skills/);
    expect(section).toContain('### Test');
    expect(section).toContain('Body');
    expect(omitted).toEqual([]);
  });
});
