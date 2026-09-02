import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../stores/project/config.js';
import { skillsStore } from '../stores/project/skills.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import type { SkillMeta } from '../core/skills/types.js';

const scan = vi.hoisted(() => ({ failWith: null as Error | null }));

vi.mock('../engine/skill-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/skill-discovery.js')>();
  return {
    ...actual,
    discoverSkills: (dir: string) =>
      scan.failWith === null ? actual.discoverSkills(dir) : Promise.reject(scan.failWith),
  };
});

let originalHome: string | undefined;
let projectDir = '';
let fakeHome = '';

beforeAll(() => {
  originalHome = process.env.HOME;
});

afterAll(() => {
  process.env.HOME = originalHome;
});

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-rescan-project-')));
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'splitbrief-rescan-home-')));
  process.env.HOME = fakeHome;
  scan.failWith = null;
  resetAllStores();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

// Dynamic import after HOME is set so homedir() picks the fake home up.
const { refreshSkills } = await import('./refresh-skills.js');

function writeSkill(id: string, description: string): void {
  const dir = join(projectDir, '.claude', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\nBody\n`,
  );
}

function seeded(id: string): SkillMeta {
  return {
    id,
    name: id,
    description: 'seeded by the test',
    path: `/nowhere/${id}/SKILL.md`,
    scope: 'project',
  };
}

function availableIds(): string[] {
  return skillsStore.get().available.map((skill) => skill.id);
}

describe('refreshSkills', () => {
  it('does nothing when no project directory is loaded', async () => {
    skillsStore.setAvailable([seeded('seeded-skill')]);

    refreshSkills();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(availableIds()).toEqual(['seeded-skill']);
  });

  it('replaces the available skills with a fresh scan of the project', async () => {
    writeSkill('rescan-proof', 'proves the rescan ran');
    skillsStore.setAvailable([seeded('stale-skill')]);
    configStore.__testReset({ projectDir });

    refreshSkills();

    await vi.waitFor(() => expect(availableIds()).toContain('rescan-proof'));
    expect(availableIds()).not.toContain('stale-skill');
  });

  it('picks up a skill added after startup', async () => {
    skillsStore.setAvailable([seeded('stale-skill')]);
    configStore.__testReset({ projectDir });

    refreshSkills();
    await vi.waitFor(() => expect(availableIds()).toEqual([]));

    writeSkill('added-late', 'written after the first scan');
    refreshSkills();

    await vi.waitFor(() => expect(availableIds()).toContain('added-late'));
  });

  it('reports a failed scan on the feedback line, never on stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    scan.failWith = new Error('skill scan exploded');
    skillsStore.setAvailable([seeded('stale-skill')]);
    configStore.__testReset({ projectDir });

    refreshSkills();

    await vi.waitFor(() => expect(feedbackStore.get().isError).toBe(true));
    expect(feedbackStore.get().message).toContain('skill scan exploded');
    expect(stderr).not.toHaveBeenCalled();
    expect(availableIds()).toEqual(['stale-skill']);
  });
});
