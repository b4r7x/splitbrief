import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { formatRetryPrompt, formatTaskPrompt } from '../../spec/prompt-formatter.js';
import { buildHintPrompt } from '../../spec/prompts/escalation.js';
import { buildFinalReviewPrompt } from '../../spec/prompts/review.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { buildPlanSessionPrompt } from '../../spec/prompts/plan-session.js';
import { discoverSkills } from '../../skill-discovery.js';
import { buildApiReviewContext } from '../api-review-context.js';
import { buildSkillsContext } from './skills-context.js';

// What a seat needs to use the skill: its instructions, where its files live, and the
// reference it points to.
const SKILL_PARTS = [
  'AUTH-BODY',
  'Base directory: .claude/skills/auth-skill (relative to the project root)',
  '#### references/tokens.md\nTOKENS-REFERENCE',
];

let projectDir: string;
// Discovery scans the global roots under the home directory; a real one would pull the
// developer's own skills into these assertions.
let home: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  home = useTrustHome('skills-context-home');
  projectDir = realpathSync(createTempDir('skills-context'));
  const skillDir = join(projectDir, '.claude', 'skills', 'auth-skill');
  mkdirSync(join(skillDir, 'references'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: AuthSkill\ndescription: d\n---\nAUTH-BODY');
  writeFileSync(join(skillDir, 'references', 'tokens.md'), 'TOKENS-REFERENCE');
});

afterEach(() => {
  cleanupTempDir(projectDir);
  home.restore();
});

async function savedSkills(): Promise<string> {
  const { skillsContext } = await buildSkillsContext({
    projectDir,
    bus: makeBusRecorder().bus,
    phase: 'implementing',
    selected: undefined,
    persisted: ['auth-skill'],
  });
  if (skillsContext === undefined) throw new Error('expected the saved skill to be rebuilt');
  return skillsContext;
}

