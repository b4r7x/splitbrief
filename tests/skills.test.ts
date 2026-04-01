import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillMeta } from '../src/types.js';

const TMP = join(import.meta.dirname, '.tmp-skills-test');
const FAKE_HOME = join(TMP, '__home__');

let originalHome: string | undefined;

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
});

after(() => {
  process.env.HOME = originalHome;
  rmSync(TMP, { recursive: true, force: true });
});

// Dynamic import after HOME is set so homedir() picks it up
const { parseFrontmatter, discoverSkills, loadSkillContent, buildSkillsSection } = await import('../src/engine/skills.js');

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const raw = `---\nname: my-skill\ndescription: Does things\n---\n# Content`;
    assert.deepStrictEqual(parseFrontmatter(raw), { name: 'my-skill', description: 'Does things' });
  });

  it('returns null for missing frontmatter', () => {
    assert.strictEqual(parseFrontmatter('# Just markdown'), null);
  });

  it('returns null when name is missing', () => {
    const raw = `---\ndescription: No name\n---\n# Content`;
    assert.strictEqual(parseFrontmatter(raw), null);
  });

  it('handles empty description', () => {
    const raw = `---\nname: skill-only\n---\n# Content`;
    assert.deepStrictEqual(parseFrontmatter(raw), { name: 'skill-only', description: '' });
  });
});

describe('discoverSkills', () => {
  it('discovers project claude-code skills from flat .md files', () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'test-skill.md'), '---\nname: Test Skill\ndescription: A test\n---\nContent');

    const skills = discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    assert.strictEqual(proj.length, 1);
    assert.strictEqual(proj[0].id, 'test-skill');
    assert.strictEqual(proj[0].name, 'Test Skill');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });

  it('discovers claude-code skills from subdirectory SKILL.md', () => {
    const skillDir = join(TMP, '.claude', 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: My Skill\ndescription: Sub skill\n---\nContent');

    const skills = discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    assert.strictEqual(proj.length, 1);
    assert.strictEqual(proj[0].id, 'my-skill');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });

  it('discovers global claude-code skills', () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'global-skill.md'), '---\nname: Global Skill\ndescription: From home\n---\nContent');

    const skills = discoverSkills('claude-code', TMP);
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].scope, 'global');
    assert.strictEqual(skills[0].id, 'global-skill');

    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
  });

  it('project skills override global skills with same id', () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'shared.md'), '---\nname: Global Version\ndescription: From home\n---\nGlobal');

    const projDir = join(TMP, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'shared.md'), '---\nname: Project Version\ndescription: From project\n---\nProject');

    const skills = discoverSkills('claude-code', TMP);
    const shared = skills.filter((s: SkillMeta) => s.id === 'shared');
    assert.strictEqual(shared.length, 1);
    assert.strictEqual(shared[0].scope, 'project');
    assert.strictEqual(shared[0].name, 'Project Version');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
  });

  it('merges global and project skills', () => {
    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'only-global.md'), '---\nname: Only Global\ndescription: G\n---\nContent');

    const projDir = join(TMP, '.claude', 'skills');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'only-project.md'), '---\nname: Only Project\ndescription: P\n---\nContent');

    const skills = discoverSkills('claude-code', TMP);
    assert.strictEqual(skills.length, 2);
    assert.strictEqual(skills.find((s: SkillMeta) => s.id === 'only-project')?.scope, 'project');
    assert.strictEqual(skills.find((s: SkillMeta) => s.id === 'only-global')?.scope, 'global');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
  });

  it('discovers codex AGENTS.md', () => {
    writeFileSync(join(TMP, 'AGENTS.md'), '---\nname: Agent Rules\ndescription: Root rules\n---\nContent');

    const skills = discoverSkills('codex', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    assert.strictEqual(proj.length, 1);
    assert.strictEqual(proj[0].id, 'agents-root');

    rmSync(join(TMP, 'AGENTS.md'), { force: true });
  });

  it('discovers aider CONVENTIONS.md', () => {
    writeFileSync(join(TMP, 'CONVENTIONS.md'), '---\nname: Conventions\ndescription: Project conventions\n---\nContent');

    const skills = discoverSkills('aider', TMP);
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].id, 'conventions');
    assert.strictEqual(skills[0].scope, 'project');

    rmSync(join(TMP, 'CONVENTIONS.md'), { force: true });
  });

  it('falls back to .tiny-spec/skills for shell planner', () => {
    const skillsDir = join(TMP, '.tiny-spec', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'custom.md'), '---\nname: Custom\ndescription: Custom skill\n---\nContent');

    const skills = discoverSkills('shell', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    assert.strictEqual(proj.length, 1);
    assert.strictEqual(proj[0].id, 'custom');

    rmSync(join(TMP, '.tiny-spec'), { recursive: true, force: true });
  });

  it('discovers skills from symlinked directories', () => {
    const realDir = join(TMP, '__real-skill');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'SKILL.md'), '---\nname: Symlinked\ndescription: Via symlink\n---\nContent');

    const globalDir = join(FAKE_HOME, '.claude', 'skills');
    mkdirSync(globalDir, { recursive: true });
    symlinkSync(realDir, join(globalDir, 'symlinked-skill'));

    const skills = discoverSkills('claude-code', TMP);
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].id, 'symlinked-skill');
    assert.strictEqual(skills[0].scope, 'global');

    rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  });

  it('returns empty array when no skills exist', () => {
    assert.deepStrictEqual(discoverSkills('claude-code', TMP), []);
  });

  it('skips files without valid frontmatter', () => {
    const skillsDir = join(TMP, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'bad.md'), '# No frontmatter');
    writeFileSync(join(skillsDir, 'good.md'), '---\nname: Good\ndescription: Valid\n---\nContent');

    const skills = discoverSkills('claude-code', TMP);
    const proj = skills.filter((s: SkillMeta) => s.scope === 'project');
    assert.strictEqual(proj.length, 1);
    assert.strictEqual(proj[0].name, 'Good');

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });
});

describe('loadSkillContent', () => {
  it('returns empty string for no skills', () => {
    assert.strictEqual(loadSkillContent([]), '');
  });

  it('loads skill content stripping frontmatter', () => {
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

    const content = loadSkillContent(skills);
    assert.ok(content.includes('### Test'));
    assert.ok(content.includes('# Content here'));
    assert.ok(!content.includes('---'));

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });

  it('truncates when exceeding budget', () => {
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

    const content = loadSkillContent(skills);
    assert.ok(content.includes('[... truncated]'));
    assert.ok(content.length < 20_000);

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });
});

describe('buildSkillsSection', () => {
  it('returns empty string for no skills', () => {
    assert.strictEqual(buildSkillsSection([]), '');
  });

  it('wraps content in Active Project Skills heading', () => {
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

    const section = buildSkillsSection(skills);
    assert.ok(section.startsWith('## Active Project Skills'));
    assert.ok(section.includes('### Test'));
    assert.ok(section.includes('Body'));

    rmSync(join(TMP, '.claude'), { recursive: true, force: true });
  });
});
