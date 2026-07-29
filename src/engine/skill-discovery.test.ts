import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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

describe('discoverSkills', () => {
  it('discovers project claude-code skills from flat .md files', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'test-skill.md'),
      '---\nname: Test Skill\ndescription: A test\n---\nContent',
    );

    const skills = await discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('test-skill');
    expect(proj[0]?.name).toBe('Test Skill');
  });

  it('tags discovered project skills with the project directory and reads them confined', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'confined.md'),
      '---\nname: Confined\ndescription: Read via confinement\n---\nConfined body',
    );

    const skills = await discoverSkills('claude-code', TMP);
    const proj = skills.find((s: SkillMeta) => s.scope === 'project');
    expect(proj?.projectDir).toBe(TMP);

    const content = await loadSkillContent(skills);
    expect(content).toContain('### Confined');
    expect(content).toContain('Confined body');
  });

  it('discovers claude-code skills from subdirectory SKILL.md', async () => {
    const skillDir = join(TMP, '.claude', 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: My Skill\ndescription: Sub skill\n---\nContent',
    );

    const skills = await discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('my-skill');
  });

  it('discovers global claude-code skills', async () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, 'global-skill.md'),
      '---\nname: Global Skill\ndescription: From home\n---\nContent',
    );

    const skills = await discoverSkills('claude-code', TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.scope).toBe('global');
    expect(skills[0]?.id).toBe('global-skill');
  });

  it('project skills override global skills with same id', async () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, 'shared.md'),
      '---\nname: Global Version\ndescription: From home\n---\nGlobal',
    );

    const projDir = join(TMP, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'shared.md'),
      '---\nname: Project Version\ndescription: From project\n---\nProject',
    );

    const skills = await discoverSkills('claude-code', TMP);
    const shared = skills.filter((s: SkillMeta) => s.id === 'shared');
    expect(shared.length).toBe(1);
    expect(shared[0]?.scope).toBe('project');
    expect(shared[0]?.name).toBe('Project Version');
  });

  it('merges global and project skills', async () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, 'only-global.md'),
      '---\nname: Only Global\ndescription: G\n---\nContent',
    );

    const projDir = join(TMP, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'only-project.md'),
      '---\nname: Only Project\ndescription: P\n---\nContent',
    );

    const skills = await discoverSkills('claude-code', TMP);
    expect(skills.length).toBe(2);
    expect(skills.find((s: SkillMeta) => s.id === 'only-project')?.scope).toBe('project');
    expect(skills.find((s: SkillMeta) => s.id === 'only-global')?.scope).toBe('global');
  });

  it('discovers codex AGENTS.md', async () => {
    writeFileSync(
      join(TMP, 'AGENTS.md'),
      '---\nname: Agent Rules\ndescription: Root rules\n---\nContent',
    );

    const skills = await discoverSkills('codex', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('agents-root');
  });

  it('discovers aider CONVENTIONS.md', async () => {
    writeFileSync(
      join(TMP, 'CONVENTIONS.md'),
      '---\nname: Conventions\ndescription: Project conventions\n---\nContent',
    );

    const skills = await discoverSkills('aider', TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe('conventions');
    expect(skills[0]?.scope).toBe('project');
  });

  it('surfaces a non-ENOENT CONVENTIONS.md read error without crashing discovery', async () => {
    // A directory at the expected file path makes readFile fail with EISDIR (non-ENOENT).
    const convPath = join(TMP, 'CONVENTIONS.md');
    mkdirSync(convPath, { recursive: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const skills = await discoverSkills('aider', TMP);
      expect(skills).toEqual([]);
      const warned = stderrSpy.mock.calls.some((c) => String(c[0]).includes('CONVENTIONS.md'));
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('falls back to .splitbrief/skills for shell planner', async () => {
    const skillsDir = join(TMP, SPLITBRIEF_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'custom.md'),
      '---\nname: Custom\ndescription: Custom skill\n---\nContent',
    );

    const skills = await discoverSkills('shell', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('custom');
  });

  it('discovers skills from symlinked directories', async () => {
    const realDir = join(TMP, '__real-skill');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      join(realDir, 'SKILL.md'),
      '---\nname: Symlinked\ndescription: Via symlink\n---\nContent',
    );

    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    symlinkSync(realDir, join(globalDir, 'symlinked-skill'));

    const skills = await discoverSkills('claude-code', TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe('symlinked-skill');
    expect(skills[0]?.scope).toBe('global');
  });

  it('returns empty array when no skills exist', async () => {
    expect(await discoverSkills('claude-code', TMP)).toEqual([]);
  });

  it('skips files without valid frontmatter', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'bad.md'), '# No frontmatter');
    writeFileSync(join(skillsDir, 'good.md'), '---\nname: Good\ndescription: Valid\n---\nContent');

    const skills = await discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.name).toBe('Good');
  });

  it('skips skill files when frontmatter omits name', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'no-name.md'),
      '---\ndescription: Missing name field\n---\nContent',
    );
    writeFileSync(
      join(skillsDir, 'named.md'),
      '---\nname: Named\ndescription: Has name\n---\nContent',
    );

    const skills = await discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.map((s) => s.id)).toEqual(['named']);
    expect(proj[0]?.name).toBe('Named');
    expect(proj[0]?.description).toBe('Has name');
  });

  it('uses empty description when frontmatter omits description', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'no-desc.md'), '---\nname: No Desc\n---\nContent');

    const skills = await discoverSkills('claude-code', TMP);
    const skill = skills.find((s: SkillMeta) => s.id === 'no-desc');
    expect(skill?.name).toBe('No Desc');
    expect(skill?.description).toBe('');
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
    expect(section.startsWith('## Active Project Skills')).toBeTruthy();
    expect(section).toContain('### Test');
    expect(section).toContain('Body');
  });
});
