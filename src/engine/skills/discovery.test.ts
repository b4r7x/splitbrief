import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillMeta } from '../../core/skills/types.js';
import { DIPTYCH_DIR } from '../../core/paths.js';

const TMP = join(import.meta.dirname, '.tmp-skills-test');
const FAKE_HOME = join(TMP, '__home__');

let originalHome: string | undefined;

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(TMP, { recursive: true, force: true });
});

// Dynamic import after HOME is set so homedir() picks it up
const { parseFrontmatter, discoverSkills, loadSkillContent, buildSkillsSection } = await import('./discovery.js');

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const raw = `---\nname: my-skill\ndescription: Does things\n---\n# Content`;
    expect(parseFrontmatter(raw)).toEqual({ name: 'my-skill', description: 'Does things' });
  });

  it('returns null for missing frontmatter', () => {
    expect(parseFrontmatter('# Just markdown')).toBe(null);
  });

  it('returns null when name is missing', () => {
    const raw = `---\ndescription: No name\n---\n# Content`;
    expect(parseFrontmatter(raw)).toBe(null);
  });

  it('handles empty description', () => {
    const raw = `---\nname: skill-only\n---\n# Content`;
    expect(parseFrontmatter(raw)).toEqual({ name: 'skill-only', description: '' });
  });
});

describe('discoverSkills', () => {
  it('discovers project claude-code skills from flat .md files', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'test-skill.md'), '---\nname: Test Skill\ndescription: A test\n---\nContent');

    const skills = await discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('test-skill');
    expect(proj[0]?.name).toBe('Test Skill');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });

  it('discovers claude-code skills from subdirectory SKILL.md', async () => {
    const skillDir = join(TMP, '.claude', 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: My Skill\ndescription: Sub skill\n---\nContent');

    const skills = await discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('my-skill');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });

  it('discovers global claude-code skills', async () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'global-skill.md'), '---\nname: Global Skill\ndescription: From home\n---\nContent');

    const skills = await discoverSkills('claude-code', TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.scope).toBe('global');
    expect(skills[0]?.id).toBe('global-skill');

    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
  });

  it('project skills override global skills with same id', async () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'shared.md'), '---\nname: Global Version\ndescription: From home\n---\nGlobal');

    const projDir = join(TMP, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'shared.md'), '---\nname: Project Version\ndescription: From project\n---\nProject');

    const skills = await discoverSkills('claude-code', TMP);
    const shared = skills.filter((s: SkillMeta) => s.id === 'shared');
    expect(shared.length).toBe(1);
    expect(shared[0]?.scope).toBe('project');
    expect(shared[0]?.name).toBe('Project Version');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
  });

  it('merges global and project skills', async () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'only-global.md'), '---\nname: Only Global\ndescription: G\n---\nContent');

    const projDir = join(TMP, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'only-project.md'), '---\nname: Only Project\ndescription: P\n---\nContent');

    const skills = await discoverSkills('claude-code', TMP);
    expect(skills.length).toBe(2);
    expect(skills.find((s: SkillMeta) => s.id === 'only-project')?.scope).toBe('project');
    expect(skills.find((s: SkillMeta) => s.id === 'only-global')?.scope).toBe('global');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
  });

  it('discovers codex AGENTS.md', async () => {
    writeFileSync(join(TMP, 'AGENTS.md'), '---\nname: Agent Rules\ndescription: Root rules\n---\nContent');

    const skills = await discoverSkills('codex', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('agents-root');

    rmSync(join(TMP, 'AGENTS.md'), { force: true });
  });

  it('discovers aider CONVENTIONS.md', async () => {
    writeFileSync(join(TMP, 'CONVENTIONS.md'), '---\nname: Conventions\ndescription: Project conventions\n---\nContent');

    const skills = await discoverSkills('aider', TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe('conventions');
    expect(skills[0]?.scope).toBe('project');

    rmSync(join(TMP, 'CONVENTIONS.md'), { force: true });
  });

  it('falls back to .diptych/skills for shell planner', async () => {
    const skillsDir = join(TMP, DIPTYCH_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'custom.md'), '---\nname: Custom\ndescription: Custom skill\n---\nContent');

    const skills = await discoverSkills('shell', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    expect(proj.length).toBe(1);
    expect(proj[0]?.id).toBe('custom');

    rmSync(join(TMP, DIPTYCH_DIR), { recursive: true, force: true });
  });

  it('discovers skills from symlinked directories', async () => {
    const realDir = join(TMP, '__real-skill');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'SKILL.md'), '---\nname: Symlinked\ndescription: Via symlink\n---\nContent');

    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    symlinkSync(realDir, join(globalDir, 'symlinked-skill'));

    const skills = await discoverSkills('claude-code', TMP);
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe('symlinked-skill');
    expect(skills[0]?.scope).toBe('global');

    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
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

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });
});

describe('loadSkillContent', () => {
  it('returns empty string for no skills', async () => {
    expect(await loadSkillContent([])).toBe('');
  });

  it('loads skill content stripping frontmatter', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'test.md'), '---\nname: Test\ndescription: Desc\n---\n# Content here');

    const skills: SkillMeta[] = [{
      id: 'test',
      name: 'Test',
      description: 'Desc',
      path: join(skillsDir, 'test.md'),
      scope: 'project',
    }];

    const content = await loadSkillContent(skills);
    expect(content).toContain('### Test');
    expect(content).toContain('# Content here');
    expect(content).not.toContain('---');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });

  it('truncates when exceeding budget', async () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bigContent = 'x'.repeat(20_000);
    writeFileSync(join(skillsDir, 'big.md'), `---\nname: Big\ndescription: Huge\n---\n${bigContent}`);

    const skills: SkillMeta[] = [{
      id: 'big',
      name: 'Big',
      description: 'Huge',
      path: join(skillsDir, 'big.md'),
      scope: 'project',
    }];

    const content = await loadSkillContent(skills);
    expect(content).toContain('[... truncated]');
    expect(content.length).toBeLessThan(20_000);

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
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

    const skills: SkillMeta[] = [{
      id: 'test',
      name: 'Test',
      description: 'Desc',
      path: join(skillsDir, 'test.md'),
      scope: 'project',
    }];

    const section = await buildSkillsSection(skills);
    expect(section.startsWith('## Active Project Skills')).toBeTruthy();
    expect(section).toContain('### Test');
    expect(section).toContain('Body');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });
});