describe('buildSkillsContext', () => {
  it('builds nothing when the run selected no skill', async () => {
    const skills = await buildSkillsContext({
      projectDir,
      bus: makeBusRecorder().bus,
      phase: 'implementing',
      selected: undefined,
      persisted: undefined,
    });

    expect(skills).toEqual({});
  });

  it('opens the directory of an attached global skill to the implementer, never a project one', async () => {
    const globalSkill = join(home.home, '.claude', 'skills', 'global-skill');
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(globalSkill, 'SKILL.md'), '---\nname: GlobalSkill\n---\nGLOBAL-BODY');

    const { skillRoots } = await buildSkillsContext({
      projectDir,
      bus: makeBusRecorder().bus,
      phase: 'implementing',
      selected: undefined,
      persisted: ['auth-skill', 'global-skill'],
    });

    expect(skillRoots).toEqual([realpathSync(globalSkill)]);
  });

  it('reads a global skill whose files live in the project like a project skill, with no zone', async () => {
    const inProject = join(projectDir, 'vendor', 'skills', 'in-project');
    mkdirSync(inProject, { recursive: true });
    writeFileSync(join(inProject, 'SKILL.md'), '---\nname: InProject\n---\nIN-PROJECT-BODY');
    mkdirSync(join(home.home, '.claude', 'skills'), { recursive: true });
    symlinkSync(inProject, join(home.home, '.claude', 'skills', 'in-project'), 'dir');

    const { skillsContext, skillRoots } = await buildSkillsContext({
      projectDir,
      bus: makeBusRecorder().bus,
      phase: 'implementing',
      selected: undefined,
      persisted: ['in-project'],
    });

    expect(skillsContext).toContain(
      'Base directory: vendor/skills/in-project (relative to the project root)',
    );
    expect(skillRoots).toBeUndefined();
  });

  it('warns with the saved skill ids that no longer resolve', async () => {
    const { bus, events } = makeBusRecorder();

    await buildSkillsContext({
      projectDir,
      bus,
      phase: 'implementing',
      selected: undefined,
      persisted: ['auth-skill', 'gone-skill'],
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'skills_unresolved',
        message: 'Saved skill not found, left out: gone-skill',
      }),
    );
  });

  it('raises no skills_truncated when only references are named by path', async () => {
    const big = join(projectDir, '.claude', 'skills', 'auth-skill', 'references', 'big.md');
    writeFileSync(big, 'x'.repeat(16_000));
    const { bus, events } = makeBusRecorder();

    const { skillsContext } = await buildSkillsContext({
      projectDir,
      bus,
      phase: 'implementing',
      selected: undefined,
      persisted: ['auth-skill'],
    });

    expect(skillsContext).toContain('references/big.md]');
    expect(events.filter((event) => event.type === 'warning')).toEqual([]);
  });

  it('reaches every implementer prompt: first attempt, retry and an API bundle', async () => {
    const context = { name: 'demo', dir: projectDir, skillsContext: await savedSkills() };
    const task = makeTask();

    const prompts = [
      formatTaskPrompt({ task, context, writesFiles: 'direct' }),
      formatRetryPrompt({ task, context, error: 'tsc failed', attempt: 1, writesFiles: 'direct' }),
      formatTaskPrompt({ task, context, outputContract: 'file-bundle-v1' }),
    ];

    for (const prompt of prompts) {
      for (const part of SKILL_PARTS) expect(prompt).toContain(part);
    }
  });

  it('reaches the hint call', async () => {
    const prompt = buildHintPrompt(
      makeTask(),
      'tsc failed',
      undefined,
      undefined,
      await savedSkills(),
    );

    for (const part of SKILL_PARTS) expect(prompt).toContain(part);
  });

  it('reaches the final review', async () => {
    const prompt = buildFinalReviewPrompt({
      spec: '# Spec',
      taskBriefs: '## T001',
      diff: 'diff --git a/x b/x',
      skillsContext: await savedSkills(),
    });

    for (const part of SKILL_PARTS) expect(prompt).toContain(part);
  });

  it("puts the block in every seat's prompt exactly once", async () => {
    const skillsContext = await savedSkills();
    const context = { name: 'demo', dir: projectDir, skillsContext };
    const task = makeTask();
    const review = buildApiReviewContext({
      feature: 'feature',
      spec: '# Spec',
      taskBriefs: '## T001',
      fullDiff: '',
      changedFiles: [],
      baseline: { head: null, runStartChangedFiles: [] },
      driftSection: 'passed: true',
      validation: { recorded: true, evidence: 'none' },
      contextLength: 64_000,
      skillsContext,
    });
    if (review.kind !== 'complete') throw new Error('expected a complete review packet');
    const prompts = {
      plan: buildPlanSessionPrompt({
        feature: 'feature',
        projectContext: 'project',
        languageContext: buildLanguageContext(undefined),
        build: { model: undefined, contextTokens: 64_000 },
        skillsContext,
      }),
      brief: formatTaskPrompt({ task, context, writesFiles: 'direct' }),
      retry: formatRetryPrompt({ task, context, error: 'x', attempt: 1, writesFiles: 'direct' }),
      bundle: formatTaskPrompt({ task, context, outputContract: 'file-bundle-v1' }),
      hint: buildHintPrompt(task, 'tsc failed', undefined, undefined, skillsContext),
      review: buildFinalReviewPrompt({
        spec: '# Spec',
        taskBriefs: '## T001',
        diff: '',
        skillsContext,
      }),
      apiReview: review.text,
    };

    for (const [seat, prompt] of Object.entries(prompts)) {
      expect(prompt.split('## Active Project Skills').length - 1, seat).toBe(1);
      expect(prompt.split('AUTH-BODY').length - 1, seat).toBe(1);
    }
  });

  it('reads a project skill git ignores from the checkout by its absolute path, with a read zone', async () => {
    createTestGitRepo(projectDir, { '.gitignore': '.splitbrief/\n' });
    const ignored = join(projectDir, '.splitbrief', 'skills', 'ignored-skill');
    mkdirSync(ignored, { recursive: true });
    writeFileSync(join(ignored, 'SKILL.md'), '---\nname: Ignored\n---\nIGNORED-BODY');

    const { skillsContext, skillRoots } = await buildSkillsContext({
      projectDir,
      bus: makeBusRecorder().bus,
      phase: 'implementing',
      selected: undefined,
      persisted: ['ignored-skill', 'auth-skill'],
    });

    expect(skillsContext).toContain(`### Ignored\nBase directory: ${ignored}\n\nIGNORED-BODY`);
    expect(skillsContext).toContain(
      'Base directory: .claude/skills/auth-skill (relative to the project root)',
    );
    expect(skillRoots).toEqual([ignored]);
  });

  it('carries the selection a continue was handed in place of the saved ids, and warns about none of them', async () => {
    const { bus, events } = makeBusRecorder();

    const { skillIds } = await buildSkillsContext({
      projectDir,
      bus,
      phase: 'implementing',
      selected: await discoverSkills(projectDir),
      persisted: ['auth-skill', 'gone-skill'],
    });

    expect(skillIds).toEqual(['auth-skill']);
    expect(events.filter((event) => event.type === 'warning')).toEqual([]);
  });

  it('reports a selected skill whose directory was removed after discovery, and the run still starts', async () => {
    const { bus, events } = makeBusRecorder();
    const [auth] = await discoverSkills(projectDir);
    if (auth === undefined) throw new Error('expected the auth skill');
    rmSync(join(projectDir, '.claude', 'skills', 'auth-skill'), { recursive: true });

    const skills = await buildSkillsContext({
      projectDir,
      bus,
      phase: 'implementing',
      selected: [auth],
      persisted: undefined,
    });

    expect(skills).toEqual({});
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'skills_unresolved',
        message: 'Skill could not be read, left out: AuthSkill',
      }),
    );
  });

  it('reports a selected skill it cannot read and leaves it out of the run record', async () => {
    const { bus, events } = makeBusRecorder();
    const [auth] = await discoverSkills(projectDir);
    if (auth === undefined) throw new Error('expected the auth skill');
    const gone = { ...auth, id: 'gone', name: 'Gone', path: join(projectDir, 'gone', 'SKILL.md') };

    const { skillIds } = await buildSkillsContext({
      projectDir,
      bus,
      phase: 'implementing',
      selected: [auth, gone],
      persisted: undefined,
    });

    expect(skillIds).toEqual(['auth-skill']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'skills_unresolved',
        message: 'Skill could not be read, left out: Gone',
      }),
    );
  });
});
