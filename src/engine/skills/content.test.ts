import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillMeta } from '../../core/skills/types.js';
import { resetLoggerForTests } from '../../lib/logger.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { writeFlatSkill, writeSkillDir } from '#testing/helpers/skill-fixtures.js';

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
  resetLoggerForTests();
  rmSync(TMP, { recursive: true, force: true });
});

// Dynamic import after HOME is set so homedir() picks it up
const { discoverSkills } = await import('./discover.js');
const { loadSkillContent, buildSkillsSection, skillRoot } = await import('./content.js');

afterEach(() => {
  rmSync(OUTSIDE, { recursive: true, force: true });
});

function projectRoot(tool: string): string {
  return join(TMP, tool, 'skills');
}

function globalRoot(...segments: string[]): string {
  return join(FAKE_HOME, ...segments, 'skills');
}

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
    enableDebugLog(TMP);
    const dir = writeSkillDir(projectRoot('.claude'), 'auth', 'name: AuthSkill', 'AUTH-BODY');
    writeReference(dir, 'a.md', 'A-REFERENCE');
    chmodSync(join(dir, 'references'), 0o000);
    try {
      const { content } = await loadSkillContent([projectSkill('auth', 'AuthSkill')]);

      expect(content).toContain('AUTH-BODY');
      expect(loggedDiagnostics(TMP)).toEqual([
        expect.stringContaining(`Failed to list skill references ${join(dir, 'references')}`),
      ]);
    } finally {
      chmodSync(join(dir, 'references'), 0o700);
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
